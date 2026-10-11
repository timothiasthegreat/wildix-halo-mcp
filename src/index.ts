import { createApp } from "./app.js";
import { loadConfig } from "./config.js";
import { log, setLogFormat, setLogLevel } from "./audit.js";
import { HaloClient } from "./halo/client.js";
import { WilmaService } from "./service.js";
import { ToolCallLog } from "./toolLog.js";

const cfg = loadConfig();
setLogLevel(cfg.LOG_LEVEL);
setLogFormat(cfg.LOG_FORMAT);

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

if (!cfg.MCP_ALLOW_COMBINED) log("info", "combined_endpoint_disabled", { endpoints: ["/mcp/voice", "/mcp/chat"] });

const app = createApp(cfg, svc, toolLog);

const httpServer = app.listen(cfg.PORT, () => log("info", "listening", { port: cfg.PORT }));

for (const sig of ["SIGTERM", "SIGINT"] as const) {
  process.on(sig, () => {
    log("info", "shutting_down", { signal: sig });
    httpServer.close(() => process.exit(0));
    setTimeout(() => process.exit(0), 5000).unref();
  });
}
