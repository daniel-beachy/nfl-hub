import type { LiveBox, LiveDrive, LiveGame, LivePlay, LiveSlate, SlateGame, Spot } from "./game.ts";

// The spoiler delay (plan 9.3). Everything a Live page draws comes from `viewAt` or
// `slateAt`, which answer one question: what may a viewer whose TV is `delay` behind see
// right now? Pages must not read a LiveGame or LiveSlate themselves.
//
// A game is cut by time: each play has a release time (`at`, from ESPN's wallclock), and
// the score, clock and situation are those of the last released play. The box score and
// the other games on the slate have no times inside them, so the feed keeps a short
// history of copies stamped with when they were fetched, and the viewer gets the newest
// copy fetched at or before the cutoff.

export const MAX_DELAY_SECONDS = 600;
/** No NFL game is still being played this long after kickoff. */
const SURELY_OVER_MS = 6 * 3600_000;

export interface Stamped<T> {
  at: number;
  value: T;
}

/** The moment the viewer has reached. With the delay off there is no cut at all (not "now": a slow device clock must not hide plays). */
export function cutoffFor(now: number, delaySeconds: number, delayOn: boolean): number {
  return delayOn && delaySeconds > 0 ? now - delaySeconds * 1000 : Infinity;
}

/**
 * Adds a copy to a history (oldest first). Content that did not change keeps its earlier
 * stamp. Copies too old to matter for any allowed delay are dropped, except the newest
 * of them, so there is always one that can be shown.
 */
export function remember<T>(history: Stamped<T>[], at: number, value: T): Stamped<T>[] {
  const last = history.at(-1);
  if (last && JSON.stringify(last.value) === JSON.stringify(value)) return history;
  const horizon = at - (MAX_DELAY_SECONDS + 60) * 1000;
  const firstKept = Math.max(0, history.findLastIndex((h) => h.at <= horizon));
  return [...history.slice(firstKept), { at, value }];
}

function newestAt<T>(history: Stamped<T>[], cutoff: number): Stamped<T> | undefined {
  return history.findLast((h) => h.at <= cutoff);
}

export type BoxView = { state: "ok"; box: LiveBox } | { state: "none" } | { state: "syncing"; seconds: number };

export interface DriveView extends LiveDrive {
  /** False while the viewer is still inside this drive; its result is then withheld. */
  over: boolean;
  plays: LivePlay[];
}

export interface GameView {
  id: string;
  home: LiveGame["home"];
  away: LiveGame["away"];
  kickoff: number;
  status: "pre" | "in" | "final";
  /** Null only when ESPN has a game under way but no plays to tell the score from. */
  score: { home: number; away: number } | null;
  /** Of the last play seen, not a running clock. */
  period: number | null;
  clock: string | null;
  /** Where the next play starts. Null before kickoff and after the end. */
  situation: Spot | null;
  plays: LivePlay[];
  drives: DriveView[];
  box: BoxView;
  /** Items ESPN sent that could not be read. */
  dropped: number;
}

export function viewAt(game: LiveGame, cutoff: number, boxHistory: Stamped<LiveBox | null>[] = []): GameView {
  const plays = game.plays.filter((p) => p.at <= cutoff);
  const all = plays.length === game.plays.length;
  const last = plays.at(-1);
  const base = { id: game.id, home: game.home, away: game.away, kickoff: game.kickoff, dropped: game.dropped };

  if (!last) {
    // No play to go by. Either it has not started (for ESPN or for this viewer), or ESPN
    // has no plays for it; then its own word is only safe once the game is surely over.
    const trustHeader = game.plays.length === 0 && game.state !== "pre" && game.kickoff + SURELY_OVER_MS <= Math.min(cutoff, game.fetchedAt);
    const hidden = game.plays.length === 0 && game.state !== "pre" && !trustHeader;
    return {
      ...base,
      status: trustHeader ? (game.state === "post" ? "final" : "in") : hidden ? "in" : "pre",
      score: trustHeader ? game.score : hidden ? null : { home: 0, away: 0 },
      period: null,
      clock: null,
      situation: null,
      plays: [],
      drives: [],
      box: trustHeader && game.box ? { state: "ok", box: game.box } : { state: "none" },
    };
  }

  const final = all && game.state === "post";
  const drives: DriveView[] = [];
  for (const d of game.drives) {
    const own = plays.filter((p) => p.driveId === d.id);
    if (own.length) drives.push({ ...d, plays: own, over: true });
  }
  const open = drives.at(-1);
  if (open && !final) Object.assign(open, { over: false, result: null, description: null, isScore: false });

  let box: BoxView;
  if (final || cutoff === Infinity) box = game.box ? { state: "ok", box: game.box } : { state: "none" };
  else {
    const copy = newestAt(boxHistory, cutoff);
    if (copy) box = copy.value ? { state: "ok", box: copy.value } : { state: "none" };
    else {
      const first = boxHistory[0];
      box = first ? { state: "syncing", seconds: Math.max(1, Math.ceil((first.at - cutoff) / 1000)) } : { state: "none" };
    }
  }

  return {
    ...base,
    status: final ? "final" : "in",
    score: { home: last.homeScore, away: last.awayScore },
    period: last.period,
    clock: last.clock,
    situation: final ? null : last.end,
    plays,
    drives,
    box,
  };
}

export interface SlateGameView extends SlateGame {
  /** True while no copy old enough exists yet: score, clock and state are withheld. */
  syncing: boolean;
}

export interface SlateView {
  season: number | null;
  week: number | null;
  games: SlateGameView[];
  /** Seconds until the withheld games can be shown; null when none is withheld. */
  syncingSeconds: number | null;
}

export function slateAt(history: Stamped<LiveSlate>[], cutoff: number): SlateView | null {
  const newest = history.at(-1)?.value;
  if (!newest) return null;
  const old = cutoff === Infinity ? newest : newestAt(history, cutoff)?.value;
  let syncing = false;
  const games = newest.games.map((g): SlateGameView => {
    const then = old?.games.find((o) => o.id === g.id);
    if (then) return { ...then, syncing: false };
    // No copy from the viewer's moment. A game that has not started, or is long over, gives nothing away.
    if (g.state === "pre" || g.kickoff + SURELY_OVER_MS <= cutoff) return { ...g, syncing: false };
    syncing = true;
    return { id: g.id, kickoff: g.kickoff, home: g.home, away: g.away, state: "in", score: null, period: null, clock: null, detail: null, situation: null, syncing: true };
  });
  return { season: newest.season, week: newest.week, games, syncingSeconds: syncing ? Math.max(1, Math.ceil((history[0]!.at - cutoff) / 1000)) : null };
}

/** For "Sync to my TV": the delay that makes `play` the newest one visible right now. */
export function delayToShow(play: LivePlay, now: number): number {
  return Math.min(MAX_DELAY_SECONDS, Math.max(0, Math.round((now - play.at) / 1000)));
}
