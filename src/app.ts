import { timingSafeEqual } from "node:crypto";
import express, { type Express, type NextFunction, type Request, type Response } from "express";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import type { Config } from "./config.js";
import { log, RateLimiter } from "./audit.js";
import type { WilmaService } from "./service.js";
import type { ToolCallLog } from "./toolLog.js";
import { buildMcpServer, type Channel } from "./tools.js";

/**
 * MCP endpoints:
 *   /mcp/voice  voice agents: verify_caller + ticket tools (no verify_chat_user)
 *   /mcp/chat   chat bots:    verify_chat_user + ticket tools (no verify_caller)
 *   /mcp and /  every tool (backward compatible; off when MCP_ALLOW_COMBINED=false).
 *               "/" also catches a Server URL entered without a path.
 */
const CHANNEL_PATHS: [Channel, string[]][] = [
  ["voice", ["/mcp/voice"]],
  ["chat", ["/mcp/chat"]],
  ["all", ["/mcp", "/"]],
];

export function createApp(cfg: Config, svc: WilmaService, toolLog?: ToolCallLog): Express {
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

  // Stateless Streamable HTTP: a fresh server + transport per request.
  const handleMcp = (channel: Channel) => async (req: Request, res: Response) => {
    const info = { ip: req.ip ?? "unknown", userAgent: req.get("user-agent") };
    if (toolLog) {
      // Record non-tool traffic too (initialize, tools/list, ...) to see how Wilma connects.
      for (const msg of Array.isArray(req.body) ? req.body : [req.body]) {
        if (msg?.method && msg.method !== "tools/call") {
          toolLog.write({ kind: "rpc", channel, method: msg.method, params: msg.params, ip: info.ip, user_agent: info.userAgent });
        }
      }
    }
    const server = buildMcpServer(svc, () => info, { channel, toolLog });
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
    res.on("close", () => {
      void transport.close();
      void server.close();
    });
    try {
      await server.connect(transport);
      await transport.handleRequest(req, res, req.body);
    } catch (e) {
      log("error", "mcp_request_failed", { channel, error: e instanceof Error ? e.message : String(e) });
      if (!res.headersSent) {
        res.status(500).json({ jsonrpc: "2.0", error: { code: -32603, message: "Internal server error" }, id: null });
      }
    }
  };

  const methodNotAllowed = (_req: Request, res: Response) => {
    res.status(405).json({ jsonrpc: "2.0", error: { code: -32000, message: "Method not allowed." }, id: null });
  };
  const combinedDisabled = (_req: Request, res: Response) => {
    res.status(404).json({
      jsonrpc: "2.0",
      error: { code: -32000, message: "This server only serves channel endpoints: use /mcp/voice or /mcp/chat." },
      id: null,
    });
  };

  for (const [channel, paths] of CHANNEL_PATHS) {
    if (channel === "all" && !cfg.MCP_ALLOW_COMBINED) {
      app.all(paths, requireApiKey, combinedDisabled);
      continue;
    }
    app.post(paths, requireApiKey, handleMcp(channel));
    app.get(paths, requireApiKey, methodNotAllowed);
    app.delete(paths, requireApiKey, methodNotAllowed);
  }

  return app;
}
