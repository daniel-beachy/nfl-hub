import { z } from "zod";
import type { AwardMarket, DivisionName, TeamMetric } from "../../shared/ids.ts";
import { teamFromKalshiCode, teamFromName, type Team } from "../../shared/teams.ts";
import { SourceError } from "../lib/http.ts";
import { failureIssue, fetchParts, otherSeason, partFailure, seasonOfSettlement } from "./odds.ts";
import { expectShape } from "./run.ts";
import { defineAdapter, type ParsedSource } from "./types.ts";

// Kalshi: a regulated prediction exchange. See docs/SOURCES.md.
// One request per series (a series is one market family, e.g. KXSB = Super Bowl winner).
// Series tickers are stable across years; each year is a new event inside the series, so
// the season is read from each market's expected settlement time, never from the ticker.

const BASE = "https://api.elections.kalshi.com/trade-api/v2";
const PAGE = 1000;
const MAX_PAGES = 5;

const DIVISIONS: DivisionName[] = ["East", "North", "South", "West"];

/** Series ticker -> what it is. Recorded from Kalshi's series list on 2026-11-13. */
export const SERIES: Record<string, { metric: TeamMetric } | { award: AwardMarket }> = {
  KXSB: { metric: "superBowl" },
  KXNFLAFCCHAMP: { metric: "conference" },
  KXNFLNFCCHAMP: { metric: "conference" },
  ...Object.fromEntries(
    ["AFC", "NFC"].flatMap((c) => DIVISIONS.map((d) => [`KXNFL${c}${d.toUpperCase()}`, { metric: "division" as const }])),
  ),
  KXNFLPLAYOFF: { metric: "playoffs" },
  KXNFL1SEED: { metric: "seed1" },
  // The AP award series. Kalshi also lists older look-alikes (KXNFLOPOY, KXNFLDPOY,
  // KXNFLOROY, KXNFLDROY, KXNFLCOACH) that had no markets for 2026.
  KXNFLMVP: { award: "mvp" },
  KXNFLOPOTY: { award: "opoy" },
  KXNFLDPOTY: { award: "dpoy" },
  KXNFLOROTY: { award: "oroy" },
  KXNFLDROTY: { award: "droy" },
  KXNFLCOTY: { award: "coy" },
  KXNFLCPOTY: { award: "cpoy" },
};

const market = z.object({
  ticker: z.string(), // "KXSB-27-JAC": the last part is the team code for team markets
  yes_sub_title: z.string(), // "Jacksonville", "Los Angeles R", "Josh Allen"
  status: z.string(), // active, closed, settled, finalized
  result: z.string().optional(), // "yes" | "no" once settled, "" before
  yes_bid_dollars: z.string().optional(), // prices are strings: "0.0700"
  yes_ask_dollars: z.string().optional(),
  last_price_dollars: z.string().optional(),
  expected_expiration_time: z.string().optional(),
});
const payload = z.object({
  series: z.record(z.string(), z.array(market)),
  failures: z.array(partFailure),
});
type Market = z.infer<typeof market>;

const PLACEHOLDER = /^(tie\b|other|field\b|no winner)|co-winners/i;

/**
 * The yes probability of one market, or null when it has no usable price. Settled markets
 * are 1 or 0. Open ones use the bid/ask midpoint when the spread is 10 cents or less,
 * otherwise the last trade (the same rule as Polymarket's display).
 */
export function kalshiPrice(m: Pick<Market, "status" | "result" | "yes_bid_dollars" | "yes_ask_dollars" | "last_price_dollars">): number | null {
  if (m.result === "yes") return 1;
  if (m.result === "no") return 0;
  const num = (s: string | undefined) => (s === undefined || s === "" ? NaN : Number(s));
  const bid = num(m.yes_bid_dollars);
  const ask = num(m.yes_ask_dollars);
  const last = num(m.last_price_dollars);
  if (m.status === "active" && Number.isFinite(ask) && ask > 0 && ask - (Number.isFinite(bid) ? bid : 0) <= 0.1) {
    return ((Number.isFinite(bid) ? bid : 0) + ask) / 2;
  }
  return Number.isFinite(last) && last > 0 ? last : null;
}

const SETTLED = new Set(["settled", "finalized", "determined"]);

/**
 * The price fields are optional in the schema because one market can lack them, but a series
 * where no market has them is a rename, not a quiet market (QA-M0-3): falling back to the
 * last trade would change every value and still look ok. Throws schema-drift.
 */
export function checkPriceFields(ticker: string, markets: readonly Market[]): void {
  const active = markets.filter((m) => m.status === "active");
  const settled = markets.filter((m) => SETTLED.has(m.status));
  const required: [Market[], keyof Market][] = [
    [active, "yes_bid_dollars"], [active, "yes_ask_dollars"], [settled, "result"],
  ];
  for (const [group, field] of required) {
    if (group.length > 0 && !group.some((m) => m[field] !== undefined)) {
      throw new SourceError("schema-drift", `Kalshi ${ticker}: none of ${group.length} markets has ${field}`, {
        detail: `series.${ticker}[].${field}`,
      });
    }
  }
}

function teamOf(m: Market): Team | undefined {
  const code = m.ticker.split("-").at(-1) ?? "";
  return teamFromKalshiCode(code) ?? teamFromName(m.yes_sub_title);
}

export const kalshi = defineAdapter({
  id: "kalshi",
  name: "Kalshi",
  kind: "market",
  tier: "standard",
  expects: {
    teams: ["superBowl", "conference", "division", "playoffs", "seed1"],
    awards: ["mvp", "opoy", "dpoy", "oroy", "droy", "coy", "cpoy"],
  },
  payload,

  async fetch({ http, signal }) {
    const { results, failures } = await fetchParts(Object.keys(SERIES), 4, (s) => s, async (ticker) => {
      const all: unknown[] = [];
      let cursor = "";
      for (let page = 0; page < MAX_PAGES; page++) {
        // No status filter: a settled market (a clinched division) still carries its result.
        const url = `${BASE}/markets?series_ticker=${ticker}&limit=${PAGE}${cursor ? `&cursor=${cursor}` : ""}`;
        const body = expectShape(
          z.object({ markets: z.array(z.unknown()), cursor: z.string().nullish() }),
          await http.getJson(url, { maxBytes: 20_000_000 }),
          `Kalshi ${ticker}`,
        );
        all.push(...body.markets);
        cursor = body.cursor ?? "";
        if (!cursor) break;
      }
      return all;
    }, { signal });
    return { series: Object.fromEntries(results), failures };
  },

  parse(data, ctx) {
    const out: ParsedSource = { season: null, observedAt: null, teams: {}, awards: {}, issues: data.failures.map(failureIssue) };
    out.season = otherSeason(
      Object.entries(data.series).flatMap(([t, ms]) => (SERIES[t] ? ms.map((m) => seasonOfSettlement(m.expected_expiration_time)) : [])),
      ctx.season,
    );
    for (const [ticker, markets] of Object.entries(data.series)) {
      const kind = SERIES[ticker];
      if (!kind) continue;
      const current = markets.filter((m) => seasonOfSettlement(m.expected_expiration_time) === ctx.season);
      checkPriceFields(ticker, current);
      for (const m of current) {
        const name = m.yes_sub_title.trim();
        if (!name || PLACEHOLDER.test(name)) continue;
        const prob = kalshiPrice(m);
        if (prob === null) continue;
        if ("award" in kind) {
          (out.awards[kind.award] ??= []).push({ playerId: null, name, team: null, prob });
          continue;
        }
        const team = teamOf(m);
        if (!team) {
          out.issues.push({ kind: "unknown-name", message: `Unknown team "${name}" in ${m.ticker}`, httpStatus: null });
          continue;
        }
        (out.teams[kind.metric] ??= {})[team.id] = prob;
      }
    }
    return out;
  },
});
