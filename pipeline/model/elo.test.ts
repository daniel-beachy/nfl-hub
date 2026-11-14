import { describe, expect, it } from "vitest";
import { ELO_MEAN, ELO_PARAMS, eloDelta, rate, winProb } from "./elo.ts";
import { evaluate, normalCdf, spreadProb } from "./evaluate.ts";
import { fixtureGames } from "./fixtures/load.ts";
import { toModelGames } from "./games.ts";
import { teamIndex } from "./types.ts";

const games = fixtureGames();

describe("games", () => {
  it("loads six full seasons in playing order", () => {
    expect(games).toHaveLength(1693);
    expect(games.every((g, i) => i === 0 || games[i - 1]!.date <= g.date)).toBe(true);
    // 2022 BUF at CIN was cancelled and never appears.
    expect(games.filter((g) => g.season === 2022 && g.type === "REG")).toHaveLength(271);
  });

  it("maps moved franchises and rejects unknown teams", () => {
    const row = { game_id: "2015_01_SD_OAK", season: 2015, game_type: "REG", week: 1, gameday: "2015-09-13", away_team: "SD", away_score: 3, home_team: "OAK", home_score: 7, location: "Home", spread_line: 1 };
    expect(toModelGames([row])[0]).toMatchObject({ home: "LV", away: "LAC", homeScore: 7 });
    expect(() => toModelGames([{ ...row, home_team: "XXX" }])).toThrow(/unknown team "XXX"/);
  });
});

describe("elo", () => {
  it("is zero-sum and symmetric", () => {
    expect(winProb(0)).toBe(0.5);
    expect(winProb(100) + winProb(-100)).toBeCloseTo(1);
    expect(eloDelta(60, 7, ELO_PARAMS)).toBeCloseTo(-eloDelta(-60, -7, ELO_PARAMS));
    const r = rate(games, 2025);
    expect(r.reduce((a, b) => a + b, 0) / r.length).toBeCloseTo(ELO_MEAN);
  });

  it("moves more for bigger margins and for upsets", () => {
    expect(eloDelta(0, 21, ELO_PARAMS)).toBeGreaterThan(eloDelta(0, 3, ELO_PARAMS));
    expect(eloDelta(-200, 7, ELO_PARAMS)).toBeGreaterThan(eloDelta(200, 7, ELO_PARAMS));
    expect(eloDelta(100, 0, ELO_PARAMS)).toBeLessThan(0); // a tie costs the favorite
  });

  it("uses only finished games up to the season asked for", () => {
    const through2021 = rate(games, 2021);
    const cut = rate(games.filter((g) => g.season <= 2021), 2021);
    expect([...through2021]).toEqual([...cut]);
    // Asking for the next season applies the between-season regression once.
    const next = rate(games.filter((g) => g.season <= 2021), 2022);
    const kc = teamIndex("KC");
    expect(next[kc]! - ELO_MEAN).toBeCloseTo((through2021[kc]! - ELO_MEAN) * (1 - ELO_PARAMS.regress));
  });
});

describe("evaluation", () => {
  it("turns spreads into probabilities", () => {
    expect(normalCdf(0)).toBeCloseTo(0.5);
    expect(normalCdf(1.96)).toBeCloseTo(0.975, 4);
    expect(spreadProb(3)).toBeGreaterThan(0.5);
    expect(spreadProb(3) + spreadProb(-3)).toBeCloseTo(1);
  });

  it("beats a coin flip and trails the closing spread", () => {
    // Ratings here start cold in 2020, so score 2022 on; docs/MODEL.md has the full-history numbers.
    const e = evaluate(games, 2022, 2025);
    expect(e.model.brier).toBeLessThan(e.coinFlip.brier - 0.015);
    expect(e.spread.brier).toBeLessThan(e.model.brier);
    expect(e.model.games).toBe(e.spread.games);
  });
});
