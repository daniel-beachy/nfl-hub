import { z } from "zod";
import type { AwardMarket } from "../../shared/ids.ts";
import { teamFromName, type TeamId } from "../../shared/teams.ts";
import { americanToProb, failureIssue, fetchParts, otherSeason, partFailure, seasonOfSettlement, teamFromAbbr } from "./odds.ts";
import { defineAdapter, type ParsedSource } from "./types.ts";

// Bovada: an offshore sportsbook, and the flakiest source (missing in 2 of 10 weeks in 2026).
// A bonus source. See docs/SOURCES.md.
// Four coupon paths, each a list of groups > events > display groups > markets > outcomes.
// The bare URL answers `{}`; `?lang=en` returns data. `{}` is treated as empty and retried.

const PATHS = ["nfl-futures", "nfl-awards", "nfl-season-props", "nfl-regular-season-wins"] as const;

const outcome = z.object({
  description: z.string(), // "Kansas City Chiefs", "Joe Burrow (CIN)", "Over 9.5", "Yes"
  price: z.object({ american: z.string() }), // "+500", "-150", "EVEN"
});
const market = z.object({ description: z.string(), outcomes: z.array(outcome) });
const event = z.object({
  description: z.string(),
  startTime: z.number(), // ms; roughly when the market settles
  displayGroups: z.array(z.object({ markets: z.array(market) })),
});
const group = z.object({ events: z.array(event) });
const payload = z.object({ groups: z.array(group), failures: z.array(partFailure) });
type Market = z.infer<typeof market>;

const AWARDS: [RegExp, AwardMarket][] = [
  [/\bmvp\b/, "mvp"],
  [/\boffensive player of the year\b/, "opoy"],
  [/\bdefensive player of the year\b/, "dpoy"],
  [/\boffensive rookie of the year\b/, "oroy"],
  [/\bdefensive rookie of the year\b/, "droy"],
  [/\bcoach of the year\b/, "coy"],
  [/\bcomeback\b/, "cpoy"], // Bovada calls it "Comeback of the Year"
];

type Kind =
  | { metric: "superBowl" | "conference" | "division" | "seed1" }
  | { metric: "playoffs"; team: string }
  | { metric: "wins"; team: string; line: number }
  | { award: AwardMarket };

/** Which of our markets a Bovada market is, from its own and its event's description. */
export function classifyMarket(eventName: string, marketName: string): Kind | null {
  const clean = (s: string) => s.toLowerCase().replace(/\s+/g, " ").trim();
  const ev = clean(eventName);
  const m = clean(marketName);
  if (/super bowl/.test(ev)) return /\bwinner$/.test(m) && !/mvp/.test(m) ? { metric: "superBowl" } : null;
  if (/^(afc|nfc) championship\b.*\bwinner$/.test(m)) return { metric: "conference" };
  if (/^(afc|nfc) #1 seed$/.test(m)) return { metric: "seed1" };
  if (/^(afc|nfc) (east|north|south|west) winner$/.test(m)) return { metric: "division" };
  const playoffs = /^(.+) to make the playoffs$/i.exec(marketName.replace(/\s+/g, " ").trim());
  if (playoffs) return { metric: "playoffs", team: playoffs[1]! };
  const wins = /^(.+) regular season wins \((\d+(?:\.\d+)?)\)$/i.exec(marketName.replace(/\s+/g, " ").trim());
  if (wins) return { metric: "wins", team: wins[1]!, line: Number(wins[2]) };
  if (/draft|grey cup|national championship/.test(ev)) return null;
  for (const [pattern, award] of AWARDS) if (pattern.test(m) && pattern.test(ev)) return { award };
  return null;
}

/** P(over) with the vig removed pairwise, or null when one side is missing. */
function overProb(mk: Market): number | null {
  const side = (re: RegExp) => mk.outcomes.find((o) => re.test(o.description.trim()));
  const over = side(/^over\b/i);
  const under = side(/^under\b/i);
  const po = over ? americanToProb(over.price.american) : null;
  const pu = under ? americanToProb(under.price.american) : null;
  return po !== null && pu !== null && po + pu > 0 ? po / (po + pu) : null;
}

/**
 * The market's median win total from its ladder of lines: the wins where P(over) crosses
 * one half, interpolated between the two lines either side. Null when no two lines
 * straddle one half (no extrapolation). Exported for tests.
 */
export function medianWins(lines: { line: number; over: number }[]): number | null {
  const sorted = [...lines].sort((a, b) => a.line - b.line);
  for (let i = 0; i + 1 < sorted.length; i++) {
    const lo = sorted[i]!;
    const hi = sorted[i + 1]!;
    if (lo.over >= 0.5 && hi.over <= 0.5 && lo.over > hi.over) {
      return lo.line + ((lo.over - 0.5) / (lo.over - hi.over)) * (hi.line - lo.line);
    }
  }
  const exact = sorted.find((l) => l.over === 0.5);
  return exact ? exact.line : null;
}

/** "Joe Burrow (CIN)" -> name and team code. */
function splitCandidate(text: string): { name: string; code: string | null } {
  const t = text.replace(/\s+/g, " ").trim();
  const m = /^(.*?) ?\(([A-Za-z]{2,3})\)$/.exec(t);
  return m ? { name: m[1]!.trim(), code: m[2]! } : { name: t, code: null };
}

const PLACEHOLDER = /^(the )?field$|^any other|^other\b|^no winner/i;

export const bovada = defineAdapter({
  id: "bovada",
  name: "Bovada",
  kind: "market",
  tier: "bonus",
  // Also captured when present, but not complete enough to expect: make playoffs (teams
  // that clinched or were eliminated drop off), win totals (only teams whose lines straddle
  // the median), #1 seed (11 to 13 teams per conference).
  expects: {
    teams: ["superBowl", "conference", "division"],
    awards: ["mvp", "opoy", "dpoy", "oroy", "droy", "coy", "cpoy"],
  },
  payload,

  async fetch({ http, signal }) {
    const isEmpty = (body: unknown) => !Array.isArray(body) || body.length === 0;
    const { results, failures } = await fetchParts(PATHS, 2, (p) => p, (path) =>
      http.getJson(`https://www.bovada.lv/services/sports/event/coupon/events/A/description/football/${path}?lang=en`, { isEmpty }),
    { signal });
    return { groups: PATHS.flatMap((p) => (results.get(p) as unknown[] | undefined) ?? []), failures };
  },

  parse(data, ctx) {
    const out: ParsedSource = { season: null, observedAt: null, teams: {}, awards: {}, issues: data.failures.map(failureIssue) };
    const winLines = new Map<TeamId, { line: number; over: number }[]>();
    const set = (metric: "superBowl" | "conference" | "division" | "seed1" | "playoffs", team: TeamId, prob: number) => {
      const values = (out.teams[metric] ??= {});
      if (values[team] === undefined) values[team] = prob;
    };
    const unknown = (name: string, where: string) =>
      out.issues.push({ kind: "unknown-name", message: `Unknown team "${name}" in "${where.trim()}"`, httpStatus: null });

    const events = data.groups.flatMap((g) => g.events);
    out.season = otherSeason(events.map((e) => seasonOfSettlement(e.startTime)), ctx.season);
    for (const e of events) {
      if (seasonOfSettlement(e.startTime) !== ctx.season) continue;
      for (const mk of e.displayGroups.flatMap((d) => d.markets)) {
        const kind = classifyMarket(e.description, mk.description);
        if (!kind) continue;
        if ("award" in kind) {
          if (out.awards[kind.award]) continue;
          const list = mk.outcomes.flatMap((o) => {
            const { name, code } = splitCandidate(o.description);
            const prob = americanToProb(o.price.american);
            if (!name || PLACEHOLDER.test(name) || prob === null) return [];
            return [{ playerId: null, name, team: code ? (teamFromAbbr(code)?.id ?? null) : null, prob }];
          });
          if (list.length > 0) out.awards[kind.award] = list;
          continue;
        }
        if (kind.metric === "wins" || kind.metric === "playoffs") {
          const team = teamFromName(kind.team);
          if (!team) {
            unknown(kind.team, mk.description);
            continue;
          }
          if (kind.metric === "wins") {
            const over = overProb(mk);
            if (over !== null) winLines.set(team.id, [...(winLines.get(team.id) ?? []), { line: kind.line, over }]);
            continue;
          }
          const yes = mk.outcomes.find((o) => /^yes$/i.test(o.description.trim()));
          const no = mk.outcomes.find((o) => /^no$/i.test(o.description.trim()));
          const pYes = yes ? americanToProb(yes.price.american) : null;
          if (pYes === null) continue;
          set("playoffs", team.id, pYes);
          const pNo = no ? americanToProb(no.price.american) : null;
          if (pNo !== null) (out.playoffsNo ??= {})[team.id] = pNo;
          continue;
        }
        for (const o of mk.outcomes) {
          const team = teamFromName(o.description);
          const prob = americanToProb(o.price.american);
          if (!team) {
            if (!PLACEHOLDER.test(o.description.trim())) unknown(o.description, mk.description);
            continue;
          }
          if (prob !== null) set(kind.metric, team.id, prob);
        }
      }
    }
    for (const [team, lines] of winLines) {
      const wins = medianWins(lines);
      if (wins !== null) (out.teams.wins ??= {})[team] = wins;
    }
    return out;
  },
});
