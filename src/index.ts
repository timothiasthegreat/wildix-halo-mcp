import { timingSafeEqual } from "node:crypto";
import express, { type NextFunction, type Request, type Response } from "express";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { loadConfig } from "./config.js";
import { log, RateLimiter, setLogLevel } from "./audit.js";
import { HaloClient } from "./halo/client.js";
import { WilmaService } from "./service.js";
import { ToolCallLog } from "./toolLog.js";
import { buildMcpServer } from "./tools.js";

const cfg = loadConfig();
setLogLevel(cfg.LOG_LEVEL);

for (const key of ["HALO_TICKETTYPE_ID", "HALO_UPDATE_OUTCOME_ID"] as const) {
  if (cfg[key] === undefined) log("warn", "config_default_missing", { key, note: "Halo defaults will be used" });
}

const halo = new HaloClient({
  baseUrl: cfg.HALO_BASE_URL,
  authUrl: cfg.HALO_AUTH_URL,
  tenant: cfg.HALO_TENANT,
  clientId: cfg.HALO_CLIENT_ID,
  clientSecret: cfg.HALO_CLIENT_SECRET,
  scope: cfg.HALO_SCOPE,
});
const svc = new WilmaService(halo, cfg);

const toolLog = cfg.TEST_MODE ? new ToolCallLog(cfg.TOOL_LOG_FILE, cfg.TOOL_LOG_MAX_MB * 1024 * 1024) : undefined;
if (cfg.TEST_MODE) {
  log("warn", "TEST_MODE_ENABLED", {
    test_client_id: cfg.TEST_CLIENT_ID,
    test_user_id: cfg.TEST_USER_ID,
    verify_mode: cfg.TEST_VERIFY_MODE,
    tool_log: cfg.TOOL_LOG_FILE,
    note: "All lookups and tickets are confined to the test client; tool calls are logged verbatim.",
  });
}

const app = express();
app.set("trust proxy", true); // runs behind a TLS reverse proxy
app.disable("x-powered-by");
app.use(express.json({ limit: "256kb" }));

const expectedKey = Buffer.from(cfg.MCP_API_KEY);
const authFailures = new RateLimiter(20, 15 * 60_000);

function requireApiKey(req: Request, res: Response, next: NextFunction) {
  const header = req.get("authorization") ?? "";
  const presented = header.toLowerCase().startsWith("bearer ") ? header.slice(7).trim() : (req.get("x-api-key") ?? "");
  const given = Buffer.from(presented);
  if (given.length === expectedKey.length && timingSafeEqual(given, expectedKey)) return next();
  const ip = req.ip ?? "unknown";
  log("warn", "mcp_auth_failed", { ip });
  if (!authFailures.take(ip)) {
    res.status(429).json({ error: "too_many_requests" });
    return;
  }
  res.status(401).json({ error: "unauthorized" });
}

app.get("/healthz", (_req, res) => {
  res.json({ ok: true, ...(cfg.TEST_MODE ? { test_mode: true } : {}) });
});

if (toolLog) {
  // Test mode only: recent tool calls as JSON, e.g. GET /debug/tool-calls?limit=20
  app.get("/debug/tool-calls", requireApiKey, async (req: Request, res: Response) => {
    const limit = Math.min(Math.max(Number(req.query.limit) || 50, 1), 500);
    res.json({ file: toolLog.file, entries: await toolLog.tail(limit) });
  });
}

// MCP endpoint. Served at /mcp and also at / so a Server URL entered without the
// path (or a proxy that strips it) still works.
const MCP_PATHS = ["/mcp", "/"];

// Stateless Streamable HTTP: a fresh server + transport per request.
app.post(MCP_PATHS, requireApiKey, async (req: Request, res: Response) => {
  const info = { ip: req.ip ?? "unknown", userAgent: req.get("user-agent") };
  if (toolLog) {
    // Record non-tool traffic too (initialize, tools/list, ...) to see how Wilma connects.
    for (const msg of Array.isArray(req.body) ? req.body : [req.body]) {
      if (msg?.method && msg.method !== "tools/call") {
        toolLog.write({ kind: "rpc", method: msg.method, params: msg.params, ip: info.ip, user_agent: info.userAgent });
      }
    }
  }
  const server = buildMcpServer(svc, () => info, toolLog);
  const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
  res.on("close", () => {
    void transport.close();
    void server.close();
  });
  try {
    await server.connect(transport);
    await transport.handleRequest(req, res, req.body);
  } catch (e) {
    log("error", "mcp_request_failed", { error: e instanceof Error ? e.message : String(e) });
    if (!res.headersSent) {
      res.status(500).json({ jsonrpc: "2.0", error: { code: -32603, message: "Internal server error" }, id: null });
    }
  }
});

const methodNotAllowed = (_req: Request, res: Response) => {
  res.status(405).json({ jsonrpc: "2.0", error: { code: -32000, message: "Method not allowed." }, id: null });
};
app.get(MCP_PATHS, requireApiKey, methodNotAllowed);
app.delete(MCP_PATHS, requireApiKey, methodNotAllowed);

const httpServer = app.listen(cfg.PORT, () => log("info", "listening", { port: cfg.PORT }));

for (const sig of ["SIGTERM", "SIGINT"] as const) {
  process.on(sig, () => {
    log("info", "shutting_down", { signal: sig });
    httpServer.close(() => process.exit(0));
    setTimeout(() => process.exit(0), 5000).unref();
  });
}
