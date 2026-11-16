import type { SeriesSourceId } from "../../../../shared/ids.ts";

// The pure logic behind every time-series chart (plan 8.2): which sources get a tab,
// which one is shown, and how a line with missing points is drawn. No React here, so
// the rules that fix Dan's main complaint are unit tested.

export type Values = readonly (number | null)[];

/** Tab order. The default source for a chart is the first of these that has data. */
export const SOURCE_ORDER: readonly SeriesSourceId[] = ["consensus", "espn-fpi", "hub", "draftkings", "polymarket", "kalshi", "bovada"];

export interface SourceInfo {
  label: string;
  kind: "Median of markets" | "Forecast" | "Model" | "Betting market" | "Prediction market";
  about: string;
  /** How its numbers are made comparable. */
  values: string;
  /** Line color in compare-sources mode: [dark theme, light theme]. */
  color: readonly [string, string];
}

const DEVIG = "Prices for a complete group (all 32 teams, a conference, a division) are scaled to add up to 100%, which removes the bookmaker's margin. Incomplete groups and awards are shown as quoted.";

export const SOURCE_INFO: Record<SeriesSourceId, SourceInfo> = {
  consensus: { label: "Consensus", kind: "Median of markets", about: "The middle value of DraftKings, Polymarket, Kalshi and Bovada on each day, shown when at least two of them have a number.", values: "Computed by NFL Hub from the market tabs; it is not a quote from anyone.", color: ["#e8ebef", "#14181d"] },
  "espn-fpi": { label: "ESPN FPI", kind: "Forecast", about: "ESPN's Football Power Index: a team-strength model that simulates the rest of the season.", values: "ESPN's own percentages, unchanged.", color: ["#ff6b6b", "#c62a2f"] },
  hub: { label: "Hub Model", kind: "Model", about: "NFL Hub's own forecast: Elo ratings from results only, then 20,000 simulated seasons. It knows nothing about injuries or trades. Seasons before 2026 were computed afterwards from results known at the time.", values: "Simulation frequencies, unchanged.", color: ["#b79bff", "#6b3fd4"] },
  draftkings: { label: "DraftKings", kind: "Betting market", about: "DraftKings sportsbook futures, as listed by ESPN.", values: DEVIG, color: ["#6fd08c", "#18794e"] },
  polymarket: { label: "Polymarket", kind: "Prediction market", about: "Prices people are trading at on Polymarket.", values: DEVIG, color: ["#6aa9ff", "#0b5cad"] },
  kalshi: { label: "Kalshi", kind: "Prediction market", about: "Prices people are trading at on Kalshi (midpoint of the best bid and ask).", values: DEVIG, color: ["#4fd1c5", "#0b7588"] },
  bovada: { label: "Bovada", kind: "Betting market", about: "Bovada sportsbook futures. Its feed is often incomplete, so expect gaps.", values: DEVIG, color: ["#f1c04a", "#8a6100"] },
};

/** True when any value in [i0, i1] is present. */
export function hasData(values: Values, i0: number, i1: number): boolean {
  for (let i = Math.max(0, i0); i <= i1 && i < values.length; i++) if (values[i] != null) return true;
  return false;
}

/**
 * The sources that get a tab: those with at least one value in the visible range, in
 * tab order. A source with nothing to show never appears, so no tab can lead to an
 * empty chart and there is no "not available" state to design.
 */
export function sourcesWithData(bySource: Partial<Record<SeriesSourceId, readonly Values[]>>, i0: number, i1: number): SeriesSourceId[] {
  return SOURCE_ORDER.filter((id) => bySource[id]?.some((values) => hasData(values, i0, i1)));
}

/** The remembered source if it has a tab, else the first tab. Null only when there are no tabs. */
export function chooseSource(available: readonly SeriesSourceId[], remembered: string | undefined): SeriesSourceId | null {
  return available.find((id) => id === remembered) ?? available[0] ?? null;
}

/** First and last axis index inside [from, to] (ISO dates, either may be null for open). Null when none. */
export function rangeIndexes(dates: readonly string[], from: string | null, to: string | null): [number, number] | null {
  let i0 = -1;
  let i1 = -1;
  dates.forEach((d, i) => {
    if ((from === null || d >= from) && (to === null || d <= to)) {
      if (i0 < 0) i0 = i;
      i1 = i;
    }
  });
  return i0 < 0 ? null : [i0, i1];
}

/** The axis index nearest to an ISO date (for keeping the hovered day across a resolution switch). */
export function nearestIndex(dates: readonly string[], date: string): number {
  let best = 0;
  let bestGap = Infinity;
  dates.forEach((d, i) => {
    const gap = Math.abs(Date.parse(d) - Date.parse(date));
    if (gap < bestGap) [best, bestGap] = [i, gap];
  });
  return best;
}

export type Point = readonly [index: number, value: number];

/**
 * A line split for drawing: `runs` are stretches of consecutive points (solid), and
 * `bridges` join the last point before a gap to the first after it (dashed), so a
 * missing day reads as "no data", never as a drop to zero.
 */
export function segments(values: Values, i0: number, i1: number): { runs: Point[][]; bridges: [Point, Point][] } {
  const runs: Point[][] = [];
  const bridges: [Point, Point][] = [];
  let run: Point[] = [];
  let last: Point | null = null;
  for (let i = Math.max(0, i0); i <= i1 && i < values.length; i++) {
    const v = values[i];
    if (v == null) {
      if (run.length) runs.push(run);
      run = [];
      continue;
    }
    const point: Point = [i, v];
    if (!run.length && last) bridges.push([last, point]);
    run.push(point);
    last = point;
  }
  if (run.length) runs.push(run);
  return { runs, bridges };
}

/** The last present value at or before index i within the range, with its index. */
export function lastValue(values: Values, i0: number, i1: number): Point | null {
  for (let i = Math.min(i1, values.length - 1); i >= Math.max(0, i0); i--) {
    const v = values[i];
    if (v != null) return [i, v];
  }
  return null;
}

/** Days a source may lag the chart's latest date before its tab says "stale since" (plan 7.4). */
export const STALE_AFTER_DAYS = 3;

/** "Stale since" date: the source's last value is more than STALE_AFTER_DAYS older than the axis's last date. */
export function staleSince(lastDate: string, axisLastDate: string): string | null {
  return Date.parse(axisLastDate) - Date.parse(lastDate) > STALE_AFTER_DAYS * 86_400_000 ? lastDate : null;
}

/** "Nov 9" for an ISO date, in the reader's locale. */
export const shortDate = (iso: string) => new Date(`${iso}T12:00:00Z`).toLocaleDateString(undefined, { month: "short", day: "numeric", timeZone: "UTC" });

/** Spread labels vertically so none overlap: positions are moved apart by at least `gap`, kept inside [min, max]. */
export function spreadLabels(ys: readonly number[], gap: number, min: number, max: number): number[] {
  const order = ys.map((y, i) => ({ y, i })).sort((a, b) => a.y - b.y);
  let prev = -Infinity;
  for (const o of order) {
    o.y = Math.max(o.y, prev + gap, min);
    prev = o.y;
  }
  let next = Infinity;
  for (const o of order.reverse()) {
    o.y = Math.min(o.y, next - gap, max);
    next = o.y;
  }
  const out: number[] = [];
  for (const o of order) out[o.i] = o.y;
  return out;
}
