# NFL Hub: QA plan

For QA agents (Opus or Sonnet) and for Dan. The goal is to find problems by using the app and attacking the pipeline, not to confirm that tests pass.

## How a QA pass works

- A pass covers one milestone's sections below, run after that milestone's build tasks and **before** Dan's checkpoint. M4 runs the whole document.
- The QA agent does not fix anything. It reports. A separate build session fixes, then the failed checks are re-run.
- Use the deployed site and the local dev build. Check every UI item at **360, 768 and 1280 px**, in **dark and light**, unless the item says otherwise.
- Do not trust the app's own numbers: where a check says "matches", compare against the named outside source (ESPN's site, nflverse files, the provider's page).
- Parallelize by section: one agent per section is fine. Sections are independent.

### Report format

Write findings to `docs/qa/<date>-<milestone>.md`, one entry per finding:

```text
ID: QA-<milestone>-<n>
Severity: blocker | major | minor | polish
Section / check: e.g. S3 "switching source keeps isolated teams"
Where: URL, viewport, theme, season, team or game
Steps: numbered, minimal
Expected / Actual:
Evidence: screenshot path, console error, or the two numbers compared
```

Severity: **blocker** = wrong data shown as right, a crash, a spoiler leak, or a failed fetch that destroys good data. **major** = a feature unusable at some viewport or a misleading label. **minor** = works but awkward. **polish** = looks.

End each report with: checks run, checks passed, checks that could not be run and why. "Could not verify" is a valid result; a guess is not.

## P. Pipeline and reliability (M0, re-run at M4)

Run these locally with fixtures and with the network deliberately broken (point an adapter at a bad host, feed a truncated fixture, block a domain).

| # | Check | Pass when |
|---|---|---|
| P1 | Each adapter parses its recorded fixture | Contract test green, coverage counts as documented in `docs/SOURCES.md` |
| P2 | Each adapter against the live provider (`npm run doctor`) | Status and coverage match the doc, or the difference is reported |
| P3 | Provider returns HTTP 500, a timeout, empty body, `{}`, HTML instead of JSON | Snapshot still written; that source `error` with a specific `kind`; other sources unaffected |
| P4 | Provider returns valid JSON with a renamed or missing field | `schema-drift` error naming the path; nothing partial is saved as `ok` |
| P5 | Provider returns the wrong season, all zeros, 31 teams, probabilities above 1 | Downgraded to `partial` or `error` with the right `kind`; no bad values in the snapshot |
| P6 | Second run on the same day | `ok` blocks byte-identical; only failed sources retried and merged |
| P7 | Capture runs while a game is in progress | Snapshot flagged `gamesInProgress`; weekly series skips it |
| P8 | Every source fails at once | Workflow still deploys; site shows yesterday's data; `status.json` says `down` |
| P9 | nflverse asset missing, or a column removed | Affected metrics absent, others built; stage reported, previous derived files kept |
| P10 | A stage crashes mid-write | No truncated JSON is ever published; last good file remains |
| P11 | Issue automation | Opens at the tier's threshold, updates in place (no duplicates), closes on recovery |
| P12 | `status.json` against reality | Every `lastOk`, coverage and freshness value is true |
| P13 | Runbook drill: a fresh agent is given only a failing issue and `docs/RUNBOOK.md` | It reproduces and locates the fault without reading unrelated code |
| P14 | Secrets and personal data | None in the repo, snapshots, logs or artifacts |
| P15 | Snapshot size and growth | Daily file under 100 KB |
| P16 | Team and player id mapping | All 32 teams map from every provider's naming; unmatched award candidates are listed, not dropped silently |

## S. Season (M1)

| # | Check | Pass when |
|---|---|---|
| S1 | Every chart in the Outlook list renders for 2026 and for 2022 | No empty charts, no overlapping labels |
| S2 | Source tabs show only sources with data for that metric | No tab leads to an empty chart; no "not available" message exists anywhere |
| S3 | Switch source with teams isolated, a zoom applied, weekly or daily chosen, page scrolled | All of it is preserved; only the lines change |
| S4 | Remembered source disappears (simulate by removing it from the series) | Falls back to the default silently |
| S5 | Stale source | Tab shows "stale since" with the right date |
| S6 | Compare-sources mode for one team | One line per available source, correctly labeled |
| S7 | Spot-check values: 3 teams by 3 metrics by every source, latest date | Match the provider's own page within rounding; de-vigged groups sum to 100% |
| S8 | Consensus | Equals the median of the market sources present that day; absent when fewer than two |
| S9 | Imported v3 history | Ten dates present; 3 values per source match v3's live site |
| S10 | Hub model sanity | Per-conference playoff odds sum to 7, division odds to 1, Super Bowl to 1; eliminated teams show 0; clinched show 1 |
| S11 | Hub model history | Final seeds for 2020 to 2025 match the real ones; backfilled seasons carry the "computed afterwards" label |
| S12 | Gaps | A missing day draws a dashed bridge, not a drop to zero |
| S13 | Leaders | Top 10 for 6 categories match nflverse totals and ESPN's leaders page; cumulative lines never decrease |
| S14 | Awards | Candidates and order match the provider page for 2 awards per source |
| S15 | Season boundaries: preseason, week 1, week 18, playoffs, the day after the Super Bowl, a season with no data yet | Sensible labels, no crash, no mislabeled weeks |
| S16 | Favorite team | Emphasized on every chart; persists across reloads; changing it updates everything |
| S17 | Team colors | All 32 readable on both themes; no two division rivals indistinguishable |
| S18 | Touch | Tooltips, isolation and tabs all work by tap; nothing is hover-only |
| S19 | Status page | Matches `status.json`; links to issues work |
| S20 | Static data fails to load (block `/data/`) | Cached copy with an "offline copy" badge, or a clear message; never a blank page |

## L. Live (M2)

Use the replay harness for most checks, then at least one real live window.

| # | Check | Pass when |
|---|---|---|
| L1 | **Spoiler audit.** With a 60 s delay in replay, at ten random moments compare every on-screen element to the true game state 60 s earlier | Nothing is newer than the delay: score, clock, situation, play feed, win probability chart, box score, drive chart, slate tiles, page title |
| L2 | Cold start with a delay set | Box score and slate scores hidden until synced; plays truncated by wall clock |
| L3 | Calibration | Tapping a play sets the delay to now minus its wall clock; nudges work; the value persists and is always visible |
| L4 | Switching to "live" and back | No flash of future data when the delay is re-enabled |
| L5 | Score and situation | Match ESPN's gamecast at five points in a game |
| L6 | EPA signs and special cases: touchdown, field goal, turnover, turnover on downs, safety, punt, penalty, kneel, end of half, overtime | Sign and rough size are sensible on a reviewed sample of each |
| L7 | EPA accuracy | Numbers in `docs/LIVE-MODEL.md` are reproducible and meet the stated targets, or the miss is reported |
| L8 | Team totals | EPA per play, success rate and splits equal the sum of the play feed |
| L9 | Estimated against official | A finished game shows official nflverse values with the label; an in-progress game shows "estimated" |
| L10 | ESPN failures: timeout, 500, malformed JSON, empty plays array | Last good data stays; a retry notice shows; recovery is automatic |
| L11 | Tab hidden for 10 minutes, laptop sleep, network drop | Polling pauses and resumes; no burst of requests; the buffer recovers |
| L12 | Request rate | No more than one scoreboard call per 15 s and one summary per 10 s |
| L13 | Slate states: pregame, live, halftime, final, overtime, postponed, bye week, no games today | Each shown correctly |
| L14 | Explainers | Every advanced stat has one; the math in each is right |
| L15 | Biggest-swing and "what mattered" lists | The listed plays really are the largest by WPA or EPA |
| L16 | Phone use during a game | Readable at arm's length; no layout shift as plays arrive; scroll position kept when the feed updates |
| L17 | Post-game for a 2021 game | Loads and is complete |

## A. Players (M3)

| # | Check | Pass when |
|---|---|---|
| A1 | Spot-check 5 players per position, 2 seasons: yards, TDs, EPA per play, CPOE, target share | Match nflverse-derived values computed independently |
| A2 | Zone tables | Cells sum to the player's totals; league averages are plausible; small samples are marked |
| A3 | Field chart | Left and right are not mirrored; depth buckets are right; readable at 360 px; a color-blind-safe scale |
| A4 | Qualification thresholds | Early-season scaling works; no one-game wonders at the top |
| A5 | Traded players, rookies, players with the same name, players who changed position | Shown once, correctly attributed by week |
| A6 | Missing inputs (remove Next Gen Stats, then FTN) | Those metrics hidden; everything else works |
| A7 | Leaders sorting and scatter axes | Every column sorts; axes switch; averages are right |
| A8 | Team view for 3 teams | Shares sum to about 100%; the right players for that season |
| A9 | Compare two players | Same scales on both sides |
| A10 | Seasons 2020 to current, regular season and playoffs | All load; playoffs never mixed into regular totals |
| A11 | Load size | No single request over 500 KB on a player page; first view under 3 s on a throttled phone profile |

## X. Whole app (every milestone, full run at M4)

| # | Check | Pass when |
|---|---|---|
| X1 | Navigation and deep links: reload and share any URL | Lands on the same view and state |
| X2 | Back and forward buttons | Behave as expected through tabs and seasons |
| X3 | Console | No errors or warnings on any page |
| X4 | Viewports 320, 360, 414, 768, 1024, 1280, 1920; iPad portrait and landscape | No horizontal scroll, no clipped controls |
| X5 | Themes | Every page in both; preference persists; no unreadable text |
| X6 | Keyboard and screen reader basics | Everything reachable by keyboard; charts have text alternatives; visible focus |
| X7 | Slow network and offline | Skeletons, not blank screens; clear messages |
| X8 | Cleared storage, and corrupt `localStorage` values | App starts with defaults; never crashes |
| X9 | Safari on iPhone and iPad, Chrome, Firefox | Same behavior |
| X10 | Honesty | Every estimate, model output and retrospective value is labeled; README limitations match reality |
| X11 | Time zones | Game times in the viewer's zone; week boundaries right for a west-coast and a European clock |
| X12 | A week of unattended running | Captures present every day; issues raised only for real faults |

## Exploratory pass

After the tables, spend time using the app the way Dan would on a Sunday: pick a game, follow it on a phone, check a team's odds, look up a player. Report anything confusing, slow, ugly or surprising, even if no check covers it. These findings often matter most.
