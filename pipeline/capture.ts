import { join } from "node:path";
import { seasonForDate, type SourceId } from "../shared/ids.ts";
import {
  SNAPSHOT_SCHEMA_VERSION, snapshotPath, snapshotSchema, type Snapshot, type SnapshotContext, type SourceBlock,
} from "../shared/snapshot.ts";
import { fetchContext } from "./context.ts";
import { isMain, parseArgs, readJsonIfExists, REPO_ROOT, writeFileAtomic } from "./lib/files.ts";
import { createHttp, type Http } from "./lib/http.ts";
import { ADAPTERS, getAdapter } from "./sources/index.ts";
import { runAdapter } from "./sources/run.ts";
import type { SourceAdapter } from "./sources/types.ts";

// Runs the adapters and writes today's snapshot (docs/PLAN.md 5.4, docs/DATA-CONTRACT.md 2).
//   npm run capture                             capture every source that is not ok yet today
//   npm run capture -- --source polymarket      one source
//   npm run capture -- --source polymarket --dry-run   print the result, write nothing

const RANK: Record<SourceBlock["status"], number> = { error: 0, partial: 1, ok: 2 };
const total = (b: SourceBlock) => Object.values(b.coverage).reduce((s, n) => s + (n ?? 0), 0);

/**
 * Which block to keep when a source is captured again on the same day. Good data is never
 * replaced by worse: ok is final, partial yields only to more coverage, an error block is
 * refreshed so it describes the latest attempt.
 */
export function mergeBlock(existing: SourceBlock | undefined, fresh: SourceBlock): SourceBlock {
  if (!existing) return fresh;
  if (RANK[fresh.status] !== RANK[existing.status]) return RANK[fresh.status] > RANK[existing.status] ? fresh : existing;
  if (existing.status === "ok") return existing;
  if (existing.status === "error") return fresh;
  return total(fresh) > total(existing) ? fresh : existing;
}

export interface CaptureOptions {
  adapters: readonly SourceAdapter[];
  /** Capture date, YYYY-MM-DD (UTC). */
  date: string;
  http: Http;
  /** Repo root: snapshots go under {root}/data/snapshots, failed payloads under {root}/tmp. */
  root: string;
  dryRun?: boolean;
  getContext?: (http: Http, season: number) => Promise<SnapshotContext | null>;
  now?: () => Date;
}

export interface CaptureResult {
  snapshot: Snapshot;
  path: string;
  /** Sources fetched in this run (the rest were already ok today). */
  ran: SourceId[];
  written: boolean;
}

export async function capture(options: CaptureOptions): Promise<CaptureResult> {
  const { adapters, date, http, root } = options;
  const now = options.now ?? (() => new Date());
  const season = seasonForDate(date);
  const path = join(root, snapshotPath(season, date));

  // An unreadable existing file stops the run: better a loud failure than overwriting observations.
  const onDisk = readJsonIfExists(path);
  const existing = onDisk === undefined ? undefined : snapshotSchema.parse(onDisk);

  const todo = adapters.filter((a) => existing?.sources[a.id]?.status !== "ok");
  const [results, context] = await Promise.all([
    Promise.all(todo.map((a) => runAdapter(a, { season, date, http }, now))),
    existing?.context ? existing.context : (options.getContext ?? fetchContext)(http, season),
  ]);

  const sources: Snapshot["sources"] = { ...existing?.sources };
  todo.forEach((adapter, i) => {
    const { block, failedPayload } = results[i]!;
    sources[adapter.id] = mergeBlock(sources[adapter.id], block);
    if (failedPayload !== null && !options.dryRun) {
      writeFileAtomic(join(root, "tmp/failed-payloads", `${adapter.id}-${date}.json`), failedPayload);
    }
  });

  // Validate before writing: a snapshot that does not match the contract is a bug, not data.
  const snapshot = snapshotSchema.parse({
    schemaVersion: SNAPSHOT_SCHEMA_VERSION,
    season,
    date,
    capturedAt: existing?.capturedAt ?? now().toISOString(),
    context,
    sources,
  } satisfies Snapshot);

  const written = !options.dryRun && todo.length > 0;
  if (written) writeFileAtomic(path, `${JSON.stringify(snapshot)}\n`);
  return { snapshot, path, ran: todo.map((a) => a.id), written };
}

/** One line per source, for the workflow log and for `--dry-run`. */
export function summarize(snapshot: Snapshot, ran: SourceId[]): string {
  const lines = Object.entries(snapshot.sources).map(([id, b]) => {
    const coverage = Object.entries(b.coverage).map(([k, n]) => `${k} ${n}`).join(", ") || "no data";
    const note = ran.includes(id as SourceId) ? `${b.durationMs} ms` : "kept from earlier today";
    const problems = b.issues.map((i) => `\n    ${i.kind}: ${i.message}`).join("");
    return `  ${b.status.toUpperCase().padEnd(7)} ${id.padEnd(11)} ${coverage} (${note})${problems}`;
  });
  const c = snapshot.context;
  const context = c ? `${c.phase}, last completed week ${c.lastCompletedWeek}, games in progress: ${c.gamesInProgress}` : "unknown";
  return [`Snapshot ${snapshot.date} (season ${snapshot.season}; ${context})`, ...lines].join("\n");
}

if (isMain(import.meta.url)) {
  const args = parseArgs(process.argv.slice(2));
  const adapters = typeof args.source === "string" ? args.source.split(",").map(getAdapter) : ADAPTERS;
  const date = typeof args.date === "string" ? args.date : new Date().toISOString().slice(0, 10);
  const result = await capture({ adapters, date, http: createHttp(), root: REPO_ROOT, dryRun: args["dry-run"] === true });
  console.log(summarize(result.snapshot, result.ran));
  if (args["dry-run"]) {
    for (const id of result.ran) console.log(`\n${id}:\n${JSON.stringify(result.snapshot.sources[id], null, 2)}`);
  } else {
    console.log(result.written ? `Wrote ${result.path}` : "Nothing to do: every source is already ok today.");
  }
  // Exit 0 even when sources failed: the snapshot records it and health.ts reports it.
}
