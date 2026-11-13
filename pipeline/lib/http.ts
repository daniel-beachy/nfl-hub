import { PAYLOAD_HEAD_BYTES, type Issue, type IssueKind } from "../../shared/snapshot.ts";

// The one way the pipeline talks to the network (docs/PLAN.md 7.1).

/** Hosts the pipeline may call. Adding a provider means adding its host here on purpose. */
export const ALLOWED_HOSTS = new Set([
  "site.api.espn.com",
  "site.web.api.espn.com",
  "sports.core.api.espn.com",
  "gamma-api.polymarket.com",
  "api.elections.kalshi.com",
  "www.bovada.lv",
  "api.github.com",
  "github.com",
  "objects.githubusercontent.com",
  "release-assets.githubusercontent.com",
]);

const USER_AGENT =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0 Safari/537.36";

/** A failure with a runbook `kind`. Everything a source can do wrong becomes one of these. */
export class SourceError extends Error {
  readonly kind: IssueKind;
  readonly httpStatus: number | null;
  readonly detail: string | undefined;
  /** The raw response body, when there was one. Saved as a workflow artifact by capture. */
  readonly payload: string | undefined;

  constructor(
    kind: IssueKind,
    message: string,
    extra: { httpStatus?: number | null; detail?: string; payload?: string } = {},
  ) {
    super(message);
    this.name = "SourceError";
    this.kind = kind;
    this.httpStatus = extra.httpStatus ?? null;
    this.detail = extra.detail;
    this.payload = extra.payload;
  }

  toIssue(): Issue {
    return {
      kind: this.kind,
      message: this.message,
      httpStatus: this.httpStatus,
      ...(this.detail !== undefined && { detail: this.detail }),
      ...(this.payload !== undefined && { payloadHead: head(this.payload) }),
    };
  }
}

/** The first 2 KB of a payload, cut on a character boundary. */
export function head(text: string): string {
  let out = text.slice(0, PAYLOAD_HEAD_BYTES);
  while (Buffer.byteLength(out) > PAYLOAD_HEAD_BYTES) out = out.slice(0, -1);
  return out;
}

export function toSourceError(err: unknown): SourceError {
  if (err instanceof SourceError) return err;
  const message = err instanceof Error ? `${err.name}: ${err.message}` : String(err);
  return new SourceError("internal", message);
}

export interface HttpOptions {
  timeoutMs?: number;
  /** Cap on the decoded body. */
  maxBytes?: number;
  attempts?: number;
  headers?: Record<string, string>;
  /** True when a 2xx body is the source's way of saying "nothing" (Bovada's `{}`). Retried. */
  isEmpty?: (body: unknown) => boolean;
}

export interface HttpDeps {
  fetch?: typeof fetch;
  sleep?: (ms: number) => Promise<void>;
  /** Base backoff in ms; attempt n waits n * backoffMs. */
  backoffMs?: number;
  allowedHosts?: ReadonlySet<string>;
}

export interface Http {
  getJson(url: string, options?: HttpOptions): Promise<unknown>;
  /** Raw bytes (release assets). Same allowlist, timeout, size cap and retries; no JSON parsing. */
  getBytes(url: string, options?: Omit<HttpOptions, "isEmpty">): Promise<Uint8Array>;
}

const RETRYABLE: ReadonlySet<IssueKind> = new Set(["network", "timeout", "empty-response"]);

export function createHttp(deps: HttpDeps = {}): Http {
  const doFetch = deps.fetch ?? fetch;
  const sleep = deps.sleep ?? ((ms) => new Promise<void>((r) => setTimeout(r, ms)));
  const backoffMs = deps.backoffMs ?? 1500;
  const allowed = deps.allowedHosts ?? ALLOWED_HOSTS;

  async function once(url: string, o: Required<Omit<HttpOptions, "isEmpty" | "headers">> & HttpOptions, binary = false) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), o.timeoutMs);
    try {
      let res: Response;
      try {
        res = await doFetch(url, {
          signal: controller.signal,
          redirect: "follow",
          headers: {
            accept: binary ? "application/octet-stream" : "application/json",
            "accept-encoding": "gzip",
            "user-agent": USER_AGENT,
            ...o.headers,
          },
        });
      } catch (err) {
        if (controller.signal.aborted) throw new SourceError("timeout", `No response within ${o.timeoutMs} ms: ${url}`);
        const cause = err instanceof Error && err.cause instanceof Error ? ` (${err.cause.message})` : "";
        throw new SourceError("network", `${err instanceof Error ? err.message : String(err)}${cause}: ${url}`);
      }
      const bytes = await readCapped(res, o.maxBytes, url, controller);
      if (!res.ok) {
        const payload = bytes.toString("utf8", 0, Math.min(bytes.length, 64_000));
        throw new SourceError("http-error", `HTTP ${res.status} from ${url}`, { httpStatus: res.status, payload });
      }
      if (binary) return new Uint8Array(bytes.buffer, bytes.byteOffset, bytes.byteLength);
      const text = bytes.toString("utf8");
      let body: unknown;
      try {
        body = JSON.parse(text);
      } catch {
        throw new SourceError("not-json", `Response is not JSON: ${url}`, { httpStatus: res.status, payload: text });
      }
      if (o.isEmpty?.(body)) {
        throw new SourceError("empty-response", `Empty response from ${url}`, { httpStatus: res.status, payload: text });
      }
      return body;
    } finally {
      clearTimeout(timer);
    }
  }

  async function withRetries<T>(url: string, options: HttpOptions, run: (o: Required<Omit<HttpOptions, "isEmpty" | "headers">> & HttpOptions) => Promise<T>): Promise<T> {
    const host = new URL(url).host;
    if (!allowed.has(host)) throw new SourceError("internal", `Host not on the allowlist: ${host}`);
    const o = { timeoutMs: 20_000, maxBytes: 5_000_000, attempts: 3, ...options };
    for (let attempt = 1; ; attempt++) {
      try {
        return await run(o);
      } catch (err) {
        const e = toSourceError(err);
        const retryable =
          RETRYABLE.has(e.kind) || (e.kind === "http-error" && (e.httpStatus! >= 500 || e.httpStatus === 429));
        if (!retryable || attempt >= o.attempts) throw e;
        await sleep(backoffMs * attempt);
      }
    }
  }

  return {
    getJson: (url, options = {}) => withRetries(url, options, (o) => once(url, o)),
    getBytes: (url, options = {}) => withRetries(url, options, (o) => once(url, o, true) as Promise<Uint8Array>),
  };
}

async function readCapped(res: Response, maxBytes: number, url: string, controller: AbortController): Promise<Buffer> {
  if (!res.body) return Buffer.alloc(0);
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    for await (const chunk of res.body as unknown as AsyncIterable<Uint8Array>) {
      size += chunk.byteLength;
      if (size > maxBytes) {
        controller.abort();
        throw new SourceError("too-large", `Response over ${maxBytes} bytes: ${url}`, { httpStatus: res.status });
      }
      chunks.push(chunk);
    }
  } catch (err) {
    if (err instanceof SourceError) throw err;
    if (controller.signal.aborted) throw new SourceError("timeout", `Body not received in time: ${url}`);
    throw new SourceError("network", `Connection lost while reading ${url}`);
  }
  return Buffer.concat(chunks);
}
