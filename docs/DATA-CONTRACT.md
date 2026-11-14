# NFL Hub: data contract

The shapes the pipeline writes and the app reads. The zod schemas in `shared/` are the source of truth; this file explains them. Change the schema and this file in the same commit.

| File | Schema | Written by | Lives in |
|---|---|---|---|
| `data/snapshots/{season}/{date}.json` | `shared/snapshot.ts` | `pipeline/capture.ts` | `main`, committed, append-only |
| `data/season/{season}/series.json`, `weekly.json` | `shared/series.ts` | `pipeline/compile.ts` (M1-4) | `derived` branch |
| `data/status.json` | `shared/status.ts` | `pipeline/health.ts` | `derived` branch |

## 1. Identifiers (`shared/ids.ts`, `shared/teams.ts`)

- **Season:** the year the season starts. `seasonForDate` puts January and February in the previous year's season; the league year turns over on March 1.
- **Dates:** `YYYY-MM-DD` in UTC. Timestamps are ISO 8601 UTC ending in `Z`.
- **Teams:** nflverse abbreviations (`KC`, `LA`, `WAS`, `JAX`, `LV`). `shared/teams.ts` is the only place provider naming is mapped:

  | Provider form | Example | Lookup |
  |---|---|---|
  | ESPN numeric id | `12`, in `$ref` URLs | `teamFromEspnId` |
  | ESPN abbreviation | `LAR`, `WSH` | `teamFromEspnAbbr` |
  | Full name (Polymarket, Bovada, ESPN) | `Kansas City Chiefs` | `teamFromName` |
  | Nickname (Polymarket win totals) | `Chiefs` | `teamFromName` |
  | Kalshi short name | `Kansas City`, `Los Angeles R`, `New York G` | `teamFromName` |
  | Kalshi ticker suffix | `KXSB-27-JAC`, `-LAR` | `teamFromKalshiCode` |

  `teamFromName` ignores case and punctuation and returns `undefined` for anything ambiguous (`Los Angeles`, `New York`) or unknown. Adapters record an `unknown-name` issue then; they never guess.
- **Team colors:** ESPN's primary and alternate. Never draw with them directly: `readableColor(color, altColor, background)` in `shared/colors.ts` returns a version with at least 3:1 contrast on that background.
- **Players:** nflverse `gsis_id`. Award candidates carry `playerId: null` until the nflverse `players` file is wired in (M0-8), then are matched by name; unmatched candidates keep `null`.
- **Team metrics:** `superBowl` (win it), `conference` (win the conference, i.e. reach the Super Bowl), `division`, `playoffs`, `seed1` are probabilities from 0 to 1. `wins` is a number of regular-season wins (projected, or a market win total).
- **Award markets:** `mvp`, `opoy`, `dpoy`, `oroy`, `droy`, `coy`, `cpoy`.
- **Sources:** `hub`, `espn-fpi`, `draftkings`, `polymarket`, `kalshi`, `bovada`. Compiled series add a computed `consensus`. Each source has a `kind` (`model`, `forecast`, `market`) and a `tier` (`core`, `standard`, `bonus`).

## 2. Daily snapshot

One file per UTC day holding what every source said that day. Observations cannot be fetched again later, so these files are committed and never rewritten once every source is `ok`.

```jsonc
{
  "schemaVersion": 1,
  "season": 2026,
  "date": "2026-11-13",
  "capturedAt": "2026-11-13T08:41:10.000Z",   // first write of the file
  "context": { "phase": "regular", "lastCompletedWeek": 9, "gamesInProgress": false },  // null if ESPN's scoreboard failed
  "sources": {
    "polymarket": {
      "status": "ok",                  // ok | partial | error
      "fetchedAt": "...", "observedAt": null, "durationMs": 384,
      "error": null,                   // the main issue; null exactly when status is ok
      "issues": [],                    // every issue found; empty exactly when status is ok
      "teams": { "KC": { "superBowl": 0.0935, "conference": 0.17, "division": 0.52, "playoffs": 0.89 } },
      "awards": { "mvp": [ { "playerId": null, "name": "Joe Burrow", "team": null, "prob": 0.3065 } ] },
      "coverage": { "superBowl": 32, "conference": 32, "division": 32, "playoffs": 32, "mvp": 25 },
      "raw": { "superBowlSum": 1.0205, "divisionSum.AFC East": 1.003, "playoffsSum": 14.078 },
      "normalized": { "superBowl": true, "conference": true, "division": true, "playoffs": false }  // markets only; optional
    }
  }
}
```

### 2.1 Rules

- A metric a source does not offer is absent. Nothing is zero-filled or null-filled.
- `context.lastCompletedWeek` is the last regular-season week with every game final (18 in the postseason, `null` otherwise). `gamesInProgress: true` tells the weekly view to skip this snapshot.
- `observedAt` is the provider's own timestamp when it gives one (ESPN FPI's `lastUpdated`), else `null`.
- Probabilities are rounded to 4 decimals, wins to 2.
- Award lists hold real candidates only (no "Other" or placeholder rows), sorted by probability, capped at 25.
- Files are written compact. `jq . file.json` to read one.

### 2.2 Checks and normalization (`pipeline/sources/finalize.ts`)

Applied identically to every source after its adapter has mapped provider values to our ids:

1. **Season:** if the provider names a season and it is not the capture season, the whole block is an error (`season-mismatch`).
2. **Range:** one probability outside 0 to 1, or wins outside 0 to 17, removes that whole metric or award market (`out-of-range`): a value out of range is a parse bug, such as a percent read as a fraction, so the values still in range are suspect too. A metric whose values are all zero is removed (`all-zero`).
3. **Two-way markets:** where a sportsbook quotes both "yes" and "no" for making the playoffs, the pair is de-vigged: `yes / (yes + no)`.
4. **Groups that must sum to 1:** Super Bowl (32 teams), `conference` and `seed1` (16 per conference), `division` (4 per division). For a complete group the raw sum goes into `raw` (`superBowlSum`, `conferenceSum.AFC`, `divisionSum.NFC West`). If it is outside 0.95 to 1.6 the group's values are removed (`bad-sum`): the data is wrong, not just vigged. Otherwise, for `market` sources only, values are divided by the sum. Forecasts and models are checked but not rescaled. An incomplete group stays raw, but if its teams already sum above 1.6 they are removed (`bad-sum`): a subset can never exceed the bound.
5. **Totals:** with all 32 teams present, `playoffs` must sum to 12 to 17 (14 teams qualify) and `wins` to 245 to 299 (272 games); otherwise the metric is removed (`bad-sum`).
6. **Awards** are range-checked and never normalized. An award market whose candidates are all zero is removed (`all-zero`); a settled market (one candidate at 1, the rest 0) stays.
7. **Normalized:** for `market` sources, `normalized[metric]` is `true` when every kept value of that probability metric was de-vigged (complete groups, or both sides of a two-way playoffs price) and `false` when any value is raw. Consensus must not mix raw and de-vigged values. Absent for `wins`, for forecasts and models (never rescaled), and in snapshots written before 2026-11-14; readers treat absent as unknown.
8. **Coverage:** teams with a value per metric, candidates per award market. A metric the adapter `expects` with fewer than 32 teams adds `team-coverage` (or `market-missing` at zero); an expected award market with no candidates adds `market-missing`.
9. **Status:** `ok` when there are no issues; `partial` when there are issues and some data; `error` when there is no usable data or the fetch or parse failed.

### 2.3 Issues

`{ kind, message, httpStatus, detail?, payloadHead? }`. `kind` is what `docs/RUNBOOK.md` is indexed by:

| Kind | Meaning |
|---|---|
| `network`, `timeout`, `http-error`, `too-large`, `not-json` | The request failed after three attempts. `timeout` also means the source passed its 3-minute deadline (`SOURCE_DEADLINE_MS` in `pipeline/sources/run.ts`): requests still open are aborted, unfinished parts become `timeout` failures, and an adapter that has not returned 5 s later is an error |
| `empty-response` | A 2xx whose body is the provider's "nothing here" (Bovada's `{}`) |
| `schema-drift` | The provider changed shape. `detail` is the path that no longer matches |
| `season-mismatch` | The provider is serving another season |
| `market-missing` | An expected metric or award market was not found. `detail` names it |
| `unknown-name` | A team name we could not map |
| `team-coverage`, `out-of-range`, `bad-sum`, `all-zero` | A check in 2.2 failed. `detail` names the metric |
| `internal` | A bug on our side |

`payloadHead` is the first 2 KB of the raw response when the response itself was the problem. The full response is saved to `tmp/failed-payloads/{source}-{date}.json`, which the workflow uploads as the `failed-payloads` artifact.

### 2.4 Capturing twice in a day

`capture` writes the file each time a source finishes, so a job killed later keeps every source that finished. It skips sources that are already `ok` today and merges the rest (`mergeBlock`): `ok` is never replaced; `partial` is replaced only by `ok` or by a `partial` with more coverage; an `error` block is replaced by any newer result. A failed fetch therefore never overwrites data. If today's file exists but does not match the schema, capture stops without writing.

## 3. Compiled series

`shared/series.ts`, built in M1-4. One file per season and resolution:

```jsonc
{
  "schemaVersion": 1, "season": 2026, "generatedAt": "...", "resolution": "daily",   // or "weekly"
  "dates": ["2026-09-08", "2026-09-09"],       // shared x axis
  "weeks": [1, 2],                              // weekly files only, aligned with dates
  "metrics": { "superBowl": { "consensus": {
    "availability": { "firstDate": "2026-09-08", "lastDate": "2026-11-13", "daysMissingInLast7": 0 },
    "teams": { "KC": [0.09, null] }             // aligned to dates; null = no value that day
  } } },
  "awards": { "mvp": { "polymarket": { "availability": { }, "candidates": [ { "playerId": null, "name": "Joe Burrow", "team": null, "values": [0.3, 0.31] } ] } } }
}
```

A source appears under a metric only if it has at least one value, so the app shows a tab exactly when there is data. `consensus` is the median of the market sources (`draftkings`, `polymarket`, `kalshi`, `bovada`) on days when at least two have a value.

## 4. status.json

`shared/status.ts`, built by `pipeline/health.ts` from the snapshots on every run.

```jsonc
{
  "schemaVersion": 1, "generatedAt": "...", "season": 2026,
  "overall": "degraded",                 // ok | degraded | down
  "sources": [ {
    "id": "bovada", "name": "Bovada", "kind": "market", "tier": "bonus",
    "status": "error",                   // ok | partial | error | missing (no block in the latest snapshot)
    "lastOk": "2026-11-09", "consecutiveFailures": 3,
    "error": { "kind": "empty-response", "message": "...", "httpStatus": 200 },
    "coverage": {}, "issue": 14          // open GitHub issue number, or null
  } ],
  "stages": [ { "id": "capture", "status": "ok", "lastOk": "...", "detail": "...", "issue": null } ],
  "dataFreshness": { "snapshots": "2026-11-13", "pbp": "2026-11-13" },  // pbp: from the nflverse manifest
  "runUrl": "https://github.com/daniel-beachy/nfl-hub/actions/runs/..."
}
```

`overall` is `down` when a `core` source or a pipeline stage is failing, or when the sources as a whole are down: no `market` source is `ok`, or fewer than two sources are `ok` (`sourcesDown` in `pipeline/health.ts`). It is `degraded` when anything else is not `ok`, and `ok` otherwise. When the sources as a whole are down, one `source-down` issue titled `All sources down` opens on the first such day, beside the per-source issues, and closes when they recover.

The `nflverse` stage's `detail` names the newest play-by-play file and when nflverse last rebuilt it, from the manifest below.

## 5. nflverse manifest

`shared/nflverse.ts`, written by `pipeline/nflverse/stage.ts` to `derived/nflverse/manifest.json` (served at `data/nflverse/manifest.json`) only when every file loaded and passed its checks. It records what the last good nflverse run loaded; the files themselves stay in the workflow cache, not on the derived branch.

```jsonc
{
  "schemaVersion": 1, "generatedAt": "2026-11-13T21:24:01Z", "seasons": [2025, 2026],
  "files": [ {
    "dataset": "pbp",                    // pbp | stats_player | games | players
    "season": 2026,                      // null for games and players (all seasons in one file)
    "name": "play_by_play_2026.parquet", // the release asset
    "updatedAt": "2026-11-13T17:11:44Z", // the asset's updated_at on GitHub
    "size": 10197719, "rows": 24002
  } ],
  "notPublished": []                     // current-season files not out yet (normal before mid-September)
}
```

Checks before the manifest is written: every column in the dataset's `required` list (`pipeline/nflverse/datasets.ts`) exists; the file has rows; a per-season file has no other season's rows; `games` reaches at least last season; `players` has at least 5,000 rows and 1,000 ESPN ids.
