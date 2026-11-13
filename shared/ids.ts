// Canonical identifiers (docs/DATA-CONTRACT.md section 1).
export const SOURCE_IDS = ["hub", "espn-fpi", "draftkings", "polymarket", "kalshi", "bovada"] as const;
export type SourceId = (typeof SOURCE_IDS)[number];

/** Betting markets: the sources the computed `consensus` is a median of. */
export const MARKET_SOURCE_IDS = ["draftkings", "polymarket", "kalshi", "bovada"] as const satisfies readonly SourceId[];

/** Ids that can appear in compiled series: every captured source plus the computed consensus. */
export const SERIES_SOURCE_IDS = ["consensus", ...SOURCE_IDS] as const;
export type SeriesSourceId = (typeof SERIES_SOURCE_IDS)[number];

export const TEAM_METRICS = ["superBowl", "conference", "division", "playoffs", "wins", "seed1"] as const;
export type TeamMetric = (typeof TEAM_METRICS)[number];

export const AWARD_MARKETS = ["mvp", "opoy", "dpoy", "oroy", "droy", "coy", "cpoy"] as const;
export type AwardMarket = (typeof AWARD_MARKETS)[number];

export const SOURCE_KINDS = ["model", "forecast", "market"] as const;
export type SourceKind = (typeof SOURCE_KINDS)[number];

export const SOURCE_TIERS = ["core", "standard", "bonus"] as const;
export type SourceTier = (typeof SOURCE_TIERS)[number];

export const CONFERENCES = ["AFC", "NFC"] as const;
export type Conference = (typeof CONFERENCES)[number];

export const DIVISION_NAMES = ["East", "North", "South", "West"] as const;
export type DivisionName = (typeof DIVISION_NAMES)[number];
export type DivisionId = `${Conference} ${DivisionName}`;
export const DIVISION_IDS: readonly DivisionId[] = CONFERENCES.flatMap((c) =>
  DIVISION_NAMES.map((d): DivisionId => `${c} ${d}`),
);

/** Regular-season games per team. */
export const GAMES_PER_TEAM = 17;

/**
 * The NFL season a calendar date belongs to. The league year turns over in March, so
 * January and February belong to the season that started the previous autumn.
 */
export function seasonForDate(isoDate: string): number {
  const year = Number(isoDate.slice(0, 4));
  const month = Number(isoDate.slice(5, 7));
  if (!Number.isInteger(year) || !(month >= 1 && month <= 12)) throw new Error(`Bad date: ${isoDate}`);
  return month >= 3 ? year : year - 1;
}
