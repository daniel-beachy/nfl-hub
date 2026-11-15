import { z } from "zod";
import { GAMES_PER_TEAM } from "./ids.ts";
import { isoDate, isoDateTime, probability, teamId } from "./snapshot.ts";
import { TEAM_IDS } from "./teams.ts";

// The hub model's forecasts: data/model/{season}.json, one file per season since 2020.
// Written by pipeline/model/stage.ts (M1-2), read by pipeline/compile.ts.
// Documented in docs/DATA-CONTRACT.md section 6. Change both together.

export const MODEL_SCHEMA_VERSION = 1;

export const modelTeamSchema = z.strictObject({
  /** Elo rating after the games known at the point's date. */
  rating: z.number(),
  playoffs: probability,
  division: probability,
  seed1: probability,
  conference: probability,
  superBowl: probability,
  /** Mean final regular-season wins. */
  wins: z.number().min(0).max(GAMES_PER_TEAM),
});
export type ModelTeam = z.infer<typeof modelTeamSchema>;

const allTeams = <T extends z.ZodType>(value: T) =>
  z.record(teamId, value).refine((r) => TEAM_IDS.every((t) => t in r), { message: "every team must be present" });

export const modelPointSchema = z.strictObject({
  /**
   * The forecast uses exactly the games final before this date (`asOf` in forecast.ts): the
   * day after a game day, so it lines up with the snapshot captured the next morning. The
   * preseason point is dated the season's first game day and also stands for every earlier
   * date of the season, since nothing about the season is known before it.
   */
  date: isoDate,
  /** Week of the latest game counted (nflverse numbering; the postseason continues after the last regular week). 0 for preseason. */
  week: z.number().int().min(0),
  phase: z.enum(["preseason", "regular", "postseason"]),
  /** True on the point after the last game of `week` (and on the preseason point): the weekly view uses only these. */
  weekComplete: z.boolean(),
  gamesPlayed: z.number().int().min(0),
  gamesLeft: z.number().int().min(0),
  teams: allTeams(modelTeamSchema),
});
export type ModelPoint = z.infer<typeof modelPointSchema>;

export const modelGameSchema = z.strictObject({
  id: z.string(),
  week: z.number().int(),
  date: isoDate,
  home: teamId,
  away: teamId,
  homeWinProb: probability,
});

export const modelSeasonSchema = z.strictObject({
  schemaVersion: z.literal(MODEL_SCHEMA_VERSION),
  season: z.number().int(),
  generatedAt: isoDateTime,
  /** Simulated seasons per point, Elo parameters, and the input hash that decides when the file is recomputed. */
  sims: z.number().int().positive(),
  params: z.strictObject({ k: z.number(), hfa: z.number(), regress: z.number() }),
  inputHash: z.string(),
  /** The nflverse games file the forecasts came from. */
  gamesUpdatedAt: z.string(),
  /** Preseason first, then one point per game day whose games are all final, oldest first. */
  points: z.array(modelPointSchema).min(1),
  /**
   * The latest point in detail, while the season still has games to play; null once it is over.
   * `winDist[i]` is the chance of exactly i wins (0 to 17); `games` are the unplayed games with
   * the home team's chance from the latest ratings.
   */
  current: z
    .strictObject({
      date: isoDate,
      winDist: allTeams(z.array(probability).length(GAMES_PER_TEAM + 1)),
      games: z.array(modelGameSchema),
    })
    .nullable(),
});
export type ModelSeason = z.infer<typeof modelSeasonSchema>;
