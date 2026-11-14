import { describe, expect, it } from "vitest";
import { TEAM_IDS } from "../../shared/teams.ts";
import { fixtureGames } from "./fixtures/load.ts";
import { asOf, forecast, mulberry32, type Forecast } from "./forecast.ts";

const games = fixtureGames();
const sum = (f: Forecast, key: "playoffs" | "division" | "seed1" | "conference" | "superBowl" | "wins") =>
  TEAM_IDS.reduce((a, t) => a + f.teams[t][key], 0);

describe("forecast", () => {
  const pre = forecast(asOf(games, "2023-09-01"), 2023, { sims: 2000 });

  it("before the season: every total adds up", () => {
    expect(pre.gamesPlayed).toBe(0);
    expect(pre.gamesLeft).toBe(272);
    expect(sum(pre, "playoffs")).toBeCloseTo(14);
    expect(sum(pre, "division")).toBeCloseTo(8);
    expect(sum(pre, "seed1")).toBeCloseTo(2);
    expect(sum(pre, "conference")).toBeCloseTo(2);
    expect(sum(pre, "superBowl")).toBeCloseTo(1);
    expect(sum(pre, "wins")).toBeCloseTo(272);
    for (const t of TEAM_IDS) {
      const f = pre.teams[t];
      expect(f.winDist).toHaveLength(18);
      expect(f.winDist.reduce((a, b) => a + b, 0)).toBeCloseTo(1);
      expect(f.division).toBeLessThanOrEqual(f.playoffs);
      expect(f.superBowl).toBeLessThanOrEqual(f.conference);
      expect(f.conference).toBeLessThanOrEqual(f.playoffs);
      expect(f.wins).toBeGreaterThan(4);
      expect(f.wins).toBeLessThan(13);
    }
  });

  it("before the season: gives a probability for every game, favoring the better-rated home team", () => {
    expect(pre.games).toHaveLength(272);
    expect(pre.games.every((g) => g.homeWinProb > 0.1 && g.homeWinProb < 0.9)).toBe(true);
    const opener = pre.games.find((g) => g.id === "2023_01_DET_KC")!;
    expect(opener.homeWinProb).toBeGreaterThan(0.6);
    // The 2022 champions start among the favorites.
    const ranked = [...TEAM_IDS].sort((a, b) => pre.teams[b].superBowl - pre.teams[a].superBowl);
    expect(ranked.slice(0, 4)).toContain("KC");
  });

  it("is reproducible, and the seed matters", () => {
    const again = forecast(asOf(games, "2023-09-01"), 2023, { sims: 2000 });
    expect(again).toEqual(pre);
    const other = forecast(asOf(games, "2023-09-01"), 2023, { sims: 2000, seed: 7 });
    expect(other.teams.KC.wins).not.toBe(pre.teams.KC.wins);
    expect(other.teams.KC.wins).toBeCloseTo(pre.teams.KC.wins, 0);
  });

  it("uses nothing from after the cutoff", () => {
    const changed = games.map((g) => (g.date >= "2023-11-01" && g.homeScore !== null ? { ...g, homeScore: g.awayScore, awayScore: g.homeScore } : g));
    expect(forecast(asOf(changed, "2023-11-01"), 2023, { sims: 500 })).toEqual(forecast(asOf(games, "2023-11-01"), 2023, { sims: 500 }));
  });

  it("mid-season: counts what is played and moves toward the teams that are winning", () => {
    const mid = forecast(asOf(games, "2023-11-15"), 2023, { sims: 2000 });
    expect(mid.gamesPlayed + mid.gamesLeft).toBe(272);
    expect(mid.gamesPlayed).toBeGreaterThan(130);
    expect(mid.teams.PHI.playoffs).toBeGreaterThan(0.95); // 8-1 at the time
    expect(mid.teams.CAR.playoffs).toBeLessThan(0.02); // 1-8
    expect(sum(mid, "wins")).toBeCloseTo(272);
  });

  it("after week 18: the field is the real one and only the bracket is uncertain", () => {
    const f = forecast(asOf(games, "2025-01-08"), 2024, { sims: 2000 });
    expect(f.gamesLeft).toBe(0);
    const inField = TEAM_IDS.filter((t) => f.teams[t].playoffs === 1);
    expect(inField).toHaveLength(14);
    expect(TEAM_IDS.filter((t) => f.teams[t].playoffs === 0)).toHaveLength(18);
    expect(f.teams.KC.seed1).toBe(1);
    expect(f.teams.DET.seed1).toBe(1);
    expect(f.teams.PHI.division).toBe(1);
    expect(f.teams.PHI.superBowl).toBeGreaterThan(0.03);
    expect(f.teams.PHI.superBowl).toBeLessThan(0.5);
    expect(f.teams.KC.wins).toBe(15);
  });

  it("during the playoffs: real results are honored", () => {
    // Before the conference championships of the 2024 season: four teams left.
    const f = forecast(asOf(games, "2025-01-22"), 2024, { sims: 2000 });
    const alive = TEAM_IDS.filter((t) => f.teams[t].superBowl > 0);
    expect(alive.sort()).toEqual(["BUF", "KC", "PHI", "WAS"]);
    expect(f.teams.KC.conference + f.teams.BUF.conference).toBeCloseTo(1);
    expect(f.games).toHaveLength(0); // asOf drops playoff games that were not set yet
  });

  it("a finished season: the champion is certain", () => {
    const f = forecast(games, 2024, { sims: 200 });
    expect(f.teams.PHI.superBowl).toBe(1);
    expect(f.teams.KC.conference).toBe(1);
    expect(f.games).toHaveLength(0);
  });

  it("needs a schedule", () => {
    expect(() => forecast(games, 2031)).toThrow(/no 2031 regular-season schedule/);
  });

  it("mulberry32 stays in [0, 1)", () => {
    const rng = mulberry32(1);
    for (let i = 0; i < 1000; i++) {
      const x = rng();
      expect(x >= 0 && x < 1).toBe(true);
    }
  });
});
