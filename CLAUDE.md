# NFL Hub

One reliable NFL app (season odds, live games, player analytics) replacing Dan's earlier one-shot NFL projects.

- **Start here:** `docs/PLAN.md` is the agreed design, the milestones and who builds what. Read it fully before changing anything.
- **Then read `docs/CONTEXT.md`:** why the plan says what it says, Dan's own words, what was verified and what was only assumed. The plan is a strong default, not gospel: think for yourself, and if something looks wrong or could be simpler, raise it with Dan and update the plan.
- **Status (2026-11-13):** M0 in progress. M0-1 to M0-6 are built and live: two sources (ESPN FPI, Polymarket) are captured daily by `.github/workflows/daily.yml` and the site shows a bare status page. Next, for Opus: M0-7 (three more adapters), M0-8 (nflverse download), M0-9 (docs, runbook, `npm run doctor`). `pipeline/README.md` says how to add a source. Run `npm run check` before every commit.
- **Project note:** `/Users/dbeachy/Library/Mobile Documents/iCloud~md~obsidian/Documents/obsidian-vault/70 Claude/AI Projects/NFL Hub.md`. Follow `AI Projects Playbook.md` in the same folder.
- **Rules that matter most:** reliability over features; a failed fetch never overwrites good data; never invent data; do not read or reuse code from the older NFL repos.
- **QA:** `docs/QA.md` is the test plan; a separate QA session runs it before each checkpoint.
- **Data shapes:** `docs/DATA-CONTRACT.md`. **Pipeline how-to:** `pipeline/README.md`.
- **Live site:** https://daniel-beachy.github.io/nfl-hub/ (status is at `data/status.json`).
- Once it exists, `docs/RUNBOOK.md` is the first stop when a data source breaks. Until then, open issues labeled `source-down` or `pipeline-broken` describe the failure and how to reproduce it.
