# NFL Hub

One reliable NFL app (season odds, live games, player analytics) replacing Dan's earlier one-shot NFL projects.

- **Start here:** `docs/PLAN.md` is the agreed design, the milestones and who builds what. Read it fully before changing anything.
- **Then read `docs/CONTEXT.md`:** why the plan says what it says, Dan's own words, what was verified and what was only assumed. The plan is a strong default, not gospel: think for yourself, and if something looks wrong or could be simpler, raise it with Dan and update the plan.
- **Status (2026-11-13):** M0 (foundation) is built and live, waiting for its QA pass and checkpoint. Five sources (ESPN FPI, DraftKings, Polymarket, Kalshi, Bovada) are captured twice daily by `.github/workflows/daily.yml`, the nflverse stage downloads and checks play-by-play, player stats, games and players, and the site shows a bare status page. Next: a separate QA session runs `docs/QA.md` section P, then Dan's M0 checkpoint (three days of unattended captures), then M1. Run `npm run check` before every commit.
- **Project note:** `/Users/dbeachy/Library/Mobile Documents/iCloud~md~obsidian/Documents/obsidian-vault/70 Claude/AI Projects/NFL Hub.md`. Follow `AI Projects Playbook.md` in the same folder.
- **Rules that matter most:** reliability over features; a failed fetch never overwrites good data; never invent data; do not read or reuse code from the older NFL repos.
- **QA:** `docs/QA.md` is the test plan; a separate QA session runs it before each checkpoint.
- **Data shapes:** `docs/DATA-CONTRACT.md`. **Providers:** `docs/SOURCES.md`. **Pipeline how-to:** `pipeline/README.md`.
- **Live site:** https://daniel-beachy.github.io/nfl-hub/ (status is at `data/status.json`).
- **When data breaks, start with `docs/RUNBOOK.md`.** Open issues labeled `source-down` or `pipeline-broken` describe each failure; `npm run doctor` probes every source live.
