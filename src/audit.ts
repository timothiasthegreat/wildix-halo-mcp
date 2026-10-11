type Level = "debug" | "info" | "warn" | "error";
const order: Record<Level, number> = { debug: 10, info: 20, warn: 30, error: 40 };
let threshold: Level = "info";
let format: "json" | "text" = "json";

export function setLogLevel(level: Level) {
  threshold = level;
}

/** json: one JSON object per line (log shippers). text: plain "ts LEVEL event k=v" (Portainer's viewer). */
export function setLogFormat(f: "json" | "text") {
  format = f;
}

function textValue(v: unknown): string {
  const s = typeof v === "string" ? v : JSON.stringify(v);
  return s === "" || /[\s"=]/.test(s) ? JSON.stringify(s) : s;
}

export function formatLine(level: Level, event: string, fields: Record<string, unknown>, ts = new Date().toISOString()): string {
  if (format === "json") return JSON.stringify({ ts, level, event, ...fields });
  const kv = Object.entries(fields)
    .filter(([, v]) => v !== undefined)
    .map(([k, v]) => `${k}=${textValue(v)}`);
  return [ts, level.toUpperCase().padEnd(5), event, ...kv].join(" ");
}

/** Structured log line to stdout/stderr. Never pass note bodies or secrets. */
export function log(level: Level, event: string, fields: Record<string, unknown> = {}) {
  if (order[level] < order[threshold]) return;
  const line = formatLine(level, event, fields);
  if (level === "error" || level === "warn") console.error(line);
  else console.log(line);
}

/** Simple fixed-window in-memory rate limiter. */
export class RateLimiter {
  private hits = new Map<string, { count: number; resetAt: number }>();
  constructor(
    private readonly limit: number,
    private readonly windowMs: number,
  ) {}

  /** Returns true if the action is allowed (and records it). */
  take(key: string, now = Date.now()): boolean {
    const entry = this.hits.get(key);
    if (!entry || entry.resetAt <= now) {
      this.hits.set(key, { count: 1, resetAt: now + this.windowMs });
      this.sweep(now);
      return true;
    }
    if (entry.count >= this.limit) return false;
    entry.count++;
    return true;
  }

  private sweep(now: number) {
    if (this.hits.size < 5000) return;
    for (const [k, v] of this.hits) if (v.resetAt <= now) this.hits.delete(k);
  }
}
