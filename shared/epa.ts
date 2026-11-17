import { expectedPoints, TOUCHDOWN_VALUE, type EpTable } from "./ep.ts";

// Live EPA estimator (plan 9.4): expected points added per play, from the play states
// ESPN sends, using the EP table. An estimate, to be labeled "estimated" and replaced by
// nflverse's official EPA once that exists. Pure, and shared by the browser (live) and
// the pipeline (validation against official EPA).
//
// EPA = EP after - EP before, both from the point of view of the team on offense at the
// snap. The special cases:
// - Touchdown: +7 (or -7 when the defense scores), whatever happened on the try.
// - Field goal: +3. Safety: -2. No allowance for the kickoff that follows, as nflfastR.
// - Change of possession (punt, interception, fumble lost, downs, missed field goal):
//   minus the other team's EP where they take over.
// - Last play of a half without a score: EP after is 0.
// - Kneel-down: 0 by definition, and not counted as an offensive play.
// - Penalty with no play: EP after - EP before like any play, kind "penalty".
// - Kickoffs, extra points and two-point tries, timeouts and period markers: no EPA.

export interface EpaSpot {
  down: number | null;
  distance: number | null;
  yardsToEndzone: number | null;
  team: string | null;
}

/** The fields of a play the estimator reads. A `LivePlay` from the live client fits as it is. */
export interface EpaPlay {
  type: string;
  text: string;
  period: number;
  /** "14:20" */
  clock: string;
  /** Score after the play. */
  homeScore: number;
  awayScore: number;
  start: EpaSpot;
  end: EpaSpot;
}

export type PlayKind = "pass" | "rush" | "kick" | "penalty" | "kneel" | "none";

export interface PlayEpa {
  /** Null when the play has no EPA (see the list above) or ESPN's states are unusable. */
  epa: number | null;
  /** The team on offense at the snap. */
  offense: string | null;
  kind: PlayKind;
  /** True for the plays offensive efficiency is measured on: passes (with sacks and scrambles) and rushes. */
  counts: boolean;
  /** EPA above zero, the usual live definition of a successful play. Null when `counts` is false. */
  success: boolean | null;
}

const ADMIN = /timeout|end period|end of|two-minute|coin toss/i;
const TRY = /extra point|two.point|2pt/i;

export function classify(play: Pick<EpaPlay, "type" | "text">): PlayKind {
  const { type, text } = play;
  if (ADMIN.test(type) || /kickoff/i.test(type) || (TRY.test(type) && !/touchdown/i.test(type))) return "none";
  if (/punt|field goal/i.test(type)) return "kick";
  if (/kneel/i.test(text)) return "kneel";
  if (/^penalty$/i.test(type)) return "penalty";
  if (/pass|sack|interception/i.test(type) || /\b(pass|sacked|scrambles)\b/i.test(text)) return "pass";
  if (/rush/i.test(type) || /fumble/i.test(type)) return "rush";
  return "none";
}

/** Seconds left in the half (or overtime period) at the snap. */
export function secondsLeftInHalf(period: number, clock: string): number {
  const [m, s] = clock.split(":").map(Number);
  const inPeriod = (Number.isFinite(m) ? m! : 0) * 60 + (Number.isFinite(s) ? s! : 0);
  return period === 1 || period === 3 ? inPeriod + 900 : inPeriod;
}

const halfOf = (period: number) => (period <= 2 ? 1 : period <= 4 ? 2 : period);

function ep(table: EpTable, spot: EpaSpot, seconds: number): number | null {
  if (spot.down === null || spot.down < 1 || spot.down > 4 || spot.yardsToEndzone === null || spot.yardsToEndzone < 1 || spot.yardsToEndzone > 99) return null;
  return expectedPoints(table, { down: spot.down, distance: spot.distance ?? 10, yardsToEndzone: spot.yardsToEndzone, secondsLeftInHalf: seconds });
}

/**
 * EPA for every play of a game, in order. `plays` may be the delayed, visible part of a
 * game: each play only looks at the one before it (for the score) and the ones after it
 * (to know the half ended), and a later play can only change the last play of a half.
 */
export function estimateEpa(plays: readonly EpaPlay[], home: string, table: EpTable): PlayEpa[] {
  return plays.map((play, i) => {
    const kind = classify(play);
    const offense = play.start.team;
    const counts = kind === "pass" || kind === "rush";
    const none: PlayEpa = { epa: null, offense, kind, counts: false, success: null };
    if (kind === "none" || offense === null) return none;
    if (kind === "kneel") return { ...none, epa: 0 };

    const seconds = secondsLeftInHalf(play.period, play.clock);
    const before = ep(table, play.start, seconds);
    if (before === null) return none;

    const prev = plays[i - 1];
    const homePoints = play.homeScore - (prev?.homeScore ?? 0);
    const awayPoints = play.awayScore - (prev?.awayScore ?? 0);
    let after: number | null;
    if (homePoints > 0 || awayPoints > 0) {
      const points = Math.max(homePoints, awayPoints);
      const byOffense = (homePoints > 0) === (offense === home);
      // 6, 7 or 8 is a touchdown with its try; 3 a field goal; 2 a safety.
      after = (byOffense ? 1 : -1) * (points >= 6 ? TOUCHDOWN_VALUE : points);
    } else {
      // Did the half end on this play? Look past timeouts for the next real play.
      let next = i + 1;
      while (next < plays.length && classify(plays[next]!) === "none" && !/end of (half|game)/i.test(plays[next]!.type) && halfOf(plays[next]!.period) === halfOf(play.period)) next++;
      const following = plays[next];
      const halfOver = following !== undefined && (/end of (half|game)/i.test(following.type) || halfOf(following.period) !== halfOf(play.period));
      if (halfOver) after = 0;
      else {
        // The clock after the play is not known; the snap's is close enough for the late-half flag.
        const then = ep(table, play.end, seconds);
        after = then === null || play.end.team === null ? null : play.end.team === offense ? then : -then;
      }
    }
    if (after === null) return none;
    const epa = after - before;
    return { epa, offense, kind, counts, success: counts ? epa > 0 : null };
  });
}

export interface TeamEpa {
  plays: number;
  epa: number;
  epaPerPlay: number | null;
  successRate: number | null;
}

/** Offensive totals for one team over the plays that count, optionally only passes or rushes. */
export function teamEpa(results: readonly PlayEpa[], team: string, kind?: "pass" | "rush"): TeamEpa {
  const own = results.filter((r) => r.counts && r.epa !== null && r.offense === team && (!kind || r.kind === kind));
  const epa = own.reduce((sum, r) => sum + r.epa!, 0);
  return { plays: own.length, epa, epaPerPlay: own.length ? epa / own.length : null, successRate: own.length ? own.filter((r) => r.success).length / own.length : null };
}
