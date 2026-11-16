import { describe, expect, it } from "vitest";
import { modelSeasonSchema } from "../../shared/model.ts";
import { fixtureGames } from "./fixtures/load.ts";
import { addDays, buildSeason, inputHash, planPoints, runModelStage, standingsAsOf } from "./stage.ts";
import { ELO_PARAMS } from "./elo.ts";
import type { ModelGame } from "./types.ts";

const all = fixtureGames();
const now = new Date("2026-11-15T09:00:00Z");
/** The 2023 season as it looked on the morning of `date`: later results blanked, schedule kept. */
const knownOn = (date: string): ModelGame[] =>
  all.filter((g) => g.season <= 2023 && (g.date < date || g.type === "REG")).map((g) => (g.date < date ? g : { ...g, homeScore: null, awayScore: null }));

describe("planPoints", () => {
  const plans = planPoints(all, 2023);

  it("a finished season: preseason, then one point per game day, weeks 1 to 22 complete", () => {
    expect(plans[0]).toEqual({ date: "2023-09-07", week: 0, phase: "preseason", weekComplete: true });
    const dates = plans.map((p) => p.date);
    expect([...dates].sort()).toEqual(dates);
    expect(new Set(dates).size).toBe(dates.length);
    const gameDays = new Set(all.filter((g) => g.season === 2023).map((g) => g.date));
    expect(plans.length).toBe(gameDays.size + 1);
    expect(plans.filter((p) => p.weekComplete && p.week > 0).map((p) => p.week)).toEqual(Array.from({ length: 22 }, (_, i) => i + 1));
    // The Super Bowl was 2024-02-11; its point is the next day.
    expect(plans.at(-1)).toEqual({ date: "2024-02-12", week: 22, phase: "postseason", weekComplete: true });
  });

  it("each week's complete point is the day after its last game", () => {
    for (const p of plans.filter((x) => x.weekComplete && x.week > 0)) {
      const last = all.filter((g) => g.season === 2023 && g.week === p.week).reduce((d, g) => (g.date > d ? g.date : d), "");
      expect(p.date).toBe(addDays(last, 1));
    }
  });

  it("a season in progress: no point for a game day still being played, and the current week is not complete", () => {
    // Morning of Sunday 2023-10-15 (week 6): Thursday's game is final, Sunday's are not.
    const games = knownOn("2023-10-15");
    const p = planPoints(games, 2023);
    expect(p.at(-1)!.date).toBe("2023-10-13");
    expect(p.at(-1)!.weekComplete).toBe(false);
    expect(p.filter((x) => x.weekComplete && x.week > 0).at(-1)!.week).toBe(5);
    // Half of Sunday final: Sunday gets no point yet.
    let blanked = 0;
    const half = all
      .filter((g) => g.season <= 2023 && (g.date <= "2023-10-15" || g.type === "REG"))
      .map((g) => (g.date < "2023-10-15" || (g.date === "2023-10-15" && blanked++ % 2 === 0) ? g : { ...g, homeScore: null, awayScore: null }));
    expect(planPoints(half, 2023).at(-1)!.date).toBe("2023-10-13");
  });

  it("a game never played does not hold back the points after it", () => {
    const cancelled = all.map((g) => (g.id === "2023_05_JAX_BUF" ? { ...g, homeScore: null, awayScore: null } : g));
    const p = planPoints(cancelled, 2023);
    expect(p.length).toBe(plans.length);
    expect(p.find((x) => x.week === 5 && x.weekComplete)).toBeDefined();
  });

  it("no schedule, no points", () => {
    expect(planPoints(all, 2030)).toEqual([]);
  });
});

describe("buildSeason", () => {
  const sims = 300;

  it("a season in progress: valid file, only results known at each date, and a current block", () => {
    const games = knownOn("2023-10-15");
    const f = buildSeason({ games, season: 2023, sims, gamesUpdatedAt: "x", now })!;
    expect(modelSeasonSchema.safeParse(f).success).toBe(true);
    expect(f.points[0]!.gamesPlayed).toBe(0);
    for (let i = 1; i < f.points.length; i++) expect(f.points[i]!.gamesPlayed).toBeGreaterThan(f.points[i - 1]!.gamesPlayed);
    expect(f.points.at(-1)!.gamesPlayed + f.points.at(-1)!.gamesLeft).toBe(272);
    expect(f.current!.date).toBe("2023-10-13");
    expect(f.current!.games.length).toBe(f.points.at(-1)!.gamesLeft);
    expect(f.current!.winDist.KC).toHaveLength(18);
  });

  it("later results never change an earlier point (asOf is the only filter)", () => {
    const early = buildSeason({ games: knownOn("2023-10-15"), season: 2023, sims, gamesUpdatedAt: "x", now })!;
    const later = buildSeason({ games: knownOn("2023-11-01"), season: 2023, sims, gamesUpdatedAt: "x", now })!;
    for (const p of early.points) expect(later.points.find((q) => q.date === p.date)).toEqual(p);
  });

  it("a finished season has no current block and ends with a champion", () => {
    const f = buildSeason({ games: all.filter((g) => g.season <= 2022), season: 2022, sims, gamesUpdatedAt: "x", now })!;
    expect(f.current).toBeNull();
    const last = f.points.at(-1)!;
    expect(last.teams.KC.superBowl).toBe(1);
    expect(last.gamesLeft).toBe(0);
  });
});

describe("runModelStage", () => {
  const games = all.filter((g) => g.season <= 2021);
  const base = { games, gamesUpdatedAt: "x", today: "2021-11-15", now, sims: 200, log: () => {} };

  it("computes every season from 2020, then keeps a season whose inputs did not change", () => {
    const first = runModelStage({ ...base, previous: () => undefined });
    expect(first.computed).toEqual([2020, 2021]);
    const files = new Map(first.files.map((f) => [f.season, f]));
    const changed = games.map((g) => (g.id === "2021_10_BAL_MIA" ? { ...g, homeScore: (g.homeScore ?? 0) + 1 } : g));
    const second = runModelStage({ ...base, games: changed, previous: (s) => files.get(s) });
    expect(second.reused).toEqual([2020]);
    expect(second.computed).toEqual([2021]);
  });

  it("a corrupt previous file is recomputed, never trusted", () => {
    const r = runModelStage({ ...base, previous: () => ({ schemaVersion: 1, inputHash: inputHash(games, 2020, 200, ELO_PARAMS) }) });
    expect(r.computed).toEqual([2020, 2021]);
  });

  it("a past season with no schedule fails the stage", () => {
    expect(() => runModelStage({ ...base, games: games.filter((g) => g.season !== 2020), previous: () => undefined })).toThrow(/2020/);
  });
});

describe("standingsAsOf", () => {

  it("gives each team's real record and the real seeds once the 2022 regular season is over", () => {
    const st = standingsAsOf(all, 2022, "2023-01-10")!;
    expect(st.records.KC).toEqual({ w: 14, l: 3, t: 0 });
    expect(st.records.HOU).toEqual({ w: 3, l: 13, t: 1 });
    expect(st.order.AFC.slice(0, 7).join(" ")).toBe("KC BUF CIN JAX LAC BAL MIA");
    expect(st.order.NFC.slice(0, 7).join(" ")).toBe("PHI SF MIN TB DAL NYG SEA");
    expect(new Set([...st.order.AFC, ...st.order.NFC]).size).toBe(32);
  });
  it("is null before the season's first game", () => {
    expect(standingsAsOf(all, 2022, "2022-09-01")).toBeNull();
  });
});
