import { readFileSync, rmSync, statSync } from "node:fs";
import { join } from "node:path";
import { z } from "zod";
import { readJsonIfExists, writeFileAtomic } from "../lib/files.ts";
import { SourceError, type Http } from "../lib/http.ts";

// Release assets with a local cache. An asset is downloaded only when its `updated_at` or
// size differs from the cached copy, so a daily run usually downloads only the current
// season's files. In Actions the cache directory is kept between runs with actions/cache.

const REPO = "nflverse/nflverse-data";
/** The largest asset we expect is a season of play-by-play parquet (about 20 MB). */
const MAX_ASSET_BYTES = 300_000_000;

const assetSchema = z.object({
  name: z.string(),
  size: z.number(),
  updated_at: z.string(),
  browser_download_url: z.string(),
});
const releaseSchema = z.object({ assets: z.array(assetSchema) });
export type Asset = z.infer<typeof assetSchema>;

const metaSchema = z.object({ name: z.string(), size: z.number(), updatedAt: z.string(), downloadedAt: z.string() });
export type CachedMeta = z.infer<typeof metaSchema>;

function apiHeaders(): Record<string, string> {
  // In Actions, the workflow token lifts the API limit from 60 to 1,000 requests an hour.
  const token = process.env.GITHUB_TOKEN;
  return { accept: "application/vnd.github+json", ...(token && { authorization: `Bearer ${token}` }) };
}

/** Every asset of one release, by name. One API request. */
export async function listAssets(http: Http, tag: string): Promise<Map<string, Asset>> {
  const url = `https://api.github.com/repos/${REPO}/releases/tags/${tag}`;
  const raw = await http.getJson(url, { headers: apiHeaders(), maxBytes: 20_000_000 });
  const parsed = releaseSchema.safeParse(raw);
  if (!parsed.success) {
    throw new SourceError("schema-drift", `GitHub release "${tag}" changed shape: ${parsed.error.issues[0]?.message ?? ""}`);
  }
  return new Map(parsed.data.assets.map((a) => [a.name, a]));
}

export interface EnsureResult {
  path: string;
  meta: CachedMeta;
  /** False when the cached copy was already current. */
  downloaded: boolean;
}

/**
 * The cached file for `asset`, downloading it first if the cache is missing or stale.
 * The file is written atomically and only after its size matches the release listing.
 */
export async function ensureAsset(http: Http, cacheDir: string, tag: string, asset: Asset, now = new Date()): Promise<EnsureResult> {
  const path = join(cacheDir, tag, asset.name);
  const metaPath = `${path}.json`;
  const cached = metaSchema.safeParse(readJsonIfExists(metaPath)).data;
  // The file's own size is checked too: a truncated file under an intact meta would otherwise
  // be trusted until nflverse publishes a new version (QA-M0-10).
  if (cached && cached.updatedAt === asset.updated_at && cached.size === asset.size && sizeOf(path) === cached.size) {
    return { path, meta: cached, downloaded: false };
  }
  const bytes = await http.getBytes(asset.browser_download_url, { timeoutMs: 120_000, maxBytes: MAX_ASSET_BYTES });
  if (bytes.byteLength !== asset.size) {
    throw new SourceError("network", `Incomplete download of ${asset.name}: got ${bytes.byteLength} bytes, the release lists ${asset.size}`);
  }
  writeFileAtomic(path, bytes);
  const meta: CachedMeta = { name: asset.name, size: asset.size, updatedAt: asset.updated_at, downloadedAt: now.toISOString() };
  writeFileAtomic(metaPath, `${JSON.stringify(meta)}\n`);
  return { path, meta, downloaded: true };
}

const sizeOf = (path: string): number | null => {
  try {
    return statSync(path).size;
  } catch {
    return null;
  }
};

/** Drop a cached file and its meta, so the next run downloads it again. */
export function evictCached(path: string): void {
  rmSync(path, { force: true });
  rmSync(`${path}.json`, { force: true });
}

/** The bytes of a cached file as an ArrayBuffer (what hyparquet reads). */
export function readCached(path: string): ArrayBuffer {
  const buf = readFileSync(path);
  return buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength) as ArrayBuffer;
}
