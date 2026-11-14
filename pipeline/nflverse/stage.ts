import { join } from "node:path";
import { seasonForDate } from "../../shared/ids.ts";
import { NFLVERSE_MANIFEST_VERSION, nflverseManifestSchema, type NflverseFile, type NflverseManifest } from "../../shared/nflverse.ts";
import { isMain, parseArgs, removeStaleTemps, REPO_ROOT, writeFileAtomic } from "../lib/files.ts";
import { createHttp, toSourceError, type Http } from "../lib/http.ts";
import { DATASET_IDS, DATASETS, type Dataset, type DatasetId } from "./datasets.ts";
import { ensureAsset, evictCached, listAssets, readCached, type Asset } from "./download.ts";
import { DatasetError, readRows, type Row } from "./read.ts";

// The nflverse stage (docs/PLAN.md 5.4): download what changed, load every file with its
// required columns, check it, and write derived/nflverse/manifest.json. Later stages
// (model, analytics, EP table) call `loadDataset` and build on the same cache.
//   npm run nflverse                               previous and current season
//   npm run nflverse -- --seasons 2020-2026        a range
//   npm run nflverse -- --datasets games,players   some datasets only
// Exits 1 when anything required fails, and then writes no manifest, so the last good one
// stays on the derived branch and health.ts opens a pipeline-broken issue.

export const CACHE_DIR = join(REPO_ROOT, "cache/nflverse");

export interface Loaded {
  file: NflverseFile;
  rows: Row[];
}

/** Ensure one asset is cached and current, then read `columns` from it. */
export async function loadDataset(
  http: Http,
  dataset: Dataset,
  season: number | null,
  columns: readonly string[],
  opts: { cacheDir?: string; assets?: Map<string, Asset> } = {},
): Promise<Loaded> {
  const name = dataset.file(season ?? 0);
  const assets = opts.assets ?? (await listAssets(http, dataset.tag));
  const asset = assets.get(name);
  if (!asset) throw new DatasetError(`${name} is not in the nflverse-data "${dataset.tag}" release`);
  const { path, meta } = await ensureAsset(http, opts.cacheDir ?? CACHE_DIR, dataset.tag, asset);
  let rows: Row[];
  try {
    rows = await readRows(readCached(path), columns, name);
  } catch (err) {
    // A file that cannot be parsed (not a missing column) is a bad cached copy: evict it so
    // the next run downloads it again instead of failing on it until nflverse rebuilds it.
    if (!(err instanceof DatasetError)) evictCached(path);
    throw err;
  }
  return { file: { dataset: dataset.id, season, name, updatedAt: meta.updatedAt, size: meta.size, rows: rows.length }, rows };
}

/** Problems with a loaded file beyond missing columns. Pure. Exported for tests. */
export function checkRows(dataset: Dataset, season: number | null, rows: Row[], currentSeason: number): string[] {
  const problems: string[] = [];
  const label = dataset.file(season ?? 0);
  if (rows.length === 0) return [`${label} has no rows`];
  if (season !== null) {
    const other = rows.find((r) => r.season !== season);
    if (other) problems.push(`${label} has a row for season ${String(other.season)}`);
  }
  if (dataset.id === "games") {
    const latest = Math.max(...rows.map((r) => Number(r.season)));
    if (!(latest >= currentSeason - 1)) problems.push(`games.parquet ends at season ${latest}`);
  }
  if (dataset.id === "players") {
    const withEspn = rows.filter((r) => r.espn_id !== null && r.espn_id !== "").length;
    if (rows.length < 5000 || withEspn < 1000) problems.push(`players.parquet looks thin: ${rows.length} rows, ${withEspn} with an espn_id`);
  }
  return problems;
}

/** "2020-2026" or "2025,2026". */
export function parseSeasons(text: string): number[] {
  const out = new Set<number>();
  for (const part of text.split(",")) {
    const [a, b] = part.split("-").map(Number);
    if (!Number.isInteger(a) || (b !== undefined && !Number.isInteger(b))) throw new Error(`Bad --seasons: ${text}`);
    for (let s = a!; s <= (b ?? a!); s++) out.add(s);
  }
  return [...out].sort((a, b) => a - b);
}

export interface StageOptions {
  http: Http;
  today: string;
  seasons: number[];
  datasets: readonly DatasetId[];
  cacheDir?: string;
  log?: (line: string) => void;
}

/** Runs the stage. Returns the manifest, or throws listing every problem found. */
export async function runStage(o: StageOptions): Promise<NflverseManifest> {
  const log = o.log ?? console.log;
  const temps = removeStaleTemps(o.cacheDir ?? CACHE_DIR);
  if (temps > 0) log(`  removed ${temps} partial download(s) left by an earlier run`);
  const current = seasonForDate(o.today);
  // nflverse publishes a season's files after its first games (early September).
  const inSeason = o.today >= `${current}-09-15`;
  const files: NflverseFile[] = [];
  const notPublished: string[] = [];
  const problems: string[] = [];

  for (const id of o.datasets) {
    const dataset = DATASETS[id];
    let assets: Map<string, Asset>;
    try {
      assets = await listAssets(o.http, dataset.tag);
    } catch (err) {
      problems.push(`listing release "${dataset.tag}": ${toSourceError(err).message}`);
      continue;
    }
    for (const season of dataset.perSeason ? o.seasons : [null]) {
      const name = dataset.file(season ?? 0);
      if (!assets.has(name) && season === current && !inSeason) {
        notPublished.push(name);
        log(`  not yet published: ${name}`);
        continue;
      }
      const started = Date.now();
      try {
        const { file, rows } = await loadDataset(o.http, dataset, season, dataset.required, { cacheDir: o.cacheDir, assets });
        const found = checkRows(dataset, season, rows, current);
        problems.push(...found);
        files.push(file);
        log(`  ${found.length ? "BAD" : "ok "} ${name}: ${file.rows} rows, updated ${file.updatedAt} (${Date.now() - started} ms)`);
      } catch (err) {
        const message = err instanceof DatasetError ? err.message : `${name}: ${toSourceError(err).message}`;
        problems.push(message);
        log(`  BAD ${message}`);
      }
    }
  }
  if (problems.length > 0) throw new DatasetError(`nflverse stage failed:\n- ${problems.join("\n- ")}`);
  return nflverseManifestSchema.parse({
    schemaVersion: NFLVERSE_MANIFEST_VERSION,
    generatedAt: new Date().toISOString(),
    seasons: o.seasons,
    files,
    notPublished,
  } satisfies NflverseManifest);
}

if (isMain(import.meta.url)) {
  const args = parseArgs(process.argv.slice(2));
  const today = new Date().toISOString().slice(0, 10);
  const current = seasonForDate(today);
  const seasons = typeof args.seasons === "string" ? parseSeasons(args.seasons) : [current - 1, current];
  const datasets = typeof args.datasets === "string" ? (args.datasets.split(",") as DatasetId[]) : DATASET_IDS;
  for (const d of datasets) if (!DATASET_IDS.includes(d)) throw new Error(`Unknown dataset "${d}". Known: ${DATASET_IDS.join(", ")}`);
  const out = join(REPO_ROOT, typeof args.out === "string" ? args.out : "derived", "nflverse/manifest.json");

  console.log(`nflverse: seasons ${seasons.join(", ")}; datasets ${datasets.join(", ")}`);
  try {
    const manifest = await runStage({ http: createHttp(), today, seasons, datasets });
    if (args["dry-run"]) console.log("Dry run: manifest not written.");
    else {
      writeFileAtomic(out, `${JSON.stringify(manifest, null, 1)}\n`);
      console.log(`Wrote ${out}`);
    }
  } catch (err) {
    console.error(err instanceof Error ? err.message : String(err));
    process.exitCode = 1;
  }
}
