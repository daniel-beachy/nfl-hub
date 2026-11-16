import { z } from "zod";
import { isoDate, isoDateTime, teamId } from "./snapshot.ts";

// Stat leaders: data/season/{season}/leaders.json, one file per season since 2020.
// Built by pipeline/leaders.ts (M1-8) from nflverse `stats_player` weekly rows, regular
// season only. Documented in docs/DATA-CONTRACT.md section 7.

export const LEADERS_SCHEMA_VERSION = 1;
export const LEADERS_TOP = 10;

/** Each category is one `stats_player` column summed over the regular season. */
export const LEADER_CATEGORIES = [
  { id: "passingYards", column: "passing_yards", label: "Passing yards", group: "Passing", decimals: 0 },
  { id: "passingTds", column: "passing_tds", label: "Passing TDs", group: "Passing", decimals: 0 },
  { id: "passingEpa", column: "passing_epa", label: "Passing EPA", group: "Passing", decimals: 1 },
  { id: "rushingYards", column: "rushing_yards", label: "Rushing yards", group: "Rushing", decimals: 0 },
  { id: "rushingTds", column: "rushing_tds", label: "Rushing TDs", group: "Rushing", decimals: 0 },
  { id: "rushingEpa", column: "rushing_epa", label: "Rushing EPA", group: "Rushing", decimals: 1 },
  { id: "receivingYards", column: "receiving_yards", label: "Receiving yards", group: "Receiving", decimals: 0 },
  { id: "receivingTds", column: "receiving_tds", label: "Receiving TDs", group: "Receiving", decimals: 0 },
  { id: "receptions", column: "receptions", label: "Receptions", group: "Receiving", decimals: 0 },
  { id: "receivingEpa", column: "receiving_epa", label: "Receiving EPA", group: "Receiving", decimals: 1 },
  { id: "sacks", column: "def_sacks", label: "Sacks", group: "Defense", decimals: 1 },
  { id: "interceptions", column: "def_interceptions", label: "Interceptions", group: "Defense", decimals: 0 },
] as const;
export type LeaderCategoryId = (typeof LEADER_CATEGORIES)[number]["id"];
const categoryIds = LEADER_CATEGORIES.map((c) => c.id) as [LeaderCategoryId, ...LeaderCategoryId[]];

export const leaderSchema = z.strictObject({
  /** nflverse gsis id. */
  playerId: z.string(),
  name: z.string(),
  /** Team of the player's latest game in the season; null if nflverse names a team we do not know. */
  team: teamId.nullable(),
  position: z.string().nullable(),
  headshot: z.string().nullable(),
  total: z.number(),
  /** Running total after each entry of the file's `weeks`. */
  cumulative: z.array(z.number()),
});
export type Leader = z.infer<typeof leaderSchema>;

export const seasonLeadersSchema = z
  .strictObject({
    schemaVersion: z.literal(LEADERS_SCHEMA_VERSION),
    season: z.number().int(),
    generatedAt: isoDateTime,
    /** The nflverse file the numbers came from. */
    sourceUpdatedAt: z.string(),
    /** Regular-season weeks with stats so far. */
    weeks: z.array(z.number().int().min(1)),
    /** The last game day of each week, aligned with `weeks`. */
    dates: z.array(isoDate),
    categories: z.record(z.enum(categoryIds), z.array(leaderSchema).max(LEADERS_TOP)),
  })
  .refine((s) => s.dates.length === s.weeks.length, { message: "dates must align with weeks", path: ["dates"] })
  .refine((s) => Object.values(s.categories).every((ls) => ls.every((l) => l.cumulative.length === s.weeks.length)), { message: "cumulative must align with weeks", path: ["categories"] });
export type SeasonLeaders = z.infer<typeof seasonLeadersSchema>;
