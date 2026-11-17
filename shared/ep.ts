import { z } from "zod";

// The expected-points table behind live EPA (plan 9.4). Built by the pipeline from
// nflverse play-by-play (`pipeline/live-model/`), published as data/live/ep-table.json,
// read by the browser. Expected points are always from the offense's point of view.

/** A half is "late" at or under this many seconds left: drives then often end with the clock, not points. */
export const LATE_HALF_SECONDS = 120;
/** Yards-to-go buckets by their upper bound: 1-2, 3-6, 7-10, 11 or more. */
export const DISTANCE_BOUNDS = [2, 6, 10] as const;
export const DISTANCE_BUCKETS = DISTANCE_BOUNDS.length + 1;
export const TOUCHDOWN_VALUE = 7;

const row = z.array(z.number().min(-4).max(7)).length(99);

export const epTableSchema = z.object({
  schemaVersion: z.literal(1),
  builtAt: z.string(),
  /** First and last season of play-by-play used. */
  seasons: z.tuple([z.number(), z.number()]),
  plays: z.number(),
  /** ep[late ? 1 : 0][down - 1][distance bucket][yards to end zone - 1] */
  ep: z.array(z.array(z.array(row).length(DISTANCE_BUCKETS)).length(4)).length(2),
});
export type EpTable = z.infer<typeof epTableSchema>;

export function distanceBucket(distance: number): number {
  const i = DISTANCE_BOUNDS.findIndex((b) => distance <= b);
  return i === -1 ? DISTANCE_BOUNDS.length : i;
}

export interface EpState {
  down: number;
  distance: number;
  yardsToEndzone: number;
  secondsLeftInHalf: number;
}

/** Expected points for the offense in this state. Out-of-range values are clamped, never guessed around. */
export function expectedPoints(table: EpTable, s: EpState): number {
  const down = Math.min(4, Math.max(1, Math.round(s.down)));
  const yards = Math.min(99, Math.max(1, Math.round(s.yardsToEndzone)));
  const late = s.secondsLeftInHalf <= LATE_HALF_SECONDS ? 1 : 0;
  return table.ep[late]![down - 1]![distanceBucket(Math.max(1, s.distance))]![yards - 1]!;
}
