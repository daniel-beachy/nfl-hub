import {
  AWARD_MARKETS, CONFERENCES, DIVISION_IDS, GAMES_PER_TEAM, TEAM_METRICS, type TeamMetric,
} from "../../shared/ids.ts";
import {
  AWARD_CANDIDATE_CAP, type AwardCandidate, type Issue, type SourceBlock, type TeamValues,
} from "../../shared/snapshot.ts";
import { TEAM_IDS, teamsInConference, teamsInDivision, type TeamId } from "../../shared/teams.ts";
import { SourceError } from "../lib/http.ts";
import type { AdapterCtx, ParsedSource, SourceAdapter } from "./types.ts";

// Sanity checks and normalization applied to every source the same way
// (docs/DATA-CONTRACT.md section 2.2). Pure.

export type FinalizedBlock = Omit<SourceBlock, "fetchedAt" | "durationMs">;

/** Issues kept per block; the last one then counts the rest (QA-M0-15). */
export const MAX_ISSUES = 50;

/** Cap a list of issues, replacing the overflow with one issue that counts it by kind. */
function capIssues(issues: Issue[]): Issue[] {
  if (issues.length <= MAX_ISSUES) return issues;
  const rest = issues.slice(MAX_ISSUES - 1);
  const byKind = new Map<string, number>();
  for (const i of rest) byKind.set(i.kind, (byKind.get(i.kind) ?? 0) + 1);
  const counts = [...byKind].map(([k, n]) => `${k} ${n}`).join(", ");
  return [...issues.slice(0, MAX_ISSUES - 1), issue(rest[0]!.kind, `${rest.length} more issues not listed (${counts})`)];
}

/** A complete group's raw probabilities must sum inside this range (books carry vig). */
export const GROUP_SUM_RANGE = [0.95, 1.6] as const;
/** 14 teams make the playoffs. */
export const PLAYOFF_SUM_RANGE = [12, 17] as const;
const TOTAL_WINS = (TEAM_IDS.length * GAMES_PER_TEAM) / 2;
export const WINS_SUM_RANGE = [TOTAL_WINS * 0.9, TOTAL_WINS * 1.1] as const;

const ALL_TEAMS: readonly TeamId[] = TEAM_IDS;
const ids = (teams: { id: TeamId }[]) => teams.map((t) => t.id);
const byConference = CONFERENCES.map((c) => ({ name: c as string, members: ids(teamsInConference(c)) }));

/** Groups whose members' probabilities sum to 1. Metrics not listed have no such group. */
const GROUPS: Partial<Record<TeamMetric, { name: string; members: readonly TeamId[] }[]>> = {
  superBowl: [{ name: "", members: ALL_TEAMS }],
  conference: byConference,
  seed1: byConference,
  division: DIVISION_IDS.map((d) => ({ name: d, members: ids(teamsInDivision(d)) })),
};

const round = (n: number, places: number) => Math.round(n * 10 ** places) / 10 ** places;
const inRange = (n: number, [lo, hi]: readonly [number, number]) => n >= lo && n <= hi;
const issue = (kind: Issue["kind"], message: string, detail?: string): Issue => ({
  kind, message, httpStatus: null, ...(detail !== undefined && { detail }),
});

export function finalize(adapter: SourceAdapter, parsed: ParsedSource, ctx: AdapterCtx): FinalizedBlock {
  if (parsed.season !== null && parsed.season !== ctx.season) {
    throw new SourceError("season-mismatch", `${adapter.name} is serving season ${parsed.season}, expected ${ctx.season}`);
  }
  const issues: Issue[] = [...parsed.issues];
  const raw: Record<string, number> = {};
  const metrics = new Map<TeamMetric, Map<TeamId, number>>();

  for (const metric of TEAM_METRICS) {
    const values = new Map<TeamId, number>();
    const limit = metric === "wins" ? GAMES_PER_TEAM : 1;
    const bad: string[] = [];
    for (const [team, value] of Object.entries(parsed.teams[metric] ?? {}) as [TeamId, number][]) {
      if (Number.isFinite(value) && value >= 0 && value <= limit) values.set(team, value);
      else bad.push(`${team} ${value}`);
    }
    // A value out of range is a parse bug (a percent read as a fraction), not one bad team:
    // the values still in range are suspect too, so the whole metric goes (QA-M0-4).
    if (bad.length > 0) {
      issues.push(issue("out-of-range", `${metric} has ${bad.length} value(s) outside 0 to ${limit} (${bad.slice(0, 5).join(", ")}); metric removed`, metric));
      continue;
    }
    if (values.size === 0) continue;
    if ([...values.values()].every((v) => v === 0)) {
      issues.push(issue("all-zero", `Every ${metric} value is zero`, metric));
      continue;
    }
    metrics.set(metric, values);
  }

  // Which values are still raw (not de-vigged), per metric, for `normalized` below.
  const rawValues = new Map<TeamMetric, Set<TeamId>>();
  for (const [metric, values] of metrics) rawValues.set(metric, new Set(values.keys()));

  // Two-way markets: remove the vig pairwise where the book quotes both sides.
  const playoffs = metrics.get("playoffs");
  if (playoffs && parsed.playoffsNo) {
    for (const [team, yes] of playoffs) {
      const no = parsed.playoffsNo[team];
      if (no !== undefined && Number.isFinite(no) && no >= 0 && yes + no > 0) {
        playoffs.set(team, yes / (yes + no));
        rawValues.get("playoffs")!.delete(team);
      }
    }
  }

  for (const [metric, groups] of Object.entries(GROUPS) as [TeamMetric, NonNullable<(typeof GROUPS)[TeamMetric]>][]) {
    const values = metrics.get(metric);
    if (!values) continue;
    for (const group of groups) {
      const present = group.members.filter((t) => values.has(t));
      if (present.length === 0) continue;
      const sum = present.reduce((s, t) => s + values.get(t)!, 0);
      const name = `${metric} ${group.name}`.trim();
      if (present.length < group.members.length) {
        // Incomplete groups stay raw, but a subset can never sum above the upper bound (QA-M0-4).
        if (sum > GROUP_SUM_RANGE[1]) {
          issues.push(issue("bad-sum", `${name} sums to ${round(sum, 3)} with only ${present.length} of ${group.members.length} teams`, metric));
          for (const t of present) values.delete(t);
        }
        continue;
      }
      raw[group.name ? `${metric}Sum.${group.name}` : `${metric}Sum`] = round(sum, 4);
      if (!inRange(sum, GROUP_SUM_RANGE)) {
        issues.push(issue("bad-sum", `${name} sums to ${round(sum, 3)}, expected about 1`, metric));
        for (const t of group.members) values.delete(t);
      } else if (adapter.kind === "market") {
        for (const t of group.members) {
          values.set(t, values.get(t)! / sum);
          rawValues.get(metric)!.delete(t);
        }
      }
    }
  }

  const checkTotal = (metric: TeamMetric, range: readonly [number, number], about: number) => {
    const values = metrics.get(metric);
    if (!values || values.size !== ALL_TEAMS.length) return;
    const sum = [...values.values()].reduce((s, v) => s + v, 0);
    raw[`${metric}Sum`] = round(sum, 4);
    if (!inRange(sum, range)) {
      issues.push(issue("bad-sum", `${metric} sums to ${round(sum, 2)}, expected about ${about}`, metric));
      values.clear();
    }
  };
  checkTotal("playoffs", PLAYOFF_SUM_RANGE, 14);
  checkTotal("wins", WINS_SUM_RANGE, TOTAL_WINS);

  const teams: Partial<Record<TeamId, TeamValues>> = {};
  const coverage: SourceBlock["coverage"] = {};
  const normalized: NonNullable<SourceBlock["normalized"]> = {};
  for (const [metric, values] of metrics) {
    if (values.size === 0) continue;
    coverage[metric] = values.size;
    // Markets only: true when every kept value was de-vigged, false when any is raw.
    if (adapter.kind === "market" && metric !== "wins") {
      normalized[metric] = ![...values.keys()].some((t) => rawValues.get(metric)!.has(t));
    }
    for (const team of ALL_TEAMS) {
      const v = values.get(team);
      if (v !== undefined) (teams[team] ??= {})[metric] = round(v, metric === "wins" ? 2 : 4);
    }
  }

  const awards: SourceBlock["awards"] = {};
  for (const market of AWARD_MARKETS) {
    const kept: AwardCandidate[] = [];
    const bad: string[] = [];
    for (const c of parsed.awards[market] ?? []) {
      if (Number.isFinite(c.prob) && c.prob >= 0 && c.prob <= 1) kept.push({ ...c, prob: round(c.prob, 4) });
      else bad.push(`${c.name} ${c.prob}`);
    }
    if (bad.length > 0) {
      issues.push(issue("out-of-range", `${market} has ${bad.length} probability(ies) outside 0 to 1 (${bad.slice(0, 5).join(", ")}); market removed`, market));
      continue;
    }
    if (kept.length === 0) continue;
    // The same rule as team metrics, per award market (QA-M0-5). A settled market has one
    // candidate at 1 and the rest at 0, which is not all zero and stays.
    if (kept.every((c) => c.prob === 0)) {
      issues.push(issue("all-zero", `Every ${market} candidate is at zero (${kept.length})`, market));
      continue;
    }
    kept.sort((a, b) => b.prob - a.prob || a.name.localeCompare(b.name));
    awards[market] = kept.slice(0, AWARD_CANDIDATE_CAP);
    coverage[market] = awards[market].length;
  }

  // What the source normally offers and did not deliver in full.
  const mentioned = new Set(issues.map((i) => i.detail));
  for (const metric of adapter.expects.teams) {
    const have = coverage[metric] ?? 0;
    if (have === ALL_TEAMS.length || mentioned.has(metric)) continue;
    issues.push(
      have === 0
        ? issue("market-missing", `No ${metric} values`, metric)
        : issue("team-coverage", `${metric} has ${have} of ${ALL_TEAMS.length} teams`, metric),
    );
  }
  for (const market of adapter.expects.awards) {
    if (!coverage[market] && !mentioned.has(market)) issues.push(issue("market-missing", `No ${market} candidates`, market));
  }

  const hasData = Object.keys(coverage).length > 0;
  const status = !hasData ? "error" : issues.length > 0 ? "partial" : "ok";
  const error = status === "ok" ? null : (issues[0] ?? issue("market-missing", "The source returned no usable values"));
  return {
    status, observedAt: parsed.observedAt, error, issues: capIssues(issues), teams, awards, coverage, raw,
    ...(Object.keys(normalized).length > 0 && { normalized }),
  };
}
