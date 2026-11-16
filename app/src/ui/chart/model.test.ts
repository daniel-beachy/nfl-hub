import { describe, expect, it } from "vitest";
import { SERIES_SOURCE_IDS } from "../../../../shared/ids.ts";
import { chooseSource, hasData, lastValue, nearestIndex, rangeIndexes, segments, SOURCE_INFO, SOURCE_ORDER, sourcesWithData, spreadLabels, staleSince } from "./model.ts";

describe("source tabs", () => {
  const bySource = {
    hub: [[0.1, 0.2, 0.3, 0.4]],
    kalshi: [[null, null, 0.3, null], [null, null, null, null]],
    bovada: [[null, null, null, null]],
    consensus: [[null, null, null, 0.5]],
  };
  it("covers every series source exactly once", () => {
    expect([...SOURCE_ORDER].sort()).toEqual([...SERIES_SOURCE_IDS].sort());
    expect(Object.keys(SOURCE_INFO).sort()).toEqual([...SERIES_SOURCE_IDS].sort());
  });
  it("lists only sources with a value in the visible range, in tab order", () => {
    expect(sourcesWithData(bySource, 0, 3)).toEqual(["consensus", "hub", "kalshi"]);
    expect(sourcesWithData(bySource, 0, 1)).toEqual(["hub"]);
    expect(sourcesWithData({}, 0, 3)).toEqual([]);
  });
  it("uses the remembered source when it has a tab, else the first tab, silently", () => {
    expect(chooseSource(["consensus", "hub", "kalshi"], "kalshi")).toBe("kalshi");
    expect(chooseSource(["consensus", "hub"], "kalshi")).toBe("consensus");
    expect(chooseSource(["hub"], undefined)).toBe("hub");
    expect(chooseSource(["hub"], "not-a-source")).toBe("hub");
    expect(chooseSource([], "hub")).toBeNull();
  });
  it("hasData respects the range", () => {
    expect(hasData([null, 1, null], 0, 0)).toBe(false);
    expect(hasData([null, 1, null], 0, 5)).toBe(true);
  });
});

describe("lines with gaps", () => {
  it("bridges a gap instead of dropping to zero", () => {
    const { runs, bridges } = segments([0.1, 0.2, null, null, 0.5, 0.6, null], 0, 6);
    expect(runs).toEqual([[[0, 0.1], [1, 0.2]], [[4, 0.5], [5, 0.6]]]);
    expect(bridges).toEqual([[[1, 0.2], [4, 0.5]]]);
  });
  it("draws nothing before the first value and no bridge after the last", () => {
    expect(segments([null, null, 0.3], 0, 2)).toEqual({ runs: [[[2, 0.3]]], bridges: [] });
    expect(segments([null, null], 0, 1)).toEqual({ runs: [], bridges: [] });
  });
  it("stays inside the visible range", () => {
    expect(segments([0.1, 0.2, 0.3, 0.4], 1, 2).runs).toEqual([[[1, 0.2], [2, 0.3]]]);
  });
  it("finds the last value", () => {
    expect(lastValue([0.1, 0.2, null], 0, 2)).toEqual([1, 0.2]);
    expect(lastValue([null, null], 0, 1)).toBeNull();
  });
});

describe("axis helpers", () => {
  const dates = ["2026-09-08", "2026-09-15", "2026-09-22", "2026-09-29"];
  it("maps a date range to indexes", () => {
    expect(rangeIndexes(dates, null, null)).toEqual([0, 3]);
    expect(rangeIndexes(dates, "2026-09-10", "2026-09-22")).toEqual([1, 2]);
    expect(rangeIndexes(dates, "2027-01-01", null)).toBeNull();
  });
  it("finds the nearest date", () => {
    expect(nearestIndex(dates, "2026-09-17")).toBe(1);
    expect(nearestIndex(dates, "2030-01-01")).toBe(3);
  });
  it("marks a source stale only when it is more than 3 days behind the axis (plan 7.4)", () => {
    expect(staleSince("2026-11-09", "2026-11-15")).toBe("2026-11-09");
    expect(staleSince("2026-11-11", "2026-11-15")).toBe("2026-11-11");
    expect(staleSince("2026-11-12", "2026-11-15")).toBeNull();
    expect(staleSince("2026-11-14", "2026-11-15")).toBeNull();
    expect(staleSince("2026-11-15", "2026-11-15")).toBeNull();
  });
  it("spreads overlapping labels and keeps them in bounds", () => {
    const ys = spreadLabels([10, 11, 12, 100], 12, 0, 100);
    const sorted = [...ys].sort((a, b) => a - b);
    for (let i = 1; i < sorted.length; i++) expect(sorted[i]! - sorted[i - 1]!).toBeGreaterThanOrEqual(12);
    expect(Math.max(...ys)).toBeLessThanOrEqual(100);
    expect(ys[3]).toBe(100);
  });
});
