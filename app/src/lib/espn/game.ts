import { teamFromEspnId, type TeamId } from "../../../../shared/teams.ts";
import type { EspnBoxscore, EspnDrive, EspnEvent, EspnPlay, EspnScoreboard, EspnSummary } from "./schemas.ts";

// ESPN's shapes turned into ours: canonical team ids, times as epoch milliseconds, plays
// in one flat ordered list. Pure functions; the feed (feed.ts) calls them.
//
// IMPORTANT: a LiveGame or LiveSlate is the newest data ESPN has. Pages must never draw
// one directly, or the spoiler delay leaks. They draw the views made from them in
// timeshift.ts (plan 9.3).

export type GameState = "pre" | "in" | "post";

export interface Spot {
  down: number | null;
  distance: number | null;
  /** 0 to 100 measured from one fixed end of the field, as ESPN sends it. */
  yardLine: number | null;
  yardsToEndzone: number | null;
  team: TeamId | null;
  /** "2nd & 5" */
  text: string | null;
  /** "SF 49" */
  possessionText: string | null;
}

export interface LivePlay {
  id: string;
  driveId: string;
  /**
   * When this play becomes visible to a delayed viewer, epoch ms. It is the play's
   * wallclock, made non-decreasing down the list so a play can never show before an
   * earlier one. A play with no wallclock borrows the next play's, or the time we first
   * saw it.
   */
  at: number;
  /** ESPN's own wallclock, epoch ms, or null when missing or unreadable. */
  wallclock: number | null;
  period: number;
  /** Game clock as ESPN prints it, "14:20". */
  clock: string;
  type: string;
  typeId: string | null;
  text: string;
  /** Score after the play. A touchdown play already includes its extra point or two-point try. */
  homeScore: number;
  awayScore: number;
  scoring: boolean;
  /** "touchdown", "field-goal", "safety" */
  scoringType: string | null;
  penalty: boolean;
  turnover: boolean;
  yards: number | null;
  start: Spot;
  end: Spot;
  /** ESPN's home win probability after the play, 0 to 1. */
  homeWp: number | null;
}

export interface LiveDrive {
  id: string;
  team: TeamId | null;
  /** ESPN's summary of the whole drive. Only safe to show once the drive is over for the viewer. */
  result: string | null;
  description: string | null;
  isScore: boolean;
}

export interface BoxTeam {
  team: TeamId;
  stats: { name: string; label: string; value: string }[];
}
export interface BoxPlayerGroup {
  team: TeamId;
  /** "passing", "rushing", ... */
  name: string;
  keys: string[];
  labels: string[];
  players: { id: string; name: string; jersey: string | null; stats: string[] }[];
}
export interface LiveBox {
  teams: BoxTeam[];
  players: BoxPlayerGroup[];
}

export interface LiveGame {
  id: string;
  /** When this copy was fetched, on the feed's clock. */
  fetchedAt: number;
  kickoff: number;
  season: number | null;
  /** ESPN's state right now. Not for display: a delayed viewer may not be there yet. */
  state: GameState;
  home: TeamId;
  away: TeamId;
  /** The header's score right now. Not for display; the view takes scores from plays. */
  score: { home: number; away: number } | null;
  plays: LivePlay[];
  drives: LiveDrive[];
  box: LiveBox | null;
  /** Items ESPN sent that did not match the schema and were left out. */
  dropped: number;
}

function toSpot(raw: EspnPlay["start"]): Spot {
  const positive = (n: number | undefined) => (n !== undefined && n > 0 ? n : null);
  return {
    down: positive(raw?.down),
    distance: raw?.distance ?? null,
    yardLine: raw?.yardLine ?? null,
    yardsToEndzone: raw?.yardsToEndzone ?? null,
    team: (raw?.team && teamFromEspnId(raw.team.id)?.id) ?? null,
    text: raw?.shortDownDistanceText ?? null,
    possessionText: raw?.possessionText ?? null,
  };
}

function toMs(iso: string | undefined): number | null {
  if (!iso) return null;
  const ms = Date.parse(iso);
  return Number.isFinite(ms) ? ms : null;
}

function toBox(raw: EspnBoxscore | undefined): LiveBox | null {
  if (!raw) return null;
  const teams: BoxTeam[] = [];
  for (const t of raw.teams) {
    const team = teamFromEspnId(t.team.id)?.id;
    if (team && t.statistics.length) teams.push({ team, stats: t.statistics.map((s) => ({ name: s.name, label: s.label ?? s.name, value: s.displayValue })) });
  }
  const players: BoxPlayerGroup[] = [];
  for (const t of raw.players) {
    const team = teamFromEspnId(t.team.id)?.id;
    if (!team) continue;
    for (const g of t.statistics) {
      if (!g.athletes.length) continue;
      players.push({
        team,
        name: g.name,
        keys: g.keys ?? [],
        labels: g.labels,
        players: g.athletes.map((a) => ({ id: a.athlete.id, name: a.athlete.displayName, jersey: a.athlete.jersey ?? null, stats: a.stats })),
      });
    }
  }
  return teams.length || players.length ? { teams, players } : null;
}

function sides(competitors: { homeAway: "home" | "away"; team: { id: string }; score?: string }[]) {
  const home = competitors.find((c) => c.homeAway === "home");
  const away = competitors.find((c) => c.homeAway === "away");
  const homeTeam = home && teamFromEspnId(home.team.id)?.id;
  const awayTeam = away && teamFromEspnId(away.team.id)?.id;
  if (!home || !away || !homeTeam || !awayTeam) return null;
  const h = Number(home.score);
  const a = Number(away.score);
  const score = home.score !== undefined && away.score !== undefined && Number.isFinite(h) && Number.isFinite(a) ? { home: h, away: a } : null;
  return { home: homeTeam, away: awayTeam, score };
}

/**
 * `firstSeen` remembers, across calls, when a play without a wallclock was first seen, so
 * its release time does not move with every poll. Pass the same map each time for a game.
 */
export function normalizeSummary(raw: EspnSummary, fetchedAt: number, dropped = 0, firstSeen: Map<string, number> = new Map()): LiveGame | null {
  const comp = raw.header.competitions[0]!;
  const teams = sides(comp.competitors);
  const kickoff = toMs(comp.date);
  // Two NFL teams and a start time, or it is not a game we can show (Pro Bowl, bad data).
  if (!teams || kickoff === null) return null;

  const rawDrives: EspnDrive[] = [...(raw.drives?.previous ?? [])];
  const current = raw.drives?.current;
  if (current) {
    const i = rawDrives.findIndex((d) => d.id === current.id);
    // The copy with more plays is the fresher one.
    if (i === -1) rawDrives.push(current);
    else if (current.plays.length > rawDrives[i]!.plays.length) rawDrives[i] = current;
  }

  const wp = new Map(raw.winprobability.map((p) => [p.playId, p.homeWinPercentage]));
  const plays: LivePlay[] = [];
  const drives: LiveDrive[] = [];
  const seen = new Set<string>();
  for (const d of rawDrives) {
    drives.push({ id: d.id, team: (d.team && teamFromEspnId(d.team.id)?.id) ?? null, result: d.displayResult ?? d.result ?? null, description: d.description ?? null, isScore: d.isScore ?? false });
    for (const p of d.plays) {
      if (seen.has(p.id)) continue;
      seen.add(p.id);
      plays.push({
        id: p.id,
        driveId: d.id,
        at: 0,
        wallclock: toMs(p.wallclock),
        period: p.period.number,
        clock: p.clock.displayValue,
        type: p.type?.text ?? "Play",
        typeId: p.type?.id ?? null,
        text: p.text ?? "",
        homeScore: p.homeScore,
        awayScore: p.awayScore,
        scoring: p.scoringPlay ?? false,
        scoringType: p.scoringType?.name ?? null,
        penalty: p.isPenalty ?? false,
        turnover: p.isTurnover ?? false,
        yards: p.statYardage ?? null,
        start: toSpot(p.start),
        end: toSpot(p.end),
        homeWp: wp.get(p.id) ?? null,
      });
    }
  }

  // Release times. Backwards: a play with no wallclock happened before the next one that
  // has one. Trailing ones use the time we first saw them. Then forwards: never earlier
  // than the play before.
  let next: number | null = null;
  for (let i = plays.length - 1; i >= 0; i--) {
    const p = plays[i]!;
    if (p.wallclock !== null) next = p.wallclock;
    else if (next === null && !firstSeen.has(p.id)) firstSeen.set(p.id, fetchedAt);
    p.at = p.wallclock ?? next ?? firstSeen.get(p.id) ?? fetchedAt;
  }
  let floor = -Infinity;
  for (const p of plays) floor = p.at = Math.max(p.at, floor);

  return {
    id: raw.header.id,
    fetchedAt,
    kickoff,
    season: raw.header.season?.year ?? null,
    state: comp.status.type.state,
    home: teams.home,
    away: teams.away,
    score: teams.score,
    plays,
    drives,
    box: toBox(raw.boxscore),
    dropped,
  };
}

export interface SlateGame {
  id: string;
  kickoff: number;
  state: GameState;
  home: TeamId;
  away: TeamId;
  score: { home: number; away: number } | null;
  period: number | null;
  clock: string | null;
  /** ESPN's short status line: "Final", "11/16 - 8:15 PM EST", "Halftime". */
  detail: string | null;
  situation: { possession: TeamId | null; text: string | null; spot: string | null; redZone: boolean; homeWp: number | null } | null;
}

export interface LiveSlate {
  fetchedAt: number;
  season: number | null;
  week: number | null;
  games: SlateGame[];
  dropped: number;
}

function toSlateGame(e: EspnEvent): SlateGame | null {
  const comp = e.competitions[0]!;
  const teams = sides(comp.competitors);
  const kickoff = toMs(e.date);
  if (!teams || kickoff === null) return null;
  const s = comp.situation;
  const gameState = comp.status.type.state;
  return {
    id: e.id,
    kickoff,
    state: gameState,
    home: teams.home,
    away: teams.away,
    score: gameState === "pre" ? null : teams.score,
    period: comp.status.period || null,
    clock: comp.status.displayClock ?? null,
    detail: comp.status.type.shortDetail ?? null,
    situation:
      s && gameState === "in"
        ? {
            possession: (s.possession && teamFromEspnId(s.possession)?.id) || null,
            text: s.shortDownDistanceText ?? null,
            spot: s.possessionText ?? null,
            redZone: s.isRedZone ?? false,
            homeWp: s.lastPlay?.probability?.homeWinPercentage ?? null,
          }
        : null,
  };
}

export function normalizeScoreboard(raw: EspnScoreboard, fetchedAt: number, dropped = 0): LiveSlate {
  const games: SlateGame[] = [];
  for (const e of raw.events) {
    const g = toSlateGame(e);
    if (g) games.push(g);
    else dropped++;
  }
  games.sort((a, b) => a.kickoff - b.kickoff || a.id.localeCompare(b.id));
  return { fetchedAt, season: raw.season?.year ?? null, week: raw.week?.number ?? null, games, dropped };
}
