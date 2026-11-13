# Data sources

One section per provider: what we request, the fields we read, what a healthy result looks like, and what has gone wrong before. The adapter file is the source of truth for parsing; this file is the map. When something breaks, start with `docs/RUNBOOK.md`.

Every captured source goes through the same path (`pipeline/README.md`): `fetch` (network only, through `pipeline/lib/http.ts`), the zod `payload` schema (a mismatch is `schema-drift`), `parse` (map to our ids), then `finalize.ts` (range and sum checks, de-vig, status). Markets are de-vigged only for complete groups (32 for the Super Bowl, 16 per conference, 4 per division); two-way make-playoffs markets are de-vigged pairwise where both sides are quoted. Award odds stay raw.

Coverage below was recorded live on 2026-11-13 (season 2026, after week 9), with `npm run capture -- --source <id> --dry-run`.

| Source | Tier | Kind | Team metrics (teams) | Awards (candidates kept, max 25) |
|---|---|---|---|---|
| `espn-fpi` | standard | forecast | superBowl, conference, division, playoffs, wins (32 each) | none |
| `draftkings` | standard | market | superBowl, conference, division, playoffs (32 each) | all seven |
| `polymarket` | standard | market | superBowl, conference, division, playoffs (32 each) | all seven (oroy 5, droy 8, coy 9, cpoy 6) |
| `kalshi` | standard | market | superBowl, conference, division, playoffs, seed1 (32 each) | all seven (cpoy 20) |
| `bovada` | bonus | market | superBowl, conference, division (32 each); also playoffs 27, seed1 24, wins 19 | all seven (oroy 22) |

"Healthy" for every source means `status: "ok"` in the snapshot block, which requires every metric in the adapter's `expects` at 32 teams, every expected award present, complete groups summing to 0.95 to 1.6 before normalization, playoffs summing to 12 to 17 and wins to 245 to 299 when all 32 teams are present. A block with less is `partial`; a block with nothing usable is `error`.

## ESPN FPI (`espn-fpi`)

- **Adapter:** `pipeline/sources/espn-fpi.ts`. **Fixture:** `pipeline/sources/fixtures/espn-fpi/`.
- **Request:** `GET https://sports.core.api.espn.com/v2/sports/football/leagues/nfl/seasons/{season}/powerindex?limit=50`. One request, keyless.
- **Fields read:** `items[].team.$ref` (ESPN team id at the end), `items[].season`, `items[].lastUpdated`, `items[].predictives[]` with `name` and `value`. Stats: `probwintitle` (Super Bowl), `probmaketitlegame` (making the Super Bowl, which is winning the conference), `probwindiv`, `probmakeplayoffs` (all percentages), `projectedw` (wins).
- **Healthy:** 32 items, all five stats present, `lastUpdated` moving daily (it read about 07:00 UTC). `observedAt` is the latest `lastUpdated`.
- **Watch for:** `season` in the payload is checked against the capture season, so a stale season is `season-mismatch`. Before FPI computes a stat, its `value` is missing (allowed by the schema; shows up as `market-missing` or `team-coverage`).

## DraftKings via ESPN (`draftkings`)

- **Adapter:** `pipeline/sources/draftkings.ts`. **Fixture:** `pipeline/sources/fixtures/draftkings/`.
- **Requests:** `GET https://sports.core.api.espn.com/v2/sports/football/leagues/nfl/seasons/{season}/futures?limit=100` (23 markets, one page), then `GET .../seasons/{season}/athletes/{id}` once per award favorite (the top 25 of each award, deduplicated: about 140 requests, 6 at a time, about 1.5 s in total).
- **Fields read:** `items[].$ref` (season), `items[].name`, `items[].futures[0].books[]` with `value` (American odds as a string, `+170`) and `team.$ref` or `athlete.$ref`; from each athlete, `displayName` and `team.$ref`.
- **Market names used:** `NFL - Super Bowl Winner`, `Pro Football (A) Conference Winner`, `Pro Football (N) Conference - Winner`, `Pro Football (A) East  Division - Winner` (double space), `Pro Football (N) West Division` (no "Winner"), `NFL - To Make the Playoffs`, `Regular Season MVP`, `Offensive Player of the Year`, `Defensive Player of the Year`, `Offensive Rookie of the Year`, `Defensive Rookie of the Year`, `Coach of the Year`, `Comeback Player of the Year`. Ignored: stat-leader markets and "Team To Win Most Games".
- **Healthy:** every team metric at 32, every award present, raw sums about 1.05 to 1.21 (the book's margin). "To Make the Playoffs" quotes only the yes side, so playoffs stay raw (sum 14.5 on 2026-11-13).
- **Watch for:** no odds timestamp (`observedAt` is null). Coaches are athletes with no team. A failed athlete lookup drops that candidate and makes the block `partial` with the athlete id in the issue. Candidates have `playerId: null`; ESPN athlete ids can be joined to nflverse `gsis_id` through the nflverse `players` file later.

## Polymarket (`polymarket`)

- **Adapter:** `pipeline/sources/polymarket.ts`. **Fixture:** `pipeline/sources/fixtures/polymarket/`.
- **Requests:** `GET https://gamma-api.polymarket.com/events?tag_slug={tag}&limit=100&offset={n}` for tags `nfl-team-futures` and `nfl-awards`, up to five pages each. **Must send `Accept-Encoding: gzip`**: without it, `limit` above 50 is rejected. Responses are megabytes; the size cap is 30 MB.
- **Fields read:** per event `title`, `endDate` (season: June N to May N+1 is season N), `volume`; per market `groupItemTitle` (the team or candidate), `outcomePrices`, `bestBid`, `bestAsk`, `lastTradePrice`, `active`, `closed`.
- **Price rule:** resolved markets use their final price (0 or 1). Open ones use the bid/ask midpoint when the spread is 10 cents or less, otherwise the last trade.
- **Events are found by title pattern, never by slug** (slugs change yearly): `classifyTitle` in the adapter, with tests of every title form seen.
- **Healthy:** team metrics at 32, all seven awards present (some have only a handful of candidates).
- **Not captured:** win totals (one event per team under tag `nfl`, a much larger listing).

## Kalshi (`kalshi`)

- **Adapter:** `pipeline/sources/kalshi.ts`. **Fixture:** `pipeline/sources/fixtures/kalshi/`.
- **Requests:** `GET https://api.elections.kalshi.com/trade-api/v2/markets?series_ticker={ticker}&limit=1000` (following `cursor`), one per series, 4 at a time, about 2 s in total. Keyless, no status filter (settled markets carry their result).
- **Series:** `KXSB` (Super Bowl), `KXNFLAFCCHAMP`, `KXNFLNFCCHAMP`, `KXNFL{AFC,NFC}{EAST,NORTH,SOUTH,WEST}`, `KXNFLPLAYOFF`, `KXNFL1SEED`, and the AP awards `KXNFLMVP`, `KXNFLOPOTY`, `KXNFLDPOTY`, `KXNFLOROTY`, `KXNFLDROTY`, `KXNFLCOTY`, `KXNFLCPOTY`. Look-alike series without the `T` (`KXNFLOPOY`, `KXNFLDPOY`, `KXNFLOROY`, `KXNFLDROY`, `KXNFLCOACH`) had no 2026 markets. Find series with `GET .../series?category=Sports`.
- **Fields read:** `ticker` (last part is the team code: `KXSB-27-JAC`), `yes_sub_title` (`Jacksonville`, `Los Angeles R`, or a player), `status`, `result`, `yes_bid_dollars`, `yes_ask_dollars`, `last_price_dollars` (all strings), `expected_expiration_time` (gives the season; the year in event tickers is inconsistent: `KXSB-27` but `KXNFL1SEED-NFC26`).
- **Price rule:** settled `result` yes or no is 1 or 0; open markets use the midpoint when the spread is 10 cents or less, else the last price; no price at all is skipped. Placeholder rows (`Tie/Co-Winners`) are skipped.
- **Healthy:** five team metrics at 32 and all seven awards. Raw sums are close to 1 (0.98 to 1.13).
- **Not available:** win totals. `KXNFLWINS-<TEAM>` series exist but had no 2026 markets on 2026-11-13 (only empty 2025-26 events). A failed series makes the block `partial` with the series ticker in the issue.

## Bovada (`bovada`)

- **Adapter:** `pipeline/sources/bovada.ts`. **Fixture:** `pipeline/sources/fixtures/bovada/`.
- **Requests:** `GET https://www.bovada.lv/services/sports/event/coupon/events/A/description/football/{path}?lang=en` for `nfl-futures`, `nfl-awards`, `nfl-season-props` and `nfl-regular-season-wins`, 2 at a time. **The bare URL returns `{}`**; `?lang=en` returns data. Anything that is not a non-empty array is `empty-response` and retried. A path that still fails makes the block `partial`; all four failing makes it `error`.
- **Fields read:** per event `description`, `startTime` (ms, gives the season); per market `description`; per outcome `description` and `price.american` (`+500`, `-150`, `EVEN`).
- **Markets used:** `Super Bowl LXI 2027 Winner`; `AFC Championship 2026-27 Winner` (with a leading non-breaking space); `AFC #1 Seed`; ` AFC North Winner`; `Arizona Cardinals To Make the Playoffs` (Yes and No, de-vigged pairwise when both are quoted); `Steelers Regular Season Wins (9.5)` (a ladder of Over/Under lines per team); and the seven awards (`Comeback of the Year` is CPOY). Award outcomes read `Joe Burrow (CIN)`; the code in brackets gives the team.
- **Win totals:** the median of the market, interpolated between the two lines where the de-vigged P(over) crosses one half. A team whose lines do not straddle one half gets no value (never extrapolated), which is why only 19 teams had one.
- **Healthy:** superBowl, conference, division at 32 and all seven awards. Playoffs, wins and seed1 are bonus metrics and their coverage varies (teams drop off as they clinch or are eliminated).
- **History:** missing entirely in 2 of 10 weeks and partial in most during 2026 in the old tracker. Expect `empty-response`; it is a bonus source (issue after 3 failed days).

## nflverse

Not a snapshot source: it is downloaded by the `nflverse` stage (`pipeline/nflverse/`). See its section in `docs/RUNBOOK.md` and `pipeline/nflverse/README.md` once M0-8 lands.
