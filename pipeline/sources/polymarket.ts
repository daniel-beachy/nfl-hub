import { z } from "zod";
import type { AwardMarket, TeamMetric } from "../../shared/ids.ts";
import { teamFromName } from "../../shared/teams.ts";
import { SourceError, type Http } from "../lib/http.ts";
import { expectShape } from "./run.ts";
import { defineAdapter, type ParsedSource } from "./types.ts";

// Polymarket (Gamma API): a prediction market. See docs/SOURCES.md.
// Events are found by tag and title pattern, never by slug: slugs change every year.

const market = z.object({
  groupItemTitle: z.string().optional(), // the team or candidate this yes/no market is about
  outcomePrices: z.string().optional(), // JSON text: '["0.14", "0.86"]', yes first
  bestBid: z.number().optional(), // absent when nobody is bidding
  bestAsk: z.number().optional(),
  lastTradePrice: z.number().optional(),
  active: z.boolean().optional(),
  closed: z.boolean().optional(),
});
const event = z.object({
  title: z.string(),
  endDate: z.string().optional(),
  volume: z.number().optional(),
  markets: z.array(market).optional(),
});
const payload = z.object({ teamFutures: z.array(event), awards: z.array(event) });
type Market = z.infer<typeof market>;
type Event = z.infer<typeof event>;

const PAGE = 100;
const MAX_PAGES = 5;

async function eventsByTag(http: Http, tag: string): Promise<unknown[]> {
  const all: unknown[] = [];
  for (let page = 0; page < MAX_PAGES; page++) {
    // No `closed` filter: a market that has resolved (a clinched division) still carries its final price.
    const url = `https://gamma-api.polymarket.com/events?tag_slug=${tag}&limit=${PAGE}&offset=${page * PAGE}`;
    const batch = expectShape(z.array(z.unknown()), await http.getJson(url, { maxBytes: 30_000_000 }), `Polymarket events (${tag})`);
    all.push(...batch);
    if (batch.length < PAGE) break;
  }
  return all;
}

const AWARD_TITLES: [RegExp, AwardMarket][] = [
  [/\bmvp\b/, "mvp"],
  [/\boffensive player of the year\b/, "opoy"],
  [/\bdefensive player of the year\b/, "dpoy"],
  [/\boffensive rookie of the year\b/, "oroy"],
  [/\bdefensive rookie of the year\b/, "droy"],
  [/\bcoach of the year\b/, "coy"],
  [/\bcomeback player of the year\b/, "cpoy"],
];

/** Which of our markets an event title is, if any. Exported for tests. */
export function classifyTitle(title: string): { metric: TeamMetric } | { award: AwardMarket } | null {
  const t = title.toLowerCase().replace(/\s+/g, " ").trim();
  if (/\b(afc|nfc) (east|north|south|west) (champion|winner)$/.test(t)) return { metric: "division" };
  if (/\b(afc|nfc) (champion|winner)$/.test(t)) return { metric: "conference" };
  if (/\bmake (the )?(postseason|playoffs)$/.test(t)) return { metric: "playoffs" };
  if (/\b\d{4} (nfl |pro football )?champion$/.test(t) || /\bsuper bowl( \w+)? (champion|winner)$/.test(t)) {
    return { metric: "superBowl" };
  }
  if (/super bowl|assistant/.test(t)) return null; // "Super Bowl MVP" is not the season award
  for (const [pattern, award] of AWARD_TITLES) if (pattern.test(t)) return { award };
  return null;
}

/** The season an event settles for: futures for season N end between June N and May N+1. */
function seasonOf(e: Event): number | null {
  const end = e.endDate ? new Date(e.endDate) : null;
  if (!end || Number.isNaN(end.getTime())) return null;
  return end.getUTCMonth() >= 5 ? end.getUTCFullYear() : end.getUTCFullYear() - 1;
}

const PLACEHOLDER = /^(other|(player|coach|team) [a-z]{1,2})$/i;

/** The yes probability of one market, or null when it has no usable price. */
function yesPrice(m: Market): number | null {
  const listed = (() => {
    try {
      const first = Number((JSON.parse(m.outcomePrices ?? "[]") as unknown[])[0]);
      return Number.isFinite(first) ? first : null;
    } catch {
      return null;
    }
  })();
  if (m.closed) return listed; // resolved: 0 or 1
  if (m.active === false || m.bestAsk === undefined) return null;
  const bid = m.bestBid ?? 0;
  // Polymarket's own display rule: the midpoint, unless the spread is wide.
  if (m.bestAsk - bid <= 0.1) return (bid + m.bestAsk) / 2;
  return m.lastTradePrice ?? listed;
}

/**
 * bestBid and bestAsk are optional because one market can lack them (nobody bidding), but an
 * event where no open market has them is a rename (QA-M0-3): the fallback prices would change
 * every value and still look ok. Throws schema-drift.
 */
export function checkPriceFields(e: Event): void {
  const open = (e.markets ?? []).filter((m) => m.active !== false && !m.closed);
  for (const field of ["bestBid", "bestAsk"] as const) {
    if (open.length > 0 && !open.some((m) => m[field] !== undefined)) {
      throw new SourceError("schema-drift", `Polymarket "${e.title.trim()}": none of ${open.length} open markets has ${field}`, {
        detail: `events[${JSON.stringify(e.title.trim())}].markets[].${field}`,
      });
    }
  }
}

export const polymarket = defineAdapter({
  id: "polymarket",
  name: "Polymarket",
  kind: "market",
  tier: "standard",
  expects: {
    teams: ["superBowl", "conference", "division", "playoffs"],
    awards: ["mvp", "opoy", "dpoy", "oroy", "droy", "coy", "cpoy"],
  },
  payload,

  async fetch({ http }) {
    const [teamFutures, awards] = await Promise.all([eventsByTag(http, "nfl-team-futures"), eventsByTag(http, "nfl-awards")]);
    return { teamFutures, awards };
  },

  parse(data, ctx) {
    const out: ParsedSource = { season: null, observedAt: null, teams: {}, awards: {}, issues: [] };
    const events = [...data.teamFutures, ...data.awards]
      .filter((e) => seasonOf(e) === ctx.season)
      // Highest volume first, so if two events claim one market the busier one wins.
      .sort((a, b) => (b.volume ?? 0) - (a.volume ?? 0));

    for (const e of events) {
      const kind = classifyTitle(e.title);
      if (!kind) continue;
      const isAward = "award" in kind;
      if (isAward && out.awards[kind.award]) continue;
      checkPriceFields(e);
      for (const m of e.markets ?? []) {
        const name = m.groupItemTitle?.trim();
        if (!name || PLACEHOLDER.test(name)) continue;
        const prob = yesPrice(m);
        if (prob === null) continue;
        if (isAward) {
          (out.awards[kind.award] ??= []).push({ playerId: null, name, team: null, prob });
          continue;
        }
        const team = teamFromName(name);
        if (!team) {
          out.issues.push({ kind: "unknown-name", message: `Unknown team "${name}" in "${e.title.trim()}"`, httpStatus: null });
          continue;
        }
        const values = (out.teams[kind.metric] ??= {});
        if (values[team.id] === undefined) values[team.id] = prob;
      }
    }
    return out;
  },
});
