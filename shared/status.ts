import { z } from "zod";
import { SOURCE_KINDS, SOURCE_TIERS } from "./ids.ts";
import { coverageKey, isoDate, isoDateTime, issueSchema, sourceId } from "./snapshot.ts";

// status.json: what the status page and a fixing session read first.
// Built by pipeline/health.ts. Documented in docs/DATA-CONTRACT.md section 4.

export const STATUS_SCHEMA_VERSION = 1;

/** `missing`: the latest snapshot has no block for this source at all. */
export const sourceHealthSchema = z.strictObject({
  id: sourceId,
  name: z.string(),
  kind: z.enum(SOURCE_KINDS),
  tier: z.enum(SOURCE_TIERS),
  status: z.enum(["ok", "partial", "error", "missing"]),
  /** Date of the last snapshot where this source was ok. Null if never. */
  lastOk: isoDate.nullable(),
  /** Consecutive snapshot days, ending today, on which the source was not ok. */
  consecutiveFailures: z.number().int().min(0),
  error: issueSchema.nullable(),
  coverage: z.partialRecord(coverageKey, z.number().int().min(0)),
  /** Open GitHub issue number, if one is open for this source. */
  issue: z.number().int().nullable(),
});
export type SourceHealth = z.infer<typeof sourceHealthSchema>;

export const stageHealthSchema = z.strictObject({
  id: z.string(),
  status: z.enum(["ok", "error", "stale"]),
  lastOk: isoDateTime.nullable(),
  detail: z.string(),
  issue: z.number().int().nullable(),
});
export type StageHealth = z.infer<typeof stageHealthSchema>;

export const statusSchema = z.strictObject({
  schemaVersion: z.literal(STATUS_SCHEMA_VERSION),
  generatedAt: isoDateTime,
  /** ok: nothing wrong. degraded: something is, the site works. down: a core source or stage is failing. */
  overall: z.enum(["ok", "degraded", "down"]),
  season: z.number().int(),
  sources: z.array(sourceHealthSchema),
  stages: z.array(stageHealthSchema),
  /** Latest date each kind of data covers. Null when there is none yet. */
  dataFreshness: z.record(z.string(), isoDate.nullable()),
  /** Link to the workflow run that produced this file, when run in Actions. */
  runUrl: z.string().nullable(),
});
export type Status = z.infer<typeof statusSchema>;
