# Pipeline

TypeScript run with `tsx`. The design is in `docs/PLAN.md` sections 5 to 7; the file shapes are in `docs/DATA-CONTRACT.md`.

| Command | What it does |
|---|---|
| `npm run capture` | Run every source that is not ok yet today and write `data/snapshots/{season}/{date}.json` |
| `npm run capture -- --source kalshi --dry-run` | Run one source and print its block; writes nothing |
| `npm run fixture -- kalshi` | Record today's real payload and expected result as a test fixture |
| `npm run nflverse` | Download changed nflverse files into `cache/nflverse/`, check them, write `derived/nflverse/manifest.json` |
| `npm run nflverse -- --seasons 2020-2026 --datasets pbp --dry-run` | Same for some seasons or datasets; `--dry-run` writes no manifest |
| `npm run health -- --no-issues` | Write `derived/status.json` without touching GitHub issues |
| `npm run check` | Typecheck, lint, tests, build. Run before every commit |

## How a source works

```text
adapter.fetch ──► adapter.payload (zod) ──► adapter.parse ──► finalize ──► block in the snapshot
 network only      provider shape           map to our ids    checks,
 via lib/http.ts   "schema-drift" if off    nothing else      de-vig, status
```

`sources/run.ts` wraps this so that nothing an adapter does can throw past it: every failure becomes an `error` block with a `kind`. `capture.ts` merges blocks into today's file and never replaces better data with worse.

## Adding a source

Copy `sources/polymarket.ts` (a market found by searching) or `sources/espn-fpi.ts` (one request, named stats). Then:

1. Add the host to `ALLOWED_HOSTS` in `lib/http.ts` if it is new.
2. Write `payload`: a zod schema of only the fields you read. Mark fields optional only if you have seen them missing.
3. Write `fetch`: requests only, through `ctx.http.getJson`. Pass `isEmpty` for a provider whose "nothing" is a 200 (Bovada's `{}`).
4. Write `parse`: map provider names to team ids with the lookups in `shared/teams.ts`, return raw implied probabilities. Do not de-vig, check sums or count teams: `finalize.ts` does that the same way for every source. Push an `unknown-name` issue for a team you cannot map; skip "Other" and placeholder rows silently. For a sportsbook's yes/no playoff market, put the "no" side in `playoffsNo`.
5. Set `expects` to what the source really offers today. Anything less than that makes the block `partial`.
6. Add the adapter to `sources/index.ts`, run `npm run fixture -- <id>`, read the `.expected.json` it wrote, and run `npm test`. `contract.test.ts` picks the new adapter up by itself.
7. Record what you found in `docs/SOURCES.md`.

American odds to implied probability: `+500` is `100 / (500 + 100)`, `-150` is `150 / (150 + 100)`.

## What the providers look like

`docs/SOURCES.md` has every source's requests, the fields read, its coverage on the day it was built and what has gone wrong before. Shared helpers for sportsbooks and exchanges (American odds, team codes, settlement season, fetching several parts where one failure only makes the block `partial`) are in `sources/odds.ts`.

## nflverse

`nflverse/stage.ts` is the stage; `nflverse/datasets.ts` lists the files and the columns later stages rely on. A later stage that needs nflverse data calls `loadDataset(http, DATASETS.pbp, 2025, columns)`: it reuses the cache, downloads only if the asset changed, and throws naming any missing column. Add a column to a dataset's `required` list when a stage starts depending on it, so a rename by nflverse fails loudly in this stage rather than quietly downstream.

## Derived data and later stages

Reproducible output (status, and later analytics, model and series files) goes on the orphan `derived` branch, not `main`. In a workflow job: `scripts/derived.sh fetch derived`, write your own files under `derived/`, `scripts/derived.sh push derived`. The deploy job copies the branch to `/data/` on the site, and the app reads it with `loadData` in `app/src/lib/data.ts`.

A new stage is a new job in `.github/workflows/daily.yml` with `needs` on the previous one and `if: always()`. Add it to the `needs` of `health` and `deploy`; `health.ts` then reports its result and opens a `pipeline-broken` issue if it fails, with no other change.
