import { ELO_PARAMS, rate, type EloParams } from "./elo.ts";
import { isPlayed, type ModelGame } from "./types.ts";

// Scoring the ratings against game results and against the closing spread. docs/MODEL.md
// records the numbers; `npx tsx pipeline/model/cli.ts evaluate` reproduces them.

export interface Score {
  games: number;
  /** Mean squared error of the home win probability. A tie counts as half a win. */
  brier: number;
  logLoss: number;
  /** Share of non-tied games where the side given more than 50% won. */
  accuracy: number;
}

export interface Evaluation {
  model: Score;
  /** The same games scored with the probability implied by the closing spread. */
  spread: Score;
  /** Always saying 50%: the floor any model must beat. */
  coinFlip: Score;
}

/** Standard deviation of the final margin around the closing spread (docs/MODEL.md). */
export const SPREAD_SD = 11.25;

/** Home win probability implied by a closing spread (positive = home favored). */
export function spreadProb(spread: number, sd = SPREAD_SD): number {
  return normalCdf(spread / sd);
}

export function normalCdf(z: number): number {
  // Abramowitz and Stegun 7.1.26, absolute error under 1e-7.
  const x = Math.abs(z) / Math.SQRT2;
  const t = 1 / (1 + 0.3275911 * x);
  const erf = 1 - ((((1.061405429 * t - 1.453152027) * t + 1.421413741) * t - 0.284496736) * t + 0.254829592) * t * Math.exp(-x * x);
  return z >= 0 ? 0.5 * (1 + erf) : 0.5 * (1 - erf);
}

class Tally {
  n = 0;
  sq = 0;
  ll = 0;
  right = 0;
  decided = 0;
  add(p: number, outcome: number) {
    const q = Math.min(Math.max(p, 1e-9), 1 - 1e-9);
    this.n++;
    this.sq += (q - outcome) ** 2;
    this.ll -= outcome * Math.log(q) + (1 - outcome) * Math.log(1 - q);
    if (outcome !== 0.5) {
      this.decided++;
      if (q !== 0.5 && q > 0.5 === (outcome === 1)) this.right++;
    }
  }
  score(): Score {
    return { games: this.n, brier: this.sq / this.n, logLoss: this.ll / this.n, accuracy: this.right / this.decided };
  }
}

/**
 * Score every finished game (regular season and playoffs) of seasons `from` to `to`. Ratings
 * are built from all earlier games in `games`, so pass history back to 1999 for a fair start.
 */
export function evaluate(games: readonly ModelGame[], from: number, to: number, p: EloParams = ELO_PARAMS, sd = SPREAD_SD): Evaluation {
  const model = new Tally();
  const spread = new Tally();
  const coin = new Tally();
  rate(games, to, p, (g, prob) => {
    if (g.season < from || !isPlayed(g) || g.spread === null) return;
    const outcome = g.homeScore > g.awayScore ? 1 : g.homeScore < g.awayScore ? 0 : 0.5;
    model.add(prob, outcome);
    spread.add(spreadProb(g.spread, sd), outcome);
    coin.add(0.5, outcome);
  });
  return { model: model.score(), spread: spread.score(), coinFlip: coin.score() };
}

export interface Tuned {
  params: EloParams;
  logLoss: number;
  brier: number;
}

/** Grid search for the parameters with the lowest log loss on seasons `from` to `to`. */
export function tune(games: readonly ModelGame[], from: number, to: number): Tuned {
  let best: Tuned | null = null;
  for (let k = 10; k <= 36; k += 2) {
    for (let hfa = 30; hfa <= 80; hfa += 2) {
      for (let i = 4; i <= 12; i++) {
        const params = { k, hfa, regress: i / 20 };
        const s = evaluate(games, from, to, params).model;
        if (!best || s.logLoss < best.logLoss) best = { params, logLoss: s.logLoss, brier: s.brier };
      }
    }
  }
  return best!;
}

/** The spread standard deviation whose implied probabilities score best on `from` to `to`. */
export function tuneSpreadSd(games: readonly ModelGame[], from: number, to: number): number {
  let best = SPREAD_SD;
  let bestLoss = Infinity;
  for (let sd = 10; sd <= 17; sd += 0.25) {
    const loss = evaluate(games, from, to, ELO_PARAMS, sd).spread.logLoss;
    if (loss < bestLoss) [best, bestLoss] = [sd, loss];
  }
  return best;
}
