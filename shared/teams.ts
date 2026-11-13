import type { Conference, DivisionId, DivisionName } from "./ids.ts";

/**
 * The 32 teams. The canonical id is the nflverse abbreviation. Every provider's own
 * naming maps to it here and nowhere else. Colors are ESPN's (recorded 2026-11-13).
 */
export const TEAM_IDS = [
  "ARI", "ATL", "BAL", "BUF", "CAR", "CHI", "CIN", "CLE", "DAL", "DEN", "DET", "GB", "HOU", "IND", "JAX", "KC",
  "LA", "LAC", "LV", "MIA", "MIN", "NE", "NO", "NYG", "NYJ", "PHI", "PIT", "SEA", "SF", "TB", "TEN", "WAS",
] as const;
export type TeamId = (typeof TEAM_IDS)[number];

export interface Team {
  id: TeamId;
  /** "Kansas City" */
  location: string;
  /** "Chiefs" */
  nickname: string;
  /** "Kansas City Chiefs": the form Polymarket, Bovada and ESPN display names use. */
  name: string;
  conference: Conference;
  division: DivisionId;
  /** ESPN numeric team id, as a string (ESPN sends strings). */
  espnId: string;
  /** ESPN abbreviation; differs from the id for LAR and WSH. */
  espnAbbr: string;
  /** Kalshi's short name ("Los Angeles R") and ticker suffix ("LAR", "JAC"). */
  kalshiName: string;
  kalshiCode: string;
  /** Hex without '#'. Use `readableColor` from colors.ts before drawing on a background. */
  color: string;
  altColor: string;
}

type Row = [TeamId, string, string, Conference, DivisionName, string, string, string, string];

// id, location, nickname, conference, division, espnId, color, altColor, overrides "espnAbbr|kalshiName|kalshiCode"
const ROWS: Row[] = [
  ["ARI", "Arizona", "Cardinals", "NFC", "West", "22", "a40227", "ffffff", ""],
  ["ATL", "Atlanta", "Falcons", "NFC", "South", "1", "a71930", "000000", ""],
  ["BAL", "Baltimore", "Ravens", "AFC", "North", "33", "29126f", "000000", ""],
  ["BUF", "Buffalo", "Bills", "AFC", "East", "2", "00338d", "d50a0a", ""],
  ["CAR", "Carolina", "Panthers", "NFC", "South", "29", "0085ca", "000000", ""],
  ["CHI", "Chicago", "Bears", "NFC", "North", "3", "0b1c3a", "e64100", ""],
  ["CIN", "Cincinnati", "Bengals", "AFC", "North", "4", "fb4f14", "000000", ""],
  ["CLE", "Cleveland", "Browns", "AFC", "North", "5", "472a08", "ff3c00", ""],
  ["DAL", "Dallas", "Cowboys", "NFC", "East", "6", "002a5c", "b0b7bc", ""],
  ["DEN", "Denver", "Broncos", "AFC", "West", "7", "0a2343", "fc4c02", ""],
  ["DET", "Detroit", "Lions", "NFC", "North", "8", "0076b6", "bbbbbb", ""],
  ["GB", "Green Bay", "Packers", "NFC", "North", "9", "204e32", "ffb612", ""],
  ["HOU", "Houston", "Texans", "AFC", "South", "34", "021018", "eb0028", ""],
  ["IND", "Indianapolis", "Colts", "AFC", "South", "11", "003b75", "ffffff", ""],
  ["JAX", "Jacksonville", "Jaguars", "AFC", "South", "30", "007487", "d7a22a", "||JAC"],
  ["KC", "Kansas City", "Chiefs", "AFC", "West", "12", "e31837", "ffb612", ""],
  ["LA", "Los Angeles", "Rams", "NFC", "West", "14", "003594", "ffd100", "LAR|Los Angeles R|LAR"],
  ["LAC", "Los Angeles", "Chargers", "AFC", "West", "24", "0080c6", "ffc20e", "|Los Angeles C|"],
  ["LV", "Las Vegas", "Raiders", "AFC", "West", "13", "000000", "a5acaf", ""],
  ["MIA", "Miami", "Dolphins", "AFC", "East", "15", "008e97", "fc4c02", ""],
  ["MIN", "Minnesota", "Vikings", "NFC", "North", "16", "4f2683", "ffc62f", ""],
  ["NE", "New England", "Patriots", "AFC", "East", "17", "002a5c", "c60c30", ""],
  ["NO", "New Orleans", "Saints", "NFC", "South", "18", "d3bc8d", "000000", ""],
  ["NYG", "New York", "Giants", "NFC", "East", "19", "003c7f", "c9243f", "|New York G|"],
  ["NYJ", "New York", "Jets", "AFC", "East", "20", "115740", "ffffff", "|New York J|"],
  ["PHI", "Philadelphia", "Eagles", "NFC", "East", "21", "06424d", "000000", ""],
  ["PIT", "Pittsburgh", "Steelers", "AFC", "North", "23", "000000", "ffb612", ""],
  ["SEA", "Seattle", "Seahawks", "NFC", "West", "26", "002a5c", "69be28", ""],
  ["SF", "San Francisco", "49ers", "NFC", "West", "25", "aa0000", "b3995d", ""],
  ["TB", "Tampa Bay", "Buccaneers", "NFC", "South", "27", "bd1c36", "3e3a35", ""],
  ["TEN", "Tennessee", "Titans", "AFC", "South", "10", "4495d2", "001532", ""],
  ["WAS", "Washington", "Commanders", "NFC", "East", "28", "5a1414", "ffb612", "WSH||"],
];

export const TEAMS: readonly Team[] = ROWS.map(
  ([id, location, nickname, conference, division, espnId, color, altColor, overrides]) => {
    const [espnAbbr, kalshiName, kalshiCode] = overrides.split("|");
    return {
      id, location, nickname, name: `${location} ${nickname}`, conference, division: `${conference} ${division}`,
      espnId, espnAbbr: espnAbbr || id, kalshiName: kalshiName || location, kalshiCode: kalshiCode || id, color, altColor,
    };
  },
);

const byId = new Map<string, Team>(TEAMS.map((t) => [t.id, t]));
const byEspnId = new Map<string, Team>(TEAMS.map((t) => [t.espnId, t]));
const byEspnAbbr = new Map<string, Team>(TEAMS.map((t) => [t.espnAbbr, t]));
const byKalshiCode = new Map<string, Team>(TEAMS.map((t) => [t.kalshiCode, t]));

const normalize = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();

// Names that identify exactly one team: full name, nickname, Kalshi short name, and the
// location when only one team plays there (so "Los Angeles" and "New York" match nothing).
const byName = new Map<string, Team>();
{
  const perLocation = new Map<string, number>();
  for (const t of TEAMS) perLocation.set(t.location, (perLocation.get(t.location) ?? 0) + 1);
  for (const t of TEAMS) {
    const names = [t.name, t.nickname, t.kalshiName];
    if (perLocation.get(t.location) === 1) names.push(t.location);
    for (const n of names) byName.set(normalize(n), t);
  }
}

export function isTeamId(value: string): value is TeamId {
  return byId.has(value);
}
export function getTeam(id: TeamId): Team {
  return byId.get(id)!;
}
/** ESPN numeric id ("12" or 12). */
export function teamFromEspnId(id: string | number): Team | undefined {
  return byEspnId.get(String(id));
}
export function teamFromEspnAbbr(abbr: string): Team | undefined {
  return byEspnAbbr.get(abbr.toUpperCase());
}
/** Kalshi ticker suffix, e.g. "JAC" from "KXSB-27-JAC". */
export function teamFromKalshiCode(code: string): Team | undefined {
  return byKalshiCode.get(code.toUpperCase());
}
/**
 * A team from a display name as Polymarket, Bovada or Kalshi write it: "Kansas City Chiefs",
 * "Chiefs", "Kansas City", "Los Angeles R". Case and punctuation are ignored. Returns
 * undefined for anything ambiguous or unknown; callers must record that, never guess.
 */
export function teamFromName(name: string): Team | undefined {
  return byName.get(normalize(name));
}

export function teamsInConference(conference: Conference): Team[] {
  return TEAMS.filter((t) => t.conference === conference);
}
export function teamsInDivision(division: DivisionId): Team[] {
  return TEAMS.filter((t) => t.division === division);
}
