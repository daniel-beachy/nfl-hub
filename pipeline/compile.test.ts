import { describe, expect, it } from "vitest";
import type { ModelPoint, ModelSeason } from "../shared/model.ts";
import type { AwardCandidate, Snapshot, SourceBlock, TeamValues } from "../shared/snapshot.ts";
import { TEAM_IDS, type TeamId } from "../shared/teams.ts";
import { candidateKey, compileSeason, consensusValue, hubLookup, median, weekPoints } from "./compile.ts";

const now = new Date("2026-11-15T09:00:00Z");

/** A block with `value` for every team in `teams` (default all 32). */
function block(metric: keyof TeamValues, value: number, extra: Partial<SourceBlock> = {}, teams: readonly TeamId[] = TEAM_IDS): SourceBlock {
  return {
    status: "ok", fetchedAt: "2026-11-01T08:00:00Z", observedAt: null, durationMs: 1, error: null, issues: [],
    teams: Object.fromEntries(teams.map((t) => [t, { [metric]: value }])), awards: {}, coverage: { [metric]: teams.length }, raw: {},
    ...extra,
  };
}
function snap(date: string, sources: Snapshot["sources"], gamesInProgress = false): Snapshot {
  return { schemaVersion: 1, season: 2026, date, capturedAt: `${date}T08:00:00Z`, context: { phase: "regular", lastCompletedWeek: null, gamesInProgress }, sources };
}
function point(date: string, week: number, weekComplete: boolean, superBowl: number): ModelPoint {
  const teams = Object.fromEntries(TEAM_IDS.map((t) => [t, { rating: 1500, playoffs: 0.4, division: 0.25, seed1: 0.06, conference: 0.06, superBowl, wins: 8.5 }])) as ModelPoint["teams"];
  return { date, week, phase: week === 0 ? "preseason" : "regular", weekComplete, gamesPlayed: week * 16, gamesLeft: 272 - week * 16, teams };
}
function model(points: ModelPoint[], pendingDates: string[] | null): ModelSeason {
  return {
    schemaVersion: 1, season: 2026, generatedAt: now.toISOString(), sims: 1000, params: { k: 22, hfa: 52, regress: 0.45 }, inputHash: "x", gamesUpdatedAt: "x", points,
    current: pendingDates && {
      date: points.at(-1)!.date,
      winDist: Object.fromEntries(TEAM_IDS.map((t) => [t, Array(18).fill(1 / 18)])) as Record<TeamId, number[]>,
      games: pendingDates.map((date, i) => ({ id: `g${i}`, week: 9, date, home: "KC", away: "BUF", homeWinProb: 0.5 })),
    },
  };
}

describe("consensus", () => {
  it("median of two or more markets; nothing from one market; forecasts never count", () => {
    expect(median([0.1, 0.3, 0.2])).toBe(0.2);
    expect(median([0.1, 0.2])).toBeCloseTo(0.15);
    const s = snap("2026-11-01", { draftkings: block("superBowl", 0.03125), polymarket: block("superBowl", 0.03), "espn-fpi": block("superBowl", 0.9) });
    expect(consensusValue(s, "superBowl", "KC")).toBe(0.0306);
    expect(consensusValue(snap("2026-11-01", { draftkings: block("superBowl", 0.03), "espn-fpi": block("superBowl", 0.04) }), "superBowl", "KC")).toBeNull();
  });

  it("never mixes de-vigged and raw values", () => {
    // A complete Super Bowl group was de-vigged; Bovada with only KC listed is raw.
    const twoDevigOneRaw = snap("2026-11-01", {
      draftkings: block("superBowl", 0.03), kalshi: block("superBowl", 0.05), bovada: block("superBowl", 0.5, {}, ["KC"]),
    });
    expect(consensusValue(twoDevigOneRaw, "superBowl", "KC")).toBe(0.04);
    // Playoffs is de-vigged only where the block says so; here the raw pair wins.
    const oneDevigTwoRaw = snap("2026-11-01", {
      draftkings: block("playoffs", 0.6, { normalized: { playoffs: true } }), kalshi: block("playoffs", 0.7, { normalized: { playoffs: false } }), polymarket: block("playoffs", 0.8),
    });
    expect(consensusValue(oneDevigTwoRaw, "playoffs", "KC")).toBe(0.75);
    // One of each: no consensus.
    const oneEach = snap("2026-11-01", { draftkings: block("playoffs", 0.6, { normalized: { playoffs: true } }), kalshi: block("playoffs", 0.7) });
    expect(consensusValue(oneEach, "playoffs", "KC")).toBeNull();
  });

  it("a division counts as de-vigged only when its four teams are all in the block", () => {
    const afcWest: TeamId[] = ["KC", "LV", "LAC", "DEN"];
    const s = snap("2026-11-01", {
      draftkings: block("division", 0.5, {}, afcWest), polymarket: block("division", 0.6, {}, afcWest), kalshi: block("division", 0.9, {}, ["KC", "LV", "LAC"]),
    });
    expect(consensusValue(s, "division", "KC")).toBe(0.55);
  });

  it("wins have one basis; rounded to 2 decimals", () => {
    const s = snap("2026-11-01", { bovada: block("wins", 10.5), draftkings: block("wins", 11.25) });
    expect(consensusValue(s, "wins", "KC")).toBe(10.88);
  });
});

describe("hubLookup", () => {
  const m = model([point("2026-09-09", 0, true, 0.01), point("2026-09-11", 1, false, 0.02), point("2026-09-15", 1, true, 0.03)], ["2026-09-17", "2026-09-20"]);
  const at = hubLookup(m);

  it("the latest point on or before the date; preseason stands for earlier dates", () => {
    expect(at("2026-09-01")!.date).toBe("2026-09-09");
    expect(at("2026-09-09")!.date).toBe("2026-09-09");
    expect(at("2026-09-13")!.date).toBe("2026-09-11");
    expect(at("2026-09-17")!.date).toBe("2026-09-15");
  });

  it("no value once an unplayed game day has passed (the model stage is behind)", () => {
    expect(at("2026-09-18")).toBeNull();
    // A finished season has nothing pending: the last point holds.
    expect(hubLookup(model(m.points, null))("2027-03-01")!.date).toBe("2026-09-15");
    expect(hubLookup(null)("2026-09-15")).toBeNull();
  });
});

describe("daily series: alignment and gaps", () => {
  const snapshots = [
    snap("2026-11-01", { draftkings: block("superBowl", 0.03), polymarket: block("superBowl", 0.04) }),
    snap("2026-11-02", { draftkings: block("superBowl", 0.031) }),
    snap("2026-11-05", { draftkings: block("superBowl", 0.032), polymarket: block("superBowl", 0.05), bovada: block("wins", 9, {}, ["KC"]) }),
  ];
  const m = model([point("2026-09-09", 0, true, 0.01), point("2026-11-02", 8, true, 0.02)], ["2026-11-08"]);
  const { daily } = compileSeason({ season: 2026, snapshots, model: m }, now)!;

  it("one shared axis of snapshot dates; every array aligned to it, null where a source had nothing", () => {
    expect(daily.dates).toEqual(["2026-11-01", "2026-11-02", "2026-11-05"]);
    const sb = daily.metrics.superBowl!;
    expect(sb.draftkings!.teams.KC).toEqual([0.03, 0.031, 0.032]);
    expect(sb.polymarket!.teams.KC).toEqual([0.04, null, 0.05]);
    expect(sb.consensus!.teams.KC).toEqual([0.035, null, 0.041]);
    expect(sb.hub!.teams.KC).toEqual([0.01, 0.02, 0.02]);
    for (const s of Object.values(sb)) for (const v of Object.values(s!.teams)) expect(v).toHaveLength(3);
  });

  it("a source or team with no value at all is absent, so a tab exists exactly when there is data", () => {
    expect(daily.metrics.superBowl!.bovada).toBeUndefined();
    expect(daily.metrics.superBowl!.kalshi).toBeUndefined();
    expect(Object.keys(daily.metrics.wins!.bovada!.teams)).toEqual(["KC"]);
    expect(daily.metrics.wins!.consensus).toBeUndefined();
  });

  it("availability counts calendar days without a value in the 7 ending on the last date", () => {
    expect(daily.metrics.superBowl!.draftkings!.availability).toEqual({ firstDate: "2026-11-01", lastDate: "2026-11-05", daysMissingInLast7: 4 });
    expect(daily.metrics.superBowl!.polymarket!.availability).toEqual({ firstDate: "2026-11-01", lastDate: "2026-11-05", daysMissingInLast7: 5 });
    // The hub has a value for every day up to the next unplayed game day.
    expect(daily.metrics.superBowl!.hub!.availability.daysMissingInLast7).toBe(0);
  });

  it("a season with no snapshots uses the model's points as its axis", () => {
    const pre = compileSeason({ season: 2026, snapshots: [], model: m }, now)!;
    expect(pre.daily.dates).toEqual(["2026-09-09", "2026-11-02"]);
    expect(Object.keys(pre.daily.metrics.superBowl!)).toEqual(["hub"]);
    expect(compileSeason({ season: 2026, snapshots: [], model: null }, now)).toBeNull();
  });
});

describe("weekly series", () => {
  const m = model(
    [point("2026-09-09", 0, true, 0.01), point("2026-09-11", 1, false, 0.015), point("2026-09-15", 1, true, 0.02), point("2026-09-22", 2, true, 0.03), point("2026-09-29", 3, true, 0.04)],
    null,
  );
  const snapshots = [
    snap("2026-09-08", { draftkings: block("superBowl", 0.1) }),
    snap("2026-09-11", { draftkings: block("superBowl", 0.11) }),
    snap("2026-09-15", { draftkings: block("superBowl", 0.12) }, true), // games in progress: skipped
    snap("2026-09-16", { draftkings: block("superBowl", 0.13) }),
    snap("2026-09-30", { draftkings: block("superBowl", 0.15) }),
  ];

  it("week 0 is the last snapshot before kickoff; each week the first clean snapshot after it ends", () => {
    const w = weekPoints(snapshots, m);
    expect(w.map((p) => [p.week, p.date, p.snapshot?.date ?? null])).toEqual([
      [0, "2026-09-08", "2026-09-08"],
      [1, "2026-09-16", "2026-09-16"],
      [2, "2026-09-22", null], // no snapshot before week 3 ended: hub only, dated the week's end
      [3, "2026-09-30", "2026-09-30"],
    ]);
  });

  it("the weekly file: week numbers aligned with dates, the hub from each week's own point", () => {
    const { weekly, daily } = compileSeason({ season: 2026, snapshots, model: m }, now)!;
    expect(weekly.weeks).toEqual([0, 1, 2, 3]);
    expect(weekly.metrics.superBowl!.draftkings!.teams.KC).toEqual([0.1, 0.13, null, 0.15]);
    expect(weekly.metrics.superBowl!.hub!.teams.KC).toEqual([0.01, 0.02, 0.03, 0.04]);
    expect(weekly.metrics.superBowl!.draftkings!.availability).toEqual(daily.metrics.superBowl!.draftkings!.availability);
  });

  it("without a model file the calendar comes from the snapshots' lastCompletedWeek", () => {
    const withContext = [
      { ...snap("2026-09-08", { draftkings: block("superBowl", 0.1) }), context: { phase: "preseason" as const, lastCompletedWeek: null, gamesInProgress: false } },
      { ...snap("2026-09-15", { draftkings: block("superBowl", 0.12) }), context: { phase: "regular" as const, lastCompletedWeek: 1, gamesInProgress: false } },
      { ...snap("2026-09-16", { draftkings: block("superBowl", 0.13) }), context: { phase: "regular" as const, lastCompletedWeek: 1, gamesInProgress: false } },
    ];
    expect(weekPoints(withContext, null).map((p) => [p.week, p.date])).toEqual([[0, "2026-09-08"], [1, "2026-09-15"]]);
  });
});

describe("awards", () => {
  const cand = (name: string, prob: number, team: TeamId | null = null): AwardCandidate => ({ playerId: null, name, team, prob });
  const awardBlock = (list: AwardCandidate[]): SourceBlock => ({ ...block("superBowl", 0.03), awards: { mvp: list } });

  it("the same person across sources: case, punctuation and suffixes ignored", () => {
    expect(candidateKey({ playerId: null, name: "Marvin Harrison Jr." })).toBe(candidateKey({ playerId: null, name: "marvin harrison" }));
    expect(candidateKey({ playerId: "00-1", name: "X" })).toBe("id:00-1");
  });

  it("candidates aligned to the axis, consensus only where two markets list the player", () => {
    const snapshots = [
      snap("2026-11-01", { draftkings: awardBlock([cand("Josh Allen", 0.3, "BUF"), cand("Joe Burrow", 0.2)]), polymarket: awardBlock([cand("josh allen", 0.4)]) }),
      snap("2026-11-02", { draftkings: awardBlock([cand("Joe Burrow", 0.25)]) }),
    ];
    const { daily } = compileSeason({ season: 2026, snapshots, model: null }, now)!;
    const dk = daily.awards.mvp!.draftkings!;
    expect(dk.candidates).toEqual([
      { playerId: null, name: "Joe Burrow", team: null, values: [0.2, 0.25] },
      { playerId: null, name: "Josh Allen", team: "BUF", values: [0.3, null] },
    ]);
    expect(daily.awards.mvp!.consensus!.candidates).toEqual([{ playerId: null, name: "Josh Allen", team: "BUF", values: [0.35, null] }]);
    expect(daily.awards.mvp!.consensus!.availability).toEqual({ firstDate: "2026-11-01", lastDate: "2026-11-01", daysMissingInLast7: 6 });
  });
});
