# Hub forecast model

The hub's own source (`hub`): team ratings from game results, a simulated rest of season, and playoff odds. Design in `docs/PLAN.md` 8.3. Code in `pipeline/model/`.

## Handoff (M1-1 done, 2026-11-13)

Everything in M1-1 is built, tested and on `main`. All of it is pure TypeScript in `pipeline/model/`; only `cli.ts` touches disk.

| Piece | File | State |
|---|---|---|
| Ratings | `elo.ts`, `games.ts` | Done, tuned on 2010 to 2019 |
| Evaluation | `evaluate.ts` | Done; numbers below. The Brier target was missed by 0.003 |
| Tiebreakers and seeding | `standings.ts` | Done; the real 2020 to 2025 seeds all reproduce with no coin flip |
| Simulation and forecast | `forecast.ts` | Done; 20,000 seasons in about 0.6 s |

Left for M1-2 (Opus), none of it started:

1. A `model` stage (`pipeline/model/stage.ts` and a `model` job in `daily.yml`, per `pipeline/README.md` "Derived data and later stages"): `loadDataset(http, DATASETS.games, ...)` with `GAME_COLUMNS`, then `toModelGames`, then `forecast(games, season)`, written under `derived/`.
2. A zod schema in `shared/` and a section in `docs/DATA-CONTRACT.md` for the output file. The `Forecast` type in `forecast.ts` is the shape to start from.
3. Backfill: for each season 2020 to 2026 and each week, `forecast(asOf(games, date), season)`, where `date` is the day after the week's last game (and one preseason point). `asOf` is what guarantees "only results known at the time"; do not filter games any other way. About 150 forecasts, under two minutes in total.
4. Nothing new is needed from nflverse: every column in `GAME_COLUMNS` is already in the `games` dataset's `required` list.

Try it: `npx tsx pipeline/model/cli.ts forecast 2026` (add `--as-of 2026-10-01` for a past date).

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

## Tiebreakers

`Standings.seed(conference)` returns the playoff order: four division winners, then wild cards. The steps are the NFL's published procedures, in order:

| Step | Within a division | Wild card, or seeding division winners |
|---|---|---|
| 1 | Head to head | Head to head (two clubs: if they met; three or more: only a sweep, winning or losing) |
| 2 | Division record | Conference record |
| 3 | Common games | Common games, if each club has at least four |
| 4 | Conference record | Strength of victory |
| 5 | Strength of victory | Strength of schedule |
| 6 | Strength of schedule | Random draw |
| 7 | Random draw | |

- Whenever a step drops a club, the clubs left start again from step 1.
- Before a wild-card tiebreaker, only the best-placed club of each division is kept, so a club never passes one that finished above it in its own division.
- Records are compared as exact fractions; a tie is half a win. The cancelled 2022 Buffalo at Cincinnati game means those two played 16, which percentages handle.
- The NFL's deeper steps (points rankings, net points, net touchdowns) are not implemented. The random draw stands in for them and was never reached in 2020 to 2025.

**Check:** fed the final results of each season, the model returns the real seeds 1 to 7 in both conferences for all six seasons, 2020 to 2025 (`standings.test.ts`). The expected seeds in the test were written from memory by the building session, not copied from a source, and then checked two ways: the test confirms that each season's six wild-card games in nflverse pair seeds adding to 9 at the better seed's stadium, and the model computes the same order independently.

## Simulation

`forecast(games, season)` in `forecast.ts`:

1. Rate every finished game. Finished regular-season games fill the standings.
2. Play every remaining regular-season game 20,000 times over. The winner is drawn from the Elo probability. The rating then moves as after a real game, with a margin drawn from a normal curve (rating gap / 25, standard deviation 13.5 points) on the winner's side, so a simulated team that keeps winning gets stronger within that simulated season. Simulated games never tie.
3. Seed both conferences with the tiebreakers above.
4. Play the bracket: 2 v 7, 3 v 6, 4 v 5, the better seed at home; reseed so the best seed left hosts the worst; Super Bowl at a neutral site. A playoff game that has really been played takes its real winner.

It is seeded (default seed: the season number), so the same games give the same forecast.

Output per team: `rating`, `playoffs`, `division`, `seed1`, `conference` (winning it), `superBowl`, `wins` (mean) and `winDist` (chance of exactly 0 to 17 wins). Per unplayed game: `homeWinProb` from today's ratings.

With 20,000 seasons a probability near 50% is good to about plus or minus 0.7 points, and near 5% to about 0.3.

## Limits

- Results only. It knows nothing about injuries, quarterbacks, trades or rest, and it lags the markets after news.
- Home field is one number for every team and season. It was tuned on 2010 to 2019; if home field has shrunk since 2020, as is widely reported, that is part of the gap to the spread (not measured here).
- A new season starts from last season's rating pulled 45% toward average. Drafts and free agency are invisible.
- Backfilled forecasts for past seasons are computed afterwards from results known at the time, with parameters that were tuned on 2010 to 2019 only.
