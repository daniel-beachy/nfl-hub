// Where live data comes from. The feed only knows this interface, so the real ESPN API
// and the replay harness (replay.ts, plan 9.5) are interchangeable, and a proxy can be
// added later by changing one base URL (plan 3, "Worker later").

export interface LiveSource {
  /** The feed's clock, epoch ms. Real time for ESPN; game time, possibly sped up, in a replay. */
  now(): number;
  /** How fast `now()` runs against real time. 1 for ESPN. Polling intervals are divided by it. */
  speed: number;
  /** Raw, unvalidated responses. Reject on any failure. */
  scoreboard(signal?: AbortSignal): Promise<unknown>;
  summary(eventId: string, signal?: AbortSignal): Promise<unknown>;
}

export const ESPN_BASE_URL: string = import.meta.env?.VITE_LIVE_BASE_URL ?? "https://site.api.espn.com/apis/site/v2/sports/football/nfl";

export class LiveFetchError extends Error {
  kind: "network" | "timeout" | "http" | "not-json";
  constructor(kind: LiveFetchError["kind"], message: string) {
    super(message);
    this.kind = kind;
  }
}

/** The one place the app makes a live request. No retries here: the poller decides when to try again. */
export async function fetchJson(baseUrl: string, path: string, opts: { signal?: AbortSignal; timeoutMs?: number; fetch?: typeof fetch } = {}): Promise<unknown> {
  const timeout = AbortSignal.timeout(opts.timeoutMs ?? 12_000);
  const signal = opts.signal ? AbortSignal.any([opts.signal, timeout]) : timeout;
  let res: Response;
  try {
    res = await (opts.fetch ?? fetch)(`${baseUrl}${path}`, { signal, cache: "no-store" });
  } catch (err) {
    if (timeout.aborted) throw new LiveFetchError("timeout", "No answer in time");
    throw new LiveFetchError("network", err instanceof Error ? err.message : String(err));
  }
  if (!res.ok) throw new LiveFetchError("http", `HTTP ${res.status}`);
  try {
    return (await res.json()) as unknown;
  } catch {
    throw new LiveFetchError("not-json", "The answer was not JSON");
  }
}

export function espnSource(baseUrl: string = ESPN_BASE_URL): LiveSource {
  return {
    now: () => Date.now(),
    speed: 1,
    scoreboard: (signal) => fetchJson(baseUrl, "/scoreboard", { signal }),
    summary: (eventId, signal) => fetchJson(baseUrl, `/summary?event=${encodeURIComponent(eventId)}`, { signal }),
  };
}
