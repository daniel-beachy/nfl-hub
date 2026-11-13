import { describe, expect, test } from "vitest";
import { sourceBlockSchema } from "../../shared/snapshot.ts";
import { TEAM_IDS } from "../../shared/teams.ts";
import { contextFromScoreboard } from "../context.ts";
import { loadFixtures } from "../fixture.ts";
import { ADAPTERS } from "./index.ts";
import { classifyTitle } from "./polymarket.ts";
import { parsePayload, validatePayload } from "./run.ts";

// The contract every adapter must meet: its recorded real payloads parse to exactly the
// recorded results. When a provider changes, record a new fixture; never edit one by hand.

describe.each(ADAPTERS.map((a) => [a.id, a] as const))("%s", (_id, adapter) => {
  const fixtures = loadFixtures(adapter.id);

  test("has at least one fixture", () => {
    expect(fixtures.length).toBeGreaterThan(0);
  });

  test.each(fixtures.map((f) => [f.date, f] as const))("fixture %s parses to its expected result", (_date, f) => {
    const block = parsePayload(adapter, f.payload, { season: f.season, date: f.date });
    expect(block).toEqual(f.expected);
    expect(sourceBlockSchema.safeParse({ ...block, fetchedAt: `${f.date}T08:00:00Z`, durationMs: 0 }).error).toBeUndefined();
  });

  test("the newest fixture is ok and covers all 32 teams for every expected metric", () => {
    const f = fixtures.at(-1)!;
    expect(f.expected.status).toBe("ok");
    for (const metric of adapter.expects.teams) expect(f.expected.coverage[metric]).toBe(TEAM_IDS.length);
    for (const market of adapter.expects.awards) expect(f.expected.coverage[market]).toBeGreaterThan(0);
  });

  test("a fixture is already trimmed to what the adapter reads", () => {
    const f = fixtures.at(-1)!;
    expect(validatePayload(adapter, f.payload)).toEqual(f.payload);
  });

  test("a payload from another season is refused or yields nothing", () => {
    const f = fixtures.at(-1)!;
    const attempt = () => parsePayload(adapter, f.payload, { season: f.season + 1, date: f.date });
    try {
      expect(attempt().status).toBe("error");
    } catch (err) {
      expect(err).toMatchObject({ kind: "season-mismatch" });
    }
  });

  test("garbage is schema drift, not a crash", () => {
    expect(() => parsePayload(adapter, { unexpected: true }, { season: 2026, date: "2026-11-13" })).toThrow(
      expect.objectContaining({ kind: "schema-drift" }),
    );
  });
});

describe("polymarket titles", () => {
  // Titles as Polymarket wrote them on 2026-11-13, plus the forms it has used before.
  test.each([
    ["Pro Football: 2027 Champion", { metric: "superBowl" }],
    ["2027 Super Bowl Winner", { metric: "superBowl" }],
    ["Pro Football: 2027 NFC Champion ", { metric: "conference" }],
    ["Pro Football: NFC West Champion   ", { metric: "division" }],
    ["Pro Football: Team to Make Postseason", { metric: "playoffs" }],
    ["Pro Football: 2026 MVP Winner", { award: "mvp" }],
    ["Pro Football: 2026-27 AP Offensive Rookie of the Year Winner", { award: "oroy" }],
    ["Pro Football: 2026-27 AP Comeback Player of the Year Winner", { award: "cpoy" }],
    ["Pro Football: 2026-27 AP Coach of the Year Winner", { award: "coy" }],
    ["Super Bowl MVP", null],
    ["Pro Football: 2027 Champion Winning Conference", null],
    ["Will a team from Texas win the 2027 Pro Football Championship?", null],
    ["Pro Football: 2026-27 Best Regular Season Record", null],
  ])("%s", (title, expected) => {
    expect(classifyTitle(title)).toEqual(expected);
  });
});

describe("season context", () => {
  const board = (type: number, states: string[], week = 10, year = 2026) => ({
    season: { year, type }, week: { number: week },
    events: states.map((state) => ({ status: { type: { state, completed: state === "post" } } })),
  });
  test("mid-week: the previous week is the last completed one", () => {
    expect(contextFromScoreboard(board(2, ["post", "pre", "pre"]), 2026)).toEqual({ phase: "regular", lastCompletedWeek: 9, gamesInProgress: false });
  });
  test("a game under way is flagged", () => {
    expect(contextFromScoreboard(board(2, ["post", "in"]), 2026)).toMatchObject({ lastCompletedWeek: 9, gamesInProgress: true });
  });
  test("every game final: this week is complete", () => {
    expect(contextFromScoreboard(board(2, ["post", "post"]), 2026)).toMatchObject({ lastCompletedWeek: 10 });
  });
  test("postseason, another season, and an unknown season type", () => {
    expect(contextFromScoreboard(board(3, ["pre"], 1), 2026)).toMatchObject({ phase: "postseason", lastCompletedWeek: 18 });
    expect(contextFromScoreboard(board(2, ["post"], 18, 2026), 2027)).toMatchObject({ phase: "offseason", lastCompletedWeek: null });
    expect(contextFromScoreboard(board(9, []), 2026)).toBeNull();
  });
});
