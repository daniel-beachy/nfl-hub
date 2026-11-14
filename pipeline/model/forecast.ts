import { GAMES_PER_TEAM } from "../../shared/ids.ts";
import { TEAM_IDS, type TeamId } from "../../shared/teams.ts";
import { ELO_PARAMS, eloDelta, homeDiff, rate, winProb, type EloParams } from "./elo.ts";
import { Standings, type Rng } from "./standings.ts";
import { isPlayed, N_TEAMS, teamIndex, type GameType, type ModelGame } from "./types.ts";

// The forecast: rate the games played so far, then play the rest of the season many times
// (regular season, seeding with real tiebreakers, playoff bracket). docs/MODEL.md "Simulation".

export interface ForecastOptions {
  /** Simulated seasons. The plan's number is 20,000. */
  sims?: number;
  /** Same seed and same games give the same forecast. */
  seed?: number;
  params?: EloParams;
}

export interface TeamForecast {
  /** Current Elo rating. */
  rating: number;
  /** Probabilities, 0 to 1. `conference` is winning the conference (making the Super Bowl). */
  playoffs: number;
  division: number;
  seed1: number;
  conference: number;
  superBowl: number;
  /** Mean final regular-season wins; a tie is half a win. */
  wins: number;
  /** Probability of finishing with exactly i wins, i = 0 to 17. A half win from a tie rounds down. */
  winDist: number[];
}

export interface GameForecast {
  id: string;
  week: number;
  type: GameType;
  date: string;
  home: TeamId;
  away: TeamId;
  /** From today's ratings, before any simulated results. */
  homeWinProb: number;
}

export interface Forecast {
  season: number;
  sims: number;
  seed: number;
  /** Regular-season games already final, and still to play, in the input. */
  gamesPlayed: number;
  gamesLeft: number;
  teams: Record<TeamId, TeamForecast>;
  /** Every game of the season in the input that is not final yet. */
  games: GameForecast[];
}

/**
 * The games as they were known before `date` (YYYY-MM-DD): later results are blanked and later
 * playoff games dropped (who plays in them was not known yet); the regular-season schedule
 * stays. This is how the backfill asks "what would the model have said then".
 */
export function asOf(games: readonly ModelGame[], date: string): ModelGame[] {
  return games
    .filter((g) => g.date < date || g.type === "REG")
    .map((g) => (g.date < date ? g : { ...g, homeScore: null, awayScore: null }));
}

/** Margin spread around the expected margin, and rating points per point of margin. */
const MARGIN_SD = 13.5;
const ELO_PER_POINT = 25;

const ROUND_KEY: Record<Exclude<GameType, "REG">, number> = { WC: 1, DIV: 2, CON: 3, SB: 4 };
const pairKey = (round: number, a: number, b: number) => (round * N_TEAMS + Math.min(a, b)) * N_TEAMS + Math.max(a, b);

/**
 * Forecast `season` from `games`: nflverse games in playing order, results present only for
 * what counts as already played (see `asOf`). Needs the season's schedule to be in `games`.
 */
export function forecast(games: readonly ModelGame[], season: number, opts: ForecastOptions = {}): Forecast {
  const sims = opts.sims ?? 20_000;
  const seed = opts.seed ?? season;
  const p = opts.params ?? ELO_PARAMS;
  const inSeason = games.filter((g) => g.season === season);
  const reg = inSeason.filter((g) => g.type === "REG");
  if (reg.length === 0) throw new Error(`no ${season} regular-season schedule in the games given`);

  const start = rate(games, season, p);
  const base = Standings.from(reg);
  const left = reg.filter((g) => !isPlayed(g));
  const leftHome = Int8Array.from(left.map((g) => teamIndex(g.home)));
  const leftAway = Int8Array.from(left.map((g) => teamIndex(g.away)));
  const leftNeutral = left.map((g) => g.neutral);

  // Playoff games already played are honored: the simulated bracket takes the real winner.
  const decided = new Map<number, number>();
  for (const g of inSeason) {
    if (g.type !== "REG" && isPlayed(g)) {
      const h = teamIndex(g.home);
      const a = teamIndex(g.away);
      decided.set(pairKey(ROUND_KEY[g.type], h, a), g.homeScore > g.awayScore ? h : a);
    }
  }

  const rng = mulberry32(seed);
  const normal = gaussian(rng);
  const r = new Float64Array(N_TEAMS);
  const st = new Standings();
  const count = { playoffs: new Uint32Array(N_TEAMS), division: new Uint32Array(N_TEAMS), seed1: new Uint32Array(N_TEAMS), conference: new Uint32Array(N_TEAMS), superBowl: new Uint32Array(N_TEAMS) };
  const winSum = new Float64Array(N_TEAMS);
  const winDist = new Uint32Array(N_TEAMS * (GAMES_PER_TEAM + 1));

  /** Play one simulated game, move the ratings, return the home margin. */
  const play = (h: number, a: number, neutral: boolean): number => {
    const diff = homeDiff(r[h]!, r[a]!, neutral, p);
    const homeWon = rng() < winProb(diff);
    // The winner comes from the Elo probability; the size of the win from a normal margin
    // around the rating gap, redrawn until it agrees with the winner.
    let m = 0;
    for (let i = 0; i < 4; i++) {
      m = diff / ELO_PER_POINT + MARGIN_SD * normal();
      if (m > 0 === homeWon) break;
    }
    const margin = Math.max(1, Math.abs(m)) * (homeWon ? 1 : -1);
    const d = eloDelta(diff, margin, p);
    r[h]! += d;
    r[a]! -= d;
    return margin;
  };

  /** Winner of a playoff game; the better seed is `h` and hosts unless neutral. */
  const playoff = (round: number, h: number, a: number, neutral = false): number => {
    const known = decided.get(pairKey(round, h, a));
    if (known !== undefined) return known;
    return play(h, a, neutral) > 0 ? h : a;
  };

  for (let s = 0; s < sims; s++) {
    r.set(start);
    st.copyFrom(base);
    for (let i = 0; i < left.length; i++) st.add(leftHome[i]!, leftAway[i]!, play(leftHome[i]!, leftAway[i]!, leftNeutral[i]!));
    for (let t = 0; t < N_TEAMS; t++) {
      winSum[t]! += st.wins(t);
      winDist[t * (GAMES_PER_TEAM + 1) + Math.min(GAMES_PER_TEAM, Math.floor(st.wins(t)))]!++;
    }
    const champs: number[] = [];
    for (let conf = 0; conf < 2; conf++) {
      const seeds = st.seed(conf, rng);
      const rank = new Map(seeds.map((t, i) => [t, i]));
      for (let i = 0; i < seeds.length; i++) {
        count.playoffs[seeds[i]!]!++;
        if (i < 4) count.division[seeds[i]!]!++;
      }
      count.seed1[seeds[0]!]!++;
      // Wild card: 2 v 7, 3 v 6, 4 v 5. Then reseed: the best seed left hosts the worst.
      const bySeed = (a: number, b: number) => rank.get(a)! - rank.get(b)!;
      const wc = [seeds[0]!, playoff(1, seeds[1]!, seeds[6]!), playoff(1, seeds[2]!, seeds[5]!), playoff(1, seeds[3]!, seeds[4]!)].sort(bySeed);
      const div = [playoff(2, wc[0]!, wc[3]!), playoff(2, wc[1]!, wc[2]!)].sort(bySeed);
      const champ = playoff(3, div[0]!, div[1]!);
      count.conference[champ]!++;
      champs.push(champ);
    }
    count.superBowl[playoff(4, champs[0]!, champs[1]!, true)]!++;
  }

  const teams = {} as Record<TeamId, TeamForecast>;
  TEAM_IDS.forEach((id, t) => {
    teams[id] = {
      rating: start[t]!,
      playoffs: count.playoffs[t]! / sims,
      division: count.division[t]! / sims,
      seed1: count.seed1[t]! / sims,
      conference: count.conference[t]! / sims,
      superBowl: count.superBowl[t]! / sims,
      wins: winSum[t]! / sims,
      winDist: Array.from(winDist.subarray(t * (GAMES_PER_TEAM + 1), (t + 1) * (GAMES_PER_TEAM + 1)), (n) => n / sims),
    };
  });
  return {
    season,
    sims,
    seed,
    gamesPlayed: reg.length - left.length,
    gamesLeft: left.length,
    teams,
    games: inSeason
      .filter((g) => !isPlayed(g))
      .map((g) => ({
        id: g.id, week: g.week, type: g.type, date: g.date, home: g.home, away: g.away,
        homeWinProb: winProb(homeDiff(start[teamIndex(g.home)]!, start[teamIndex(g.away)]!, g.neutral, p)),
      })),
  };
}

/** Small, fast, seedable generator (public domain mulberry32). */
export function mulberry32(seed: number): Rng {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Standard normal draws (Box-Muller, both values used). */
function gaussian(rng: Rng): () => number {
  let spare: number | null = null;
  return () => {
    if (spare !== null) {
      const s = spare;
      spare = null;
      return s;
    }
    const u = Math.sqrt(-2 * Math.log(1 - rng()));
    const v = 2 * Math.PI * rng();
    spare = u * Math.sin(v);
    return u * Math.cos(v);
  };
}
