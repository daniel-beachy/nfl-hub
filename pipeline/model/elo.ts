import { isPlayed, N_TEAMS, teamIndex, type ModelGame } from "./types.ts";

// Team ratings: Elo with a margin-of-victory multiplier, a home-field term and regression to
// the mean between seasons. docs/MODEL.md says how the parameters were chosen.

export interface EloParams {
  /** Rating points moved per game before the margin multiplier. */
  k: number;
  /** Home-field advantage in rating points (25 points is about one point of spread). */
  hfa: number;
  /** Fraction of the distance to the mean a rating loses between seasons. */
  regress: number;
}

/** Tuned on 2010 to 2019 (docs/MODEL.md). */
export const ELO_PARAMS: EloParams = { k: 22, hfa: 52, regress: 0.45 };

export const ELO_MEAN = 1500;

/** Ratings by team index (see teamIndex). */
export type Ratings = Float64Array;

export function newRatings(): Ratings {
  return new Float64Array(N_TEAMS).fill(ELO_MEAN);
}

/** Probability the home team wins, from the rating difference including home field. */
export function winProb(diff: number): number {
  return 1 / (1 + 10 ** (-diff / 400));
}

export function homeDiff(home: number, away: number, neutral: boolean, p: EloParams): number {
  return home - away + (neutral ? 0 : p.hfa);
}

/**
 * Rating points the home team gains (the away team loses the same) for a final margin of
 * `margin` = home score minus away score. The multiplier grows with the log of the margin and
 * shrinks when the favorite wins, which stops strong teams from running away (the 538 form).
 */
export function eloDelta(diff: number, margin: number, p: EloParams): number {
  const score = margin > 0 ? 1 : margin < 0 ? 0 : 0.5;
  const winnerDiff = margin > 0 ? diff : margin < 0 ? -diff : 0;
  const mult = Math.log(Math.max(Math.abs(margin), 1) + 1) * (2.2 / (winnerDiff * 0.001 + 2.2));
  return p.k * mult * (score - winProb(diff));
}

export function regressToMean(r: Ratings, p: EloParams): void {
  for (let i = 0; i < r.length; i++) r[i] = ELO_MEAN + (1 - p.regress) * (r[i]! - ELO_MEAN);
}

/**
 * Rate every finished game in `games` (must be in playing order) and return the ratings going
 * into the next game of `season`. `visit` sees each game with the home win probability before
 * it was played. Unplayed games are ignored, so callers pass "everything known at the time".
 */
export function rate(
  games: readonly ModelGame[],
  season: number,
  p: EloParams = ELO_PARAMS,
  visit?: (g: ModelGame, homeWinProb: number) => void,
): Ratings {
  const r = newRatings();
  let current: number | null = null;
  for (const g of games) {
    if (!isPlayed(g) || g.season > season) continue;
    if (current !== null && g.season !== current) regressToMean(r, p);
    current = g.season;
    const h = teamIndex(g.home);
    const a = teamIndex(g.away);
    const diff = homeDiff(r[h]!, r[a]!, g.neutral, p);
    visit?.(g, winProb(diff));
    const d = eloDelta(diff, g.homeScore - g.awayScore, p);
    r[h]! += d;
    r[a]! -= d;
  }
  if (current !== null && current < season) regressToMean(r, p);
  return r;
}
