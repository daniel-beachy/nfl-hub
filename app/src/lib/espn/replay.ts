import { parseSummary, type EspnDrive, type EspnSummary } from "./schemas.ts";
import { ESPN_BASE_URL, fetchJson, type LiveSource } from "./source.ts";

// The replay harness (plan 9.5): a finished game served through the same LiveSource
// interface as ESPN, as if it were being played now. Its clock starts a minute before
// the first play and runs `speed` times faster than real time; each request answers with
// the game as ESPN would have shown it at that moment: plays up to the clock, the score
// and state they imply, win probability for those plays only.
//
// What a final summary cannot give back: the box score as it stood mid-game (ESPN only
// sends the final one). The replay has no box score until the game is over. A recorded
// live sequence (scripts/record-live.ts) would not have that limit.

export interface ReplayOptions {
  /** Game seconds per real second. */
  speed: number;
  /** Start this many seconds after the first play instead of a minute before it. */
  from?: number;
  /** Real time, for tests. */
  realNow?: () => number;
}

/** The game as it stood at `at` (epoch ms), in ESPN's summary shape. */
export function summaryAt(full: EspnSummary, at: number): EspnSummary {
  const released = (d: EspnDrive) => d.plays.filter((p) => Date.parse(p.wallclock ?? "") <= at);
  const all = full.drives?.previous ?? [];
  const total = all.reduce((n, d) => n + d.plays.length, 0);
  const drives: EspnDrive[] = [];
  for (const d of all) {
    const plays = released(d);
    if (plays.length) drives.push({ ...d, plays });
  }
  const shown = drives.reduce((n, d) => n + d.plays.length, 0);
  const over = shown === total;
  const comp = full.header.competitions[0]!;
  if (over) return full;

  // The drive in progress has no result yet.
  const last = drives.at(-1);
  if (last) drives[drives.length - 1] = { id: last.id, team: last.team, plays: last.plays };
  const lastPlay = last?.plays.at(-1);
  const ids = new Set(drives.flatMap((d) => d.plays.map((p) => p.id)));
  return {
    header: {
      ...full.header,
      competitions: [
        {
          date: comp.date,
          competitors: comp.competitors.map((c) => ({ homeAway: c.homeAway, team: c.team, ...(lastPlay ? { score: String(c.homeAway === "home" ? lastPlay.homeScore : lastPlay.awayScore) } : {}) })),
          status: { type: { state: lastPlay ? "in" : "pre" } },
        },
      ],
    },
    ...(drives.length ? { drives: { previous: drives.slice(0, -1), current: drives.at(-1)! } } : {}),
    winprobability: full.winprobability.filter((p) => ids.has(p.playId)),
  };
}

/** A one-game scoreboard for the same moment, in ESPN's scoreboard shape. */
function scoreboardAt(full: EspnSummary, at: number) {
  const now = summaryAt(full, at);
  const comp = now.header.competitions[0]!;
  const lastPlay = (now.drives?.current ?? now.drives?.previous.at(-1))?.plays.at(-1);
  const gameState = comp.status.type.state;
  return {
    season: full.header.season,
    week: full.header.week === undefined ? undefined : { number: full.header.week },
    events: [
      {
        id: full.header.id,
        date: comp.date,
        competitions: [
          {
            competitors: comp.competitors,
            status: { displayClock: lastPlay?.clock.displayValue, period: lastPlay?.period.number, type: { state: gameState, shortDetail: gameState === "post" ? "Final" : undefined } },
          },
        ],
      },
    ],
  };
}

export function replaySource(raw: unknown, opts: ReplayOptions): LiveSource {
  const parsed = parseSummary(raw);
  if (!parsed.ok) throw new Error(`This game cannot be replayed (${parsed.error})`);
  const full = parsed.value;
  const times = (full.drives?.previous ?? []).flatMap((d) => d.plays.map((p) => Date.parse(p.wallclock ?? ""))).filter(Number.isFinite);
  if (!times.length) throw new Error("This game cannot be replayed (no plays with a time)");
  const realNow = opts.realNow ?? (() => Date.now());
  const speed = Math.min(Math.max(opts.speed, 1), 100_000);
  const start = Math.min(...times) + (opts.from === undefined ? -60_000 : opts.from * 1000);
  const t0 = realNow();
  const now = () => start + (realNow() - t0) * speed;
  return {
    now,
    speed,
    scoreboard: async () => scoreboardAt(full, now()),
    summary: async (eventId) => {
      if (eventId !== full.header.id) throw new Error("Only the replayed game is available in a replay");
      return summaryAt(full, now());
    },
  };
}

/** Fetches a finished game once and returns its replay. */
export async function loadReplay(eventId: string, opts: ReplayOptions, baseUrl: string = ESPN_BASE_URL): Promise<LiveSource> {
  return replaySource(await fetchJson(baseUrl, `/summary?event=${encodeURIComponent(eventId)}`), opts);
}
