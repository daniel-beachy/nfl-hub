import { isTeamId } from "../../shared/teams.ts";
import { GAME_TYPES, type GameType, type ModelGame } from "./types.ts";

/** The nflverse `games` columns the model reads. */
export const GAME_COLUMNS = [
  "game_id", "season", "game_type", "week", "gameday", "away_team", "away_score", "home_team", "home_score",
  "location", "spread_line",
] as const;

type Cell = string | number | boolean | null;

// nflverse keeps the abbreviation a franchise had at the time. Ratings follow the franchise.
const FRANCHISE: Record<string, string> = { OAK: "LV", SD: "LAC", STL: "LA" };

/**
 * nflverse `games` rows to model games, in playing order (date, then game id). Throws on a team
 * or game type it does not know, so a change at nflverse fails loudly instead of skewing ratings.
 */
export function toModelGames(rows: readonly Record<string, Cell>[]): ModelGame[] {
  const games = rows.map((r): ModelGame => {
    const id = String(r.game_id);
    const type = String(r.game_type);
    if (!(GAME_TYPES as readonly string[]).includes(type)) throw new Error(`${id}: unknown game_type "${type}"`);
    const team = (v: Cell | undefined) => {
      const t = FRANCHISE[String(v)] ?? String(v);
      if (!isTeamId(t)) throw new Error(`${id}: unknown team "${String(v)}"`);
      return t;
    };
    const num = (v: Cell | undefined) => (typeof v === "number" && Number.isFinite(v) ? v : null);
    const homeScore = num(r.home_score);
    const awayScore = num(r.away_score);
    const played = homeScore !== null && awayScore !== null;
    return {
      id,
      season: Number(r.season),
      week: Number(r.week),
      type: type as GameType,
      date: String(r.gameday).slice(0, 10),
      home: team(r.home_team),
      away: team(r.away_team),
      neutral: r.location === "Neutral",
      homeScore: played ? homeScore : null,
      awayScore: played ? awayScore : null,
      spread: num(r.spread_line),
    };
  });
  return sortGames(games);
}

export function sortGames(games: readonly ModelGame[]): ModelGame[] {
  return [...games].sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
}

// The committed fixture (fixtures/games-2020-2025.json) stores one array per game to stay small:
// id, week, type, date, away, home, away score, home score, neutral, spread.
export type CompactGame = [string, number, string, string, string, string, number | null, number | null, number, number | null];

export function toCompact(g: ModelGame): CompactGame {
  return [g.id, g.week, g.type, g.date, g.away, g.home, g.awayScore, g.homeScore, g.neutral ? 1 : 0, g.spread];
}

export function fromCompact(rows: readonly CompactGame[]): ModelGame[] {
  return toModelGames(
    rows.map(([game_id, week, game_type, gameday, away_team, home_team, away_score, home_score, neutral, spread_line]) => ({
      game_id, season: Number(game_id.slice(0, 4)), game_type, week, gameday, away_team, away_score, home_team, home_score,
      location: neutral ? "Neutral" : "Home", spread_line,
    })),
  );
}
