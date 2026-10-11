import { afterEach, describe, expect, it } from "vitest";
import { formatLine, setLogFormat } from "../src/audit.js";

afterEach(() => setLogFormat("json"));

describe("formatLine", () => {
  it("json by default", () => {
    expect(JSON.parse(formatLine("warn", "x", { a: 1 }, "T"))).toEqual({ ts: "T", level: "warn", event: "x", a: 1 });
  });

  it("text: one plain line, values quoted only when needed, undefined dropped", () => {
    setLogFormat("text");
    expect(formatLine("warn", "mcp_auth_failed", { ip: "1.2.3.4", user_agent: "curl/8 x", n: 3, gone: undefined }, "T")).toBe(
      'T WARN  mcp_auth_failed ip=1.2.3.4 user_agent="curl/8 x" n=3',
    );
  });
});
