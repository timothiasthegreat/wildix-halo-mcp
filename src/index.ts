import { timingSafeEqual } from "node:crypto";
import express, { type NextFunction, type Request, type Response } from "express";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { loadConfig } from "./config.js";
import { log, RateLimiter, setLogLevel } from "./audit.js";
import { HaloClient } from "./halo/client.js";
import { WilmaService } from "./service.js";
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
  res.json({ ok: true });
});

// Stateless Streamable HTTP: a fresh server + transport per request.
app.post("/mcp", requireApiKey, async (req: Request, res: Response) => {
  const server = buildMcpServer(svc, () => req.ip ?? "unknown");
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
app.get("/mcp", requireApiKey, methodNotAllowed);
app.delete("/mcp", requireApiKey, methodNotAllowed);

const httpServer = app.listen(cfg.PORT, () => log("info", "listening", { port: cfg.PORT }));

for (const sig of ["SIGTERM", "SIGINT"] as const) {
  process.on(sig, () => {
    log("info", "shutting_down", { signal: sig });
    httpServer.close(() => process.exit(0));
    setTimeout(() => process.exit(0), 5000).unref();
  });
}
