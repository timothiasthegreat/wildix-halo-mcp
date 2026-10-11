import type { AddressInfo } from "node:net";
import type { Server } from "node:http";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createApp, keyFingerprint } from "../src/app.js";
import { loadConfig, type Config } from "../src/config.js";
import type { HaloApi } from "../src/halo/client.js";
import { WilmaService } from "../src/service.js";

const KEY = "k".repeat(32);
const baseEnv = {
  MCP_API_KEY: KEY,
  TOKEN_SECRET: "s".repeat(40),
  HALO_BASE_URL: "https://halo.example.com/api",
  HALO_AUTH_URL: "https://halo.example.com/auth",
  HALO_CLIENT_ID: "id",
  HALO_CLIENT_SECRET: "secret",
};

// Listing tools never touches Halo; anything that does should fail loudly.
const noHalo: HaloApi = {
  get: () => Promise.reject(new Error("unexpected Halo call")),
  post: () => Promise.reject(new Error("unexpected Halo call")),
};

let server: Server | undefined;
afterEach(() => new Promise<void>((done) => (server ? server.close(() => done()) : done())));

async function start(cfg: Config = loadConfig(baseEnv)) {
  server = createApp(cfg, new WilmaService(noHalo, cfg)).listen(0);
  await new Promise((r) => server!.once("listening", r));
  return `http://127.0.0.1:${(server!.address() as AddressInfo).port}`;
}

async function rpc(base: string, path: string, body: unknown, key = KEY) {
  const res = await fetch(base + path, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Accept: "application/json, text/event-stream",
      Authorization: `Bearer ${key}`,
    },
    body: JSON.stringify(body),
  });
  return { status: res.status, json: (await res.json()) as any };
}

async function toolsAt(base: string, path: string) {
  const { status, json } = await rpc(base, path, { jsonrpc: "2.0", id: 1, method: "tools/list" });
  expect(status).toBe(200);
  return json.result.tools as { name: string; inputSchema: { properties: Record<string, unknown>; required?: string[] } }[];
}

const TICKET_TOOLS = ["list_my_open_tickets", "get_ticket_update", "create_ticket", "add_ticket_update", "log_unverified_request"];

describe("channel endpoints", () => {
  it("/mcp/voice offers verify_caller but never verify_chat_user", async () => {
    const names = (await toolsAt(await start(), "/mcp/voice")).map((t) => t.name);
    expect(names).toContain("verify_caller");
    expect(names).not.toContain("verify_chat_user");
    expect(names).toEqual(expect.arrayContaining(TICKET_TOOLS));
  });

  it("/mcp/chat offers verify_chat_user but never verify_caller", async () => {
    const names = (await toolsAt(await start(), "/mcp/chat")).map((t) => t.name);
    expect(names).toContain("verify_chat_user");
    expect(names).not.toContain("verify_caller");
    expect(names).toEqual(expect.arrayContaining(TICKET_TOOLS));
  });

  it("chat verification requires name and company", async () => {
    const chat = (await toolsAt(await start(), "/mcp/chat")).find((t) => t.name === "verify_chat_user")!;
    expect(chat.inputSchema.required).toEqual(expect.arrayContaining(["email", "full_name", "company_name"]));
  });

  it("channel endpoints don't ask for log_unverified_request's channel", async () => {
    const base = await start();
    for (const path of ["/mcp/voice", "/mcp/chat"]) {
      const tool = (await toolsAt(base, path)).find((t) => t.name === "log_unverified_request")!;
      expect(tool.inputSchema.properties).not.toHaveProperty("channel");
    }
    const combined = (await toolsAt(base, "/mcp")).find((t) => t.name === "log_unverified_request")!;
    expect(combined.inputSchema.required).toContain("channel");
  });

  it("calling the other channel's verify tool fails", async () => {
    const { json } = await rpc(await start(), "/mcp/voice", {
      jsonrpc: "2.0",
      id: 2,
      method: "tools/call",
      params: { name: "verify_chat_user", arguments: { email: "a@b.com", full_name: "A B", company_name: "C" } },
    });
    expect(JSON.stringify(json)).toMatch(/not found|unknown tool|-32602/i);
    expect(JSON.stringify(json)).not.toContain("token");
  });

  it("/mcp and / serve every tool by default", async () => {
    const base = await start();
    for (const path of ["/mcp", "/"]) {
      const names = (await toolsAt(base, path)).map((t) => t.name);
      expect(names).toEqual(expect.arrayContaining(["verify_caller", "verify_chat_user", ...TICKET_TOOLS]));
    }
  });

  it("MCP_ALLOW_COMBINED=false turns off /mcp and / but keeps the channel endpoints", async () => {
    const base = await start(loadConfig({ ...baseEnv, MCP_ALLOW_COMBINED: "false" }));
    for (const path of ["/mcp", "/"]) {
      const { status, json } = await rpc(base, path, { jsonrpc: "2.0", id: 1, method: "tools/list" });
      expect(status).toBe(404);
      expect(json.error.message).toMatch(/\/mcp\/voice or \/mcp\/chat/);
    }
    expect((await toolsAt(base, "/mcp/voice")).length).toBeGreaterThan(0);
  });

  it("every MCP endpoint needs the API key", async () => {
    const base = await start();
    for (const path of ["/mcp/voice", "/mcp/chat", "/mcp", "/"]) {
      expect((await rpc(base, path, { jsonrpc: "2.0", id: 1, method: "tools/list" }, "wrong")).status).toBe(401);
    }
  });
});

describe("auth logging", () => {
  it("GET on MCP paths answers 405 without a key and logs nothing", async () => {
    const base = await start();
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    const out = vi.spyOn(console, "log").mockImplementation(() => {});
    try {
      for (const path of ["/", "/mcp", "/mcp/voice"]) expect((await fetch(base + path)).status).toBe(405);
      expect([...spy.mock.calls, ...out.mock.calls].join("\n")).not.toMatch(/mcp_auth_failed|mcp_unauthenticated/);
    } finally {
      spy.mockRestore();
      out.mockRestore();
    }
  });

  it("a wrong key logs a warning with detail and a fingerprint, never the key", async () => {
    const base = await start();
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      const wrong = "w".repeat(32);
      await rpc(base, "/mcp/voice", { jsonrpc: "2.0", id: 1, method: "tools/list" }, wrong);
      const line = spy.mock.calls.map((c) => String(c[0])).find((l) => l.includes("mcp_auth_failed"))!;
      const entry = JSON.parse(line);
      expect(entry).toMatchObject({ level: "warn", method: "POST", path: "/mcp/voice", credentials: "bearer", key_fp: keyFingerprint(wrong), key_length: 32 });
      expect(line).not.toContain(wrong);
      expect(line).not.toContain(KEY);
    } finally {
      spy.mockRestore();
    }
  });

  it("no key at all is logged at info as unauthenticated", async () => {
    const base = await start();
    const out = vi.spyOn(console, "log").mockImplementation(() => {});
    const err = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      const res = await fetch(base + "/", { method: "POST", headers: { "Content-Type": "application/json" }, body: "{}" });
      expect(res.status).toBe(401);
      expect(out.mock.calls.map((c) => String(c[0])).join("\n")).toMatch(/"event":"mcp_unauthenticated".*"credentials":"none"/);
      expect(err.mock.calls.map((c) => String(c[0])).join("\n")).not.toMatch(/mcp_auth_failed/);
    } finally {
      out.mockRestore();
      err.mockRestore();
    }
  });
});
