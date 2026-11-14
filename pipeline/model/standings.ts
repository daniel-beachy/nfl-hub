import { DIVISION_IDS } from "../../shared/ids.ts";
import { TEAMS } from "../../shared/teams.ts";
import { isPlayed, N_TEAMS, teamIndex, type ModelGame } from "./types.ts";

// Standings and playoff seeding with the NFL tiebreaking procedures (docs/MODEL.md
// "Tiebreakers"). Built for the simulation: typed arrays, no allocation per game, and exact
// comparisons (records are kept as points = 2 * wins + ties, compared as integer fractions).

/** Division number 0 to 7 and conference number 0 (AFC) or 1 (NFC), by team index. */
export const DIV_OF = Int8Array.from(TEAMS.map((t) => DIVISION_IDS.indexOf(t.division)));
export const CONF_OF = Int8Array.from(TEAMS.map((t) => (t.conference === "AFC" ? 0 : 1)));
const DIV_TEAMS: number[][] = DIVISION_IDS.map((_, d) => TEAMS.map((_, i) => i).filter((i) => DIV_OF[i] === d));

const MAX_GAMES = 20;
/** Returns a number in [0, 1). Only used when every tiebreaker step is level. */
export type Rng = () => number;

export class Standings {
  /** 2 * wins + ties, and games played. */
  readonly pts = new Int16Array(N_TEAMS);
  readonly gp = new Int16Array(N_TEAMS);
  readonly divPts = new Int16Array(N_TEAMS);
  readonly divGp = new Int16Array(N_TEAMS);
  readonly confPts = new Int16Array(N_TEAMS);
  readonly confGp = new Int16Array(N_TEAMS);
  /** Head to head, [team * 32 + opponent]. */
  readonly h2hPts = new Int16Array(N_TEAMS * N_TEAMS);
  readonly h2hGp = new Int16Array(N_TEAMS * N_TEAMS);
  /** Each team's games in order: opponent and points won (2, 1 or 0). */
  readonly logOpp = new Int8Array(N_TEAMS * MAX_GAMES);
  readonly logPts = new Int8Array(N_TEAMS * MAX_GAMES);
  private readonly arrays = [this.pts, this.gp, this.divPts, this.divGp, this.confPts, this.confGp, this.h2hPts, this.h2hGp, this.logOpp, this.logPts];

  static from(games: readonly ModelGame[]): Standings {
    const s = new Standings();
    for (const g of games) {
      if (g.type === "REG" && isPlayed(g)) s.add(teamIndex(g.home), teamIndex(g.away), g.homeScore - g.awayScore);
    }
    return s;
  }

  copyFrom(o: Standings): void {
    for (let i = 0; i < this.arrays.length; i++) this.arrays[i]!.set(o.arrays[i]!);
  }

  /** Record one regular-season game. `margin` is home score minus away score. */
  add(home: number, away: number, margin: number): void {
    const hp = margin > 0 ? 2 : margin < 0 ? 0 : 1;
    this.one(home, away, hp);
    this.one(away, home, 2 - hp);
  }

  private one(t: number, o: number, p: number): void {
    const n = this.gp[t]!;
    this.logOpp[t * MAX_GAMES + n] = o;
    this.logPts[t * MAX_GAMES + n] = p;
    this.pts[t]! += p;
    this.gp[t]!++;
    if (CONF_OF[t] === CONF_OF[o]) {
      this.confPts[t]! += p;
      this.confGp[t]!++;
      if (DIV_OF[t] === DIV_OF[o]) {
        this.divPts[t]! += p;
        this.divGp[t]!++;
      }
    }
    this.h2hPts[t * N_TEAMS + o]! += p;
    this.h2hGp[t * N_TEAMS + o]!++;
  }

  /** Wins plus half of ties. */
  wins(t: number): number {
    return this.pts[t]! / 2;
  }

  /**
   * The conference's playoff order: four division winners (seeds 1 to 4), then wild cards.
   * `count` 7 gives the playoff field; 16 ranks the whole conference for a standings page.
   */
  seed(conf: number, rng: Rng, count = 7): number[] {
    const order = DIV_TEAMS.filter((d) => CONF_OF[d[0]!] === conf).map((d) => this.rankDivision(d, rng));
    const place = new Int8Array(N_TEAMS); // position within own division, for the wild-card rule
    for (const d of order) d.forEach((t, i) => (place[t] = i));

    const seeds: number[] = [];
    let pool = order.map((d) => d[0]!);
    while (pool.length > 0) {
      const pick = this.breakWild(this.topByRecord(pool), rng);
      seeds.push(pick);
      pool = pool.filter((t) => t !== pick);
    }
    pool = order.flatMap((d) => d.slice(1));
    while (seeds.length < count && pool.length > 0) {
      // Only the best-placed club of each division goes into a wild-card tiebreaker.
      const tied = this.topByRecord(pool);
      const best = tied.filter((t) => !tied.some((o) => DIV_OF[o] === DIV_OF[t] && place[o]! < place[t]!));
      const pick = this.breakWild(best, rng);
      seeds.push(pick);
      pool = pool.filter((t) => t !== pick);
    }
    return seeds;
  }

  /** A division in finishing order. */
  rankDivision(teams: readonly number[], rng: Rng): number[] {
    const out: number[] = [];
    let pool = [...teams];
    while (pool.length > 0) {
      const pick = this.breakDivision(this.topByRecord(pool), rng);
      out.push(pick);
      pool = pool.filter((t) => t !== pick);
    }
    return out;
  }

  private topByRecord(pool: readonly number[]): number[] {
    return best(pool, (t) => this.pts[t]!, (t) => this.gp[t]!);
  }

  // Each step keeps the clubs with the best value. When a step drops anyone, the clubs left
  // start again from the first step, as the NFL procedure says.
  private breakDivision(group: number[], rng: Rng): number {
    if (group.length === 1) return group[0]!;
    const steps: (() => number[])[] = [
      () => best(group, (t) => this.sumVs(this.h2hPts, t, group), (t) => this.sumVs(this.h2hGp, t, group)),
      () => best(group, (t) => this.divPts[t]!, (t) => this.divGp[t]!),
      () => this.commonGames(group, 0),
      () => best(group, (t) => this.confPts[t]!, (t) => this.confGp[t]!),
      () => this.strength(group, true),
      () => this.strength(group, false),
    ];
    for (const step of steps) {
      const left = step();
      if (left.length < group.length) return this.breakDivision(left, rng);
    }
    return group[Math.floor(rng() * group.length)]!;
  }

  /** Clubs from different divisions (wild cards, or division winners being seeded). */
  private breakWild(group: number[], rng: Rng): number {
    if (group.length === 1) return group[0]!;
    const steps: (() => number[])[] = [
      () => this.headToHeadWild(group),
      () => best(group, (t) => this.confPts[t]!, (t) => this.confGp[t]!),
      () => this.commonGames(group, 4),
      () => this.strength(group, true),
      () => this.strength(group, false),
    ];
    for (const step of steps) {
      const left = step();
      if (left.length < group.length) return this.breakWild(left, rng);
    }
    return group[Math.floor(rng() * group.length)]!;
  }

  // Two clubs: head to head if they met. Three or more: only a sweep counts, either a club
  // that beat every other one (it wins) or a club that lost to every other one (it is out).
  private headToHeadWild(group: number[]): number[] {
    if (group.length === 2) {
      const [a, b] = group as [number, number];
      if (this.h2hGp[a * N_TEAMS + b] === 0) return group;
      return best(group, (t) => this.sumVs(this.h2hPts, t, group), (t) => this.sumVs(this.h2hGp, t, group));
    }
    const swept = (t: number, won: boolean) =>
      group.every((o) => {
        if (o === t) return true;
        const gp = this.h2hGp[t * N_TEAMS + o]!;
        return gp > 0 && this.h2hPts[t * N_TEAMS + o] === (won ? 2 * gp : 0);
      });
    const winner = group.find((t) => swept(t, true));
    if (winner !== undefined) return [winner];
    const left = group.filter((t) => !swept(t, false));
    return left.length > 0 ? left : group;
  }

  private sumVs(arr: Int16Array, t: number, group: readonly number[]): number {
    let s = 0;
    for (const o of group) if (o !== t) s += arr[t * N_TEAMS + o]!;
    return s;
  }

  /** Record against opponents every club in the group has played. Skipped if any club has fewer than `min` such games. */
  private commonGames(group: number[], min: number): number[] {
    let mask = -1;
    for (const t of group) {
      let m = 0;
      for (let i = 0; i < this.gp[t]!; i++) m |= 1 << this.logOpp[t * MAX_GAMES + i]!;
      mask &= m;
    }
    const pts = new Map<number, number>();
    const gp = new Map<number, number>();
    for (const t of group) {
      let p = 0;
      let n = 0;
      for (let i = 0; i < this.gp[t]!; i++) {
        if (mask & (1 << this.logOpp[t * MAX_GAMES + i]!)) {
          p += this.logPts[t * MAX_GAMES + i]!;
          n++;
        }
      }
      if (n < min) return group;
      pts.set(t, p);
      gp.set(t, n);
    }
    return best(group, (t) => pts.get(t)!, (t) => gp.get(t)!);
  }

  /** Strength of victory (combined record of the opponents beaten) or of schedule (all opponents), per game. */
  private strength(group: number[], victoriesOnly: boolean): number[] {
    const pts = new Map<number, number>();
    const gp = new Map<number, number>();
    for (const t of group) {
      let p = 0;
      let n = 0;
      for (let i = 0; i < this.gp[t]!; i++) {
        if (victoriesOnly && this.logPts[t * MAX_GAMES + i] !== 2) continue;
        const o = this.logOpp[t * MAX_GAMES + i]!;
        p += this.pts[o]!;
        n += this.gp[o]!;
      }
      pts.set(t, p);
      gp.set(t, n);
    }
    return best(group, (t) => pts.get(t)!, (t) => gp.get(t)!);
  }
}

/** The teams with the highest num/den, compared exactly. No games counts as .000. */
function best(group: readonly number[], num: (t: number) => number, den: (t: number) => number): number[] {
  let top: number[] = [];
  let tn = 0;
  let td = 1;
  for (const t of group) {
    const d = den(t);
    const n = d === 0 ? 0 : num(t);
    const c = top.length === 0 ? 1 : n * td - tn * (d === 0 ? 1 : d);
    if (c > 0) {
      top = [t];
      tn = n;
      td = d === 0 ? 1 : d;
    } else if (c === 0) top.push(t);
  }
  return top;
}
