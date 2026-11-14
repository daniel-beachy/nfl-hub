import { mkdtempSync, readdirSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test } from "vitest";
import { snapshotSchema, type SourceBlock } from "../shared/snapshot.ts";
import { capture, mergeBlock } from "./capture.ts";
import { SourceError } from "./lib/http.ts";
import { fakeAdapter, fullTeams, noHttp, parsed } from "./sources/testing.ts";
import type { SourceAdapter } from "./sources/types.ts";

const date = "2026-11-13";
const context = { phase: "regular", lastCompletedWeek: 9, gamesInProgress: false } as const;

function setup() {
  const root = mkdtempSync(join(tmpdir(), "nfl-hub-capture-"));
  let clock = Date.parse("2026-11-13T08:00:00Z");
  const run = (adapters: SourceAdapter[], dryRun = false) =>
    capture({ adapters, date, http: noHttp, root, dryRun, getContext: async () => context, now: () => new Date((clock += 1000)) });
  const onDisk = () => snapshotSchema.parse(JSON.parse(readFileSync(join(root, "data/snapshots/2026", `${date}.json`), "utf8")));
  return { root, run, onDisk };
}

const good = fakeAdapter({ id: "polymarket" });
const failing = (err: Error) => fakeAdapter({ id: "espn-fpi", result: () => Promise.reject(err) });
const missingDivision = () => {
  const teams = fullTeams();
  delete teams.division;
  return fakeAdapter({ id: "espn-fpi", result: () => parsed({ teams }) });
};

describe("capture", () => {
  test("a forced failure still yields a valid snapshot, with an error block beside the good one", async () => {
    const { root, run, onDisk } = setup();
    const outage = new SourceError("http-error", "HTTP 503 from provider", { httpStatus: 503, payload: "<html>down</html>" });
    const result = await run([good, failing(outage)]);
    const snapshot = onDisk();
    expect(result.written).toBe(true);
    expect(snapshot.sources.polymarket!.status).toBe("ok");
    expect(snapshot.sources["espn-fpi"]).toMatchObject({
      status: "error", teams: {}, coverage: {},
      error: { kind: "http-error", httpStatus: 503, payloadHead: "<html>down</html>" },
    });
    expect(snapshot.context).toEqual(context);
    expect(readFileSync(join(root, "tmp/failed-payloads", `espn-fpi-${date}.json`), "utf8")).toBe("<html>down</html>");
  });

  test("a bug inside an adapter is contained as an internal error", async () => {
    const { run, onDisk } = setup();
    await run([good, failing(new TypeError("x is not a function"))]);
    expect(onDisk().sources["espn-fpi"]!.error).toMatchObject({ kind: "internal", message: "TypeError: x is not a function" });
  });

  test("a provider that changes shape is reported as schema drift with the path", async () => {
    const { run, onDisk } = setup();
    await run([{ ...good, fetch: async () => ({ value: 42 }) }]);
    expect(onDisk().sources.polymarket!.error).toMatchObject({ kind: "schema-drift", detail: "value", payloadHead: '{"value":42}' });
  });

  test("a second run retries only what is not ok, and never touches an ok block", async () => {
    const { run, onDisk } = setup();
    await run([good, failing(new SourceError("timeout", "slow"))]);
    const first = onDisk();

    let goodCalls = 0;
    const countingGood = { ...good, fetch: async () => (goodCalls++, good.fetch({} as never)) };
    const recovered = fakeAdapter({ id: "espn-fpi", kind: "forecast" });
    const second = await run([countingGood, recovered]);
    const after = onDisk();

    expect(second.ran).toEqual(["espn-fpi"]);
    expect(goodCalls).toBe(0);
    expect(after.sources.polymarket).toEqual(first.sources.polymarket);
    expect(after.sources["espn-fpi"]!.status).toBe("ok");
    expect(after.capturedAt).toBe(first.capturedAt);

    const third = await run([countingGood, failing(new SourceError("timeout", "slow again"))]);
    expect([third.ran, third.written]).toEqual([[], false]);
    expect(onDisk()).toEqual(after);
  });

  test("a later failure does not replace a partial block", async () => {
    const { run, onDisk } = setup();
    await run([missingDivision()]);
    expect(onDisk().sources["espn-fpi"]!.status).toBe("partial");
    await run([failing(new SourceError("network", "down"))]);
    expect(onDisk().sources["espn-fpi"]).toMatchObject({ status: "partial", coverage: { superBowl: 32 } });
  });

  test("a later run that replaces a block fetches context again and ORs gamesInProgress (QA-M0-6)", async () => {
    const root = mkdtempSync(join(tmpdir(), "nfl-hub-capture-"));
    const onDisk = () => snapshotSchema.parse(JSON.parse(readFileSync(join(root, "data/snapshots/2026", `${date}.json`), "utf8")));
    const run = (adapters: SourceAdapter[], gamesInProgress: boolean, week = 9) =>
      capture({ adapters, date, http: noHttp, root, getContext: async () => ({ ...context, gamesInProgress, lastCompletedWeek: week }) });

    await run([good, failing(new SourceError("timeout", "slow"))], false);
    expect(onDisk().context!.gamesInProgress).toBe(false);

    // Games start; the retry fails again, so nothing captured now made it into the file.
    await run([good, failing(new SourceError("timeout", "slow"))], true);
    expect(onDisk().context!.gamesInProgress).toBe(false);

    // The retry succeeds during games: its prices are in-game prices.
    await run([good, fakeAdapter({ id: "espn-fpi", kind: "forecast" })], true, 10);
    expect(onDisk().context).toEqual({ ...context, gamesInProgress: true }); // week stays the morning's

    // Once true, a later quiet run never turns it back.
    await run([good, fakeAdapter({ id: "bovada" })], false);
    expect(onDisk().context!.gamesInProgress).toBe(true);
  });

  test("dry run writes nothing", async () => {
    const { root, run } = setup();
    const result = await run([good, failing(new SourceError("network", "down"))], true);
    expect(result.snapshot.sources.polymarket!.status).toBe("ok");
    expect(readdirSync(root)).toEqual([]);
  });

  test("an unreadable existing snapshot stops the run instead of being overwritten", async () => {
    const { root, run } = setup();
    const dir = join(root, "data/snapshots/2026");
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, `${date}.json`), '{"schemaVersion":99}');
    await expect(run([good])).rejects.toThrow();
    expect(readFileSync(join(dir, `${date}.json`), "utf8")).toBe('{"schemaVersion":99}');
  });
});

describe("mergeBlock", () => {
  const block = (status: SourceBlock["status"], teams = 0, tag = "a"): SourceBlock => ({
    status, fetchedAt: "2026-11-13T08:00:00Z", observedAt: null, durationMs: 1, issues: [], teams: {}, awards: {},
    error: status === "ok" ? null : { kind: "network", message: tag, httpStatus: null },
    coverage: teams ? { superBowl: teams } : {}, raw: {},
  });
  test.each([
    ["ok", "error", "existing"], ["ok", "partial", "existing"], ["ok", "ok", "existing"],
    ["partial", "ok", "fresh"], ["partial", "error", "existing"], ["error", "partial", "fresh"],
    ["error", "ok", "fresh"], ["error", "error", "fresh"],
  ] as const)("existing %s, fresh %s -> keeps %s", (a, b, keeps) => {
    const existing = block(a, 10, "old");
    const fresh = block(b, 10, "new");
    expect(mergeBlock(existing, fresh)).toBe(keeps === "existing" ? existing : fresh);
  });
  test("between two partial blocks, more coverage wins and ties keep the first", () => {
    const small = block("partial", 20);
    const big = block("partial", 31);
    expect(mergeBlock(small, big)).toBe(big);
    expect(mergeBlock(big, small)).toBe(big);
    expect(mergeBlock(small, block("partial", 20))).toBe(small);
  });
});
