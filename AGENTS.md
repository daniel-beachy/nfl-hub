# NFL Hub

One reliable NFL app (season odds, live games, player analytics) replacing Dan's earlier one-shot NFL projects.

- **Start here:** `docs/PLAN.md` is the agreed design, the milestones and who builds what. Read it fully before changing anything.
- **Then read `docs/CONTEXT.md`:** why the plan says what it says, Dan's own words, what was verified and what was only assumed. The plan is a strong default, not gospel: think for yourself, and if something looks wrong or could be simpler, raise it with Dan and update the plan.
- **Status:** M0 in progress (Dan said go 2026-11-13). M0-1 scaffold is committed locally; Pages deploy and M0-2 onward are not done. Run `npm run check` before committing.
- **Project note:** `/Users/dbeachy/Library/Mobile Documents/iCloud~md~obsidian/Documents/obsidian-vault/70 Claude/AI Projects/NFL Hub.md`. Follow `AI Projects Playbook.md` in the same folder.
- **Rules that matter most:** reliability over features; a failed fetch never overwrites good data; never invent data; do not read or reuse code from the older NFL repos.
- **QA:** `docs/QA.md` is the test plan; a separate QA session runs it before each checkpoint.
- Once it exists, `docs/RUNBOOK.md` is the first stop when a data source breaks.
