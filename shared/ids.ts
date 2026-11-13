// Canonical identifiers from docs/PLAN.md section 6.1. Full zod schemas arrive in M0-2.
export const SOURCE_IDS = ["hub", "espn-fpi", "draftkings", "polymarket", "kalshi", "bovada"] as const;
export type SourceId = (typeof SOURCE_IDS)[number];

export const TEAM_METRICS = ["superBowl", "conference", "division", "playoffs", "wins", "seed1"] as const;
export type TeamMetric = (typeof TEAM_METRICS)[number];

export const AWARD_MARKETS = ["mvp", "opoy", "dpoy", "oroy", "droy", "coy", "cpoy"] as const;
export type AwardMarket = (typeof AWARD_MARKETS)[number];
