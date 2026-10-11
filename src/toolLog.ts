import { appendFile, mkdir, readFile, rename, stat } from "node:fs/promises";
import { dirname } from "node:path";
import { log } from "./audit.js";

export interface ToolLogEntry {
  kind: "tool_call" | "rpc";
  [key: string]: unknown;
}

/** Shorten verification tokens so logs show which token was used without being replayable. */
export function redactTokens(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(redactTokens);
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value).map(([k, v]) => [k, k === "token" && typeof v === "string" ? `${v.slice(0, 10)}...(${v.length})` : redactTokens(v)]),
    );
  }
  return value;
}

/**
 * Append-only JSONL log of what Wilma sends and gets back (test mode only). Writes are
 * serialised and never throw into the request path. Rotates to `<file>.1` past maxBytes.
 */
export class ToolCallLog {
  private queue: Promise<void> = Promise.resolve();
  private ready?: Promise<void>;

  constructor(
    readonly file: string,
    private readonly maxBytes: number,
  ) {}

  write(entry: ToolLogEntry): void {
    const line = JSON.stringify(redactTokens({ ts: new Date().toISOString(), ...entry })) + "\n";
    log("debug", entry.kind, { tool: entry.tool, method: entry.method });
    this.queue = this.queue.then(() => this.append(line)).catch((e) => log("warn", "tool_log_write_failed", { error: String(e) }));
  }

  private async append(line: string) {
    this.ready ??= mkdir(dirname(this.file), { recursive: true }).then(() => undefined);
    await this.ready;
    const size = await stat(this.file).then((s) => s.size).catch(() => 0);
    if (size > this.maxBytes) await rename(this.file, `${this.file}.1`).catch(() => undefined);
    await appendFile(this.file, line, "utf8");
  }

  /** Last `limit` entries, newest last. */
  async tail(limit: number): Promise<unknown[]> {
    await this.queue;
    const text = await readFile(this.file, "utf8").catch(() => "");
    return text
      .split("\n")
      .filter(Boolean)
      .slice(-limit)
      .map((l) => {
        try {
          return JSON.parse(l);
        } catch {
          return { unparsable: l };
        }
      });
  }
}
