import { z } from "zod";

// derived/nflverse/manifest.json: what the nflverse stage loaded in its last good run.
// Written by pipeline/nflverse/stage.ts, read by health.ts. docs/DATA-CONTRACT.md section 5.

export const NFLVERSE_MANIFEST_VERSION = 1;

export const nflverseFileSchema = z.strictObject({
  dataset: z.string(),
  /** Null for files that cover every season (games, players). */
  season: z.number().int().nullable(),
  /** Release asset name, e.g. play_by_play_2026.parquet. */
  name: z.string(),
  /** The asset's updated_at on GitHub: when nflverse last rebuilt it. */
  updatedAt: z.string(),
  size: z.number().int(),
  rows: z.number().int(),
});
export type NflverseFile = z.infer<typeof nflverseFileSchema>;

export const nflverseManifestSchema = z.strictObject({
  schemaVersion: z.literal(NFLVERSE_MANIFEST_VERSION),
  generatedAt: z.string(),
  seasons: z.array(z.number().int()),
  files: z.array(nflverseFileSchema),
  /** Current-season files nflverse has not published yet (normal before mid-September). */
  notPublished: z.array(z.string()),
});
export type NflverseManifest = z.infer<typeof nflverseManifestSchema>;
