import { describe, expect, it } from "vitest";
import { TEAMS } from "../shared/teams.ts";
import { convertV3, SEPT_11 } from "./import-v3.ts";

// A synthetic file in v3's shape (not v3 data): every team equal, so groups sum to 100%.
const projections = (withPlayoffs: boolean, nullFor: string[] = []) =>
  Object.fromEntries(
    TEAMS.map((t) => [
      t.espnId,
      { superBowl: 100 / 32, conference: 100 / 16, division: 25, ...(withPlayoffs && { playoffs: nullFor.includes(t.espnId) ? null : 43.75, wins: 8.5 }) },
    ]),
  );
const awards = (status = "ok") => ({
  status,
  categories:
    status === "ok"
      ? [
          { id: "mvp", candidates: [{ name: "B Player", teamId: "12", impliedProbability: 10 }, { name: "A Player", teamId: null, impliedProbability: 20 }] },
          { id: "protector", candidates: [{ name: "Lineman", teamId: "2", impliedProbability: 5 }] },
        ]
      : [],
});
const file = {
  season: 2026,
  sources: [
    { id: "espn-fpi", metrics: ["superBowl", "conference", "division", "playoffs", "wins"] },
    { id: "draftkings", metrics: ["superBowl", "conference", "division"] },
    { id: "bovada", metrics: ["superBowl", "conference", "division", "playoffs", "wins"] },
    { id: "polymarket", metrics: ["superBowl", "conference", "division"] },
  ],
  snapshots: [
    {
      capturedAt: "2026-09-08T16:56:42.327Z", phase: "preseason", week: null,
      sources: {
        "espn-fpi": { status: "ok", observedAt: "2026-08-31T14:44:00.000Z", projections: projections(true) },
        draftkings: { status: "ok", projections: projections(false) },
        bovada: { status: "ok", projections: projections(true) },
        polymarket: { status: "ok", projections: projections(false) },
      },
      awards: { draftkings: awards(), bovada: awards(), polymarket: awards() },
    },
    {
      capturedAt: "2026-10-13T19:58:48.977Z", phase: "regular", week: 5,
      sources: {
        "espn-fpi": { status: "ok", projections: projections(true) },
        bovada: { status: "ok", projections: projections(true, ["1", "2"]) },
        polymarket: { status: "unavailable", note: "Polymarket 2026: no events returned. More text.", projections: {} },
      },
      awards: { bovada: awards("unavailable") },
    },
  ],
};

describe("convertV3", () => {
  const out = convertV3(file, "2026-11-15T12:00:00.000Z");
  const byDate = new Map(out.map((s) => [s.date, s]));

  it("one file per capture date, plus 09-11 for the quotes v3 attached to its preseason baseline", () => {
    expect(out.map((s) => s.date)).toEqual(["2026-09-08", SEPT_11, "2026-10-13"]);
    expect(Object.keys(byDate.get("2026-09-08")!.sources)).toEqual(["espn-fpi", "draftkings"]);
    expect(Object.keys(byDate.get(SEPT_11)!.sources)).toEqual(["bovada", "polymarket"]);
    expect(byDate.get(SEPT_11)!.context).toBeNull();
    expect(byDate.get(SEPT_11)!.sources.bovada!.provenance).toMatch(/2026-09-11/);
    expect(byDate.get("2026-09-08")!.sources.draftkings!.provenance).toMatch(/award odds were added/);
    for (const s of out) expect(s.imported?.from).toBe("nfl-season-tracker-v3");
  });

  it("maps ESPN ids to our teams and percentages to fractions", () => {
    const fpi = byDate.get("2026-09-08")!.sources["espn-fpi"]!;
    expect(fpi.status).toBe("ok");
    expect(fpi.teams.LA).toEqual({ superBowl: 0.0313, conference: 0.0625, division: 0.25, playoffs: 0.4375, wins: 8.5 });
    expect(fpi.observedAt).toBe("2026-08-31T14:44:00.000Z");
    expect(fpi.coverage).toEqual({ superBowl: 32, conference: 32, division: 32, playoffs: 32, wins: 32 });
    expect(fpi.normalized).toBeUndefined();
    expect(byDate.get("2026-10-13")!.context).toEqual({ phase: "regular", lastCompletedWeek: 5, gamesInProgress: false });
  });

  it("marks complete market groups that sum to 1 as normalized", () => {
    const dk = byDate.get("2026-09-08")!.sources.draftkings!;
    expect(dk.normalized).toEqual({ superBowl: true, conference: true, division: true });
    expect(dk.raw).toEqual({});
  });

  it("awards: raw fractions, sorted, only our markets, team mapped when v3 had one", () => {
    const mvp = byDate.get("2026-09-08")!.sources.draftkings!.awards.mvp!;
    expect(mvp).toEqual([
      { playerId: null, name: "A Player", team: null, prob: 0.2 },
      { playerId: null, name: "B Player", team: "KC", prob: 0.1 },
    ]);
    expect(Object.keys(byDate.get("2026-09-08")!.sources.draftkings!.awards)).toEqual(["mvp"]);
  });

  it("a null value is absent and makes the block partial; unavailable is an error block", () => {
    const bov = byDate.get("2026-10-13")!.sources.bovada!;
    expect(bov.status).toBe("partial");
    expect(bov.teams.ATL!.playoffs).toBeUndefined();
    expect(bov.coverage.playoffs).toBe(30);
    expect(bov.issues.map((i) => i.kind)).toEqual(["market-missing", "team-coverage"]);
    const poly = byDate.get("2026-10-13")!.sources.polymarket!;
    expect(poly.status).toBe("error");
    expect(poly.error!.message).toBe("v3 recorded this source as unavailable: Polymarket 2026: no events returned");
    expect(poly.teams).toEqual({});
  });

  it("a value out of range removes the metric", () => {
    const bad = structuredClone(file);
    bad.snapshots[0]!.sources.draftkings!.projections["12"]!.superBowl = 140;
    const dk = convertV3(bad, "2026-11-15T12:00:00.000Z")[0]!.sources.draftkings!;
    expect(dk.status).toBe("partial");
    expect(dk.teams.KC!.superBowl).toBeUndefined();
    expect(dk.issues[0]!.kind).toBe("out-of-range");
  });

  it("rejects a file that is not v3's shape", () => {
    expect(() => convertV3({ season: 2026 }, "2026-11-15T12:00:00.000Z")).toThrow();
  });
});
