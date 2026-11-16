import { normalizeScoreboard, normalizeSummary, type LiveGame, type LiveSlate } from "./game.ts";
import { browserEnv, Poller, type PollerEnv } from "./poller.ts";
import { parseScoreboard, parseSummary } from "./schemas.ts";
import type { LiveSource } from "./source.ts";

// The live data client (plan 9.2). It polls the scoreboard always and one game's summary
// while that game is open, validates every response, and keeps the last good copy of
// each. A response that fails is dropped: the data on screen stays, and `health` says
// ESPN is not responding (plan 7.4).

export const SCOREBOARD_LIVE_MS = 15_000;
export const SCOREBOARD_IDLE_MS = 5 * 60_000;
export const SUMMARY_MS = 10_000;

export interface Health {
  /** "loading": nothing yet. "retrying": the last attempt failed; any data shown is older. */
  status: "loading" | "ok" | "retrying";
  lastOkAt: number | null;
  failures: number;
  error: string | null;
}

export interface FeedState {
  slate: LiveSlate | null;
  slateHealth: Health;
  gameId: string | null;
  game: LiveGame | null;
  gameHealth: Health;
}

const FRESH: Health = { status: "loading", lastOkAt: null, failures: 0, error: null };

function failed(h: Health, err: unknown): Health {
  return { status: "retrying", lastOkAt: h.lastOkAt, failures: h.failures + 1, error: err instanceof Error ? err.message : String(err) };
}

export class LiveFeed {
  readonly source: LiveSource;
  private state: FeedState = { slate: null, slateHealth: FRESH, gameId: null, game: null, gameHealth: FRESH };
  private listeners = new Set<() => void>();
  private slatePoller: Poller;
  private gamePoller: Poller;
  private gameAbort: AbortController | null = null;
  private firstSeen = new Map<string, number>();

  constructor(source: LiveSource, env: PollerEnv = browserEnv) {
    this.source = source;
    this.slatePoller = new Poller(() => this.fetchSlate(), () => this.scaled(this.slateInterval()), env);
    this.gamePoller = new Poller(() => this.fetchGame(), () => this.scaled(this.gameInterval()), env);
  }

  getState = (): FeedState => this.state;

  subscribe = (fn: () => void): (() => void) => {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  };

  start(): void {
    this.slatePoller.start();
    if (this.state.gameId) this.gamePoller.start();
  }

  stop(): void {
    this.slatePoller.stop();
    this.gamePoller.stop();
    this.gameAbort?.abort();
  }

  /** Choose the game whose summary is polled, or null for none. */
  openGame(id: string | null): void {
    if (id === this.state.gameId) return;
    this.gameAbort?.abort();
    this.firstSeen = new Map();
    this.set({ gameId: id, game: null, gameHealth: FRESH });
    this.gamePoller.stop();
    if (id) this.gamePoller.start();
  }

  protected set(patch: Partial<FeedState>): void {
    this.state = { ...this.state, ...patch };
    this.listeners.forEach((fn) => fn());
  }

  private scaled(ms: number | null): number | null {
    return ms === null ? null : Math.max(250, ms / this.source.speed);
  }

  private slateInterval(): number {
    const games = this.state.slate?.games ?? [];
    if (games.some((g) => g.state === "in")) return SCOREBOARD_LIVE_MS;
    // Nothing live: check again at the next kickoff, and at least every five minutes.
    const now = this.source.now();
    const untilKickoff = Math.min(...games.filter((g) => g.state === "pre").map((g) => g.kickoff - now));
    return Math.min(SCOREBOARD_IDLE_MS, Math.max(SCOREBOARD_LIVE_MS, untilKickoff));
  }

  private gameInterval(): number | null {
    const game = this.state.game;
    if (!game || game.state === "in") return SUMMARY_MS;
    if (game.state === "post") return null;
    return Math.min(SCOREBOARD_IDLE_MS, Math.max(SUMMARY_MS, game.kickoff - this.source.now()));
  }

  private async fetchSlate(): Promise<void> {
    try {
      const raw = await this.source.scoreboard();
      const parsed = parseScoreboard(raw);
      if (!parsed.ok) throw new Error(`Unexpected scoreboard (${parsed.error})`);
      const slate = normalizeScoreboard(parsed.value, this.source.now(), parsed.dropped);
      // A scoreboard that lost every game it had a moment ago is a bad answer, not news.
      if (slate.games.length === 0 && slate.dropped > 0) throw new Error("Unexpected scoreboard (no readable games)");
      this.set({ slate, slateHealth: { status: "ok", lastOkAt: slate.fetchedAt, failures: 0, error: null } });
    } catch (err) {
      this.set({ slateHealth: failed(this.state.slateHealth, err) });
      throw err;
    }
  }

  private async fetchGame(): Promise<void> {
    const id = this.state.gameId;
    if (!id) return;
    const abort = (this.gameAbort = new AbortController());
    try {
      const raw = await this.source.summary(id, abort.signal);
      if (abort.signal.aborted) return;
      const parsed = parseSummary(raw);
      if (!parsed.ok) throw new Error(`Unexpected game data (${parsed.error})`);
      if (parsed.value.header.id !== id) throw new Error("ESPN answered with a different game");
      const game = normalizeSummary(parsed.value, this.source.now(), parsed.dropped, this.firstSeen);
      if (!game) throw new Error("Unexpected game data (teams or start time unreadable)");
      // Plays only ever accumulate. A copy with far fewer than the one we hold is a bad answer.
      const held = this.state.game;
      if (held && game.plays.length < held.plays.length - 5) throw new Error("ESPN answered with an older copy of the game");
      this.set({ game, gameHealth: { status: "ok", lastOkAt: game.fetchedAt, failures: 0, error: null } });
    } catch (err) {
      // The user moved to another game while this was in flight: not a failure.
      if (abort.signal.aborted) return;
      this.set({ gameHealth: failed(this.state.gameHealth, err) });
      throw err;
    }
  }
}
