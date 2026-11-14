import { describe, expect, it } from "vitest";
import { TEAM_IDS, type TeamId } from "../../shared/teams.ts";
import { fixtureGames } from "./fixtures/load.ts";
import { Standings } from "./standings.ts";
import { teamIndex, type ModelGame } from "./types.ts";

const games = fixtureGames();
const noRandom = () => {
  throw new Error("tiebreaker fell through to a coin flip");
};

// The real playoff seeds, AFC then NFC, 1 to 7 (NFL.com final standings).
const SEEDS: Record<number, [string, string]> = {
  2020: ["KC BUF PIT TEN BAL CLE IND", "GB NO SEA WAS TB LA CHI"],
  2021: ["TEN KC BUF CIN LV NE PIT", "GB TB DAL LA ARI SF PHI"],
  2022: ["KC BUF CIN JAX LAC BAL MIA", "PHI SF MIN TB DAL NYG SEA"],
  2023: ["BAL BUF KC HOU CLE MIA PIT", "SF DAL DET TB PHI LA GB"],
  2024: ["KC BUF BAL HOU LAC PIT DEN", "DET PHI TB LA MIN WAS GB"],
  2025: ["DEN NE JAX PIT HOU BUF LAC", "SEA CHI PHI CAR LA SF GB"],
};

const names = (seeds: number[]) => seeds.map((i) => TEAM_IDS[i]).join(" ");

describe("playoff seeding", () => {
  for (const [season, [afc, nfc]] of Object.entries(SEEDS)) {
    it(`reproduces the ${season} seeds from final results`, () => {
      const s = Standings.from(games.filter((g) => g.season === Number(season)));
      expect(names(s.seed(0, noRandom))).toBe(afc);
      expect(names(s.seed(1, noRandom))).toBe(nfc);
    });

    it(`${season} seeds agree with the wild-card games actually played`, () => {
      const order = `${afc} ${nfc}`.split(" ");
      const seedOf = (t: string) => (order.indexOf(t) % 7) + 1;
      const wc = games.filter((g) => g.season === Number(season) && g.type === "WC");
      expect(wc).toHaveLength(6);
      for (const g of wc) expect(seedOf(g.home) + seedOf(g.away)).toBe(9);
    });
  }

  it("ranks a whole conference", () => {
    const s = Standings.from(games.filter((g) => g.season === 2024));
    const all = s.seed(0, noRandom, 16);
    expect(new Set(all).size).toBe(16);
    expect(names(all.slice(0, 7))).toBe(SEEDS[2024]![0]);
  });
});

// Hand-built cases for the rules the six real seasons may not exercise.
let n = 0;
function game(home: TeamId, away: TeamId, homeScore: number, awayScore: number): ModelGame {
  return { id: `t${n++}`, season: 2030, week: 1, type: "REG", date: "2030-09-08", home, away, neutral: false, homeScore, awayScore, spread: null };
}

describe("tiebreaker steps", () => {
  it("division: head to head decides before division record", () => {
    // BUF and MIA both 2-1. BUF beat MIA; MIA has the better division record.
    const s = Standings.from([
      game("BUF", "MIA", 20, 10), game("BUF", "KC", 20, 10), game("NE", "BUF", 20, 10),
      game("MIA", "NE", 20, 10), game("MIA", "NYJ", 20, 10),
    ]);
    const east = ["BUF", "MIA", "NE", "NYJ"].map((t) => teamIndex(t as TeamId));
    expect(TEAM_IDS[s.rankDivision(east, noRandom)[0]!]).toBe("BUF");
  });

  it("division: three tied clubs restart as two once one is dropped", () => {
    // BUF, MIA, NE all 2-2 overall. Among the three: BUF 2-0, MIA 1-1, NE 0-2... then MIA over NE head to head.
    const s = Standings.from([
      game("BUF", "MIA", 20, 10), game("BUF", "NE", 20, 10), game("MIA", "NE", 20, 10),
      game("KC", "BUF", 20, 10), game("DEN", "BUF", 20, 10),
      game("MIA", "KC", 20, 10), game("DEN", "MIA", 20, 10),
      game("NE", "KC", 20, 10), game("NE", "DEN", 20, 10),
    ]);
    const east = ["NE", "MIA", "BUF"].map((t) => teamIndex(t as TeamId));
    expect(s.rankDivision(east, noRandom).map((i) => TEAM_IDS[i])).toEqual(["BUF", "MIA", "NE"]);
  });

  it("wild card: a second-place club cannot pass its own division's first-place club", () => {
    // KC wins the West. DEN and LAC (same division) and BUF are level; DEN beat LAC twice.
    const s = Standings.from([
      game("KC", "DEN", 20, 10), game("KC", "LAC", 20, 10), game("KC", "LV", 20, 10),
      game("DEN", "LAC", 20, 10), game("LAC", "DEN", 10, 20), game("LV", "DEN", 20, 10),
      game("LAC", "BUF", 20, 10), game("LAC", "LV", 20, 10), game("LAC", "NYJ", 20, 10),
      game("DEN", "NYJ", 20, 10),
    ]);
    const order = s.seed(0, () => 0, 16).map((i) => TEAM_IDS[i]);
    expect(order.indexOf("DEN")).toBeLessThan(order.indexOf("LAC"));
  });

  it("falls back to the random draw only when everything is level", () => {
    const s = new Standings();
    const afc = s.seed(0, () => 0.999);
    expect(afc).toHaveLength(7);
    expect(new Set(afc.slice(0, 4).map((t) => TEAM_IDS[t])).size).toBe(4);
  });

  it("counts a tie as half a win", () => {
    const s = Standings.from([game("BUF", "MIA", 20, 20), game("BUF", "NE", 20, 10), game("MIA", "NYJ", 20, 10), game("NE", "MIA", 10, 20)]);
    expect(s.wins(teamIndex("BUF"))).toBe(1.5);
    const east = ["BUF", "MIA", "NE", "NYJ"].map((t) => teamIndex(t as TeamId));
    expect(TEAM_IDS[s.rankDivision(east, noRandom)[0]!]).toBe("MIA"); // 2-0-1 beats 1-0-1
  });
});
