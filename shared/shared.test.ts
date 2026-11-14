import { readFileSync } from "node:fs";
import { describe, expect, test } from "vitest";
import { contrast, MIN_CONTRAST, readableColor } from "./colors.ts";
import { AWARD_MARKETS, CONFERENCES, DIVISION_IDS, seasonForDate, SOURCE_IDS, TEAM_METRICS } from "./ids.ts";
import { snapshotSchema, type Snapshot } from "./snapshot.ts";
import {
  TEAM_IDS, TEAMS, teamFromEspnAbbr, teamFromEspnId, teamFromKalshiCode, teamFromName, teamsInConference,
  teamsInDivision,
} from "./teams.ts";

test("identifier lists have no duplicates", () => {
  for (const list of [SOURCE_IDS, TEAM_METRICS, AWARD_MARKETS, TEAM_IDS]) {
    expect(new Set(list).size).toBe(list.length);
  }
});

test("seasonForDate turns over in March", () => {
  expect(seasonForDate("2026-11-13")).toBe(2026);
  expect(seasonForDate("2027-02-14")).toBe(2026);
  expect(seasonForDate("2027-03-01")).toBe(2027);
});

describe("team table", () => {
  test("32 teams, 16 per conference, 4 per division", () => {
    expect(TEAMS).toHaveLength(32);
    expect(TEAMS.map((t) => t.id)).toEqual([...TEAM_IDS]);
    for (const c of CONFERENCES) expect(teamsInConference(c)).toHaveLength(16);
    expect(DIVISION_IDS).toHaveLength(8);
    for (const d of DIVISION_IDS) expect(teamsInDivision(d)).toHaveLength(4);
  });

  test("every provider naming round-trips to the same team", () => {
    for (const t of TEAMS) {
      expect(teamFromEspnId(t.espnId)?.id).toBe(t.id);
      expect(teamFromEspnId(Number(t.espnId))?.id).toBe(t.id);
      expect(teamFromEspnAbbr(t.espnAbbr)?.id).toBe(t.id);
      expect(teamFromKalshiCode(t.kalshiCode)?.id).toBe(t.id);
      expect(teamFromName(t.kalshiName)?.id).toBe(t.id); // Kalshi yes_sub_title
      expect(teamFromName(t.name)?.id).toBe(t.id); // Polymarket, Bovada, ESPN displayName
      expect(teamFromName(t.nickname)?.id).toBe(t.id); // Polymarket win-total titles
      expect(teamFromName(` ${t.name.toUpperCase()} `)?.id).toBe(t.id);
    }
  });

  // Names exactly as each provider sent them on 2026-11-13.
  test("recorded provider spellings", () => {
    const seen: Record<string, string> = {
      "Los Angeles R": "LA", "Los Angeles C": "LAC", "New York G": "NYG", "New York J": "NYJ",
      "Tampa Bay": "TB", "San Francisco 49ers": "SF", "Washington Commanders": "WAS", Jacksonville: "JAX",
    };
    for (const [name, id] of Object.entries(seen)) expect(teamFromName(name)?.id).toBe(id);
    expect(teamFromKalshiCode("JAC")?.id).toBe("JAX");
    expect(teamFromKalshiCode("LAR")?.id).toBe("LA");
    expect(teamFromEspnAbbr("WSH")?.id).toBe("WAS");
    expect(teamFromEspnAbbr("LAR")?.id).toBe("LA");
  });

  test("ambiguous and unknown names match nothing", () => {
    for (const name of ["Los Angeles", "New York", "Other", "", "London Monarchs"]) {
      expect(teamFromName(name)).toBeUndefined();
    }
  });

  test("ids are unique across each provider naming", () => {
    for (const key of ["espnId", "espnAbbr", "kalshiCode", "kalshiName", "name", "nickname"] as const) {
      expect(new Set(TEAMS.map((t) => t[key])).size).toBe(32);
    }
  });
});

describe("readable colors", () => {
  test.each(["0f1216", "ffffff"])("every team is readable on #%s", (bg) => {
    for (const t of TEAMS) {
      expect(contrast(readableColor(t.color, t.altColor, bg), bg)).toBeGreaterThanOrEqual(MIN_CONTRAST);
    }
  });
  test("keeps the primary when it already works", () => {
    expect(readableColor("e31837", "ffb612", "0f1216")).toBe("e31837");
    expect(readableColor("000000", "a5acaf", "0f1216")).toBe("a5acaf");
  });
});

describe("snapshot schema", () => {
  const base: Snapshot = {
    schemaVersion: 1, season: 2026, date: "2026-11-12", capturedAt: "2026-11-12T08:41:10Z",
    context: { phase: "regular", lastCompletedWeek: 9, gamesInProgress: false },
    sources: {
      polymarket: {
        status: "ok", fetchedAt: "2026-11-12T08:41:10Z", observedAt: null, durationMs: 812, error: null, issues: [],
        teams: { KC: { superBowl: 0.081, playoffs: 0.83 } },
        awards: { mvp: [{ playerId: null, name: "Josh Allen", team: "BUF", prob: 0.24 }] },
        coverage: { superBowl: 1, mvp: 1 }, raw: { superBowlSum: 1.03 },
      },
    },
  };
  test("accepts the documented shape", () => {
    expect(snapshotSchema.parse(base)).toEqual(base);
  });
  test("rejects a probability above 1, an unknown team and an ok block with an error", () => {
    const block = base.sources.polymarket!;
    const bad = (sources: unknown) => snapshotSchema.safeParse({ ...base, sources }).success;
    expect(bad({ polymarket: { ...block, teams: { KC: { superBowl: 8.1 } } } })).toBe(false);
    expect(bad({ polymarket: { ...block, teams: { XXX: { superBowl: 0.1 } } } })).toBe(false);
    expect(bad({ polymarket: { ...block, error: { kind: "network", message: "x", httpStatus: null } } })).toBe(false);
    expect(bad({ polymarket: { ...block, status: "error" } })).toBe(false);
  });
  test("normalized is optional, so snapshots written before it existed still read (QA-M0-4)", () => {
    const block = base.sources.polymarket!;
    const withIt = { ...base, sources: { polymarket: { ...block, normalized: { superBowl: true, playoffs: false } } } };
    expect(snapshotSchema.parse(withIt)).toEqual(withIt);
    expect(snapshotSchema.safeParse({ ...base, sources: { polymarket: { ...block, normalized: { superBowl: "yes" } } } }).success).toBe(false);
    for (const date of ["2026-11-13", "2026-11-14"]) {
      const file = JSON.parse(readFileSync(new URL(`../data/snapshots/2026/${date}.json`, import.meta.url), "utf8")) as unknown;
      expect(snapshotSchema.safeParse(file).error).toBeUndefined();
    }
  });
});
