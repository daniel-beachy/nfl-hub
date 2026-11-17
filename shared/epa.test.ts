import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { normalizeSummary } from "../app/src/lib/espn/game.ts";
import { parseSummary } from "../app/src/lib/espn/schemas.ts";
import { distanceBucket, epTableSchema, expectedPoints, type EpTable } from "./ep.ts";
import { classify, estimateEpa, secondsLeftInHalf, teamEpa, type EpaPlay, type EpaSpot } from "./epa.ts";

/** A made-up but football-shaped table: closer is better, later downs and longer distances are worse, late in a half is worth less. */
export function testTable(): EpTable {
  const value = (late: number, down: number, bucket: number, yards: number) => Math.max(-3.9, (6 - 0.07 * yards - 0.55 * (down - 1) - 0.25 * bucket) * (late ? 0.5 : 1));
  const ep = [0, 1].map((late) => [1, 2, 3, 4].map((down) => [0, 1, 2, 3].map((bucket) => Array.from({ length: 99 }, (_, i) => value(late, down, bucket, i + 1)))));
  return epTableSchema.parse({ schemaVersion: 1, builtAt: "2026-11-17T00:00:00Z", seasons: [2016, 2025], plays: 0, ep });
}
const T = testTable();
const EP = (down: number, distance: number, yards: number, seconds = 1500) => expectedPoints(T, { down, distance, yardsToEndzone: yards, secondsLeftInHalf: seconds });

const spot = (team: string | null, down: number | null, distance: number | null, yardsToEndzone: number | null): EpaSpot => ({ team, down, distance, yardsToEndzone });
function play(type: string, start: EpaSpot, end: EpaSpot, score: [number, number] = [0, 0], more: Partial<EpaPlay> = {}): EpaPlay {
  return { type, text: "", period: 1, clock: "10:00", homeScore: score[0], awayScore: score[1], start, end, ...more };
}
const one = (p: EpaPlay, before: EpaPlay[] = [], after: EpaPlay[] = []) => estimateEpa([...before, p, ...after], "HOME", T)[before.length]!;

describe("EP table lookup", () => {
  it("buckets distance and clamps what is out of range", () => {
    expect([1, 2, 3, 6, 7, 10, 11, 30].map(distanceBucket)).toEqual([0, 0, 1, 1, 2, 2, 3, 3]);
    expect(EP(1, 10, 75)).toBeCloseTo(6 - 5.25 - 0.5);
    expect(EP(9, 0, 150)).toBe(EP(4, 1, 99));
    expect(EP(1, 10, 50, 120)).toBe(EP(1, 10, 50, 5));
    expect(EP(1, 10, 50, 121)).toBeCloseTo(2 * EP(1, 10, 50, 120));
  });
  it("reads the clock", () => {
    expect([secondsLeftInHalf(1, "15:00"), secondsLeftInHalf(2, "1:58"), secondsLeftInHalf(3, "0:07"), secondsLeftInHalf(4, "12:00"), secondsLeftInHalf(5, "10:00"), secondsLeftInHalf(2, "?")]).toEqual([1800, 118, 907, 720, 600, 0]);
  });
});

describe("EPA special cases", () => {
  it("ordinary play: EP after minus EP before", () => {
    const r = one(play("Rush", spot("HOME", 1, 10, 75), spot("HOME", 2, 4, 69)));
    expect(r).toMatchObject({ offense: "HOME", kind: "rush", counts: true, success: true });
    expect(r.epa).toBeCloseTo(EP(2, 4, 69) - EP(1, 10, 75));
    expect(one(play("Sack", spot("AWAY", 2, 8, 40), spot("AWAY", 3, 16, 48)))).toMatchObject({ kind: "pass", success: false });
  });
  it("touchdown is 7 whatever the try did; a defensive touchdown is -7", () => {
    for (const points of [6, 7, 8]) expect(one(play("Passing Touchdown", spot("HOME", 2, 5, 20), spot("HOME", null, null, null), [points, 0])).epa).toBeCloseTo(7 - EP(2, 5, 20));
    expect(one(play("Rushing Touchdown", spot("AWAY", 1, 1, 1), spot("AWAY", null, null, null), [3, 13]), [play("Rush", spot("AWAY", 1, 10, 11), spot("AWAY", 1, 1, 1), [3, 6])]).epa).toBeCloseTo(7 - EP(1, 1, 1));
    const pickSix = one(play("Interception Return Touchdown", spot("HOME", 1, 10, 60), spot("AWAY", null, null, null), [0, 7]));
    expect(pickSix).toMatchObject({ kind: "pass", success: false });
    expect(pickSix.epa).toBeCloseTo(-7 - EP(1, 10, 60));
  });
  it("field goal is 3, a miss hands over the ball, a safety is -2", () => {
    expect(one(play("Field Goal Good", spot("HOME", 4, 7, 34), spot("HOME", -1, 10, 0), [3, 0]))).toMatchObject({ kind: "kick", counts: false, success: null, epa: 3 - EP(4, 7, 34) });
    expect(one(play("Field Goal Missed", spot("HOME", 4, 7, 34), spot("AWAY", 1, 10, 58))).epa).toBeCloseTo(-EP(1, 10, 58) - EP(4, 7, 34));
    expect(one(play("Sack", spot("HOME", 2, 10, 98), spot("HOME", null, null, null), [0, 2]), [], []).epa).toBeCloseTo(-2 - EP(2, 10, 98));
  });
  it("change of possession is minus the other team's EP", () => {
    expect(one(play("Punt", spot("HOME", 4, 7, 62), spot("AWAY", 1, 10, 74))).epa).toBeCloseTo(-EP(1, 10, 74) - EP(4, 7, 62));
    expect(one(play("Pass Interception Return", spot("HOME", 4, 2, 40), spot("AWAY", 1, 10, 90))).epa).toBeCloseTo(-EP(1, 10, 90) - EP(4, 2, 40));
    const downs = one(play("Pass Incompletion", spot("AWAY", 4, 3, 30), spot("HOME", 1, 10, 70)));
    expect(downs).toMatchObject({ kind: "pass", success: false });
    expect(downs.epa).toBeCloseTo(-EP(1, 10, 70) - EP(4, 3, 30));
  });
  it("the last play of a half is worth nothing afterwards, but only once the half is seen to end", () => {
    const last = play("Pass Reception", spot("HOME", 1, 10, 60), spot("HOME", 1, 10, 30), [0, 0], { period: 2, clock: "0:04" });
    const live = one(last);
    expect(live.epa).toBeCloseTo(EP(1, 10, 30, 4) - EP(1, 10, 60, 4));
    const admin = (type: string, period: number) => play(type, spot("HOME", null, null, null), spot("HOME", null, null, null), [0, 0], { period, clock: "0:00" });
    expect(one(last, [], [admin("Timeout", 2), admin("End of Half", 2)]).epa).toBeCloseTo(-EP(1, 10, 60, 4));
    expect(one(last, [], [play("Kickoff", spot("AWAY", null, null, 65), spot("HOME", 1, 10, 70), [0, 0], { period: 3, clock: "15:00" })]).epa).toBeCloseTo(-EP(1, 10, 60, 4));
    // The end of the first quarter is not the end of a half.
    const q1 = { ...last, period: 1 };
    expect(one(q1, [], [admin("End Period", 1), play("Rush", spot("HOME", 1, 10, 30), spot("HOME", 2, 8, 28), [0, 0], { period: 2, clock: "15:00" })]).epa).toBeCloseTo(EP(1, 10, 30, 904) - EP(1, 10, 60, 904));
  });
  it("kneels are zero and do not count; penalties count as their own kind", () => {
    expect(one(play("Rush", spot("HOME", 1, 10, 45), spot("HOME", 2, 11, 46), [0, 0], { text: "B.Purdy kneels to SF 46 for -1 yards." }))).toEqual({ epa: 0, offense: "HOME", kind: "kneel", counts: false, success: null });
    const flag = one(play("Penalty", spot("HOME", 2, 10, 69), spot("HOME", 1, 10, 54)));
    expect(flag).toMatchObject({ kind: "penalty", counts: false, success: null });
    expect(flag.epa).toBeCloseTo(EP(1, 10, 54) - EP(2, 10, 69));
  });
  it("kickoffs, tries, timeouts and unusable states have no EPA", () => {
    for (const type of ["Kickoff", "Kickoff Return (Offense)", "Extra Point Good", "Two Point Pass", "Timeout", "Official Timeout", "Two-minute warning", "End Period", "End of Half", "End of Game", "Coin Toss"]) {
      expect(classify({ type, text: "" })).toBe("none");
      expect(one(play(type, spot("HOME", 1, 10, 50), spot("HOME", 2, 5, 45))).epa).toBeNull();
    }
    expect(one(play("Rush", spot(null, 1, 10, 50), spot("HOME", 2, 5, 45))).epa).toBeNull();
    expect(one(play("Rush", spot("HOME", null, 10, 50), spot("HOME", 2, 5, 45))).epa).toBeNull();
    expect(one(play("Rush", spot("HOME", 1, 10, 50), spot("HOME", 2, 5, null))).epa).toBeNull();
    expect(one(play("Rush", spot("HOME", 1, 10, 50), spot(null, 2, 5, 45))).epa).toBeNull();
    expect(classify({ type: "Fumble Recovery (Own)", text: "D.Prescott sacked at DAL 20" })).toBe("pass");
    expect(classify({ type: "Rush", text: "B.Purdy scrambles right end" })).toBe("pass");
  });
});

describe("on a real game (SF 46 at DAL 40)", () => {
  const parsed = parseSummary(JSON.parse(readFileSync(join(import.meta.dirname, "../app/src/lib/espn/fixtures/summary-401873063.json"), "utf8")));
  if (!parsed.ok) throw new Error(parsed.error);
  const game = normalizeSummary(parsed.value, 0)!;
  const results = estimateEpa(game.plays, game.home, T);

  it("gives every scrimmage play a finite EPA with the right sign on the obvious ones", () => {
    const counted = results.filter((r) => r.counts);
    expect(counted.length).toBeGreaterThan(125);
    expect(counted.every((r) => r.epa !== null && Number.isFinite(r.epa) && Math.abs(r.epa) < 12)).toBe(true);
    game.plays.forEach((p, i) => {
      const r = results[i]!;
      if (/Touchdown/.test(p.type)) expect(r.epa).toBeGreaterThan(0);
      if (p.type === "Sack" || p.type === "Pass Interception Return") expect(r.epa).toBeLessThan(0);
      if (p.type === "Field Goal Good") expect(r.epa).toBeCloseTo(3 - EP(p.start.down!, p.start.distance!, p.start.yardsToEndzone!, secondsLeftInHalf(p.period, p.clock)));
      if (/Kickoff|Timeout|End/.test(p.type)) expect(r.epa).toBeNull();
    });
    expect(new Set(results.map((r) => r.offense))).toEqual(new Set(["SF", "DAL"]));
  });

  it("totals per team add up from the plays, and a delayed view gets the same numbers for the plays it has", () => {
    const sf = teamEpa(results, "SF");
    const pass = teamEpa(results, "SF", "pass");
    const rush = teamEpa(results, "SF", "rush");
    expect(pass.plays + rush.plays).toBe(sf.plays);
    expect(pass.epa + rush.epa).toBeCloseTo(sf.epa);
    expect(sf.successRate).toBeGreaterThan(0.3);
    expect(teamEpa(results, "KC")).toEqual({ plays: 0, epa: 0, epaPerPlay: null, successRate: null });
    // Mid-drive in the third quarter: earlier plays do not change when later ones arrive.
    const partial = estimateEpa(game.plays.slice(0, 120), game.home, T);
    expect(partial.slice(0, 119)).toEqual(results.slice(0, 119));
  });
});
