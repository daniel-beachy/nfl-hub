# NFL Hub: context behind the plan

Written 2026-11-12 by the planning session, for whoever builds next. `PLAN.md` says what was decided. This file says why, what Dan actually said, what was rejected, and how much to trust each claim.

**The plan is a strong default, not gospel.** It was written in one session with limited verification. If you find a better approach or a wrong assumption, say so to Dan, change the plan, and carry on. What is fixed is the intent in the next section; the mechanisms are negotiable.

## What Dan cares about, in his words

- "I have done a lot of NFL projects, but they've all kind of been fragmented and they're all slightly unreliable because they were more just one-shot prompts." He wants "a real system that I would like to use that has one entry point."
- "Reliability is the main thing, specifically reliability into the future."
- His sharpest complaint about the old tracker: "I would click a category I want to see, but then it would say this market is not available in this data source. So I would say change data sources, but I wouldn't know which one to change to. And when I change to it, it would reset the visual I was looking at." Per-chart source tabs exist to kill exactly this. If a design ever shows him an empty chart or makes him hunt for a source, it has failed, whatever the plan says.
- On precision: "I don't need extreme precision, this is just a hobby thing." Prefer shipping an honest approximation over blocking on accuracy.
- On stats: "I'm not an expert on what stats are even tracked." The explainers matter, and so does choosing good defaults for him instead of offering every option.
- On field visuals: "I really like to see things visualized with where they are on the field." The Players area is the rebuild of an NFL Visualized prototype he made and never pushed; he was looking forward to it.
- On live: "I could click on a game that I'm watching and keep up with it on my computer with more detailed stats." The spoiler delay is "a nice feature to have", so do not let it compromise the basic live view.
- On fixes: "If there is a broken data source, I will be using a Claude session to fix it." Diagnostics are written for an agent reader.
- On cost: nothing paid, ever. He asked specifically whether anything would push past Cloudflare's free tier.
- On old code: reworks start from scratch. He does not like the prototypes.
- More sources are welcome "so long as it doesn't get too bloated."
- He is open to a login later for syncing favorites and view settings, and was glad the design leaves room for it. Keep that door open: preferences should sit behind one small module so storage can move server-side.
- He invited pushback, and took it well. Push back when something is wrong.

## How Dan works

- Fable (expensive) does planning, design and the hard core. Opus builds everything bounded. Sonnet or Opus agents do QA. Do not spend Fable usage on routine work.
- In Fable sessions, check the 5-hour usage window and stop around 90% used.
- He likes checkpoints where he tries the real thing. He reviews look and feel on real UI, not on descriptions.
- He prefers a plain recommendation to a menu of options.

## Why the big choices went the way they did

- **Static Pages, not a Cloudflare app.** ESPN allows browser requests from any origin, so live needs no server. A server is one more thing to break and to keep inside free limits. The risk accepted: if ESPN blocks browsers, live breaks until a proxy is added.
- **TypeScript for the pipeline too, not Python.** nflverse tooling is better in Python, and this was a close call. One language won because schemas are shared between pipeline and app and because there is one toolchain to keep alive. If parquet reading in Node turns out painful, a small Python step for the nflverse stage alone is a reasonable retreat.
- **Own SVG charts, not a chart library.** The two signature visuals (32 team lines with source switching, and the field) need custom behavior anyway, and libraries are a common source of future breakage. If this costs too much time, a library for the secondary charts is fine.
- **Per-day snapshot files, not one growing season file.** The old tracker rewrote one large JSON weekly; daily would bloat git history.
- **Derived data on an orphan branch.** It keeps reproducible output out of `main` while still giving a last-known-good copy. This is the piece I am least attached to; a simpler mechanism with the same guarantee is welcome.
- **Daily instead of weekly.** The old tracker's hardest logic was deciding whether a week was complete. Daily stamping removes that, and a failed day heals the next day.
- **A results-only Elo model.** Chosen because its only input is the schedule and scores, so it cannot break on a provider. It will be worse than markets, and that is acceptable: it is one tab, labeled a model. Do not grow it into a research project.
- **EP lookup table for live EPA.** The simplest thing that could work in a browser. Porting the real nflfastR model was considered and judged too heavy for a hobby tool. Accuracy is unmeasured.
- **Consensus as the default tab.** It is present whenever any two markets are, so the default view almost never has a gap.
- **No login.** Favorites in the browser cover the need today.

## What was verified, and how firmly

Checked by live request on 2026-11-12:

- Every ESPN endpoint named in the plan returned 200 with data, with `access-control-allow-origin: *`.
- An ESPN game summary for a finished game had 24 drives, 166 plays, 167 win-probability points, and plays with `wallclock`, `start` and `end` (down, distance, `yardLine`, `yardsToEndzone`) and `statYardage`.
- ESPN's core API also has a per-play endpoint (`/events/{id}/competitions/{id}/plays`) with `homeScore`, `awayScore`, `participants`, `probability` and `isTurnover`. The plan uses the summary endpoint; the core one may be better for deriving score at a past moment.
- ESPN FPI's `lastUpdated` moves daily (it read 07:00Z that day). Its probabilities are percentages, and `probmaketitlegame` means making the Super Bowl.
- ESPN's futures list had 23 markets including "To Make the Playoffs", which the old tracker did not use.
- Polymarket rejected an uncompressed request with `limit=100`; with gzip it returned 100 events including Super Bowl, both conferences, make-postseason, MVP and the other awards, and stat-leader markets.
- Kalshi returned 32 Super Bowl markets with string prices. Series tickers were read from its series list.
- Bovada: bare URL gave `{}` twice; with `?lang=en` it gave 291 KB.
- nflverse had 2026 files updated that day for play-by-play, player stats, Next Gen Stats, FTN charting, PFR advanced, snap counts, injuries and depth charts. `pbp_participation` showed no 2026 file.
- The old tracker's scheduled runs started 4 to 6 hours after their cron time.

Assumed from general knowledge, not checked here:

- nflverse play-by-play column names (`ep`, `epa`, `cpoe`, `air_yards`, `pass_location`, `run_location`, `run_gap`) and that `games` carries spreads.
- That `hyparquet` reads nflverse parquet files.
- That Kalshi and Polymarket cover every division and award this season.
- NFL tiebreaker order as written in the plan; check it against the league's published procedures before coding.
- That ESPN `wallclock` is close enough to real time for calibration to feel right.
- Every size, time and accuracy number in the plan (snapshot under 100 KB, 40 MB a year, model under a minute, EPA correlation 0.95) is an estimate or a target, not a measurement.

## Things I would look at harder with more time

- Whether the time-shift buffer is over-built. Truncating plays by `wallclock` and deriving score from the last visible play might be enough on its own, and simpler.
- Whether daily snapshots in the offseason are worth it, or weekly would do from March to August.
- Whether the Season area should also show per-game odds for the coming week; ESPN's scoreboard carries DraftKings lines and a `predictor` endpoint exists. Not in the plan.
- Defense and special teams are absent from Players. Dan asked only for QB, RB and WR.
- ESPN's undocumented API has no terms covering this use. It is a hobby site with low traffic; keep request rates polite.

## State of the old projects

Recorded in `PLAN.md` section 12. The one live dependency: `nfl-season-tracker-v3` still captures weekly and holds the only real 2026 odds history (ten snapshots from 2026-09-08). Import it before retiring it.
