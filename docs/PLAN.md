# NFL Hub: build plan

Written 2026-11-12 by Claude Fable 5.2 with Dan, for later build sessions (mostly Opus).
Status: **plan approved by Dan on 2026-11-12. Building started 2026-11-13; `CLAUDE.md` says what is done.**

Read this whole file before building anything. Tasks are tagged:

- **[F]** core or hard: Fable builds it, only when Dan says go.
- **[O]** well defined and bounded: Opus builds it from this plan.

If something here turns out to be wrong (an endpoint changed, a library does not do what the plan assumes), fix the plan in the same commit as the code and say so in the commit message. Do not silently work around it.

## 1. What this is

One NFL web app with one entry point, replacing five fragmented one-shot projects. Dan is the user. It is a hobby tool: free to run, pleasant to use on a phone, laptop and iPad, and above all **still working a year from now without anyone touching it**.

Three areas, built in this order:

1. **Season**: championship, conference, division and playoff probabilities, projected wins, award odds and stat leaders, over time, from several sources.
2. **Live**: pick a game you are watching and follow it with richer stats (win probability, EPA, success rate), delayed to match your TV so nothing is spoiled. Also good for post-game review.
3. **Players**: advanced QB, RB and WR analytics with field-zone charts, at leaders, team and individual scope, seasons 2020 onward.

Out of scope: fantasy football (Sunday HQ and the Command Center stay separate; Sunday HQ may be rebuilt later as its own project and linked from the hub), logins, anything paid.

Nothing is reused from the old repos except the real 2026 snapshot data in `nfl-season-tracker-v3`. Do not read the old code for inspiration.

## 2. Principles (these decide every tradeoff)

1. **Last known good, always.** A failed fetch never blanks the site and never overwrites good data. Every stage writes only after validating, and the app always has the previous good file.
2. **Sources are optional, the app is not.** Any single provider can vanish and every page still renders. Only ESPN (live games) and nflverse (history, players) are structural; both get explicit degraded modes.
3. **Failures are loud to Claude, quiet to Dan.** The UI shows a small stale badge. The detail goes to `status.json`, a status page, and a GitHub issue that a Claude session can read and act on.
4. **Never invent data.** Missing is missing. Estimates and retrospective computations are labeled as such.
5. **Few moving parts.** One language (TypeScript), one daily workflow, static hosting, a short dependency list with a lockfile. Every dependency is a future breakage.
6. **Provider parsing is isolated and fixture-tested.** Each provider is one adapter file with recorded real payloads as test fixtures, so a fix is a one-file change that a test proves.

## 3. Decisions already made with Dan

| Topic | Decision |
|---|---|
| Name, repo | `nfl-hub`, `daniel-beachy/nfl-hub`, public |
| Hosting | GitHub Pages + one scheduled GitHub Actions workflow (playbook tier 2). No server. Browser calls ESPN directly for live games. |
| Worker later | The live data client goes through one `fetchJson` wrapper with a configurable base URL, so a Cloudflare Worker proxy can be added without touching features. Not built now. |
| Login | None. Favorite team and view preferences live in `localStorage`. |
| Source switching | No global source selector. Each chart has its own source tabs showing only sources that have data for that chart. Switching never resets the view. |
| Capture cadence | Daily. |
| Own model | Yes: a hub forecast model is a first-class source and backfills 2020 to 2025. |
| Live EPA | Yes: estimated in the browser during the game, replaced by official nflverse EPA the next day. |
| Field charts | Zone based (depth by left/middle/right, run gaps). Free data has no per-play x/y coordinates. |
| Seasons | 2020 onward for players and model backfill. |
| Monitoring | Status page in the app, `status.json`, auto-opened GitHub issues, a runbook for Claude. |
| Default source | Consensus (median of the betting markets) where present. |
| Look and feel | Section 11 accepted as the starting point; reviewed with Dan when the first real UI exists (M1). |
| QA | Independent agent QA passes before every checkpoint, per `docs/QA.md`. |
| Old projects | Deprecated per section 12. |

## 4. Data sources (verified live on 2026-11-12)

| Source | Used for | Access | Reliability notes |
|---|---|---|---|
| **ESPN site/core APIs** | Live scoreboard, game summary (plays, win probability, box score), FPI forecasts, schedule, teams, DraftKings futures | Keyless, undocumented, `access-control-allow-origin: *` | Worked every week of 2026. Undocumented, so validate shape and season on every response. |
| **nflverse-data releases** | Play-by-play with EPA/CPOE, weekly player stats, schedules and results, Next Gen Stats, FTN charting, PFR advanced, snap counts, rosters, players | GitHub release assets, keyless | Updated daily in season. Post-game only. The old `player_stats` release is dead (last update 2025-05); use `stats_player`. |
| **Hub model** | Team forecasts for every metric, every week since 2020 | Computed in our pipeline from nflverse `games` | Cannot go offline. |
| **Polymarket Gamma** | Super Bowl, conference, division, make-playoffs, awards | Keyless. **Must send `Accept-Encoding: gzip`**; requests with `limit` above 50 are rejected otherwise. | Worked every week. Event slugs change yearly, so discover by tag and title pattern, never by hard-coded slug. |
| **Kalshi** | Super Bowl (`KXSB`), conference (`KXNFLAFCCHAMP`, `KXNFLNFCCHAMP`), divisions (`KXNFLAFCNORTH` etc.), playoffs (`KXNFLPLAYOFF`), 1 seed (`KXNFL1SEED`), awards (`KXNFLMVP`, `KXNFLOPOTY` etc.; see `docs/SOURCES.md`). No 2026 win totals. | `https://api.elections.kalshi.com/trade-api/v2`, keyless for market data, no CORS header (fine: pipeline only) | New to us. Prices are strings in `yes_bid_dollars`, `yes_ask_dollars`, `last_price_dollars`. Use bid/ask midpoint, falling back to last price when the spread is over 10 cents. |
| **DraftKings via ESPN futures** | Super Bowl, conference, division, make-playoffs, awards | `sports.core.api.espn.com/v2/.../seasons/{y}/futures` | Worked every week. No odds timestamp. |
| **Bovada** | Super Bowl, conference, division, 1 seed, playoffs, win totals, awards (four coupon paths) | Keyless JSON | **Flaky.** Missing entirely in 2 of 10 weeks and partial in most. The bare URL returns `{}`; `?lang=en` returned full data on the day tested. Retry with backoff; treat as a bonus source. |

Not included: **Novig** (only an undocumented GraphQL endpoint that rejected plain requests; revisit if they publish an API). Anything that needs a key or an account.

Exact endpoints live in `docs/SOURCES.md` (task M0-9), one section per source with a sample request, the fields we read, and what "healthy" looks like.

## 5. Architecture

```text
            GitHub Actions: daily.yml (08:00 and 15:00 UTC)
  ┌──────────────────────────────────────────────────────────────┐
  │ capture ─► snapshots (append-only, committed to main)        │
  │ nflverse ─► analytics + leaders + EP table  ┐                │
  │ model ───► hub forecasts                    ├─► derived data │
  │ compile ─► chart-ready series               ┘  (branch)      │
  │ health ──► status.json, GitHub issues                        │
  │ deploy ──► GitHub Pages (app + data)                         │
  └──────────────────────────────────────────────────────────────┘
  Browser ─► static JSON on Pages (season, players)
          ─► ESPN directly, polled (live games only)
```

### 5.1 Stack

- **App:** Vite, React, TypeScript, React Router with hash routing (no Pages 404 tricks). No CSS framework; CSS variables and CSS modules. Charts are our own SVG components on `d3-scale` and `d3-shape` (full control of the 32-line charts and field diagrams, and no chart-library upgrades to break).
- **Pipeline:** TypeScript run with `tsx` on Node 24, in the same repo, sharing types and `zod` schemas with the app. Parquet read with `hyparquet`; if it cannot read an nflverse file, fall back to that release's `.csv.gz` asset (M0-8 proves which).
- **Tests:** Vitest for units and adapter contract tests, Playwright for a small smoke suite at phone and desktop widths.
- Keep runtime dependencies to roughly: `react`, `react-dom`, `react-router`, `d3-scale`, `d3-shape`, `zod`. Justify anything else in the PR.

### 5.2 Repo layout

```text
app/                 React app (src/, index.html, vite.config.ts)
  src/features/season|live|players|status/
  src/ui/            design system: tokens, SourceTabs, charts, Field
  src/lib/           data loading, prefs, espn live client
pipeline/
  sources/           one adapter per provider + fixtures/
  capture.ts         runs adapters, writes snapshots
  nflverse/          download + aggregate
  model/             hub forecast model
  live-model/        EP table builder
  compile.ts         snapshots + model -> chart series
  health.ts          status.json + issue sync
shared/              zod schemas, team table, metric ids (imported by both)
data/snapshots/      committed, append-only: {season}/{YYYY-MM-DD}.json
docs/                PLAN.md, SOURCES.md, RUNBOOK.md, DATA-CONTRACT.md
.github/workflows/   daily.yml, ci.yml
```

### 5.3 Two kinds of data, stored differently

1. **Observations** (odds and forecasts captured from providers) cannot be re-fetched later. They are committed to `main` under `data/snapshots/{season}/{date}.json`, one immutable file per day. Per-day files keep git growth small (target under 100 KB per day; cap award lists at the top 25 candidates per market).
2. **Derived data** (player analytics, stat leaders, model output, compiled chart series, EP table, `status.json`) is reproducible from observations plus nflverse. It is not committed to `main`. Each run publishes it to an orphan branch `derived` with a single force-pushed commit. A stage that fails leaves that stage's previous files in place. The deploy job combines the app build with the `derived` branch contents under `/data/`.

### 5.4 The daily workflow

One workflow, `daily.yml`, on `schedule` (08:00 UTC and 15:00 UTC), `workflow_dispatch`, and push to `main`. GitHub often starts scheduled runs hours late; nothing may depend on the exact time.

Jobs, each independent so one failure does not stop the others:

1. `capture`: run every adapter, validate, write today's snapshot, commit. The 15:00 run only retries sources whose status today is not `ok` and merges results into the same file; an `ok` block is never overwritten.
2. `nflverse`: download needed release assets (cached by asset `updated_at`), build analytics, leaders and the EP table.
3. `model`: update ratings from finished games, simulate, write forecasts.
4. `compile`: turn snapshots and model output into chart-ready series files.
5. `health`: compute `status.json`, open, update or close GitHub issues.
6. `deploy`: build the app, assemble data, deploy to Pages. Runs even if earlier jobs failed, using last known good data.

08:00 UTC is after every night game has ended and after ESPN's FPI refresh (observed around 06:00 to 07:00 UTC). If a game is in progress when a capture actually runs, the snapshot is still written with `gamesInProgress: true` and the weekly view skips it.

The daily commit also keeps the schedule alive (GitHub disables schedules after 60 days without repo activity).

## 6. Data contract

Full schemas go in `shared/` as zod and are documented in `docs/DATA-CONTRACT.md` (M0-2). The shape below is the agreed design.

### 6.1 Identifiers

- Teams: nflverse abbreviations (`KC`, `SF`, `LA`, `WAS`...) as the canonical id. `shared/teams.ts` maps ESPN ids, ESPN abbreviations, Kalshi and Polymarket naming, and Bovada names to it, and holds conference, division and colors (primary, alternate, and a computed readable-on-dark and readable-on-light color).
- Players: nflverse `gsis_id` canonical, with `espn_id` from the nflverse `players` file for joining ESPN and market data. Market candidates that cannot be matched keep their display name and a null id.
- Team metrics: `superBowl`, `conference` (win conference), `division`, `playoffs`, `wins` (projected or market win total), `seed1`.
- Award markets: `mvp`, `opoy`, `dpoy`, `oroy`, `droy`, `coy`, `cpoy`.
- Source ids: `hub`, `espn-fpi`, `draftkings`, `polymarket`, `kalshi`, `bovada`. Plus a computed `consensus`.

### 6.2 Daily snapshot file

```jsonc
{
  "schemaVersion": 1,
  "season": 2026,
  "date": "2026-11-12",
  "capturedAt": "2026-11-12T08:41:10Z",
  "context": { "phase": "regular", "lastCompletedWeek": 9, "gamesInProgress": false },
  "sources": {
    "polymarket": {
      "status": "ok",                    // ok | partial | error
      "fetchedAt": "...", "observedAt": null, "durationMs": 812,
      "error": null,                     // { kind, message, httpStatus } when not ok
      "teams": { "KC": { "superBowl": 0.081, "conference": 0.17, "division": 0.52, "playoffs": 0.83 } },
      "awards": { "mvp": [ { "playerId": "00-0034857", "name": "Josh Allen", "team": "BUF", "prob": 0.24 } ] },
      "coverage": { "superBowl": 32, "conference": 32, "division": 32, "playoffs": 32, "wins": 0 },
      "raw": { "superBowlSum": 1.03 }    // pre-normalization sums, for honesty and debugging
    }
  }
}
```

Rules:

- Probabilities are fractions 0 to 1. `wins` is a number of wins.
- Market probabilities are de-vigged by proportional normalization only when the group is complete (32 for Super Bowl, 16 per conference, 4 per division). Two-way markets (make playoffs yes/no) are de-vigged pairwise. Award probabilities stay raw. Incomplete groups stay raw and the coverage count says so.
- A metric a source does not offer is absent, never zero or null-filled.
- An adapter that throws produces `status: "error"` with the error recorded. The snapshot is still written.

### 6.3 Compiled series (what the app loads)

`data/season/{season}/series.json`: for each metric, each source, each team, an array aligned to a shared date axis, with `null` for missing days, plus per-source availability (`firstDate`, `lastDate`, `daysMissingInLast7`). `consensus` is the median across market sources (`draftkings`, `polymarket`, `kalshi`, `bovada`) with at least two present that day. A second, smaller `weekly.json` holds one point per completed week (the first snapshot after the week's last game) and is the default resolution; the daily view is a toggle.

### 6.4 status.json

```jsonc
{
  "generatedAt": "...",
  "overall": "degraded",                 // ok | degraded | down
  "sources": [ {
    "id": "bovada", "tier": "bonus",     // core | standard | bonus
    "status": "error", "lastOk": "2026-11-09", "consecutiveFailures": 3,
    "error": { "kind": "empty-response", "message": "...", "httpStatus": 200 },
    "coverage": { "superBowl": 0 }, "issue": 14
  } ],
  "stages": [ { "id": "nflverse", "status": "ok", "lastOk": "...", "detail": "pbp 2026 updated 2026-11-12T17:34Z" } ],
  "dataFreshness": { "snapshots": "2026-11-12", "pbp": "2026-11-12", "model": "2026-11-12" }
}
```

## 7. Reliability system

### 7.1 Adapter contract [F]

```ts
interface SourceAdapter<P> {
  id: SourceId; name: string; kind: 'model' | 'forecast' | 'market';
  tier: 'core' | 'standard' | 'bonus';
  expects: { teams: TeamMetric[]; awards: AwardMarket[] }; // what it normally offers
  payload: z.ZodType<P>;                              // the provider shape we rely on
  fetch(ctx: FetchCtx): Promise<unknown>;             // network only, no parsing
  parse(payload: P, ctx: AdapterCtx): ParsedSource;   // pure, no network
}
```

Built in M0-3 (`pipeline/sources/types.ts`); the checks are specified in `docs/DATA-CONTRACT.md` section 2.2.

- `fetch` goes through one shared HTTP helper (`pipeline/lib/http.ts`): host allowlist, 20 s timeout, size cap, explicit `Accept-Encoding: gzip` and a browser-like `User-Agent`, three attempts with backoff on network errors, 5xx, 429, and responses a source declares empty (Bovada's `{}`).
- The framework validates the raw response against `payload` before `parse` sees it. A shape failure is `error.kind: "schema-drift"` and includes the zod path, which tells Claude exactly what changed.
- `parse` only maps provider values to our ids. Sanity checks and de-vigging then run in one shared place (`finalize.ts`), the same for every source: season matches, team count expected, probabilities in range, complete groups sum close to 1 before normalization (0.95 to 1.6), not all zero. Violations downgrade to `partial` or `error` with a specific `kind`.
- Each adapter has `fixtures/<source>/<date>.json`, a real recorded payload trimmed to the fields `payload` reads (Polymarket's raw responses are megabytes), and `<date>.expected.json`, the result it must parse to. One contract test (`contract.test.ts`) runs every adapter against its fixtures. `npm run fixture -- <source>` records a fresh pair.
- On failure, the raw response is written to `tmp/failed-payloads/` and uploaded as a workflow artifact (`failed-payloads`), and its first 2 KB goes into the snapshot's error block.

### 7.2 Health and issues [F]

- Failure thresholds for opening an issue: `core` after 1 failed day, `standard` after 2, `bonus` after 3.
- One issue per source, labeled `source-down`, titled `Source down: <id>`. The body is regenerated each run: error kind and message, last ok date, link to the failing run and artifact, the adapter file path, and the exact repro command. The issue closes itself with a comment when the source recovers.
- Stage failures (nflverse, model, compile, deploy) open `pipeline-broken` issues the same way.
- `health.ts` never fails the workflow; the deploy must still run.

### 7.3 Tools for the fixing session [O, after F defines the contract]

- `npm run doctor`: probes every source live, prints a table (status, coverage, latency, error kind). Read-only.
- `npm run capture -- --source <id> --dry-run`: runs one adapter and prints the normalized result.
- `docs/RUNBOOK.md`: how to read `status.json`, how to reproduce, the usual failure kinds and their usual fixes, how to re-record a fixture, and the rule that a fix ships with an updated fixture.
- `CLAUDE.md` points to the runbook first.

### 7.4 In the app

- Charts never show an error state for a missing source; that source's tab is simply not there, or is marked stale.
- A source whose latest value is older than 3 days gets a small "stale since Nov 9" marker on its tab.
- A footer link "Data status" opens the status page: one row per source and stage, last ok, coverage, link to the open issue.
- If the static data itself fails to load, the app shows the cached copy from the last visit (service worker or `localStorage` for the small season files) with an "offline copy" badge.
- Live mode has its own inline states: "ESPN not responding, retrying", with the last received data left on screen.

## 8. Season area (replaces Sunday Signal)

### 8.1 Pages

- **Outlook:** Super Bowl (32 teams), Make Super Bowl (AFC, NFC), Win Division (8 small multiples), Make Playoffs (AFC, NFC), Projected Wins, 1 seed. Time on the x axis with week bands, team-colored lines, favorite team emphasized, hover and tap tooltips, tap a legend entry to isolate teams.
- **Standings and playoff picture:** current seeds with each team's hub-model playoff, division and seed odds.
- **Leaders:** top 10 per category (passing, rushing, receiving yards and TDs, receptions, sacks, interceptions, plus EPA-based ones from section 10), as current cards and as cumulative week-by-week lines. Built from nflverse `stats_player`, so 2020 to 2025 are real.
- **Awards:** per award, candidates over time, with source tabs.
- Season selector: 2020 to current. Seasons before 2026 have the hub model and leaders only, and say so once at the top.

### 8.2 Source tabs (the fix for Dan's main complaint) [F: component and state model]

- Every chart or chart group has a compact tab row listing only the sources with data for that metric in the visible range. No disabled entries and no "not available in this source" message anywhere.
- Order: Consensus, ESPN FPI, Hub Model, DraftKings, Polymarket, Kalshi, Bovada. The default is the first one present.
- Choosing a tab changes only the data series. Zoom, isolated teams, hovered week, scroll position and resolution are kept. If the chosen source lacks a point, the line has a gap bridged by a dashed segment.
- The choice is remembered per metric in `localStorage`. If the remembered source has no data, fall back to the default without a message.
- A "compare sources" toggle on any chart, with one team selected, draws one line per source for that team.
- Each tab has an info popover: what the source is, whether it is a model, a forecast or a market, when it was last captured, and how values were normalized.

### 8.3 Hub forecast model [F]

Purpose: a source that is always available, covers every metric, and gives real week-by-week history for 2020 to 2025.

- **Input:** nflverse `games` (schedule, results, neutral site flag). Nothing else, so it cannot break on a provider.
- **Ratings:** Elo with a margin-of-victory multiplier and home-field term, ratings carried between seasons with regression to the mean. Tune K, home advantage and regression on 2010 to 2019, evaluate on 2020 to 2025 by Brier score and log loss on game outcomes, and record the numbers in `docs/MODEL.md`. Target: Brier no worse than 0.01 above the closing-spread implied probabilities in nflverse `games` (state the actual result either way).
- **Simulation:** Monte Carlo over all remaining games (20,000 seasons, seeded and reproducible), ratings updated within each simulated season, then the playoff bracket simulated with reseeding and home field.
- **Tiebreakers:** implement the NFL division and wild-card procedures in order through head-to-head, division record, common games, conference record, strength of victory and strength of schedule; break anything deeper randomly. This is the hard part. Test against the real final seeds of 2020 to 2025 (all six seasons must reproduce exactly when fed final results).
- **Output per team:** `playoffs`, `division`, `seed1`, `conference`, `superBowl`, `wins` (mean) and the win distribution; per upcoming game: home win probability (used on the Live slate before kickoff).
- **Backfill:** walk forward through 2020 to 2025 producing one forecast per week using only games played before that point. Label it in the UI as "computed afterwards from results known at the time". Also backfill 2026 weeks 1 to present, then run daily.
- Runs in the pipeline in well under a minute. Pure functions, no I/O inside the model.

### 8.4 Carrying over 2026 history [O]

One-off script `pipeline/import-v3.ts` converts the ten real weekly snapshots in `nfl-season-tracker-v3/public/data/seasons/2026.json` (2026-09-08 to 2026-11-10; ESPN FPI, DraftKings, Bovada, Polymarket, awards) into daily snapshot files on their capture dates. ESPN team ids map to canonical abbreviations; percentages become fractions; the unavailable Bovada weeks stay `error`. The September baseline's retrospectively attached award odds keep a `provenance` note. The mocked 2025 season is not imported. Commit the output, then delete the script's dependency on v3.

## 9. Live area

### 9.1 Pages

- **Slate:** every game this week grouped by status (live, upcoming, final), with score, clock, possession, situation, win probability bar and hub-model pregame odds. Favorite team pinned first. Tap to open a game.
- **Game:** header (score, clock, down and distance, field position strip), win probability chart with the biggest swings marked, play feed where each play shows EPA and win probability change, drive chart, team comparison (EPA per play, success rate, pass and rush splits, third down, explosive plays), player box score with EPA per dropback or carry or target, and a "what mattered" list of the highest-leverage plays.
- **Teach without dumbing down:** every advanced stat has a tap-through explainer: what it is, how it is calculated, what a good number looks like, with this game's own plays as the example.
- **Post-game:** the same page for any finished game since 2020. For games with nflverse play-by-play, official EPA and WP replace the live estimates and a small label says which is shown.

### 9.2 Live data client [F]

- Endpoints: `site.api.espn.com/apis/site/v2/sports/football/nfl/scoreboard` and `.../summary?event={id}` (drives with plays, each with `wallclock`, start and end down, distance and yard line; `winprobability` by play id; box score).
- Polling: scoreboard every 15 s while any game is live, every 5 min otherwise; the open game's summary every 10 s. Pause when the tab is hidden, back off on errors, resume immediately on focus.
- Every response is zod-validated. A bad response is dropped and the last good one stays on screen.
- All requests go through `fetchJson(baseUrl, path)` so a proxy can be introduced later by configuration.

### 9.3 Spoiler delay [F]

One mechanism for everything on screen, so nothing can leak:

- A **time-shift buffer** stores each fetched scoreboard and summary payload with its fetch time. The UI renders the payload from `now - delay`, never the newest one. Scores, clock, box score, win probability and plays are therefore all consistently delayed.
- **Cold start:** when the page opens there is no history yet. Until the buffer covers the delay, show the newest summary truncated to plays whose `wallclock <= now - delay`, derive score and situation from the last visible play, and hide the box score and slate scores behind "syncing, 40 s".
- **Calibration:** "Sync to my TV" shows the last few plays; Dan taps the one that just happened on screen, and the delay becomes `now - thatPlay.wallclock`. Fine-tune with plus and minus 5 s buttons. Stored in `localStorage`, shown permanently in the header ("delayed 38 s"), with a one-tap "live" switch.
- The delay also applies to the document title, notifications and any cached values.
- Known limit, to state in the UI: if ESPN's feed is itself behind the broadcast, the app cannot be ahead of it; the delay can only hold data back.

### 9.4 Live EPA estimator [F]

- **EP table:** built in the pipeline from nflverse play-by-play 2016 to last season, using its `ep` column: smoothed mean expected points by down, distance bucket, yards to end zone, and a late-half flag. Published as a small JSON (`data/live/ep-table.json`).
- **In the browser:** EPA for a play is EP after minus EP before from the offense's point of view, with the standard special cases: touchdowns, field goals and safeties use the points scored; a change of possession uses the negative of the opponent's EP; end of half is zero; penalties and kneels are handled explicitly; kickoffs and extra points are excluded from offensive EPA.
- **Validation before shipping:** run the estimator over every 2025 game using ESPN-shaped play states and compare with official nflverse `epa`. Report per-play correlation and mean absolute error and per-team game totals in `docs/LIVE-MODEL.md`. Targets: correlation at least 0.95, team game totals within 2.0 EPA for 90% of games. If the table cannot reach that, say so and move to a small regression before shipping.
- Win probability uses ESPN's live values (no model of our own); WPA is the difference between consecutive plays.
- All live estimates are labeled "estimated" and replaced by official numbers once nflverse has the game (usually the next morning).

### 9.5 Replay harness [F, small]

`?replay={eventId}&speed=20` feeds a finished game's summary through the same client as if it were live, releasing plays by `wallclock`. It is how Live is developed and tested when no game is on, and the Playwright smoke test uses it with a committed fixture game.

## 10. Players area (the NFL Visualized rebuild)

### 10.1 Data [O, pipeline]

From nflverse, per season 2020 onward, regular season and playoffs separately:

- `pbp`: EPA per play, success rate, CPOE, air yards, YAC, `pass_location` (left, middle, right), `run_location` and `run_gap`, down and distance, pressure and scramble flags.
- `stats_player`: weekly box stats. `nextgen_stats`: time to throw, aggressiveness, separation, cushion, rush yards over expected. `pfr_advstats`: drops, pressures, broken tackles. `ftn_charting`: play action, screens, catchable balls (2022 onward). `snap_counts`, `players`, `rosters`.

Output, sized for lazy loading:

- `data/players/index.json`: id, name, position, team by season, headshot URL.
- `data/players/{season}/leaders.json`: one row per qualified player with every metric (thresholds: QBs 100 dropbacks, RBs 60 carries, WR/TE 30 targets, scaled early in the season).
- `data/players/{season}/players/{id}.json`: weekly lines, season metrics with league percentiles, and zone tables.
- `data/players/{season}/teams/{team}.json`: the team's players and team-level zone tables.
- Zone tables: passing and receiving use depth (behind the line, 0 to 9, 10 to 19, 20 plus air yards) by left, middle, right, each cell with attempts or targets, completion rate, yards, EPA per play, touchdowns, interceptions, and the league average for the cell. Rushing uses seven gaps (left end, left tackle, left guard, middle, right guard, right tackle, right end) with carries, yards per carry, EPA per carry, success rate.

Missing inputs degrade per metric: if Next Gen Stats is unavailable, those columns are absent and the UI hides them.

### 10.2 Views

- **Leaders:** position tabs, a sortable table, and a scatter plot with selectable axes (for example EPA per play against CPOE) with league-average crosshairs.
- **Team:** a franchise's QBs, RBs and receivers side by side, target and carry share, and the team's field charts.
- **Player:** headline metrics with percentile bars, week-by-week trend, field charts, and compare with one other player.

### 10.3 Field charts [F: the `Field` component; O: the pages around it]

One reusable SVG `Field` component draws a football field section with yard lines and shades zones by a chosen metric relative to league average, on a diverging scale, with the count in each cell and a tap-through to detail. Passing and receiving use the depth grid above the line of scrimmage; rushing uses gap lanes at the line. It must read clearly at 360 px wide and in both themes. This is the visual signature of the hub, so it gets real design attention.

## 11. Look and feel (starting point, reviewed with Dan at M1)

- Dark first, with a light theme; the choice persists. Dense but calm: a broadcast analytics desk, not a sportsbook.
- Neutral surfaces; team colors carry meaning (lines, accents, the favorite team), always through the readable-color mapping.
- System font stack with tabular numerals for every number.
- Navigation: Live, Season, Players. A bottom tab bar on phones, a top bar on wider screens. Favorite team picker in the header.
- Layouts designed at 360, 768 and 1280 px. Charts are touch first: tap for tooltip, no hover-only information.
- A small "More projects" link back to the portfolio.

## 12. Deprecation plan

| Repo | Today (2026-11-12) | When | Final state |
|---|---|---|---|
| `nfl-season-tracker` (v1) | Capture workflow disabled | After M4 | Unpublish Pages, archive repo |
| `nfl-season-tracker-v2` | Capture workflow disabled | After M4 | Unpublish Pages, archive repo |
| `nfl-dashboard` | Fetch workflow disabled | After M4 | Unpublish Pages, archive repo |
| `NFL-NERD` | Fetch workflow disabled (was failing since Jan 1) | After M4 | Archive repo |
| `nfl-season-tracker-v3` | **Still capturing weekly** so 2026 history has no gap | At the M1 checkpoint, once Dan accepts the hub's season view and the import is verified | Disable capture, replace the site with a one-line pointer to the hub, archive repo, replace its portfolio card with the hub's |
| `fantasy-dashboard-v1` (Sunday HQ) | Untouched | Not part of this project | Future separate rebuild |
| `fantasy-football-command-center-v1` | Untouched | With a general cleanup of Dan's repos | Archive |

Archiving and unpublishing need Dan's go-ahead at the time. The vault notes for NFL Season Tracker, NFL Live Companion and NFL Visualized should be marked as superseded by NFL Hub; agents may only edit the NFL Hub note, so Dan does this or grants permission.

## 13. Milestones

Each ends with a checkpoint where Dan uses the live site. Do not start a milestone before the previous checkpoint passes.

**QA gate:** before each checkpoint, a separate QA session (Opus or Sonnet, not the session that built the code) runs that milestone's sections of `docs/QA.md` and writes a report to `docs/qa/`. Blockers and majors are fixed and re-checked before Dan is asked to look. Fable does not spend usage on QA.

### M0. Foundation (no visible features)

| # | Task | Who | Done when |
|---|---|---|---|
| M0-1 ✅ | Repo scaffold: Vite app shell, pipeline folder, shared package, lint, `ci.yml` (typecheck, tests, build) | O | CI green on an empty app deployed to Pages |
| M0-2 ✅ | `shared/` schemas and `docs/DATA-CONTRACT.md`: ids, team table, snapshot, series, status | F | Schemas compile; team table round-trips all 32 teams for every provider naming |
| M0-3 ✅ | Adapter framework: HTTP helper, adapter interface, sanity checks, fixture runner, `capture.ts` with merge-not-overwrite | F | Contract tests pass; a forced failure yields a valid snapshot with an error block |
| M0-4 ✅ | Exemplar adapters: `espn-fpi` and `polymarket`, with fixtures | F | Both produce 32-team coverage live and from fixtures |
| M0-5 ✅ | `health.ts`, `status.json`, issue sync | F | Simulated outage opens an issue; recovery closes it |
| M0-6 ✅ | `daily.yml` with independent jobs, `derived` branch publish, deploy that survives failed stages | F | A run with one job forced to fail still deploys with last good data |
| M0-7 ✅ | Remaining adapters from the exemplar pattern: `draftkings`, `kalshi`, `bovada` | O | Each has a fixture and contract test and live coverage recorded in `docs/SOURCES.md` |
| M0-8 | nflverse download module with asset caching; prove `hyparquet` or fall back to csv.gz | O | `pbp`, `stats_player`, `games`, `players` load for 2025 in CI |
| M0-9 | `docs/SOURCES.md`, `docs/RUNBOOK.md`, `npm run doctor`, `CLAUDE.md` | O | A fresh session can diagnose a broken fixture using only the runbook |

M0-1 to M0-6 were finished on 2026-11-13 (✅), M0-7 the same day. Notes for M0-8 and M0-9 are in `pipeline/README.md`.

Checkpoint: Dan sees a bare status page listing every source green, and three days of unattended captures.

### M1. Season

| # | Task | Who | Done when |
|---|---|---|---|
| M1-1 | Hub model: ratings, simulation, tiebreakers, `docs/MODEL.md` | F | 2020 to 2025 final seeds reproduce; evaluation numbers recorded |
| M1-2 | Model backfill 2020 to 2026 and daily run | O | Weekly forecasts exist for every completed week |
| M1-3 | Import v3 2026 snapshots | O | Ten dates present; spot-check three values per source against v3's live site |
| M1-4 | `compile.ts`: series, weekly, consensus | O | Unit tests for alignment, gaps and consensus |
| M1-5 | Design system: tokens, themes, layout shell, navigation, favorite team | F | Looks right at 360, 768, 1280 in both themes |
| M1-6 | `TimeSeriesChart` and `SourceTabs` with the state model in 8.2 | F | Switching source preserves isolation, zoom and scroll; verified by a Playwright test |
| M1-7 | Outlook, Standings, Awards pages | O | All charts in 8.1 render for 2026 and 2022 |
| M1-8 | Leaders pipeline and page | O | 2025 final leaders match nflverse totals |
| M1-9 | Status page and stale markers | O | Matches `status.json` |

Checkpoint: Dan uses the season view for a week. If accepted: retire v3 (section 12).

### M2. Live

| # | Task | Who | Done when |
|---|---|---|---|
| M2-1 | ESPN live client and schemas | F | Survives malformed payloads in tests |
| M2-2 | Time-shift buffer, cold start, calibration | F | Replay test proves no element shows data newer than the delay |
| M2-3 | EP table builder and EPA estimator, validated | F | `docs/LIVE-MODEL.md` reports the numbers against the targets |
| M2-4 | Replay harness and fixture game | F | `?replay=` works locally and in Playwright |
| M2-5 | Slate page | O | Correct for a live window, checked by replay |
| M2-6 | Game page: header, WP chart, play feed, drives, team comparison, box score | O | Verified on a replayed game at phone and desktop widths |
| M2-7 | Stat explainers | O | Every advanced stat has one |
| M2-8 | Post-game mode with official nflverse EPA | O | A 2025 game shows official values and the label |

Checkpoint: Dan watches a real game with it and calibrates the delay.

### M3. Players

| # | Task | Who | Done when |
|---|---|---|---|
| M3-1 | Analytics pipeline for 2020 onward | O | Spot checks against nflverse for five players per position |
| M3-2 | `Field` component | F | Passing grid and rushing lanes readable at 360 px in both themes |
| M3-3 | Leaders view with scatter | O | Sorting, thresholds, axis selection work |
| M3-4 | Player page and compare | O | Verified for a QB, RB, WR and TE |
| M3-5 | Team view | O | Verified for three teams |

Checkpoint: Dan browses players.

### M4. Finish

- Remaining deprecation steps in section 12 [O, with Dan's go-ahead].
- Portfolio card per the portfolio repo's `AGENTS.md` [O].
- README with honest data limitations [O].
- Full `docs/QA.md` pass, all sections [QA agents].
- One week of unattended running with no open issues, or with issues that were correctly raised.

## 14. Risks and open items

- **ESPN changes or blocks browser access.** Live would break. Mitigation: validated client, degraded state, and the proxy seam. Not mitigated in advance beyond that.
- **nflverse changes file names or columns.** Mitigation: column presence checks per file and per-metric degradation; a core-tier health check.
- **GitHub schedule delays or a disabled schedule.** Mitigation: idempotent runs, two schedules a day, daily commits, and a freshness check in `status.json` that the app surfaces if snapshots are more than 2 days old.
- **Repo growth from daily snapshots.** Estimated under 40 MB per year. Revisit yearly; old seasons can move to a release asset.
- **Hub model quality.** It is a simple results-only model and will lag markets on injuries. It is labeled as a model and is one tab among several.
- **Live EPA accuracy.** Unknown until M2-3 measures it; the plan states the fallback.
- **Kalshi coverage** was checked in M0-7 (2026-11-13): every team metric, 1 seed and all seven awards, but no 2026 win totals. `docs/SOURCES.md` has the series list.
- **Things not verified in planning:** `hyparquet` against nflverse files; whether ESPN `wallclock` is close enough to broadcast time for calibration to feel right; Sunday HQ's logged-in flow (out of scope).
