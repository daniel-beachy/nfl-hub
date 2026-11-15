import { join, resolve } from "node:path";
import {
  AWARD_MARKETS, MARKET_SOURCE_IDS, seasonForDate, SOURCE_IDS, TEAM_METRICS,
  type AwardMarket, type SeriesSourceId, type SourceId, type TeamMetric,
} from "../shared/ids.ts";
import { modelSeasonSchema, type ModelPoint, type ModelSeason } from "../shared/model.ts";
import { SERIES_SCHEMA_VERSION, seasonSeriesSchema, type SeasonSeries } from "../shared/series.ts";
import type { Snapshot, SourceBlock } from "../shared/snapshot.ts";
import { getTeam, TEAM_IDS, teamsInConference, teamsInDivision, type TeamId } from "../shared/teams.ts";
import { loadSnapshots } from "./health.ts";
import { isMain, parseArgs, readJsonIfExists, REPO_ROOT, writeFileAtomic } from "./lib/files.ts";
import { addDays, FIRST_SEASON } from "./model/stage.ts";

// The compile stage (docs/PLAN.md 6.3 and 8, docs/DATA-CONTRACT.md section 3): snapshots and
// hub model forecasts into chart-ready series, one daily and one weekly file per season.
//   npm run compile        every season from 2020 to the current one into derived/season/{season}/
// Reads data/snapshots (main) and derived/model (the model stage's last good files). Writes
// nothing unless every season compiled and validated, so a failure leaves the previous files.

type Axis = { dates: string[]; weeks?: number[] };
type TeamSeries = NonNullable<NonNullable<SeasonSeries["metrics"][TeamMetric]>[SeriesSourceId]>;
type AwardSeries = NonNullable<NonNullable<SeasonSeries["awards"][AwardMarket]>[SeriesSourceId]>;
type Availability = TeamSeries["availability"];

/** Award candidates kept per source and market: any that was in the top this-many on at least one date. */
export const AWARD_TOP = 10;
const MARKETS: readonly SourceId[] = MARKET_SOURCE_IDS;

const roundFor = (m: TeamMetric | "award") => (x: number) => (m === "wins" ? Math.round(x * 100) / 100 : Math.round(x * 10_000) / 10_000);

export function median(xs: readonly number[]): number {
  const s = [...xs].sort((a, b) => a - b);
  const mid = s.length >> 1;
  return s.length % 2 ? s[mid]! : (s[mid - 1]! + s[mid]!) / 2;
}

// ---------------------------------------------------------------- hub model lookup

/**
 * The hub forecast as of `date`, or null. Between points no game was played, so the latest
 * point on or before `date` is exact, and the preseason point stands for any earlier date
 * (docs/DATA-CONTRACT.md 6). Past the first unplayed game day after the latest point the
 * forecast would have moved, so there is no value there until the model stage catches up.
 */
export function hubLookup(model: ModelSeason | null): (date: string) => ModelPoint | null {
  if (!model) return () => null;
  const points = model.points;
  const last = points.at(-1)!;
  const pending = (model.current?.games ?? []).map((g) => g.date).filter((d) => d >= last.date).sort()[0];
  return (date) => {
    if (pending !== undefined && date > pending) return null;
    let found = points[0]!;
    for (const p of points) if (p.date <= date) found = p;
    return found;
  };
}

// ---------------------------------------------------------------- consensus

/** The teams a group metric is de-vigged over (docs/DATA-CONTRACT.md 2.2 step 4). */
function groupOf(metric: TeamMetric, team: TeamId): TeamId[] | null {
  const t = getTeam(team);
  if (metric === "superBowl") return [...TEAM_IDS];
  if (metric === "conference" || metric === "seed1") return teamsInConference(t.conference).map((x) => x.id);
  if (metric === "division") return teamsInDivision(t.division).map((x) => x.id);
  return null;
}

/**
 * Whether a market value was de-vigged. Group metrics: finalize de-vigs a market's group exactly
 * when the whole group is present, so a complete group means de-vigged (this also covers
 * snapshots written before `normalized` existed). Playoffs: only when the block says so (both
 * sides of a two-way price). Wins are not probabilities: one basis for all.
 */
export function isDevigged(block: SourceBlock, metric: TeamMetric, team: TeamId): boolean {
  if (metric === "wins") return true;
  const group = groupOf(metric, team);
  if (group) return group.every((t) => block.teams[t]?.[metric] !== undefined);
  return block.normalized?.[metric] === true;
}

/**
 * Median of the market sources' values for one team and metric on one snapshot, when at least
 * two have one. De-vigged and raw values are never mixed: the larger set with at least two
 * values is used, de-vigged when they tie.
 */
export function consensusValue(snapshot: Snapshot, metric: TeamMetric, team: TeamId): number | null {
  const devig: number[] = [];
  const raw: number[] = [];
  for (const id of MARKETS) {
    const block = snapshot.sources[id];
    const v = block?.teams[team]?.[metric];
    if (block === undefined || v === undefined) continue;
    (isDevigged(block, metric, team) ? devig : raw).push(v);
  }
  const use = devig.length >= raw.length ? devig : raw;
  return use.length >= 2 ? roundFor(metric)(median(use)) : null;
}

// ---------------------------------------------------------------- awards

/** Same person across sources and days: gsis id when matched, else the name without case, punctuation or suffix. */
export function candidateKey(c: { playerId: string | null; name: string }): string {
  if (c.playerId) return `id:${c.playerId}`;
  return `name:${c.name.toLowerCase().replace(/[^a-z ]/g, "").replace(/\s+(jr|sr|ii|iii|iv)$/, "").replace(/\s+/g, " ").trim()}`;
}

interface Candidate { playerId: string | null; name: string; team: TeamId | null }
type AwardDay = Map<string, { c: Candidate; prob: number }>;

function awardDay(snapshot: Snapshot | undefined, source: SeriesSourceId, market: AwardMarket): AwardDay | null {
  if (!snapshot) return null;
  if (source === "consensus") {
    const all = new Map<string, { c: Candidate; probs: number[] }>();
    for (const id of MARKETS) {
      for (const c of snapshot.sources[id]?.awards[market] ?? []) {
        const k = candidateKey(c);
        const e = all.get(k) ?? { c, probs: [] };
        e.probs.push(c.prob);
        if (!e.c.team && c.team) e.c = { ...e.c, team: c.team };
        all.set(k, e);
      }
    }
    const day: AwardDay = new Map();
    for (const [k, e] of all) if (e.probs.length >= 2) day.set(k, { c: e.c, prob: roundFor("award")(median(e.probs)) });
    return day.size ? day : null;
  }
  const list = snapshot.sources[source as SourceId]?.awards[market];
  if (!list?.length) return null;
  return new Map(list.map((c) => [candidateKey(c), { c, prob: c.prob }]));
}

// ---------------------------------------------------------------- building a file

interface Inputs {
  season: number;
  snapshots: readonly Snapshot[];
  model: ModelSeason | null;
}

function availabilityOf(dates: readonly string[], has: (date: string) => boolean, onDay: (day: string) => boolean): Availability | null {
  const present = dates.filter(has);
  if (!present.length) return null;
  const end = dates.at(-1)!;
  let missing = 0;
  for (let i = 0; i < 7; i++) if (!onDay(addDays(end, -i))) missing++;
  return { firstDate: present[0]!, lastDate: present.at(-1)!, daysMissingInLast7: missing };
}

/**
 * The series for one axis. `snapshotAt` gives the snapshot used at each axis point (or none);
 * `hubAt` the hub point. `onDay` answers "did this source have a value on this calendar day",
 * for availability, which is always measured in days whatever the axis.
 */
function buildSeries(
  inputs: Inputs,
  axis: Axis,
  resolution: "daily" | "weekly",
  snapshotAt: (i: number) => Snapshot | undefined,
  hubAt: (i: number) => ModelPoint | null,
  dayHas: (source: SeriesSourceId, key: TeamMetric | AwardMarket, day: string) => boolean,
  now: Date,
): SeasonSeries {
  const n = axis.dates.length;
  const metrics: SeasonSeries["metrics"] = {};
  for (const metric of TEAM_METRICS) {
    const bySource: Partial<Record<SeriesSourceId, TeamSeries>> = {};
    const value = (source: SeriesSourceId, i: number, team: TeamId): number | null => {
      if (source === "hub") return hubAt(i)?.teams[team][metric] ?? null;
      const snap = snapshotAt(i);
      if (!snap) return null;
      if (source === "consensus") return consensusValue(snap, metric, team);
      return snap.sources[source]?.teams[team]?.[metric] ?? null;
    };
    for (const source of ["consensus", ...SOURCE_IDS] as const) {
      const teams: Partial<Record<TeamId, (number | null)[]>> = {};
      for (const team of TEAM_IDS) {
        const vals = Array.from({ length: n }, (_, i) => value(source, i, team));
        if (vals.some((v) => v !== null)) teams[team] = vals;
      }
      const rows = Object.values(teams);
      const availability = availabilityOf(axis.dates, (d) => rows.some((r) => r![axis.dates.indexOf(d)] !== null), (day) => dayHas(source, metric, day));
      if (availability) bySource[source] = { availability, teams };
    }
    if (Object.keys(bySource).length) metrics[metric] = bySource;
  }

  const awards: SeasonSeries["awards"] = {};
  for (const market of AWARD_MARKETS) {
    const bySource: Partial<Record<SeriesSourceId, AwardSeries>> = {};
    for (const source of ["consensus", ...MARKETS] as const) {
      const days = Array.from({ length: n }, (_, i) => awardDay(snapshotAt(i), source, market));
      const keep = new Set<string>();
      for (const day of days) {
        if (!day) continue;
        [...day.entries()].sort((a, b) => b[1].prob - a[1].prob).slice(0, AWARD_TOP).forEach(([k]) => keep.add(k));
      }
      if (!keep.size) continue;
      const candidates = [...keep].map((k) => {
        let latest: Candidate | null = null;
        let team: TeamId | null = null;
        const values = days.map((day) => {
          const e = day?.get(k);
          if (e) {
            latest = e.c;
            team = e.c.team ?? team;
          }
          return e ? e.prob : null;
        });
        const c = latest! as Candidate;
        return { playerId: c.playerId, name: c.name, team, values };
      });
      // Current board first (value on the last date), then those who dropped off, by their last value.
      const rank = (v: (number | null)[]) => [v.at(-1) ?? -1, v.findLast((x) => x !== null) ?? 0] as const;
      candidates.sort((a, b) => {
        const [ra, rb] = [rank(a.values), rank(b.values)];
        return rb[0] - ra[0] || rb[1] - ra[1] || a.name.localeCompare(b.name);
      });
      const availability = availabilityOf(axis.dates, (d) => days[axis.dates.indexOf(d)] !== null, (day) => dayHas(source, market, day))!;
      bySource[source] = { availability, candidates };
    }
    if (Object.keys(bySource).length) awards[market] = bySource;
  }

  return seasonSeriesSchema.parse({
    schemaVersion: SERIES_SCHEMA_VERSION,
    season: inputs.season,
    generatedAt: now.toISOString(),
    resolution,
    dates: axis.dates,
    ...(axis.weeks && { weeks: axis.weeks }),
    metrics,
    awards,
  } satisfies SeasonSeries);
}

export interface WeekPoint { week: number; date: string; snapshot: Snapshot | undefined; hub: ModelPoint | null }

/**
 * One point per completed week (docs/PLAN.md 6.3). The calendar comes from the hub model's
 * `weekComplete` points (the day after each week's last game, from the schedule); each week uses
 * the first snapshot on or after that day and before the next week ends, skipping snapshots taken
 * while games were in progress. Week 0 is the preseason: the latest snapshot on or before the
 * first game day. A week with no such snapshot is still a point (dated the day after its last
 * game) with the hub value only. Without a model file the calendar falls back to the snapshots'
 * own `lastCompletedWeek`.
 */
export function weekPoints(snapshots: readonly Snapshot[], model: ModelSeason | null): WeekPoint[] {
  const usable = snapshots.filter((s) => s.context?.gamesInProgress !== true);
  if (model) {
    const ends = model.points.filter((p) => p.weekComplete);
    return ends.map((p, i) => {
      const next = ends[i + 1]?.date;
      const snapshot =
        p.week === 0
          ? usable.filter((s) => s.date <= p.date).at(-1)
          : usable.find((s) => s.date >= p.date && (next === undefined || s.date < next));
      return { week: p.week, date: snapshot?.date ?? p.date, snapshot, hub: p };
    });
  }
  const out: WeekPoint[] = [];
  const pre = usable.filter((s) => s.context?.phase === "preseason").at(-1);
  if (pre) out.push({ week: 0, date: pre.date, snapshot: pre, hub: null });
  for (const s of usable) {
    const w = s.context?.lastCompletedWeek;
    if (w === null || w === undefined || w < 1 || out.some((p) => p.week >= w)) continue;
    out.push({ week: w, date: s.date, snapshot: s, hub: null });
  }
  return out;
}

export interface CompiledSeason { daily: SeasonSeries; weekly: SeasonSeries }

/** Both files for one season, or null when there is nothing to compile. Pure apart from `now`. */
export function compileSeason(inputs: Inputs, now: Date): CompiledSeason | null {
  const { snapshots, model } = inputs;
  if (!snapshots.length && !model) return null;
  const byDate = new Map(snapshots.map((s) => [s.date, s]));
  const hub = hubLookup(model);

  const dayHas = (source: SeriesSourceId, key: TeamMetric | AwardMarket, day: string): boolean => {
    if (source === "hub") return (TEAM_METRICS as readonly string[]).includes(key) && hub(day) !== null;
    const snap = byDate.get(day);
    if (!snap) return false;
    if ((AWARD_MARKETS as readonly string[]).includes(key)) return awardDay(snap, source, key as AwardMarket) !== null;
    const metric = key as TeamMetric;
    if (source === "consensus") return TEAM_IDS.some((t) => consensusValue(snap, metric, t) !== null);
    return TEAM_IDS.some((t) => snap.sources[source]?.teams[t]?.[metric] !== undefined);
  };

  // Daily: the snapshot dates; for a season with no snapshots, the model's points.
  const dailyDates = snapshots.length ? snapshots.map((s) => s.date) : model!.points.map((p) => p.date);
  const daily = buildSeries(inputs, { dates: dailyDates }, "daily", (i) => byDate.get(dailyDates[i]!), (i) => hub(dailyDates[i]!), dayHas, now);

  const weeks = weekPoints(snapshots, model);
  const weekly = buildSeries(
    inputs,
    { dates: weeks.map((w) => w.date), weeks: weeks.map((w) => w.week) },
    "weekly",
    (i) => weeks[i]!.snapshot,
    (i) => weeks[i]!.hub,
    dayHas,
    now,
  );
  // Availability describes the source, not the resolution: the weekly file repeats the daily one.
  for (const [metric, bySource] of Object.entries(weekly.metrics)) {
    for (const [source, s] of Object.entries(bySource!)) s!.availability = daily.metrics[metric as TeamMetric]?.[source as SeriesSourceId]?.availability ?? s!.availability;
  }
  for (const [market, bySource] of Object.entries(weekly.awards)) {
    for (const [source, s] of Object.entries(bySource!)) s!.availability = daily.awards[market as AwardMarket]?.[source as SeriesSourceId]?.availability ?? s!.availability;
  }
  return { daily, weekly };
}

if (isMain(import.meta.url)) {
  const args = parseArgs(process.argv.slice(2));
  const now = new Date();
  const derived = resolve(REPO_ROOT, typeof args.derived === "string" ? args.derived : "derived");
  const current = seasonForDate(now.toISOString().slice(0, 10));
  try {
    const out: Array<{ season: number; files: CompiledSeason }> = [];
    for (let season = FIRST_SEASON; season <= current; season++) {
      const { snapshots, unreadable } = loadSnapshots(REPO_ROOT, season);
      if (unreadable.length) console.warn(`  ${season}: unreadable snapshots skipped: ${unreadable.join(", ")}`);
      const parsed = modelSeasonSchema.safeParse(readJsonIfExists(join(derived, "model", `${season}.json`)));
      const model = parsed.success ? parsed.data : null;
      if (!model) console.warn(`  ${season}: no valid model file; compiling without the hub`);
      const files = compileSeason({ season, snapshots, model }, now);
      if (!files) {
        console.log(`  ${season}: nothing to compile`);
        continue;
      }
      out.push({ season, files });
      const srcs = Object.keys(files.daily.metrics.superBowl ?? {}).join(", ");
      console.log(`  ${season}: ${files.daily.dates.length} daily points, ${files.weekly.dates.length} weekly; superBowl from ${srcs || "none"}`);
    }
    if (args["dry-run"]) console.log("Dry run: nothing written.");
    else {
      for (const { season, files } of out) {
        writeFileAtomic(join(derived, "season", String(season), "series.json"), `${JSON.stringify(files.daily)}\n`);
        writeFileAtomic(join(derived, "season", String(season), "weekly.json"), `${JSON.stringify(files.weekly)}\n`);
      }
      console.log(`Wrote ${out.length} seasons to ${join(derived, "season")}`);
    }
  } catch (err) {
    console.error(err instanceof Error ? (err.stack ?? err.message) : String(err));
    process.exitCode = 1;
  }
}
