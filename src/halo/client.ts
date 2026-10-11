import { log } from "../audit.js";

export type QueryValue = string | number | boolean | undefined | null;
export type Query = Record<string, QueryValue>;

/** The slice of the Halo REST API the tools depend on. Mocked in tests. */
export interface HaloApi {
  get<T>(path: string, query?: Query): Promise<T>;
  post<T>(path: string, body: unknown): Promise<T>;
}

export class HaloError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
  }
}

export interface HaloClientOptions {
  baseUrl: string;
  authUrl: string;
  tenant?: string;
  clientId: string;
  clientSecret: string;
  scope: string;
  timeoutMs?: number;
  fetchImpl?: typeof fetch;
}

const RETRYABLE = new Set([429, 502, 503, 504]);
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export class HaloClient implements HaloApi {
  private token?: { value: string; expiresAt: number };
  private tokenPromise?: Promise<string>;
  private readonly fetch: typeof fetch;
  private readonly timeoutMs: number;

  constructor(private readonly opts: HaloClientOptions) {
    this.fetch = opts.fetchImpl ?? fetch;
    this.timeoutMs = opts.timeoutMs ?? 15000;
  }

  private async getToken(): Promise<string> {
    if (this.token && this.token.expiresAt - 60_000 > Date.now()) return this.token.value;
    // Collapse concurrent refreshes into one request.
    this.tokenPromise ??= this.fetchToken().finally(() => (this.tokenPromise = undefined));
    return this.tokenPromise;
  }

  private async fetchToken(): Promise<string> {
    const url = new URL(this.opts.authUrl.replace(/\/+$/, "") + "/token");
    if (this.opts.tenant) url.searchParams.set("tenant", this.opts.tenant);
    const body = new URLSearchParams({
      grant_type: "client_credentials",
      client_id: this.opts.clientId,
      client_secret: this.opts.clientSecret,
      scope: this.opts.scope,
    });
    const res = await this.fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body,
      signal: AbortSignal.timeout(this.timeoutMs),
    });
    if (!res.ok) {
      log("error", "halo_auth_failed", { status: res.status });
      throw new HaloError(`Halo authentication failed (${res.status})`, res.status);
    }
    const json = (await res.json()) as { access_token: string; expires_in?: number };
    this.token = { value: json.access_token, expiresAt: Date.now() + (json.expires_in ?? 3600) * 1000 };
    log("debug", "halo_token_refreshed", { expires_in: json.expires_in });
    return json.access_token;
  }

  private buildUrl(path: string, query?: Query): URL {
    const url = new URL(this.opts.baseUrl.replace(/\/+$/, "") + path);
    for (const [k, v] of Object.entries(query ?? {})) {
      if (v !== undefined && v !== null && v !== "") url.searchParams.set(k, String(v));
    }
    return url;
  }

  private async request<T>(method: "GET" | "POST", path: string, query?: Query, body?: unknown): Promise<T> {
    const url = this.buildUrl(path, query);
    for (let attempt = 0; ; attempt++) {
      const token = await this.getToken();
      const started = Date.now();
      const res = await this.fetch(url, {
        method,
        headers: {
          Authorization: `Bearer ${token}`,
          Accept: "application/json",
          ...(body !== undefined ? { "Content-Type": "application/json" } : {}),
        },
        body: body !== undefined ? JSON.stringify(body) : undefined,
        signal: AbortSignal.timeout(this.timeoutMs),
      });
      log("debug", "halo_request", { method, path, status: res.status, ms: Date.now() - started });

      if (res.status === 401 && attempt === 0) {
        this.token = undefined; // token revoked/expired early; retry once with a fresh one
        continue;
      }
      if (RETRYABLE.has(res.status) && attempt < 3) {
        const retryAfter = Number(res.headers.get("retry-after"));
        await sleep(Number.isFinite(retryAfter) && retryAfter > 0 ? retryAfter * 1000 : 500 * 2 ** attempt);
        continue;
      }
      if (!res.ok) {
        const text = await res.text().catch(() => "");
        log("warn", "halo_request_failed", { method, path, status: res.status, body: text.slice(0, 300) });
        throw new HaloError(`Halo ${method} ${path} failed (${res.status})`, res.status);
      }
      const text = await res.text();
      return (text ? JSON.parse(text) : undefined) as T;
    }
  }

  get<T>(path: string, query?: Query): Promise<T> {
    return this.request<T>("GET", path, query);
  }

  post<T>(path: string, body: unknown): Promise<T> {
    return this.request<T>("POST", path, undefined, body);
  }
}
