import { join } from "node:path";
import { seasonForDate } from "../shared/ids.ts";
import { LEADER_CATEGORIES, LEADERS_SCHEMA_VERSION, LEADERS_TOP, seasonLeadersSchema, type Leader, type SeasonLeaders } from "../shared/leaders.ts";
import { isTeamId } from "../shared/teams.ts";
import { isMain, parseArgs, REPO_ROOT, writeFileAtomic } from "./lib/files.ts";
import { createHttp } from "./lib/http.ts";
import { DATASETS } from "./nflverse/datasets.ts";
import type { Row } from "./nflverse/read.ts";
import { loadDataset, parseSeasons } from "./nflverse/stage.ts";

// Stat leaders (plan 8.1, M1-8): the top 10 per category from nflverse `stats_player`
// weekly rows, regular season only, with running totals week by week.
//   npm run leaders                      2020 to the current season
//   npm run leaders -- --seasons 2025    one season
// Each season's file is validated before it is written, so a failure leaves the
// previous file in place. Run in the daily workflow's nflverse job, after its download.

const STAT_COLUMNS = ["player_id", "player_display_name", "position", "headshot_url", "season", "week", "season_type", "team", ...LEADER_CATEGORIES.map((c) => c.column)];
const GAME_COLUMNS = ["season", "game_type", "week", "gameday"];

const round = (v: number, decimals: number) => Number(v.toFixed(decimals));

/** Pure: weekly rows and the games table to one season's leaders. Exported for tests. */
export function buildLeaders(season: number, stats: Row[], games: Row[], sourceUpdatedAt: string, generatedAt: string): SeasonLeaders {
  const reg = stats.filter((r) => r.season === season && r.season_type === "REG" && typeof r.player_id === "string");
  const weeks = [...new Set(reg.map((r) => Number(r.week)))].sort((a, b) => a - b);
  const lastDay = new Map<number, string>();
  for (const g of games) {
    if (g.season !== season || g.game_type !== "REG" || typeof g.gameday !== "string") continue;
    const w = Number(g.week);
    if (!lastDay.has(w) || g.gameday > lastDay.get(w)!) lastDay.set(w, g.gameday);
  }
  const missing = weeks.filter((w) => !lastDay.has(w));
  if (missing.length) throw new Error(`games.parquet has no ${season} regular-season game day for week(s) ${missing.join(", ")}`);

  // Latest row per player for name, team, position and headshot.
  const latest = new Map<string, Row>();
  for (const r of reg) {
    const prev = latest.get(r.player_id as string);
    if (!prev || Number(r.week) >= Number(prev.week)) latest.set(r.player_id as string, r);
  }

  const categories = {} as SeasonLeaders["categories"];
  for (const cat of LEADER_CATEGORIES) {
    const byPlayer = new Map<string, number[]>();
    for (const r of reg) {
      const v = r[cat.column];
      if (typeof v !== "number" || v === 0) continue;
      const perWeek = byPlayer.get(r.player_id as string) ?? weeks.map(() => 0);
      perWeek[weeks.indexOf(Number(r.week))]! += v;
      byPlayer.set(r.player_id as string, perWeek);
    }
    const ranked = [...byPlayer].map(([id, perWeek]) => ({ id, perWeek, total: perWeek.reduce((a, b) => a + b, 0) })).sort((a, b) => b.total - a.total || a.id.localeCompare(b.id));
    categories[cat.id] = ranked.slice(0, LEADERS_TOP).map(({ id, perWeek, total }): Leader => {
      const info = latest.get(id)!;
      let run = 0;
      const team = typeof info.team === "string" ? info.team : null;
      return {
        playerId: id,
        name: String(info.player_display_name ?? id),
        team: team && isTeamId(team) ? team : null,
        position: typeof info.position === "string" ? info.position : null,
        headshot: typeof info.headshot_url === "string" && info.headshot_url ? info.headshot_url : null,
        total: round(total, cat.decimals),
        cumulative: perWeek.map((v) => round((run += v), cat.decimals)),
      };
    });
  }
  return seasonLeadersSchema.parse({ schemaVersion: LEADERS_SCHEMA_VERSION, season, generatedAt, sourceUpdatedAt, weeks, dates: weeks.map((w) => lastDay.get(w)!), categories });
}

if (isMain(import.meta.url)) {
  const args = parseArgs(process.argv.slice(2));
  const today = new Date().toISOString().slice(0, 10);
  const current = seasonForDate(today);
  const seasons = typeof args.seasons === "string" ? parseSeasons(args.seasons) : parseSeasons(`2020-${current}`);
  const outDir = join(REPO_ROOT, typeof args.out === "string" ? args.out : "derived", "season");
  const http = createHttp();
  const games = await loadDataset(http, DATASETS.games, null, GAME_COLUMNS);
  const failures: string[] = [];
  for (const season of seasons) {
    try {
      const stats = await loadDataset(http, DATASETS.stats_player, season, STAT_COLUMNS);
      const leaders = buildLeaders(season, stats.rows, games.rows, stats.file.updatedAt, new Date().toISOString());
      writeFileAtomic(join(outDir, String(season), "leaders.json"), `${JSON.stringify(leaders)}\n`);
      console.log(`  ok  ${season}: weeks ${leaders.weeks.at(0) ?? "-"} to ${leaders.weeks.at(-1) ?? "-"}, ${leaders.categories.passingYards?.[0]?.name ?? "no passing"} leads passing yards`);
    } catch (err) {
      // A season not yet published (before mid-September) is not a failure worth an issue.
      const message = err instanceof Error ? err.message : String(err);
      if (season === current && /not in the nflverse-data/.test(message) && today < `${current}-09-15`) console.log(`  not yet published: ${season}`);
      else failures.push(`${season}: ${message}`);
    }
  }
  if (failures.length) {
    console.error(`leaders failed (previous files kept):\n- ${failures.join("\n- ")}`);
    process.exitCode = 1;
  }
}
