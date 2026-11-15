import { existsSync } from "node:fs";
import { join } from "node:path";
import { z } from "zod";
import { AWARD_MARKETS, CONFERENCES, DIVISION_IDS, type AwardMarket, type TeamMetric } from "../shared/ids.ts";
import {
  AWARD_CANDIDATE_CAP, SNAPSHOT_SCHEMA_VERSION, snapshotPath, snapshotSchema,
  type AwardCandidate, type Issue, type Snapshot, type SnapshotContext, type SourceBlock, type TeamValues,
} from "../shared/snapshot.ts";
import { teamFromEspnId, teamsInConference, teamsInDivision, type TeamId } from "../shared/teams.ts";
import { isMain, parseArgs, readJsonIfExists, REPO_ROOT, writeFileAtomic } from "./lib/files.ts";

// One-off (docs/PLAN.md 8.4, M1-3): convert the real 2026 weekly snapshots captured by the old
// tracker, nfl-season-tracker-v3, into this repo's daily snapshot files. Reads only v3's data
// file, never its code. The output is committed; after that nothing depends on v3.
//   npx tsx pipeline/import-v3.ts --file <path to v3 public/data/seasons/2026.json> [--dry-run]
// Never overwrites an existing snapshot. Every file it writes carries `imported`.
//
// What changes on the way in:
// - ESPN team ids become our team ids; percentages become fractions (4 decimals; wins 2).
// - A value v3 recorded as null is absent. A v3 source marked "unavailable" becomes an
//   `error` block. A metric v3 normally had for that source but is missing or short of 32
//   teams makes the block `partial`, as finalize.ts would.
// - v3 already de-vigged complete market groups. `normalized` is set only where the group
//   sums show it (complete and summing to 1), and pre-normalization sums are unknown, so
//   `raw` is empty.
// - v3's September 8 baseline also held Bovada and Polymarket quotes it says were captured on
//   September 11, after the first week-1 games. They go into a 2026-09-11 file, not 09-08:
//   a snapshot is what each source said on its date.

const V3_SOURCES = ["espn-fpi", "draftkings", "bovada", "polymarket"] as const;
type V3Source = (typeof V3_SOURCES)[number];
const V3_METRICS = ["superBowl", "conference", "division", "playoffs", "wins"] as const;

const projection = z.object(Object.fromEntries(V3_METRICS.map((m) => [m, z.number().nullable().optional()])) as Record<(typeof V3_METRICS)[number], z.ZodOptional<z.ZodNullable<z.ZodNumber>>>);
const v3Schema = z.object({
  season: z.number(),
  sources: z.array(z.object({ id: z.string(), metrics: z.array(z.string()) })),
  snapshots: z.array(
    z.object({
      capturedAt: z.string(),
      phase: z.string(),
      week: z.number().nullable(),
      sources: z.record(z.string(), z.object({ status: z.string(), note: z.string().optional(), observedAt: z.string().nullable().optional(), projections: z.record(z.string(), projection).optional() })),
      awards: z.record(
        z.string(),
        z.object({
          status: z.string(),
          note: z.string().optional(),
          categories: z.array(z.object({ id: z.string(), candidates: z.array(z.object({ name: z.string(), teamId: z.string().nullable(), impliedProbability: z.number() })) })),
        }),
      ),
    }),
  ),
});
export type V3File = z.infer<typeof v3Schema>;
type V3Snapshot = V3File["snapshots"][number];

/** v3's 09-08 Bovada and Polymarket quotes, which v3's notes date to this day. Time of day not recorded. */
export const SEPT_11 = "2026-09-11";
const SEPT_11_AT = `${SEPT_11}T00:00:00.000Z`;
const MOVED_TO_SEPT_11: readonly V3Source[] = ["bovada", "polymarket"];

const round = (n: number, places: number) => Math.round(n * 10 ** places) / 10 ** places;
const NEAR_ONE = 0.01;

function issue(kind: Issue["kind"], message: string, detail?: string): Issue {
  return { kind, message, httpStatus: null, ...(detail && { detail }) };
}

function convertTeams(projections: Record<string, z.infer<typeof projection>>, issues: Issue[]): Partial<Record<TeamId, TeamValues>> {
  const teams: Partial<Record<TeamId, TeamValues>> = {};
  for (const [espnId, p] of Object.entries(projections)) {
    const team = teamFromEspnId(espnId);
    if (!team) {
      issues.push(issue("unknown-name", `v3 ESPN team id ${espnId} is not one of ours`, espnId));
      continue;
    }
    const v: TeamValues = {};
    for (const m of V3_METRICS) {
      const x = p[m];
      if (x === null || x === undefined) continue;
      if (m === "wins") v.wins = round(x, 2);
      else v[m] = round(x / 100, 4);
    }
    teams[team.id] = v;
  }
  // Range: one bad value removes the metric (docs/DATA-CONTRACT.md 2.2).
  for (const m of V3_METRICS) {
    const max = m === "wins" ? 17 : 1;
    if (Object.values(teams).some((v) => v[m] !== undefined && !(v[m]! >= 0 && v[m]! <= max))) {
      for (const v of Object.values(teams)) delete v[m];
      issues.push(issue("out-of-range", `v3 ${m} has a value out of range; removed`, m));
    }
  }
  return teams;
}

/** Which probability groups are complete and sum to 1, i.e. were de-vigged by v3. */
function normalizedFor(teams: Partial<Record<TeamId, TeamValues>>): Partial<Record<TeamMetric, boolean>> {
  const sumOf = (ids: TeamId[], m: TeamMetric) =>
    ids.every((t) => teams[t]?.[m] !== undefined) ? ids.reduce((a, t) => a + teams[t]![m]!, 0) : null;
  const ok = (s: number | null, target = 1) => s !== null && Math.abs(s - target) <= NEAR_ONE * target;
  const all = Object.keys(teams) as TeamId[];
  const out: Partial<Record<TeamMetric, boolean>> = {};
  const has = (m: TeamMetric) => all.some((t) => teams[t]![m] !== undefined);
  if (has("superBowl")) out.superBowl = all.length === 32 && ok(sumOf(all, "superBowl"));
  if (has("conference")) out.conference = CONFERENCES.every((c) => ok(sumOf(teamsInConference(c).map((t) => t.id), "conference")));
  if (has("division")) out.division = DIVISION_IDS.every((d) => ok(sumOf(teamsInDivision(d).map((t) => t.id), "division")));
  return out;
}

function convertAwards(v3: V3Snapshot["awards"][string] | undefined): Partial<Record<AwardMarket, AwardCandidate[]>> {
  const awards: Partial<Record<AwardMarket, AwardCandidate[]>> = {};
  if (!v3 || v3.status !== "ok") return awards;
  for (const c of v3.categories) {
    if (!(AWARD_MARKETS as readonly string[]).includes(c.id)) continue; // e.g. DraftKings "protector"
    const list = c.candidates
      .map((x): AwardCandidate => ({ playerId: null, name: x.name, team: x.teamId ? (teamFromEspnId(x.teamId)?.id ?? null) : null, prob: round(x.impliedProbability / 100, 4) }))
      .filter((x) => x.prob >= 0 && x.prob <= 1)
      .sort((a, b) => b.prob - a.prob)
      .slice(0, AWARD_CANDIDATE_CAP);
    if (list.length) awards[c.id as AwardMarket] = list;
  }
  return awards;
}

interface BlockInput {
  id: V3Source;
  kind: "forecast" | "market";
  expects: readonly string[];
  fetchedAt: string;
  v3: V3Snapshot["sources"][string] | undefined;
  awards: V3Snapshot["awards"][string] | undefined;
  provenance?: string;
}

export function convertBlock(b: BlockInput): SourceBlock {
  const observedAt = b.v3?.observedAt ? new Date(b.v3.observedAt).toISOString() : null;
  const base = { fetchedAt: b.fetchedAt, observedAt, durationMs: 0, raw: {}, ...(b.provenance && { provenance: b.provenance }) };
  if (!b.v3 || b.v3.status !== "ok") {
    const e = issue("empty-response", `v3 recorded this source as ${b.v3?.status ?? "missing"}: ${b.v3?.note?.split(". ")[0] ?? "no block"}`);
    return { ...base, status: "error", error: e, issues: [e], teams: {}, awards: {}, coverage: {} };
  }
  const issues: Issue[] = [];
  const teams = convertTeams(b.v3.projections ?? {}, issues);
  const awards = convertAwards(b.awards);
  if (b.awards && b.awards.status !== "ok") issues.push(issue("market-missing", `v3 had no award odds from this source: ${b.awards.note ?? b.awards.status}`, "awards"));
  const coverage: SourceBlock["coverage"] = {};
  for (const m of V3_METRICS) {
    const n = Object.values(teams).filter((v) => v[m] !== undefined).length;
    if (n > 0) coverage[m] = n;
    if (!b.expects.includes(m)) continue;
    if (n === 0) issues.push(issue("market-missing", `v3 had no ${m} values from this source on this date`, m));
    else if (n < 32) issues.push(issue("team-coverage", `${m} has ${n} of 32 teams`, m));
  }
  for (const [m, list] of Object.entries(awards)) coverage[m as AwardMarket] = list.length;
  const usable = Object.keys(coverage).length > 0;
  const status = issues.length === 0 ? "ok" : usable ? "partial" : "error";
  const normalized = b.kind === "market" ? normalizedFor(teams) : undefined;
  if (normalized && b.id === "bovada" && coverage.playoffs) {
    // v3 de-vigged Bovada's yes/no playoff prices pairwise; the sums (13.8 to 13.9) agree.
    normalized.playoffs = true;
  }
  return { ...base, status, error: issues[0] ?? null, issues: issues.slice(0, 50), teams, awards, coverage, ...(normalized && { normalized }) };
}

function contextOf(s: V3Snapshot): SnapshotContext | null {
  if (s.phase === "preseason") return { phase: "preseason", lastCompletedWeek: null, gamesInProgress: false };
  // v3 captured each regular week on the Tuesday after it ("Checkpoint is AFTER all games in regular week N").
  if (s.phase === "regular" && s.week !== null) return { phase: "regular", lastCompletedWeek: s.week, gamesInProgress: false };
  return null;
}

const BASE_NOTE =
  "Converted from nfl-season-tracker-v3's weekly capture (public/data/seasons/2026.json) by pipeline/import-v3.ts. " +
  "Percentages became fractions; v3 had already de-vigged complete market groups, so pre-normalization sums are unknown and raw is empty; durationMs is unknown (0). " +
  "v3 rescaled ESPN FPI division probabilities so each division sums to exactly 100%; this pipeline does not rescale FPI.";

/** Pure. One snapshot per v3 capture date, plus the 2026-09-11 file for the quotes moved off 09-08. */
export function convertV3(raw: unknown, importedAt: string): Snapshot[] {
  const v3 = v3Schema.parse(raw);
  const expects = new Map(v3.sources.map((s) => [s.id, s.metrics]));
  const kind = (id: V3Source) => (id === "espn-fpi" ? "forecast" : "market");
  const out: Snapshot[] = [];
  const sept11: Snapshot["sources"] = {};

  for (const s of v3.snapshots) {
    const capturedAt = new Date(s.capturedAt).toISOString();
    const date = capturedAt.slice(0, 10);
    const sources: Snapshot["sources"] = {};
    for (const id of V3_SOURCES) {
      if (!(id in s.sources)) continue;
      const input: BlockInput = { id, kind: kind(id), expects: expects.get(id) ?? [], fetchedAt: capturedAt, v3: s.sources[id], awards: s.awards[id] };
      if (date === "2026-09-08" && MOVED_TO_SEPT_11.includes(id)) {
        sept11[id] = convertBlock({
          ...input, fetchedAt: SEPT_11_AT,
          provenance: "v3 stored these quotes in its 2026-09-08 preseason baseline but notes they were captured on 2026-09-11 (after the first week-1 games), so they are filed under that date. v3 recorded only the date; the time of day is not known.",
        });
        continue;
      }
      if (date === "2026-09-08" && id === "draftkings") {
        input.provenance =
          "Team odds captured by v3 at 16:56Z. The award odds were added by v3 on 2026-09-11 from publications dated 2026-09-08, before kickoff (DraftKings Network for MVP, OPOY, DPOY, OROY, DROY, CPOY; CBS Sports for COY), not captured live and not verified closing prices.";
      }
      sources[id] = convertBlock(input);
    }
    out.push({
      schemaVersion: SNAPSHOT_SCHEMA_VERSION, season: v3.season, date, capturedAt, context: contextOf(s), sources,
      imported: { from: "nfl-season-tracker-v3", importedAt, note: BASE_NOTE },
    });
  }
  if (Object.keys(sept11).length) {
    out.push({
      schemaVersion: SNAPSHOT_SCHEMA_VERSION, season: v3.season, date: SEPT_11, capturedAt: SEPT_11_AT, context: null, sources: sept11,
      imported: { from: "nfl-season-tracker-v3", importedAt, note: BASE_NOTE },
    });
  }
  return out.sort((a, b) => (a.date < b.date ? -1 : 1)).map((s) => snapshotSchema.parse(s));
}

if (isMain(import.meta.url)) {
  const args = parseArgs(process.argv.slice(2));
  if (typeof args.file !== "string") {
    console.error("usage: npx tsx pipeline/import-v3.ts --file <v3 public/data/seasons/2026.json> [--dry-run]");
    process.exit(1);
  }
  const snapshots = convertV3(readJsonIfExists(args.file), new Date().toISOString());
  for (const s of snapshots) {
    const path = join(REPO_ROOT, snapshotPath(s.season, s.date));
    const summary = Object.entries(s.sources).map(([id, b]) => `${id} ${b.status}`).join(", ");
    if (existsSync(path)) {
      console.log(`  skip ${s.date}: a snapshot already exists (never overwritten)`);
      continue;
    }
    if (!args["dry-run"]) writeFileAtomic(path, `${JSON.stringify(s)}\n`);
    console.log(`  ${args["dry-run"] ? "would write" : "wrote"} ${s.date}: ${summary}`);
  }
}
