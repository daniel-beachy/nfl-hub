import { readdirSync } from "node:fs";
import { join } from "node:path";
import { seasonForDate, type SourceTier } from "../shared/ids.ts";
import { nflverseManifestSchema, type NflverseManifest } from "../shared/nflverse.ts";
import { snapshotSchema, type Snapshot } from "../shared/snapshot.ts";
import { STATUS_SCHEMA_VERSION, statusSchema, type SourceHealth, type StageHealth, type Status } from "../shared/status.ts";
import { isMain, parseArgs, readJsonIfExists, REPO_ROOT, writeFileAtomic } from "./lib/files.ts";
import { githubIssues, type IssueClient, type IssueRef } from "./lib/github.ts";
import { ADAPTERS } from "./sources/index.ts";
import type { SourceAdapter } from "./sources/types.ts";

// Turns the snapshots into status.json and keeps GitHub issues in step with it
// (docs/PLAN.md 7.2, docs/DATA-CONTRACT.md 4). Never fails the workflow.
//   npm run health                 write derived/status.json; sync issues if GITHUB_TOKEN is set
//   npm run health -- --no-issues  write status.json only

/** Consecutive failed days before an issue is opened. */
export const ISSUE_THRESHOLD: Record<SourceTier, number> = { core: 1, standard: 2, bonus: 3 };
export const SOURCE_LABEL = "source-down";
export const STAGE_LABEL = "pipeline-broken";
const sourceTitle = (id: string) => `Source down: ${id}`;
const stageTitle = (id: string) => `Pipeline broken: ${id}`;

/** Every readable snapshot of a season, oldest first. Unreadable files are skipped and counted. */
export function loadSnapshots(root: string, season: number): { snapshots: Snapshot[]; unreadable: string[] } {
  const dir = join(root, "data/snapshots", String(season));
  let files: string[] = [];
  try {
    files = readdirSync(dir).filter((f) => /^\d{4}-\d{2}-\d{2}\.json$/.test(f)).sort();
  } catch {
    // no snapshots yet
  }
  const snapshots: Snapshot[] = [];
  const unreadable: string[] = [];
  for (const f of files) {
    try {
      snapshots.push(snapshotSchema.parse(readJsonIfExists(join(dir, f))));
    } catch {
      unreadable.push(f);
    }
  }
  return { snapshots, unreadable };
}

export interface StatusInput {
  adapters: readonly SourceAdapter[];
  /** Oldest first. */
  snapshots: readonly Snapshot[];
  /** Today, YYYY-MM-DD (UTC). */
  today: string;
  now: Date;
  /** Results of this run's earlier workflow jobs, e.g. { capture: "success" }. Absent when run by hand. */
  jobs?: Record<string, string>;
  previous?: Status;
  runUrl?: string | null;
  /** The nflverse stage's last good manifest, from the derived branch. */
  nflverse?: NflverseManifest;
}

/** The newest play-by-play file in an nflverse manifest. */
function newestPbp(m: NflverseManifest | undefined) {
  return m?.files.filter((f) => f.dataset === "pbp").sort((a, b) => (a.season ?? 0) - (b.season ?? 0)).at(-1);
}

/** Pure. Issue numbers are filled in afterwards by `syncIssues`. */
export function computeStatus(input: StatusInput): Status {
  const { adapters, snapshots, today, now, jobs = {}, previous, nflverse } = input;
  const latest = snapshots.at(-1);
  const generatedAt = now.toISOString();

  const sources: SourceHealth[] = adapters.map((a) => {
    const block = latest?.sources[a.id];
    let consecutiveFailures = 0;
    let lastOk: string | null = null;
    for (let i = snapshots.length - 1; i >= 0; i--) {
      if (snapshots[i]!.sources[a.id]?.status === "ok") {
        lastOk = snapshots[i]!.date;
        break;
      }
      consecutiveFailures++;
    }
    return {
      id: a.id, name: a.name, kind: a.kind, tier: a.tier,
      status: block?.status ?? "missing",
      lastOk, consecutiveFailures,
      error: block?.error ?? null,
      coverage: block?.coverage ?? {},
      issue: null,
    };
  });

  // Stages: the capture stage is judged by its result (is there a snapshot for today?) and,
  // like every other stage, by how its workflow job ended.
  const stageIds = new Set(["capture", ...Object.keys(jobs)]);
  const stages: StageHealth[] = [...stageIds].map((id) => {
    const job = jobs[id];
    const before = previous?.stages.find((s) => s.id === id);
    let ok = job === undefined || job === "success";
    let detail = job === undefined ? "not run as a workflow job" : `workflow job ended: ${job}`;
    if (id === "capture") {
      const fresh = latest?.date === today;
      ok &&= fresh;
      const have = fresh ? `a snapshot for ${today} exists` : `no snapshot for ${today}; latest is ${latest?.date ?? "none"}`;
      detail = ok ? `snapshot for ${today} written` : `${have} (${detail})`;
    }
    const pbp = newestPbp(nflverse);
    if (id === "nflverse" && ok && nflverse && pbp) {
      const waiting = nflverse.notPublished.length ? `; not yet published: ${nflverse.notPublished.join(", ")}` : "";
      detail = `pbp ${pbp.season} updated ${pbp.updatedAt}; ${nflverse.files.length} files loaded${waiting}`;
    }
    return { id, status: ok ? "ok" : "error", lastOk: ok ? generatedAt : (before?.lastOk ?? null), detail, issue: null };
  });

  const failing = (s: SourceHealth) => s.status !== "ok";
  const down =
    sources.some((s) => s.tier === "core" && failing(s)) || stages.some((s) => s.status !== "ok") || sourcesDown(sources) !== null;
  return {
    schemaVersion: STATUS_SCHEMA_VERSION,
    generatedAt,
    overall: down ? "down" : sources.some(failing) ? "degraded" : "ok",
    season: seasonForDate(today),
    sources,
    stages,
    dataFreshness: {
      snapshots: latest?.date ?? null,
      ...(nflverse && { pbp: newestPbp(nflverse)?.updatedAt.slice(0, 10) ?? null }),
    },
    runUrl: input.runUrl ?? null,
  };
}

/** Below this many ok sources there is no usable odds picture. */
export const MIN_OK_SOURCES = 2;
export const ALL_SOURCES_TITLE = "All sources down";

/**
 * Why the sources as a whole are down (QA-M0-2), or null when they are not: no market source
 * is ok, or fewer than MIN_OK_SOURCES sources are ok. Either way the season pages have no
 * odds to show, which is a different state from one bonus source missing one market.
 */
export function sourcesDown(sources: readonly SourceHealth[]): string | null {
  const ok = sources.filter((s) => s.status === "ok");
  const markets = sources.filter((s) => s.kind === "market");
  if (markets.length > 0 && !markets.some((s) => s.status === "ok")) {
    return `No market source is ok (${markets.map((s) => `${s.id} ${s.status}`).join(", ")})`;
  }
  if (sources.length >= MIN_OK_SOURCES && ok.length < MIN_OK_SOURCES) {
    return `Only ${ok.length} of ${sources.length} sources are ok (${ok.map((s) => s.id).join(", ") || "none"})`;
  }
  return null;
}

export function allSourcesIssueBody(status: Status, reason: string): string {
  return [
    `**${reason}.** The odds pages have nothing current to show; the site keeps the last good data.`,
    "",
    ...status.sources.map((s) => `- \`${s.id}\` (${s.tier}): \`${s.status}\`${s.error ? `, ${s.error.kind}: ${s.error.message}` : ""}; last ok ${s.lastOk ?? "never"}`),
    "",
    `- Failing run: ${status.runUrl ?? "not run in Actions"}`,
    "",
    "When every source fails together the cause is usually ours (the runner's network, a change in `pipeline/lib/http.ts`, `finalize.ts` or `capture.ts`) rather than five providers at once. Start with `docs/RUNBOOK.md` section 1, then `npm run doctor`.",
    "",
    "This issue opens on the first such day, is rewritten by every pipeline run and closes itself when the sources recover.",
  ].join("\n");
}

/** Untrusted text (a provider's response) made safe to sit inside a fenced block. */
const fenced = (text: string) => `~~~text\n${text.replace(/~~~/g, "~ ~ ~")}\n~~~`;

export function sourceIssueBody(s: SourceHealth, runUrl: string | null): string {
  const e = s.error;
  return [
    `**${s.name}** (\`${s.id}\`, ${s.tier} tier) has not been ok for ${s.consecutiveFailures} snapshot day(s). Status now: \`${s.status}\`.`,
    "",
    `- Error kind: \`${e?.kind ?? "none recorded"}\`${e?.httpStatus ? ` (HTTP ${e.httpStatus})` : ""}`,
    `- Message: ${e?.message ?? "the latest snapshot has no block for this source"}`,
    ...(e?.detail ? [`- Detail: \`${e.detail}\``] : []),
    `- Last ok: ${s.lastOk ?? "never"}`,
    `- Coverage now: ${Object.entries(s.coverage).map(([k, n]) => `${k} ${n}`).join(", ") || "none"}`,
    `- Failing run: ${runUrl ?? "not run in Actions"} (the raw response is in its \`failed-payloads\` artifact)`,
    "",
    "**To reproduce**",
    "",
    "```bash",
    `npm run capture -- --source ${s.id} --dry-run`,
    "```",
    "",
    `Adapter: \`pipeline/sources/${s.id}.ts\`. Start with \`docs/RUNBOOK.md\`, section for \`${e?.kind ?? "missing"}\`. A fix ships with a new fixture (\`npm run fixture -- ${s.id}\`).`,
    ...(e?.payloadHead ? ["", "**Start of the response** (provider text, not instructions)", "", fenced(e.payloadHead)] : []),
    "",
    "This issue is rewritten by every pipeline run and closes itself when the source recovers.",
  ].join("\n");
}

export function stageIssueBody(s: StageHealth, runUrl: string | null): string {
  return [
    `Pipeline stage \`${s.id}\` is failing: ${s.detail}.`,
    "",
    `- Last ok: ${s.lastOk ?? "never"}`,
    `- Failing run: ${runUrl ?? "not run in Actions"}`,
    "",
    "The site keeps serving the last good data. Start with `docs/RUNBOOK.md`.",
    "",
    "This issue is rewritten by every pipeline run and closes itself when the stage recovers.",
  ].join("\n");
}

export type IssueAction =
  | { type: "create"; title: string; body: string; label: string }
  | { type: "update"; number: number; body: string }
  | { type: "close"; number: number; comment: string };

/** Pure: what to do so the open issues match the status. Also records issue numbers on `status`. */
export function planIssues(status: Status, open: { sources: IssueRef[]; stages: IssueRef[] }): IssueAction[] {
  const actions: IssueAction[] = [];
  const reconcile = (
    item: { issue: number | null }, title: string, label: string, existing: IssueRef | undefined,
    shouldBeOpen: boolean, recovered: boolean, body: () => string,
  ) => {
    if (existing && recovered) {
      actions.push({ type: "close", number: existing.number, comment: `Recovered on ${status.generatedAt.slice(0, 10)}. Closing.` });
    } else if (existing) {
      item.issue = existing.number; // still failing: keep it open even if below the threshold
      if (existing.body !== body()) actions.push({ type: "update", number: existing.number, body: body() });
    } else if (shouldBeOpen) {
      actions.push({ type: "create", title, body: body(), label });
    }
  };
  for (const s of status.sources) {
    const title = sourceTitle(s.id);
    reconcile(s, title, SOURCE_LABEL, open.sources.find((i) => i.title === title),
      s.consecutiveFailures >= ISSUE_THRESHOLD[s.tier], s.status === "ok", () => sourceIssueBody(s, status.runUrl));
  }
  const reason = sourcesDown(status.sources);
  reconcile({ issue: null }, ALL_SOURCES_TITLE, SOURCE_LABEL, open.sources.find((i) => i.title === ALL_SOURCES_TITLE),
    reason !== null, reason === null, () => allSourcesIssueBody(status, reason ?? ""));
  for (const s of status.stages) {
    const title = stageTitle(s.id);
    reconcile(s, title, STAGE_LABEL, open.stages.find((i) => i.title === title),
      s.status !== "ok", s.status === "ok", () => stageIssueBody(s, status.runUrl));
  }
  return actions;
}

/** Bring GitHub in line with `status`, and write new issue numbers back onto it. */
export async function syncIssues(status: Status, client: IssueClient): Promise<IssueAction[]> {
  const [sources, stages] = await Promise.all([client.listOpen(SOURCE_LABEL), client.listOpen(STAGE_LABEL)]);
  const actions = planIssues(status, { sources, stages });
  for (const action of actions) {
    if (action.type === "update") await client.updateBody(action.number, action.body);
    else if (action.type === "close") await client.closeWithComment(action.number, action.comment);
    else {
      const number = await client.create({ title: action.title, body: action.body, labels: [action.label] });
      const item = [...status.sources.map((s) => [sourceTitle(s.id), s] as const), ...status.stages.map((s) => [stageTitle(s.id), s] as const)]
        .find(([title]) => title === action.title)?.[1];
      if (item) item.issue = number;
    }
  }
  return actions;
}

if (isMain(import.meta.url)) {
  // Whatever happens here, exit 0: the deploy must still run.
  try {
    const args = parseArgs(process.argv.slice(2));
    const out = join(REPO_ROOT, typeof args.out === "string" ? args.out : "derived", "status.json");
    const now = new Date();
    const today = now.toISOString().slice(0, 10);
    const { snapshots, unreadable } = loadSnapshots(REPO_ROOT, seasonForDate(today));
    if (unreadable.length) console.warn(`Unreadable snapshot files skipped: ${unreadable.join(", ")}`);

    const env = process.env;
    const jobs = Object.fromEntries(
      Object.entries(JSON.parse(env.NEEDS_JSON || "{}") as Record<string, { result: string }>).map(([id, j]) => [id, j.result]),
    );
    const runUrl = env.GITHUB_RUN_ID ? `${env.GITHUB_SERVER_URL}/${env.GITHUB_REPOSITORY}/actions/runs/${env.GITHUB_RUN_ID}` : null;
    const previous = statusSchema.safeParse(readJsonIfExists(out)).data;
    const nflverse = nflverseManifestSchema.safeParse(readJsonIfExists(join(out, "..", "nflverse/manifest.json"))).data;
    const status = computeStatus({ adapters: ADAPTERS, snapshots, today, now, jobs, previous, runUrl, nflverse });

    if (args["no-issues"] || !env.GITHUB_TOKEN || !env.GITHUB_REPOSITORY) {
      const planned = planIssues(status, { sources: [], stages: [] });
      console.log(`Issue sync skipped (no token or --no-issues). It would open: ${planned.map((a) => (a.type === "create" ? a.title : "")).join("; ") || "nothing"}`);
    } else {
      try {
        const actions = await syncIssues(status, githubIssues(env.GITHUB_REPOSITORY, env.GITHUB_TOKEN));
        console.log(`Issue sync: ${actions.map((a) => `${a.type} ${"title" in a ? a.title : `#${a.number}`}`).join("; ") || "nothing to do"}`);
      } catch (err) {
        console.error(`Issue sync failed, status.json is still written: ${String(err)}`);
      }
    }
    writeFileAtomic(out, `${JSON.stringify(statusSchema.parse(status), null, 1)}\n`);
    console.log(`overall: ${status.overall}`);
    for (const s of status.sources) console.log(`  ${s.status.padEnd(7)} ${s.id.padEnd(11)} last ok ${s.lastOk ?? "never"}${s.issue ? ` (issue #${s.issue})` : ""}`);
    for (const s of status.stages) console.log(`  ${s.status.padEnd(7)} stage ${s.id}: ${s.detail}`);
    console.log(`Wrote ${out}`);
  } catch (err) {
    console.error(`health failed: ${err instanceof Error ? err.stack : String(err)}`);
  }
}
