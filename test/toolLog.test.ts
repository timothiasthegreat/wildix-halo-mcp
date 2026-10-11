import { mkdtemp, readFile, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { redactTokens, ToolCallLog } from "../src/toolLog.js";

describe("redactTokens", () => {
  it("shortens tokens anywhere in the structure and leaves everything else", () => {
    const token = "eyJ1aWQiOjEwMSwiY2lkIjoxMH0.abcdefghijklmnop";
    expect(redactTokens({ token, note: "hi", nested: [{ token }] })).toEqual({
      token: `eyJ1aWQiOj...(${token.length})`,
      note: "hi",
      nested: [{ token: `eyJ1aWQiOj...(${token.length})` }],
    });
  });
});

describe("ToolCallLog", () => {
  it("appends JSONL, creates the folder, and tails newest last", async () => {
    const dir = await mkdtemp(join(tmpdir(), "toollog-"));
    const tl = new ToolCallLog(join(dir, "sub", "calls.jsonl"), 1024 * 1024);
    tl.write({ kind: "rpc", method: "initialize" });
    tl.write({ kind: "tool_call", tool: "verify_caller", args: { caller_id: "604", token: "x".repeat(40) } });
    const entries = (await tl.tail(10)) as any[];
    expect(entries.map((e) => e.kind)).toEqual(["rpc", "tool_call"]);
    expect(entries[1].args.token).toMatch(/\.\.\.\(40\)$/);
    expect(entries[1].ts).toBeTruthy();
    expect((await tl.tail(1)) as any[]).toHaveLength(1);
  });

  it("rotates past the size cap", async () => {
    const dir = await mkdtemp(join(tmpdir(), "toollog-"));
    const file = join(dir, "calls.jsonl");
    const tl = new ToolCallLog(file, 200);
    for (let i = 0; i < 5; i++) tl.write({ kind: "tool_call", tool: "t", args: { pad: "y".repeat(100), i } });
    await tl.tail(1);
    expect((await stat(`${file}.1`)).size).toBeGreaterThan(0);
    expect((await readFile(file, "utf8")).length).toBeLessThan(400);
  });
});
