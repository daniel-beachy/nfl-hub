# Browser test fixtures

Real files copied unchanged from the live site on 2026-11-15, served under `/data/` by `e2e/data.ts`:

- `data/season/2026/series.json` and `weekly.json` from https://daniel-beachy.github.io/nfl-hub/data/season/2026/
- `data/status.json` from https://daniel-beachy.github.io/nfl-hub/data/status.json

Never hand-edit values here. A test that needs different data (a missing source, say) changes the JSON in flight through `serveFixtures(page, edit)`. To refresh, copy newer files from the live site; tests that name a team or source may need updating.
