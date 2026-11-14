import { describe, expect, test } from "vitest";
import { SourceError } from "../lib/http.ts";
import { classifyMarket, medianWins } from "./bovada.ts";
import { classifyFuture } from "./draftkings.ts";
import { kalshiPrice } from "./kalshi.ts";
import { americanToProb, fetchParts, seasonOfSettlement, teamFromAbbr } from "./odds.ts";

// Unit tests for the M0-7 adapters' helpers. The adapters themselves are covered end to end
// by contract.test.ts against their recorded fixtures.

describe("odds", () => {
  test.each([
    ["+500", 100 / 600],
    ["-150", 150 / 250],
    ["+100", 0.5],
    ["EVEN", 0.5],
    ["-6000", 6000 / 6100],
    [" +170 ", 100 / 270],
    ["", null],
    ["+50", null],
    ["N/A", null],
  ])("%s", (odds, expected) => {
    const p = americanToProb(odds);
    if (expected === null) expect(p).toBeNull();
    else expect(p).toBeCloseTo(expected, 10);
  });

  test("team codes as books write them", () => {
    expect(["KC", "LAR", "LA", "JAC", "JAX", "WSH", "WAS", "kc"].map((c) => teamFromAbbr(c)?.id)).toEqual([
      "KC", "LA", "LA", "JAX", "JAX", "WAS", "WAS", "KC",
    ]);
    expect(teamFromAbbr("XYZ")).toBeUndefined();
  });

  test("settlement season: awards in March belong to the season before", () => {
    expect(seasonOfSettlement("2027-02-14T23:30:00Z")).toBe(2026);
    expect(seasonOfSettlement("2027-03-14T15:00:00Z")).toBe(2026);
    expect(seasonOfSettlement(Date.UTC(2026, 10, 15))).toBe(2026);
    expect(seasonOfSettlement("2026-06-01T00:00:00Z")).toBe(2026);
    expect(seasonOfSettlement(undefined)).toBeNull();
    expect(seasonOfSettlement("soon")).toBeNull();
  });
});

describe("fetchParts", () => {
  test("one failed part is recorded, the rest kept", async () => {
    const { results, failures } = await fetchParts(["a", "b", "c"], 2, (s) => s, async (s) => {
      if (s === "b") throw new SourceError("http-error", "HTTP 503", { httpStatus: 503 });
      return s.toUpperCase();
    });
    expect([...results.values()].sort()).toEqual(["A", "C"]);
    expect(failures).toEqual([{ part: "b", kind: "http-error", message: "HTTP 503" }]);
  });

  test("every part failing throws the first error, keeping its kind", async () => {
    await expect(
      fetchParts(["a", "b"], 2, (s) => s, async () => {
        throw new SourceError("empty-response", "Empty");
      }),
    ).rejects.toMatchObject({ kind: "empty-response" });
  });

  test("at the deadline, what finished is kept and the rest are timeout failures", async () => {
    const controller = new AbortController();
    const pending = fetchParts(["a", "b", "c"], 2, (s) => s, (s) =>
      s === "a" ? Promise.resolve("A") : new Promise<string>(() => {}), { signal: controller.signal });
    await new Promise((r) => setTimeout(r, 5));
    controller.abort();
    const { results, failures } = await pending;
    expect([...results.entries()]).toEqual([["a", "A"]]);
    expect(failures.map((f) => [f.part, f.kind])).toEqual([["b", "timeout"], ["c", "timeout"]]);
  });

  test("throwIfAllFail false returns the failures instead of throwing", async () => {
    const { results, failures } = await fetchParts(["a"], 1, (s) => s, async () => {
      throw new SourceError("timeout", "slow");
    }, { throwIfAllFail: false });
    expect([results.size, failures.length]).toEqual([0, 1]);
  });
});

describe("kalshi prices", () => {
  const m = (over: Partial<Parameters<typeof kalshiPrice>[0]>) => kalshiPrice({ status: "active", result: "", ...over });
  test("midpoint when the spread is tight", () => {
    expect(m({ yes_bid_dollars: "0.3000", yes_ask_dollars: "0.3100", last_price_dollars: "0.2500" })).toBeCloseTo(0.305);
    expect(m({ yes_bid_dollars: "0.0000", yes_ask_dollars: "0.0100" })).toBeCloseTo(0.005);
  });
  test("last trade when the spread is wide or nobody is asking", () => {
    expect(m({ yes_bid_dollars: "0.0000", yes_ask_dollars: "1.0000", last_price_dollars: "0.0200" })).toBe(0.02);
    expect(m({ yes_bid_dollars: "0.0000", yes_ask_dollars: "0.0000", last_price_dollars: "0.0400" })).toBe(0.04);
  });
  test("settled markets are 1 or 0; no price at all is null", () => {
    expect(m({ status: "finalized", result: "yes" })).toBe(1);
    expect(m({ status: "finalized", result: "no", last_price_dollars: "0.0200" })).toBe(0);
    expect(m({ yes_bid_dollars: "0.0000", yes_ask_dollars: "0.0000", last_price_dollars: "0.0000" })).toBeNull();
  });
});

describe("draftkings market names", () => {
  // As ESPN listed them on 2026-11-13, including its inconsistent spacing and suffixes.
  test.each([
    ["NFL - Super Bowl Winner", { metric: "superBowl" }],
    ["Pro Football (A) Conference Winner", { metric: "conference" }],
    ["Pro Football (N) Conference - Winner", { metric: "conference" }],
    ["Pro Football (A) East  Division - Winner", { metric: "division" }],
    ["Pro Football (N) West Division", { metric: "division" }],
    ["NFL - To Make the Playoffs", { metric: "playoffs" }],
    ["Regular Season MVP", { award: "mvp" }],
    ["Offensive Player of the Year", { award: "opoy" }],
    ["Comeback Player of the Year", { award: "cpoy" }],
    ["Coach of the Year", { award: "coy" }],
    ["Super Bowl MVP", null],
    ["Most Regular Season Passing Yards", null],
    ["NFL - Team To Win Most Games (reg. season)", null],
  ])("%s", (name, expected) => {
    expect(classifyFuture(name)).toEqual(expected);
  });
});

describe("bovada markets", () => {
  // Event and market descriptions as Bovada wrote them on 2026-11-13 (non-breaking spaces included).
  test.each([
    ["Super Bowl LXI 2027", "Super Bowl LXI 2027 Winner", { metric: "superBowl" }],
    ["\u00a0AFC Championship 2026-27", "\u00a0AFC Championship 2026-27 Winner", { metric: "conference" }],
    ["#1 Seed in the NFC Playoffs 2026-27", "NFC #1 Seed", { metric: "seed1" }],
    ["NFC West Winner 2026/27", " NFC West Winner", { metric: "division" }],
    ["To Make the Playoffs 2026-27", "Arizona Cardinals To Make the Playoffs", { metric: "playoffs", team: "Arizona Cardinals" }],
    ["Regular Season Wins 2026-27", " Bengals Regular Season Wins (9.5)", { metric: "wins", team: "Bengals", line: 9.5 }],
    ["Regular Season MVP 2026-27", "Regular Season MVP", { award: "mvp" }],
    ["Comeback of the Year 2026-2027", "Comeback of the Year", { award: "cpoy" }],
    ["Defensive Rookie of the Year 2026-2027", "Defensive Rookie of the Year", { award: "droy" }],
    ["NFL Draft 2027 #1 Overall Pick", "Number 1 Pick 2027 Draft", null],
    ["Super Bowl LXI 2027", "Super Bowl MVP", null],
  ])("%s / %s", (event, market, expected) => {
    expect(classifyMarket(event, market)).toEqual(expected);
  });

  test("median wins is interpolated where P(over) crosses one half", () => {
    expect(medianWins([{ line: 9.5, over: 0.709 }, { line: 10.5, over: 0.4 }])).toBeCloseTo(9.5 + 0.209 / 0.309);
    expect(medianWins([{ line: 10.5, over: 0.4 }, { line: 8.5, over: 0.9 }, { line: 9.5, over: 0.709 }])).toBeCloseTo(10.176, 3);
    expect(medianWins([{ line: 7.5, over: 0.5 }])).toBe(7.5);
  });

  test("no median when no two lines straddle one half: never extrapolated", () => {
    expect(medianWins([{ line: 8.5, over: 0.89 }, { line: 9.5, over: 0.75 }])).toBeNull();
    expect(medianWins([{ line: 9.5, over: 0.3 }])).toBeNull();
    expect(medianWins([])).toBeNull();
  });
});
