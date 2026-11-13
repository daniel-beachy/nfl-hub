# Pipeline

TypeScript run with `tsx`. The design is in `docs/PLAN.md` sections 5 to 7; the file shapes are in `docs/DATA-CONTRACT.md`.

| Command | What it does |
|---|---|
| `npm run capture` | Run every source that is not ok yet today and write `data/snapshots/{season}/{date}.json` |
| `npm run capture -- --source kalshi --dry-run` | Run one source and print its block; writes nothing |
| `npm run fixture -- kalshi` | Record today's real payload and expected result as a test fixture |
| `npm run health -- --no-issues` | Write `derived/status.json` without touching GitHub issues |
| `npm run check` | Typecheck, lint, tests, build. Run before every commit |

## How a source works

```text
adapter.fetch ──► adapter.payload (zod) ──► adapter.parse ──► finalize ──► block in the snapshot
 network only      provider shape           map to our ids    checks,
 via lib/http.ts   "schema-drift" if off    nothing else      de-vig, status
```

`sources/run.ts` wraps this so that nothing an adapter does can throw past it: every failure becomes an `error` block with a `kind`. `capture.ts` merges blocks into today's file and never replaces better data with worse.

## Adding a source (M0-7)

Copy `sources/polymarket.ts` (a market found by searching) or `sources/espn-fpi.ts` (one request, named stats). Then:

1. Add the host to `ALLOWED_HOSTS` in `lib/http.ts` if it is new.
2. Write `payload`: a zod schema of only the fields you read. Mark fields optional only if you have seen them missing.
3. Write `fetch`: requests only, through `ctx.http.getJson`. Pass `isEmpty` for a provider whose "nothing" is a 200 (Bovada's `{}`).
4. Write `parse`: map provider names to team ids with the lookups in `shared/teams.ts`, return raw implied probabilities. Do not de-vig, check sums or count teams: `finalize.ts` does that the same way for every source. Push an `unknown-name` issue for a team you cannot map; skip "Other" and placeholder rows silently. For a sportsbook's yes/no playoff market, put the "no" side in `playoffsNo`.
5. Set `expects` to what the source really offers today. Anything less than that makes the block `partial`.
6. Add the adapter to `sources/index.ts`, run `npm run fixture -- <id>`, read the `.expected.json` it wrote, and run `npm test`. `contract.test.ts` picks the new adapter up by itself.
7. Record what you found in `docs/SOURCES.md`.

American odds to implied probability: `+500` is `100 / (500 + 100)`, `-150` is `150 / (150 + 100)`.

## What the providers looked like on 2026-11-13

Seen in live responses while building M0-2 to M0-4. Verify before relying on any of it.

- **Kalshi** `GET https://api.elections.kalshi.com/trade-api/v2/markets?series_ticker=KXSB&status=open&limit=100` returned 32 markets and an empty `cursor`. Team: ticker suffix (`KXSB-27-JAC`, `-LAR`) via `teamFromKalshiCode`, or `yes_sub_title` (`Los Angeles R`, `New York G`) via `teamFromName`. Prices are strings: `yes_bid_dollars`, `yes_ask_dollars`, `last_price_dollars`. The event ticker carries the Super Bowl year (`KXSB-27` for the 2026 season). Other series in the plan (section 4) were not checked.
- **DraftKings via ESPN** `GET https://sports.core.api.espn.com/v2/sports/football/leagues/nfl/seasons/2026/futures?limit=100` returned 23 markets in one page. Each item has `name` and `futures[0].books[]` with `value` (American odds, a string like `+170`) and a `team.$ref` or `athlete.$ref` URL ending in the ESPN id. Names seen: `NFL - Super Bowl Winner`, `Pro Football (A) Conference Winner`, `Pro Football (N) Conference - Winner`, `Pro Football (A) South Division - Winner`, `Pro Football (N) West Division` (no "Winner"), `NFL - To Make the Playoffs`, `Regular Season MVP`, `Offensive Player of the Year`, and the other five awards. Whether "To Make the Playoffs" quotes both sides was not checked. Athlete names need a second request per `$ref`, or the nflverse `players` file (M0-8) by `espn_id`.
- **Bovada** `GET https://www.bovada.lv/services/sports/event/coupon/events/A/description/football/nfl-futures?lang=en` returned an array of groups, each with `events[]`, each with `displayGroups[].markets[].outcomes[]` (`description` is the full team name, `price.american`). Events seen: `Super Bowl LXI 2027` (32), ` AFC Championship 2026-27` (16, note the leading space), `#1 Seed in the AFC Playoffs 2026-27` (11 of 16 teams), the eight divisions (4 each). No make-playoffs, win totals or awards at that URL that day.
- **Polymarket win totals** exist as one event per team (`Pro Football: Bills 2026 Win Total`) under tag `nfl`, not under `nfl-team-futures`. Not captured yet; it would need about four more pages of a large response.

## Derived data and later stages

Reproducible output (status, and later analytics, model and series files) goes on the orphan `derived` branch, not `main`. In a workflow job: `scripts/derived.sh fetch derived`, write your own files under `derived/`, `scripts/derived.sh push derived`. The deploy job copies the branch to `/data/` on the site, and the app reads it with `loadData` in `app/src/lib/data.ts`.

A new stage is a new job in `.github/workflows/daily.yml` with `needs` on the previous one and `if: always()`. Add it to the `needs` of `health` and `deploy`; `health.ts` then reports its result and opens a `pipeline-broken` issue if it fails, with no other change.
