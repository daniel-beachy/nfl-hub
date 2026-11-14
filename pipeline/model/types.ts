import { TEAM_IDS, type TeamId } from "../../shared/teams.ts";

// The hub forecast model (docs/PLAN.md 8.3, docs/MODEL.md). Everything in this folder except
// cli.ts is pure: games in, numbers out, no I/O and no clock.

export const GAME_TYPES = ["REG", "WC", "DIV", "CON", "SB"] as const;
export type GameType = (typeof GAME_TYPES)[number];

/** One game from nflverse `games`, with franchises mapped to today's team ids. */
export interface ModelGame {
  id: string;
  season: number;
  week: number;
  type: GameType;
  /** Kickoff date, YYYY-MM-DD (US Eastern, as nflverse gives it). */
  date: string;
  home: TeamId;
  away: TeamId;
  neutral: boolean;
  /** Null until the game is final. */
  homeScore: number | null;
  awayScore: number | null;
  /** Closing spread in points, positive when the home team is favored. Used only by evaluation. */
  spread: number | null;
}

export type PlayedGame = ModelGame & { homeScore: number; awayScore: number };

export const N_TEAMS = TEAM_IDS.length;
const INDEX = new Map<TeamId, number>(TEAM_IDS.map((id, i) => [id, i]));

/** Position of a team in TEAM_IDS: the index every typed array in the model uses. */
export function teamIndex(id: TeamId): number {
  return INDEX.get(id)!;
}

export function isPlayed(g: ModelGame): g is PlayedGame {
  return g.homeScore !== null && g.awayScore !== null;
}
