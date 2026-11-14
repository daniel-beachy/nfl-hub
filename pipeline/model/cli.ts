import { readFileSync, writeFileSync } from "node:fs";
import { parseArgs } from "node:util";
import { readRows } from "../nflverse/read.ts";
import { ELO_PARAMS } from "./elo.ts";
import { evaluate, tune, tuneSpreadSd } from "./evaluate.ts";
import { asOf, forecast } from "./forecast.ts";
import { GAME_COLUMNS, toCompact, toModelGames } from "./games.ts";

// Developer commands for the model. The only file in this folder that touches disk.
//   npx tsx pipeline/model/cli.ts evaluate            score 2010-2019 and 2020-2025
//   npx tsx pipeline/model/cli.ts tune                grid-search the Elo parameters on 2010-2019
//   npx tsx pipeline/model/cli.ts forecast 2026       print a forecast (--as-of YYYY-MM-DD, --sims N)
//   npx tsx pipeline/model/cli.ts fixture             rewrite fixtures/games-2020-2025.json
// `--games <path>` points at nflverse games.parquet (default: the nflverse stage's cache).

const { values, positionals } = parseArgs({ options: { games: { type: "string" }, "as-of": { type: "string" }, sims: { type: "string" } }, allowPositionals: true });
const path = values.games ?? "cache/nflverse/schedules/games.parquet";
const buf = readFileSync(path);
const file = buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength) as ArrayBuffer;
const games = toModelGames(await readRows(file, GAME_COLUMNS, "games"));
const fmt = (n: number) => n.toFixed(4);

switch (positionals[0]) {
  case "tune": {
    const t = tune(games, 2010, 2019);
    console.log("best on 2010-2019:", t.params, "log loss", fmt(t.logLoss), "brier", fmt(t.brier));
    console.log("spread sd with the lowest log loss on 2010-2019:", tuneSpreadSd(games, 2010, 2019));
    break;
  }
  case "evaluate": {
    console.log("params", ELO_PARAMS);
    for (const [from, to] of [[2010, 2019], [2020, 2025]] as const) {
      const e = evaluate(games, from, to);
      console.log(`${from}-${to}: ${e.model.games} games`);
      for (const [name, s] of Object.entries(e)) {
        console.log(`  ${name.padEnd(9)} brier ${fmt(s.brier)}  log loss ${fmt(s.logLoss)}  accuracy ${fmt(s.accuracy)}`);
      }
    }
    for (let y = 2020; y <= 2025; y++) {
      const e = evaluate(games, y, y);
      console.log(`  ${y}: model brier ${fmt(e.model.brier)}  spread brier ${fmt(e.spread.brier)}  (${e.model.games} games)`);
    }
    break;
  }
  case "forecast": {
    const season = Number(positionals[1]);
    const t0 = performance.now();
    const f = forecast(values["as-of"] ? asOf(games, values["as-of"]) : games, season, { sims: values.sims ? Number(values.sims) : undefined });
    const ms = performance.now() - t0;
    const pct = (n: number) => `${(n * 100).toFixed(1).padStart(5)}%`;
    console.log(`${season}: ${f.gamesPlayed} played, ${f.gamesLeft} left, ${f.sims} sims in ${ms.toFixed(0)} ms`);
    console.log("team  elo   wins  playoffs division  seed1   conf  superBowl");
    for (const [id, t] of Object.entries(f.teams).sort((a, b) => b[1].superBowl - a[1].superBowl || b[1].wins - a[1].wins)) {
      console.log(`${id.padEnd(4)} ${t.rating.toFixed(0)}  ${t.wins.toFixed(1).padStart(4)}  ${pct(t.playoffs)}   ${pct(t.division)}  ${pct(t.seed1)} ${pct(t.conference)}  ${pct(t.superBowl)}`);
    }
    break;
  }
  case "fixture": {
    const rows = games.filter((g) => g.season >= 2020 && g.season <= 2025).map(toCompact);
    const out = new URL("./fixtures/games-2020-2025.json", import.meta.url);
    writeFileSync(out, `[\n${rows.map((r) => JSON.stringify(r)).join(",\n")}\n]\n`);
    console.log(`wrote ${rows.length} games`);
    break;
  }
  default:
    console.error("usage: cli.ts evaluate | tune | forecast <season> | fixture [--games path]");
    process.exit(1);
}
