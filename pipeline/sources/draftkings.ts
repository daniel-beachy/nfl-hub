import { z } from "zod";
import type { AwardMarket, TeamMetric } from "../../shared/ids.ts";
import { AWARD_CANDIDATE_CAP } from "../../shared/snapshot.ts";
import { teamFromEspnId } from "../../shared/teams.ts";
import { americanToProb, failureIssue, fetchParts, partFailure } from "./odds.ts";
import { defineAdapter, type ParsedSource } from "./types.ts";

// DraftKings futures, as republished by ESPN's core API. See docs/SOURCES.md.
// One request lists every futures market. Award candidates are athlete references with no
// name, so the top candidates' names are fetched one athlete at a time.

const ref = z.object({ $ref: z.string() });
const book = z.object({
  value: z.string(), // American odds: "+170", "-6000"
  team: ref.optional(), // ".../seasons/2026/teams/12?..." for team markets
  athlete: ref.optional(), // ".../seasons/2026/athletes/3915511?..." for awards
});
const future = z.object({
  $ref: z.string(), // ".../seasons/2026/futures/1219?...": carries the season
  name: z.string(),
  futures: z.array(z.object({ books: z.array(book) })),
});
const athlete = z.object({ displayName: z.string(), team: ref.optional() });
const payload = z.object({
  items: z.array(future),
  athletes: z.record(z.string(), athlete),
  failures: z.array(partFailure),
});
type Future = z.infer<typeof future>;

const AWARD_NAMES: [RegExp, AwardMarket][] = [
  [/\bmvp\b/, "mvp"],
  [/\boffensive player of the year\b/, "opoy"],
  [/\bdefensive player of the year\b/, "dpoy"],
  [/\boffensive rookie of the year\b/, "oroy"],
  [/\bdefensive rookie of the year\b/, "droy"],
  [/\bcoach of the year\b/, "coy"],
  [/\bcomeback player of the year\b/, "cpoy"],
];

/** Which of our markets a futures name is, if any. Exported for tests. */
export function classifyFuture(name: string): { metric: TeamMetric } | { award: AwardMarket } | null {
  const t = name.toLowerCase().replace(/\s+/g, " ").trim();
  if (/super bowl/.test(t)) return /\bwinner\b/.test(t) && !/mvp/.test(t) ? { metric: "superBowl" } : null;
  if (/\((a|n)\) (east|north|south|west) division\b/.test(t)) return { metric: "division" };
  if (/\((a|n)\) conference\b/.test(t)) return { metric: "conference" };
  if (/\bto make the playoffs$/.test(t)) return { metric: "playoffs" };
  for (const [pattern, award] of AWARD_NAMES) if (pattern.test(t)) return { award };
  return null;
}

const idFrom = (url: string, kind: "teams" | "athletes") => new RegExp(`/${kind}/(\\d+)`).exec(url)?.[1];

/** The award candidates worth naming: the favorites, as many as a snapshot keeps. */
function topAthletes(items: Future[]): string[] {
  const ids = new Set<string>();
  for (const item of items) {
    const kind = classifyFuture(item.name);
    if (!kind || !("award" in kind)) continue;
    const ranked = (item.futures[0]?.books ?? [])
      .map((b) => ({ id: b.athlete ? idFrom(b.athlete.$ref, "athletes") : undefined, prob: americanToProb(b.value) ?? 0 }))
      .filter((b): b is { id: string; prob: number } => b.id !== undefined)
      .sort((a, b) => b.prob - a.prob);
    for (const b of ranked.slice(0, AWARD_CANDIDATE_CAP)) ids.add(b.id);
  }
  return [...ids].sort();
}

export const draftkings = defineAdapter({
  id: "draftkings",
  name: "DraftKings",
  kind: "market",
  tier: "standard",
  expects: {
    teams: ["superBowl", "conference", "division", "playoffs"],
    awards: ["mvp", "opoy", "dpoy", "oroy", "droy", "coy", "cpoy"],
  },
  payload,

  async fetch({ http, season }) {
    const list = await http.getJson(
      `https://sports.core.api.espn.com/v2/sports/football/leagues/nfl/seasons/${season}/futures?limit=100`,
    );
    // Validate the list now: the athlete requests depend on it. A failure here is schema drift
    // reported by the framework when it validates the whole payload.
    const items = z.object({ items: z.array(future) }).safeParse(list);
    if (!items.success) return { items: (list as { items?: unknown })?.items, athletes: {}, failures: [] };
    const { results, failures } = await fetchParts(topAthletes(items.data.items), 6, (id) => `athlete ${id}`, (id) =>
      http.getJson(`https://sports.core.api.espn.com/v2/sports/football/leagues/nfl/seasons/${season}/athletes/${id}`),
    );
    return { items: items.data.items, athletes: Object.fromEntries(results), failures };
  },

  parse(data) {
    const out: ParsedSource = { season: null, observedAt: null, teams: {}, awards: {}, issues: data.failures.map(failureIssue) };
    for (const item of data.items) {
      const season = Number(/\/seasons\/(\d{4})\//.exec(item.$ref)?.[1]);
      if (Number.isInteger(season)) out.season ??= season;
      const kind = classifyFuture(item.name);
      if (!kind) continue;
      const books = item.futures[0]?.books ?? []; // one provider (DraftKings) per market
      if ("award" in kind) {
        const ranked = books
          .map((b) => ({ id: b.athlete ? idFrom(b.athlete.$ref, "athletes") : undefined, prob: americanToProb(b.value) }))
          .filter((b): b is { id: string; prob: number } => b.id !== undefined && b.prob !== null)
          .sort((a, b) => b.prob - a.prob)
          .slice(0, AWARD_CANDIDATE_CAP);
        for (const { id, prob } of ranked) {
          const person = data.athletes[id];
          if (!person) continue; // its lookup failed: already reported in failures
          const teamId = person.team ? idFrom(person.team.$ref, "teams") : undefined;
          const team = teamId ? (teamFromEspnId(teamId)?.id ?? null) : null;
          (out.awards[kind.award] ??= []).push({ playerId: null, name: person.displayName, team, prob });
        }
        continue;
      }
      for (const b of books) {
        const espnId = b.team ? idFrom(b.team.$ref, "teams") : undefined;
        const team = espnId ? teamFromEspnId(espnId) : undefined;
        const prob = americanToProb(b.value);
        if (!team) {
          out.issues.push({ kind: "unknown-name", message: `Unknown team in "${item.name}": ${b.team?.$ref ?? "no team"}`, httpStatus: null });
          continue;
        }
        if (prob === null) {
          out.issues.push({ kind: "out-of-range", message: `Unreadable odds "${b.value}" for ${team.id} in "${item.name}"`, httpStatus: null });
          continue;
        }
        (out.teams[kind.metric] ??= {})[team.id] = prob;
      }
    }
    return out;
  },
});
