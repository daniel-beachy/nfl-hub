import { z } from "zod";
import type { SnapshotContext } from "../shared/snapshot.ts";
import type { Http } from "./lib/http.ts";

// Where the season stands when a snapshot is taken, from ESPN's scoreboard.

export const REGULAR_SEASON_WEEKS = 18;

export const scoreboardSchema = z.object({
  season: z.object({ year: z.number(), type: z.number() }),
  week: z.object({ number: z.number() }),
  events: z.array(z.object({ status: z.object({ type: z.object({ state: z.string(), completed: z.boolean() }) }) })),
});

const PHASES: Record<number, SnapshotContext["phase"]> = { 1: "preseason", 2: "regular", 3: "postseason", 4: "offseason" };

/** Pure. Returns null when the payload cannot tell us (unknown season type). */
export function contextFromScoreboard(raw: unknown, season: number): SnapshotContext | null {
  const board = scoreboardSchema.parse(raw);
  // ESPN keeps showing the old season for a while after the league year turns over.
  if (board.season.year !== season) return { phase: "offseason", lastCompletedWeek: null, gamesInProgress: false };
  const phase = PHASES[board.season.type];
  if (!phase) return null;
  const gamesInProgress = board.events.some((e) => e.status.type.state === "in");
  let lastCompletedWeek: number | null = null;
  if (phase === "regular") {
    const weekDone = board.events.length > 0 && board.events.every((e) => e.status.type.completed);
    lastCompletedWeek = weekDone ? board.week.number : board.week.number - 1;
  } else if (phase === "postseason") {
    lastCompletedWeek = REGULAR_SEASON_WEEKS;
  }
  return { phase, lastCompletedWeek, gamesInProgress };
}

/** Never throws: context is nice to have, and a snapshot without it is still a snapshot. */
export async function fetchContext(http: Http, season: number): Promise<SnapshotContext | null> {
  try {
    return contextFromScoreboard(await http.getJson("https://site.api.espn.com/apis/site/v2/sports/football/nfl/scoreboard"), season);
  } catch {
    return null;
  }
}
