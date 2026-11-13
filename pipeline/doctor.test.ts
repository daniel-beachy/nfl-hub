import { describe, expect, test } from "vitest";
import { formatReport, probeSource } from "./doctor.ts";
import { fakeAdapter, noHttp } from "./sources/testing.ts";
import { SourceError } from "./lib/http.ts";

describe("doctor", () => {
  test("a healthy source is one OK line", async () => {
    const probe = await probeSource(fakeAdapter(), noHttp, "2026-11-13", false);
    expect(probe.status).toBe("ok");
    expect(probe.short).toEqual([]);
    expect(formatReport([probe], [])).toMatch(/^polymarket\s+standard\s+OK\s+\S+\s+superBowl 32, conference 32, division 32, playoffs 32, wins 32$/m);
  });

  test("a failing source shows its kind, message and what is short", async () => {
    const adapter = fakeAdapter({ result: () => Promise.reject(new SourceError("empty-response", "Empty response from https://x")) });
    const probe = await probeSource(adapter, noHttp, "2026-11-13", false);
    const report = formatReport([probe], [{ file: "pbp/play_by_play_2026.parquet", status: "missing", updatedAt: null, ageHours: null }]);
    expect(report).toContain("ERROR");
    expect(report).toContain("short of expected: superBowl, conference, division, playoffs");
    expect(report).toContain("empty-response: Empty response from https://x");
    expect(report).toMatch(/pbp\/play_by_play_2026\.parquet\s+MISSING\s+not in the release/);
  });
});
