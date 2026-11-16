import { createHash } from "node:crypto";
import { join, resolve } from "node:path";
import { seasonForDate } from "../../shared/ids.ts";
import { MODEL_SCHEMA_VERSION, modelSeasonSchema, type ModelPoint, type ModelSeason, type ModelStandings, type ModelTeam } from "../../shared/model.ts";
import { TEAM_IDS, type TeamId } from "../../shared/teams.ts";
import { isMain, parseArgs, readJsonIfExists, REPO_ROOT, writeFileAtomic } from "../lib/files.ts";
import { createHttp } from "../lib/http.ts";
import { DATASETS } from "../nflverse/datasets.ts";
import { loadDataset } from "../nflverse/stage.ts";
import { ELO_PARAMS, type EloParams } from "./elo.ts";
import { asOf, forecast, mulberry32, type Forecast } from "./forecast.ts";
import { MAX_GAMES, Standings } from "./standings.ts";
import { GAME_COLUMNS, toModelGames } from "./games.ts";
import { isPlayed, teamIndex, type ModelGame } from "./types.ts";

// The model stage (docs/PLAN.md 5.4 and 8.3, docs/MODEL.md): for every season since 2020, the
// hub forecast as it stood after every game day, using only the games final before that date
// (`asOf`, the only allowed way to limit games). Writes derived/model/{season}.json.
//   npm run model                    every season from 2020 to the current one
//   npm run model -- --sims 2000     fewer simulations (quick local look; not for the workflow)
//   npm run model -- --dry-run       compute and print, write nothing
// A season whose inputs (its games and every earlier season's, the parameters and the number
// of simulations) are unchanged keeps its previous file, so the daily run recomputes only the
// season in progress. Nothing is written unless every season succeeded, so a failure leaves
// the previous files on the derived branch and health.ts opens a pipeline-broken issue.

export const FIRST_SEASON = 2020;
export const SIMS = 20_000;
/** Bump when the model or this stage changes in a way that changes the output. */
export const MODEL_VERSION = 2;

const round = (n: number, places: number) => Math.round(n * 10 ** places) / 10 ** places;

export function addDays(date: string, days: number): string {
  const d = new Date(`${date}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

function teamsOf(f: Forecast): Record<TeamId, ModelTeam> {
  const out = {} as Record<TeamId, ModelTeam>;
  for (const id of TEAM_IDS) {
    const t = f.teams[id];
    out[id] = {
      rating: round(t.rating, 1),
      playoffs: round(t.playoffs, 4),
      division: round(t.division, 4),
      seed1: round(t.seed1, 4),
      conference: round(t.conference, 4),
      superBowl: round(t.superBowl, 4),
      wins: round(t.wins, 2),
    };
  }
  return out;
}

/** What a season's file depends on. Spreads are left out: only evaluation reads them. */
export function inputHash(games: readonly ModelGame[], season: number, sims: number, params: EloParams): string {
  const h = createHash("sha256");
  h.update(JSON.stringify({ v: MODEL_VERSION, sims, params }));
  for (const g of games) {
    if (g.season > season) continue;
    h.update(JSON.stringify([g.id, g.type, g.week, g.date, g.home, g.away, g.neutral, g.homeScore, g.awayScore]));
  }
  return h.digest("hex").slice(0, 16);
}

export interface PointPlan {
  /** The `asOf` date. */
  date: string;
  week: number;
  phase: ModelPoint["phase"];
  weekComplete: boolean;
}

/**
 * Which points a season gets, from its schedule and results. Pure. A game counts as settled
 * when it is final, or when a later game of the season is final (a game that was never played,
 * like the cancelled 2022 Buffalo at Cincinnati, must not hold back every point after it).
 * A game day gets a point, dated the next day, once all its games are settled.
 */
export function planPoints(games: readonly ModelGame[], season: number): PointPlan[] {
  const inSeason = games.filter((g) => g.season === season);
  const reg = inSeason.filter((g) => g.type === "REG");
  if (reg.length === 0) return [];
  const lastPlayed = inSeason.filter(isPlayed).reduce((d, g) => (g.date > d ? g.date : d), "");
  const settled = (g: ModelGame) => isPlayed(g) || g.date < lastPlayed;
  const first = reg.reduce((d, g) => (g.date < d ? g.date : d), reg[0]!.date);
  const plans: PointPlan[] = [{ date: first, week: 0, phase: "preseason", weekComplete: true }];

  const byDate = new Map<string, ModelGame[]>();
  for (const g of inSeason) byDate.set(g.date, [...(byDate.get(g.date) ?? []), g]);
  const byWeek = new Map<number, ModelGame[]>();
  for (const g of inSeason) byWeek.set(g.week, [...(byWeek.get(g.week) ?? []), g]);

  for (const date of [...byDate.keys()].sort()) {
    const day = byDate.get(date)!;
    if (!day.every(settled) || !day.some(isPlayed)) continue;
    const week = Math.max(...day.map((g) => g.week));
    const weekGames = byWeek.get(week)!;
    const weekEnd = weekGames.reduce((d, g) => (g.date > d ? g.date : d), "");
    plans.push({
      date: addDays(date, 1),
      week,
      phase: day.some((g) => g.type !== "REG") ? "postseason" : "regular",
      weekComplete: date === weekEnd && weekGames.every(settled),
    });
  }
  return plans;
}

export interface SeasonInput {
  games: readonly ModelGame[];
  season: number;
  sims: number;
  params?: EloParams;
  gamesUpdatedAt: string;
  now: Date;
}

/** Records and conference order from the games final before `date`; null if none has been played. Pure. */
export function standingsAsOf(games: readonly ModelGame[], season: number, date: string): ModelStandings | null {
  const st = Standings.from(asOf(games, date).filter((g) => g.season === season));
  if (TEAM_IDS.every((id) => st.gp[teamIndex(id)] === 0)) return null;
  const records = Object.fromEntries(
    TEAM_IDS.map((id) => {
      const t = teamIndex(id);
      let w = 0;
      let ties = 0;
      for (let k = 0; k < st.gp[t]!; k++) {
        const p = st.logPts[t * MAX_GAMES + k];
        if (p === 2) w++;
        else if (p === 1) ties++;
      }
      return [id, { w, l: st.gp[t]! - w - ties, t: ties }];
    }),
  ) as ModelStandings["records"];
  const rng = mulberry32(season);
  const order = (conf: number) => st.seed(conf, rng, 16).map((t) => TEAM_IDS[t]!);
  return { date, records, order: { AFC: order(0), NFC: order(1) } };
}

/** Every point of one season. Pure apart from the clock passed in. Returns null if the season has no schedule. */
export function buildSeason(o: SeasonInput): ModelSeason | null {
  const params = o.params ?? ELO_PARAMS;
  const plans = planPoints(o.games, o.season);
  if (plans.length === 0) return null;
  let last: Forecast | null = null;
  let lastDate = "";
  const points: ModelPoint[] = plans.map((p) => {
    const f = forecast(asOf(o.games, p.date), o.season, { sims: o.sims, params });
    last = f;
    lastDate = p.date;
    return { ...p, gamesPlayed: f.gamesPlayed, gamesLeft: f.gamesLeft, teams: teamsOf(f) };
  });
  const latest = last as Forecast | null;
  const current =
    latest && latest.games.length > 0
      ? {
          date: lastDate,
          winDist: Object.fromEntries(TEAM_IDS.map((id) => [id, latest.teams[id].winDist.map((n) => round(n, 4))])) as Record<TeamId, number[]>,
          games: latest.games.map((g) => ({ id: g.id, week: g.week, date: g.date, home: g.home, away: g.away, homeWinProb: round(g.homeWinProb, 4) })),
        }
      : null;
  return modelSeasonSchema.parse({
    schemaVersion: MODEL_SCHEMA_VERSION,
    season: o.season,
    generatedAt: o.now.toISOString(),
    sims: o.sims,
    params: { k: params.k, hfa: params.hfa, regress: params.regress },
    inputHash: inputHash(o.games, o.season, o.sims, params),
    gamesUpdatedAt: o.gamesUpdatedAt,
    points,
    current,
    standings: standingsAsOf(o.games, o.season, lastDate),
  } satisfies ModelSeason);
}

export interface StageOptions {
  games: readonly ModelGame[];
  gamesUpdatedAt: string;
  today: string;
  now: Date;
  sims: number;
  /** The previous run's file for a season, if any (from the derived branch). */
  previous: (season: number) => unknown;
  log?: (line: string) => void;
}

export interface StageResult {
  files: ModelSeason[];
  reused: number[];
  computed: number[];
}

/** All seasons from FIRST_SEASON to today's. Throws if a past season has no schedule. */
export function runModelStage(o: StageOptions): StageResult {
  const log = o.log ?? console.log;
  const current = seasonForDate(o.today);
  const result: StageResult = { files: [], reused: [], computed: [] };
  for (let season = FIRST_SEASON; season <= current; season++) {
    const hash = inputHash(o.games, season, o.sims, ELO_PARAMS);
    const prev = modelSeasonSchema.safeParse(o.previous(season));
    if (prev.success && prev.data.inputHash === hash) {
      result.files.push(prev.data);
      result.reused.push(season);
      log(`  ${season}: unchanged, kept (${prev.data.points.length} points)`);
      continue;
    }
    const started = Date.now();
    const file = buildSeason({ games: o.games, season, sims: o.sims, gamesUpdatedAt: o.gamesUpdatedAt, now: o.now });
    if (!file) {
      // Before the schedule is released (spring) the new season simply has no forecast yet.
      if (season === current) {
        log(`  ${season}: no schedule yet, skipped`);
        continue;
      }
      throw new Error(`no ${season} regular-season schedule in nflverse games`);
    }
    const weeks = file.points.filter((p) => p.weekComplete && p.week > 0).length;
    log(`  ${season}: ${file.points.length} points, ${weeks} completed weeks, latest ${file.points.at(-1)!.date} (${Date.now() - started} ms)`);
    result.files.push(file);
    result.computed.push(season);
  }
  return result;
}

if (isMain(import.meta.url)) {
  const args = parseArgs(process.argv.slice(2));
  const now = new Date();
  const today = now.toISOString().slice(0, 10);
  const dir = resolve(REPO_ROOT, typeof args.out === "string" ? args.out : "derived", "model");
  const sims = typeof args.sims === "string" ? Number(args.sims) : SIMS;
  try {
    const { file, rows } = await loadDataset(createHttp(), DATASETS.games, null, GAME_COLUMNS);
    const games = toModelGames(rows);
    console.log(`model: ${games.length} games (nflverse games updated ${file.updatedAt}), ${sims} sims per point`);
    const result = runModelStage({
      games, gamesUpdatedAt: file.updatedAt, today, now, sims,
      previous: (season) => readJsonIfExists(join(dir, `${season}.json`)),
    });
    if (args["dry-run"]) console.log("Dry run: nothing written.");
    else {
      for (const f of result.files) writeFileAtomic(join(dir, `${f.season}.json`), `${JSON.stringify(f)}\n`);
      console.log(`Wrote ${result.files.length} season files to ${dir} (computed ${result.computed.join(", ") || "none"})`);
    }
  } catch (err) {
    console.error(err instanceof Error ? (err.stack ?? err.message) : String(err));
    process.exitCode = 1;
  }
}
