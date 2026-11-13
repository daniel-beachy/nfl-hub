import { z } from "zod";
import { AWARD_MARKETS, SERIES_SOURCE_IDS, TEAM_METRICS } from "./ids.ts";
import { isoDate, isoDateTime, teamId } from "./snapshot.ts";

// Compiled, chart-ready series: data/season/{season}/series.json (daily axis) and
// weekly.json (one point per completed week). Built by pipeline/compile.ts (M1-4).
// Documented in docs/DATA-CONTRACT.md section 3.

export const SERIES_SCHEMA_VERSION = 1;

/** Values aligned to the file's axis; null where the source has nothing for that point. */
const values = z.array(z.number().nullable());

export const availabilitySchema = z.strictObject({
  firstDate: isoDate,
  lastDate: isoDate,
  daysMissingInLast7: z.number().int().min(0).max(7),
});

export const teamSeriesSchema = z.strictObject({
  availability: availabilitySchema,
  teams: z.partialRecord(teamId, values),
});

export const awardSeriesSchema = z.strictObject({
  availability: availabilitySchema,
  candidates: z.array(
    z.strictObject({ playerId: z.string().nullable(), name: z.string(), team: teamId.nullable(), values }),
  ),
});

const seriesSource = z.enum(SERIES_SOURCE_IDS);

export const seasonSeriesSchema = z
  .strictObject({
    schemaVersion: z.literal(SERIES_SCHEMA_VERSION),
    season: z.number().int(),
    generatedAt: isoDateTime,
    resolution: z.enum(["daily", "weekly"]),
    /** The shared x axis. Weekly files use the date of the first snapshot after the week ended. */
    dates: z.array(isoDate),
    /** Weekly files only: the week number for each axis point. */
    weeks: z.array(z.number().int()).optional(),
    /** Only sources with at least one value appear, so a tab exists exactly when there is data. */
    metrics: z.partialRecord(z.enum(TEAM_METRICS), z.partialRecord(seriesSource, teamSeriesSchema)),
    awards: z.partialRecord(z.enum(AWARD_MARKETS), z.partialRecord(seriesSource, awardSeriesSchema)),
  })
  .refine((s) => s.weeks === undefined || s.weeks.length === s.dates.length, {
    message: "weeks must align with dates",
    path: ["weeks"],
  });
export type SeasonSeries = z.infer<typeof seasonSeriesSchema>;
