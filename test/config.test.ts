import { describe, expect, it } from "vitest";
import { loadConfig } from "../src/config.js";

const required = {
  MCP_API_KEY: "k".repeat(32),
  TOKEN_SECRET: "s".repeat(40),
  HALO_BASE_URL: "https://halo.example.com/api",
  HALO_AUTH_URL: "https://halo.example.com/auth",
  HALO_CLIENT_ID: "id",
  HALO_CLIENT_SECRET: "secret",
};

describe("loadConfig", () => {
  it("treats blank optional values (as passed by docker compose) as unset", () => {
    const cfg = loadConfig({
      ...required,
      HALO_TENANT: "",
      HALO_TICKETTYPE_ID: "",
      HALO_TEAM_ID: " ",
      HALO_PRIORITY_LOW: "",
      HALO_UPDATE_OUTCOME_ID: "",
      HALO_UPDATE_NEW_STATUS_ID: "",
      HALO_TICKET_SOURCE_ID: "",
    });
    expect(cfg.HALO_TICKETTYPE_ID).toBeUndefined();
    expect(cfg.HALO_TEAM_ID).toBeUndefined();
    expect(cfg.HALO_UPDATE_OUTCOME_ID).toBeUndefined();
  });

  it("parses IDs and still rejects junk", () => {
    expect(loadConfig({ ...required, HALO_TICKETTYPE_ID: "31" }).HALO_TICKETTYPE_ID).toBe(31);
    expect(() => loadConfig({ ...required, HALO_TICKETTYPE_ID: "abc" })).toThrow(/HALO_TICKETTYPE_ID/);
    expect(() => loadConfig({ ...required, MCP_API_KEY: "short" })).toThrow(/MCP_API_KEY/);
  });
});
