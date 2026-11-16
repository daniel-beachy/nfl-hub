import { describe, expect, it } from "vitest";
import { buildLeaders } from "./leaders.ts";

// Synthetic rows (shape only) to pin the aggregation rules: regular season only, running
// totals aligned to weeks, ties broken by id, latest team wins, unknown teams become null.

const row = (id: string, week: number, extra: Record<string, unknown>, seasonType = "REG") => ({
  player_id: id, player_display_name: `Player ${id}`, position: "QB", headshot_url: "", season: 2025, week, season_type: seasonType, team: "KC", ...extra,
});
const games = [1, 2, 3].map((w) => ({ season: 2025, game_type: "REG", week: w, gameday: `2025-09-0${w}` }));

describe("buildLeaders", () => {
  const stats = [
    row("a", 1, { passing_yards: 300 }),
    row("a", 3, { passing_yards: 250, team: "BUF" }),
    row("b", 1, { passing_yards: 100 }),
    row("b", 2, { passing_yards: 500, team: "XYZ" }),
    row("a", 19, { passing_yards: 999 }, "POST"),
    row("c", 2, { def_sacks: 1.5 }),
  ];
  const out = buildLeaders(2025, stats as never, games as never, "u", "2025-12-01T00:00:00.000Z");

  it("sums the regular season only, with running totals per week", () => {
    expect(out.weeks).toEqual([1, 2, 3]);
    expect(out.dates).toEqual(["2025-09-01", "2025-09-02", "2025-09-03"]);
    const [first, second] = out.categories.passingYards!;
    expect(first).toMatchObject({ playerId: "b", total: 600, cumulative: [100, 600, 600], team: null });
    expect(second).toMatchObject({ playerId: "a", total: 550, cumulative: [300, 300, 550], team: "BUF", headshot: null });
  });
  it("keeps decimals where the stat has them and leaves out players with nothing", () => {
    expect(out.categories.sacks).toEqual([expect.objectContaining({ playerId: "c", total: 1.5 })]);
    expect(out.categories.rushingYards).toEqual([]);
  });
  it("refuses a week the games table cannot date", () => {
    expect(() => buildLeaders(2025, [row("a", 4, { passing_yards: 1 })] as never, games as never, "u", "2025-12-01T00:00:00.000Z")).toThrow(/week\(s\) 4/);
  });
});
