# Hub forecast model

The hub's own source (`hub`): team ratings from game results, a simulated rest of season, and playoff odds. Design in `docs/PLAN.md` 8.3. Code in `pipeline/model/`.

## Handoff (M1-1 in progress, 2026-11-13)

| Piece | State |
|---|---|
| Ratings (`elo.ts`, `games.ts`) | Done, tuned, tested |
| Evaluation (`evaluate.ts`, `cli.ts`) | Done; numbers below |
| Tiebreakers and seeding (`standings.ts`) | Done; 2020 to 2025 real seeds all reproduce, with no coin flips needed |
| Season and playoff simulation | Not started |
| Forecast output for M1-2 | Not started |

## Ratings

Elo, one number per team, updated after every game (regular season and playoffs).

- Home win probability: `1 / (1 + 10^(-(home - away + hfa) / 400))`; no `hfa` at a neutral site.
- Update: `k * multiplier * (result - probability)`, with `multiplier = ln(|margin| + 1) * 2.2 / (0.001 * winner's rating edge + 2.2)`. A tie is half a win with the multiplier of a one-point game.
- Between seasons each rating moves `regress` of the way back to 1500.
- Franchises keep their rating when they move (OAK to LV, SD to LAC, STL to LA). Everyone starts at 1500 in 1999.

Parameters, chosen by grid search for the lowest log loss on 2010 to 2019 (`cli.ts tune`): **k 22, hfa 52, regress 0.45**.

## Evaluation

Every finished game, regular season and playoffs. The benchmark is the closing spread in nflverse `games`, turned into a probability with a normal curve whose standard deviation (11.25) was fitted on 2010 to 2019 so the benchmark is as strong as it can be.

| Seasons | Games | Model Brier | Spread Brier | Model log loss | Spread log loss | Model picks right | Spread picks right |
|---|---|---|---|---|---|---|---|
| 2010 to 2019 (tuned on) | 2670 | 0.2184 | 0.2111 | 0.6274 | 0.6114 | 65.0% | 66.3% |
| 2020 to 2025 (held out) | 1693 | 0.2225 | 0.2094 | 0.6376 | 0.6070 | 63.7% | 66.6% |

A coin flip scores 0.2493 Brier.

**Against the plan's target:** the target was a Brier no worse than 0.01 above the spread on 2020 to 2025. The actual gap is **0.0131**, so the target is missed by 0.003. The model is clearly better than a coin flip and clearly worse than the market, which is what a results-only model should be. Nothing was tuned on 2020 to 2025 to close the gap.

Reproduce with `npx tsx pipeline/model/cli.ts evaluate` (after `npm run nflverse` has filled the cache).
