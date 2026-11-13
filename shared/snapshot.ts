import { z } from "zod";
import { AWARD_MARKETS, GAMES_PER_TEAM, SOURCE_IDS, TEAM_METRICS } from "./ids.ts";
import { TEAM_IDS } from "./teams.ts";

// The daily snapshot file: data/snapshots/{season}/{YYYY-MM-DD}.json.
// Documented in docs/DATA-CONTRACT.md section 2. Change both together.

export const SNAPSHOT_SCHEMA_VERSION = 1;

export const isoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "expected YYYY-MM-DD");
export const isoDateTime = z.iso.datetime();
export const teamId = z.enum(TEAM_IDS);
export const sourceId = z.enum(SOURCE_IDS);
export const probability = z.number().min(0).max(1);

/** Why a source is not `ok`. `kind` is what the runbook is indexed by. */
export const ISSUE_KINDS = [
  "network", // DNS, connection reset, TLS
  "timeout",
  "http-error", // non-2xx after retries
  "empty-response", // 2xx but the source's own "nothing here" body
  "too-large",
  "not-json",
  "schema-drift", // the provider changed shape; `detail` holds the zod path
  "season-mismatch", // the provider is serving another season
  "market-missing", // an expected market or metric was not found
  "unknown-name", // a team or market name we could not map
  "team-coverage", // fewer teams than expected for a metric
  "out-of-range",
  "bad-sum", // a complete group's probabilities do not sum close to 1
  "all-zero",
  "internal", // a bug on our side
] as const;
export type IssueKind = (typeof ISSUE_KINDS)[number];

export const PAYLOAD_HEAD_BYTES = 2048;

export const issueSchema = z.strictObject({
  kind: z.enum(ISSUE_KINDS),
  message: z.string(),
  httpStatus: z.number().int().nullable(),
  /** Machine-oriented extra: zod path, metric, group. */
  detail: z.string().optional(),
  /** Start of the raw response, when the response itself was the problem. */
  payloadHead: z.string().max(PAYLOAD_HEAD_BYTES).optional(),
});
export type Issue = z.infer<typeof issueSchema>;

/** One team's values from one source. A metric the source does not offer is absent. */
export const teamValuesSchema = z.strictObject({
  superBowl: probability.optional(),
  conference: probability.optional(),
  division: probability.optional(),
  playoffs: probability.optional(),
  wins: z.number().min(0).max(GAMES_PER_TEAM).optional(),
  seed1: probability.optional(),
});
export type TeamValues = z.infer<typeof teamValuesSchema>;

export const AWARD_CANDIDATE_CAP = 25;

export const awardCandidateSchema = z.strictObject({
  /** nflverse gsis_id, or null when the candidate could not be matched. */
  playerId: z.string().nullable(),
  name: z.string().min(1),
  team: teamId.nullable(),
  /** Raw implied probability. Award markets are never de-vigged. */
  prob: probability,
});
export type AwardCandidate = z.infer<typeof awardCandidateSchema>;

export const SOURCE_STATUSES = ["ok", "partial", "error"] as const;
export type SourceStatus = (typeof SOURCE_STATUSES)[number];

export const coverageKey = z.enum([...TEAM_METRICS, ...AWARD_MARKETS]);

export const sourceBlockSchema = z
  .strictObject({
    status: z.enum(SOURCE_STATUSES),
    fetchedAt: isoDateTime,
    /** When the provider says the values are from, if it says. */
    observedAt: isoDateTime.nullable(),
    durationMs: z.number().int().min(0),
    /** The main reason the block is not ok. Null exactly when status is ok. */
    error: issueSchema.nullable(),
    /** Everything the checks found, including what did not change the status. */
    issues: z.array(issueSchema),
    teams: z.partialRecord(teamId, teamValuesSchema),
    awards: z.partialRecord(z.enum(AWARD_MARKETS), z.array(awardCandidateSchema).max(AWARD_CANDIDATE_CAP)),
    /** Teams with a value per metric, candidates per award market. */
    coverage: z.partialRecord(coverageKey, z.number().int().min(0)),
    /** Pre-normalization sums per group, e.g. "superBowlSum", "divisionSum.AFC East". */
    raw: z.record(z.string(), z.number()),
  })
  .refine((b) => (b.status === "ok") === (b.error === null), {
    message: "error must be null exactly when status is ok",
    path: ["error"],
  });
export type SourceBlock = z.infer<typeof sourceBlockSchema>;

export const SEASON_PHASES = ["preseason", "regular", "postseason", "offseason"] as const;

export const snapshotContextSchema = z.strictObject({
  phase: z.enum(SEASON_PHASES),
  /** Last regular-season week with every game final. Null outside the regular season. */
  lastCompletedWeek: z.number().int().min(0).nullable(),
  gamesInProgress: z.boolean(),
});
export type SnapshotContext = z.infer<typeof snapshotContextSchema>;

export const snapshotSchema = z.strictObject({
  schemaVersion: z.literal(SNAPSHOT_SCHEMA_VERSION),
  season: z.number().int().min(2020),
  date: isoDate,
  /** First write of this file. Each source block carries its own fetchedAt. */
  capturedAt: isoDateTime,
  /** Null when the schedule lookup failed; we do not guess. */
  context: snapshotContextSchema.nullable(),
  sources: z.partialRecord(sourceId, sourceBlockSchema),
});
export type Snapshot = z.infer<typeof snapshotSchema>;

export function snapshotPath(season: number, date: string): string {
  return `data/snapshots/${season}/${date}.json`;
}
