import { join } from "node:path";
import { seasonForDate } from "../shared/ids.ts";
import type { SourceBlock } from "../shared/snapshot.ts";
import { TEAM_IDS } from "../shared/teams.ts";
import { isMain, parseArgs, REPO_ROOT, writeFileAtomic } from "./lib/files.ts";
import { createHttp, toSourceError, type Http } from "./lib/http.ts";
import { DATASET_IDS, DATASETS } from "./nflverse/datasets.ts";
import { listAssets } from "./nflverse/download.ts";
import { ADAPTERS, getAdapter } from "./sources/index.ts";
import { runAdapter } from "./sources/run.ts";
import type { SourceAdapter } from "./sources/types.ts";

// Probes every source live and prints one line each (docs/RUNBOOK.md). Read-only: it writes
// no snapshot and touches no GitHub issue.
//   npm run doctor                         every source, plus the nflverse releases
//   npm run doctor -- --source kalshi      one or more sources (comma separated)
//   npm run doctor -- --json               machine-readable
//   npm run doctor -- --save-failed        also write failed raw responses to tmp/failed-payloads/
// Exits 1 when any source is not ok or an nflverse file is missing, so it can gate a fix.

export interface SourceProbe {
  id: string;
  tier: string;
  status: SourceBlock["status"];
  ms: number;
  /** Teams per team metric and candidates per award. */
  coverage: SourceBlock["coverage"];
  /** What `expects` asks for and is not complete. */
  short: string[];
  issues: { kind: string; message: string; detail?: string }[];
}

export interface NflverseProbe {
  file: string;
  status: "ok" | "missing" | "error";
  updatedAt: string | null;
  ageHours: number | null;
  message?: string;
}

export async function probeSource(adapter: SourceAdapter, http: Http, date: string, saveFailed: boolean): Promise<SourceProbe> {
  const { block, failedPayload } = await runAdapter(adapter, { season: seasonForDate(date), date, http });
  if (saveFailed && failedPayload !== null) {
    writeFileAtomic(join(REPO_ROOT, "tmp/failed-payloads", `${adapter.id}-${date}.json`), failedPayload);
  }
  const short = [
    ...adapter.expects.teams.filter((m) => (block.coverage[m] ?? 0) < TEAM_IDS.length),
    ...adapter.expects.awards.filter((m) => !block.coverage[m]),
  ];
  return {
    id: adapter.id, tier: adapter.tier, status: block.status, ms: block.durationMs, coverage: block.coverage, short,
    issues: block.issues.map((i) => ({ kind: i.kind, message: i.message, ...(i.detail !== undefined && { detail: i.detail }) })),
  };
}

export async function probeNflverse(http: Http, date: string, now = new Date()): Promise<NflverseProbe[]> {
  const season = seasonForDate(date);
  const out: NflverseProbe[] = [];
  for (const id of DATASET_IDS) {
    const d = DATASETS[id];
    const names = d.perSeason ? [d.file(season - 1), d.file(season)] : [d.file(0)];
    try {
      const assets = await listAssets(http, d.tag);
      for (const name of names) {
        const a = assets.get(name);
        const ageHours = a ? Math.round((now.getTime() - Date.parse(a.updated_at)) / 36e5) : null;
        out.push({ file: `${d.tag}/${name}`, status: a ? "ok" : "missing", updatedAt: a?.updated_at ?? null, ageHours });
      }
    } catch (err) {
      for (const name of names) out.push({ file: `${d.tag}/${name}`, status: "error", updatedAt: null, ageHours: null, message: toSourceError(err).message });
    }
  }
  return out;
}

/** The table a person or agent reads. Pure. */
export function formatReport(sources: SourceProbe[], nflverse: NflverseProbe[]): string {
  const lines = ["SOURCE      TIER      STATUS   TIME    COVERAGE", "-".repeat(78)];
  for (const s of sources) {
    const teams = Object.entries(s.coverage).filter(([k]) => !/^(mvp|opoy|dpoy|oroy|droy|coy|cpoy)$/.test(k));
    const awards = Object.entries(s.coverage).filter(([k]) => /^(mvp|opoy|dpoy|oroy|droy|coy|cpoy)$/.test(k));
    const cov = [
      teams.map(([k, n]) => `${k} ${n}`).join(", "),
      awards.length ? `awards ${awards.length}/7` : "",
    ].filter(Boolean).join("; ") || "no data";
    lines.push(`${s.id.padEnd(11)} ${s.tier.padEnd(9)} ${s.status.toUpperCase().padEnd(8)} ${`${(s.ms / 1000).toFixed(1)}s`.padEnd(7)} ${cov}`);
    if (s.short.length) lines.push(`            short of expected: ${s.short.join(", ")}`);
    for (const i of s.issues) lines.push(`            ${i.kind}: ${i.message}${i.detail ? ` [${i.detail}]` : ""}`);
  }
  if (nflverse.length) {
    lines.push("", "NFLVERSE FILE                                   STATUS   UPDATED (AGE)", "-".repeat(78));
    for (const n of nflverse) {
      const when = n.updatedAt ? `${n.updatedAt} (${n.ageHours} h)` : (n.message ?? "not in the release");
      lines.push(`${n.file.padEnd(47)} ${n.status.toUpperCase().padEnd(8)} ${when}`);
    }
  }
  return lines.join("\n");
}

if (isMain(import.meta.url)) {
  const args = parseArgs(process.argv.slice(2));
  const adapters = typeof args.source === "string" ? args.source.split(",").map(getAdapter) : ADAPTERS;
  const date = new Date().toISOString().slice(0, 10);
  const http = createHttp();
  const [sources, nflverse] = await Promise.all([
    Promise.all(adapters.map((a) => probeSource(a, http, date, args["save-failed"] === true))),
    typeof args.source === "string" ? Promise.resolve([]) : probeNflverse(http, date),
  ]);
  if (args.json) console.log(JSON.stringify({ date, sources, nflverse }, null, 2));
  else {
    console.log(`Doctor ${date} (season ${seasonForDate(date)}). Live requests; nothing is written${args["save-failed"] ? " except tmp/failed-payloads/" : ""}.\n`);
    console.log(formatReport(sources, nflverse));
  }
  const bad = sources.some((s) => s.status !== "ok") || nflverse.some((n) => n.status !== "ok");
  process.exitCode = bad ? 1 : 0;
}
