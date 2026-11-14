import { describe, expect, test } from "vitest";
import { teamsInDivision } from "../../shared/teams.ts";
import { finalize } from "./finalize.ts";
import { even, fakeAdapter, fullTeams, parsed } from "./testing.ts";

const ctx = { season: 2026, date: "2026-11-13" };
const market = fakeAdapter();
const forecast = fakeAdapter({ kind: "forecast" });
const kinds = (b: { issues: { kind: string }[] }) => b.issues.map((i) => i.kind);

describe("finalize", () => {
  test("a clean market is ok, normalized, with raw sums kept", () => {
    const b = finalize(market, parsed({ teams: fullTeams(0.08) }), ctx);
    expect([b.status, b.error, b.issues]).toEqual(["ok", null, []]);
    expect(b.raw.superBowlSum).toBe(1.08);
    expect(b.raw["divisionSum.AFC East"]).toBe(1.08);
    expect(b.teams.KC).toEqual({ superBowl: 0.0313, conference: 0.0625, division: 0.25, playoffs: 0.4375, wins: 8.5 });
    expect(b.coverage).toEqual({ superBowl: 32, conference: 32, division: 32, playoffs: 32, wins: 32 });
  });

  test("a forecast is checked but never rescaled", () => {
    const b = finalize(forecast, parsed({ teams: fullTeams(0.08) }), ctx);
    expect(b.status).toBe("ok");
    expect(b.teams.KC!.division).toBe(0.27);
  });

  test("an incomplete group stays raw and makes the block partial", () => {
    const teams = fullTeams(0.08);
    delete teams.division!.KC;
    const b = finalize(market, parsed({ teams }), ctx);
    expect(b.status).toBe("partial");
    expect(b.error).toMatchObject({ kind: "team-coverage", detail: "division" });
    expect(b.teams.DEN!.division).toBe(0.27); // KC's division: raw
    expect(b.teams.BUF!.division).toBe(0.25); // a complete division: normalized
    expect(b.raw["divisionSum.AFC West"]).toBeUndefined();
    expect(b.coverage.division).toBe(31);
  });

  test("a complete group with an impossible sum is dropped, not charted", () => {
    const teams = fullTeams();
    Object.assign(teams.division!, even(teamsInDivision("NFC West").map((t) => t.id), 2.4));
    const b = finalize(market, parsed({ teams }), ctx);
    expect(b.status).toBe("partial");
    expect(kinds(b)).toEqual(["bad-sum"]);
    expect(b.teams.SF!.division).toBeUndefined();
    expect(b.teams.SF!.superBowl).toBeDefined();
    expect(b.coverage.division).toBe(28);
  });

  test("percentages sent as fractions are caught by the sum check", () => {
    const b = finalize(forecast, parsed({ teams: { superBowl: even(Object.keys(fullTeams().superBowl!) as never, 0.01) } }), ctx);
    expect(kinds(b)).toContain("bad-sum");
    expect(b.status).toBe("error");
  });

  test("one out-of-range value removes the whole metric; all-zero metrics are removed (QA-M0-4)", () => {
    const teams = fullTeams();
    teams.superBowl!.KC = 1.4;
    teams.playoffs = even(Object.keys(teams.playoffs!) as never, 0);
    const b = finalize(market, parsed({ teams }), ctx);
    expect(kinds(b)).toEqual(["out-of-range", "all-zero"]);
    expect(b.coverage.superBowl).toBeUndefined();
    expect(b.teams.BUF!.superBowl).toBeUndefined();
    expect(b.coverage.playoffs).toBeUndefined();
    expect(b.coverage.division).toBe(32);
  });

  test("a percent read as a fraction removes the metric, even where some values stay at or below 1 (QA-M0-4)", () => {
    const teams = fullTeams();
    const sb = teams.superBowl!;
    const ids = Object.keys(sb) as (keyof typeof sb)[];
    ids.forEach((t, i) => (sb[t] = i < 16 ? 0.005 : 0.06)); // a sum of 1.04 ...
    for (const t of ids) sb[t]! *= 100; // ... read as percent: 0.5 for half the teams, 6 for the rest
    const b = finalize(market, parsed({ teams }), ctx);
    expect(b.coverage.superBowl).toBeUndefined();
    expect(b.issues.filter((i) => i.detail === "superBowl").map((i) => i.kind)).toEqual(["out-of-range"]);
  });

  test("an incomplete group that sums above 1.6 is removed too (QA-M0-4)", () => {
    const teams = fullTeams();
    delete teams.division!.KC;
    for (const t of ["DEN", "LAC", "LV"] as const) teams.division![t] = 0.9;
    const b = finalize(market, parsed({ teams }), ctx);
    expect(kinds(b)).toContain("bad-sum");
    expect(b.teams.DEN!.division).toBeUndefined();
    expect(b.coverage.division).toBe(28);
  });

  test("each market metric records whether it was normalized (QA-M0-4)", () => {
    const clean = finalize(market, parsed({ teams: fullTeams(0.08) }), ctx);
    expect(clean.normalized).toEqual({ superBowl: true, conference: true, division: true, playoffs: false });
    const teams = fullTeams(0.08);
    delete teams.division!.KC;
    const incomplete = finalize(market, parsed({ teams, playoffsNo: even(Object.keys(teams.playoffs!) as never, 18) }), ctx);
    expect(incomplete.normalized).toMatchObject({ superBowl: true, division: false, playoffs: true });
    expect(finalize(forecast, parsed({ teams: fullTeams(0.08) }), ctx).normalized).toBeUndefined();
  });

  test("an out-of-range award probability removes that award market (QA-M0-4)", () => {
    const c = (name: string, prob: number) => ({ playerId: null, name, team: null, prob });
    const b = finalize(market, parsed({ awards: { mvp: [c("A", 0.2), c("B", 30)] } }), ctx);
    expect(b.awards.mvp).toBeUndefined();
    expect(kinds(b)).toEqual(["out-of-range"]);
  });

  test("two-way playoff prices are de-vigged pairwise", () => {
    const teams = fullTeams();
    teams.playoffs!.KC = 0.84;
    const b = finalize(market, parsed({ teams, playoffsNo: { KC: 0.21 } }), ctx);
    expect(b.teams.KC!.playoffs).toBe(0.8);
    expect(b.teams.BUF!.playoffs).toBe(0.4375);
  });

  test("awards are sorted, capped at 25 and never normalized", () => {
    const mvp = Array.from({ length: 30 }, (_, i) => ({ playerId: null, name: `P${i}`, team: null, prob: (i + 1) / 100 }));
    const b = finalize(market, parsed({ awards: { mvp } }), ctx);
    expect(b.awards.mvp).toHaveLength(25);
    expect(b.awards.mvp![0]).toMatchObject({ name: "P29", prob: 0.3 });
    expect(b.coverage.mvp).toBe(25);
  });

  test("a missing expected market is reported once", () => {
    const teams = fullTeams();
    delete teams.playoffs;
    const withAwards = fakeAdapter({ expects: { teams: ["superBowl", "playoffs"], awards: ["mvp"] } });
    const b = finalize(withAwards, parsed({ teams }), ctx);
    expect(b.issues.map((i) => [i.kind, i.detail])).toEqual([["market-missing", "playoffs"], ["market-missing", "mvp"]]);
  });

  test("no usable values at all is an error", () => {
    const b = finalize(market, parsed({ teams: {} }), ctx);
    expect(b.status).toBe("error");
    expect(b.error?.kind).toBe("market-missing");
  });

  test("another season's data is refused outright", () => {
    expect(() => finalize(market, parsed({ season: 2025 }), ctx)).toThrow(/season 2025/);
  });
});
