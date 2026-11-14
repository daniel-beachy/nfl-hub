import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, test, vi } from "vitest";
import { snapshotSchema } from "../shared/snapshot.ts";
import { capture } from "./capture.ts";
import { loadFixtures } from "./fixture.ts";
import { createHttp } from "./lib/http.ts";
import { draftkings } from "./sources/draftkings.ts";
import { fakeAdapter, noHttp } from "./sources/testing.ts";
import type { SourceAdapter } from "./sources/types.ts";

// QA-M0-1: one hanging endpoint must not keep capture past its 10-minute job timeout.
// Fake timers stand in for the clock, so minutes pass in milliseconds.

const date = "2026-11-13";
const context = { phase: "regular", lastCompletedWeek: 9, gamesInProgress: false } as const;
const JOB_TIMEOUT_MS = 10 * 60_000;

const others = (["espn-fpi", "polymarket", "kalshi", "bovada"] as const).map((id) =>
  fakeAdapter({ id, kind: id === "espn-fpi" ? "forecast" : "market" }),
);

/** A fetch that never answers: it only ends when its request is aborted. */
const hang = (init?: RequestInit) =>
  new Promise<Response>((_, reject) => {
    init?.signal?.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError")));
  });

/** Run capture under fake timers until it settles; returns the simulated time it took. */
async function runToEnd(adapters: SourceAdapter[], http = noHttp) {
  const root = mkdtempSync(join(tmpdir(), "nfl-hub-deadline-"));
  const started = Date.now();
  let settled = false;
  const done = capture({ adapters, date, http, root, getContext: async () => context }).finally(() => (settled = true));
  while (!settled && Date.now() - started < 2 * JOB_TIMEOUT_MS) await vi.advanceTimersByTimeAsync(5_000);
  const elapsed = Date.now() - started;
  const path = join(root, "data/snapshots/2026", `${date}.json`);
  return { done, elapsed, settled, root, path, onDisk: () => snapshotSchema.parse(JSON.parse(readFileSync(path, "utf8"))) };
}

describe("source deadlines", () => {
  afterEach(() => vi.useRealTimers());

  test("hanging DraftKings athlete lookups still end in a written snapshot with the other four sources", async () => {
    vi.useFakeTimers();
    const dk = loadFixtures("draftkings").at(-1)!;
    const items = (dk.payload as { items: unknown[] }).items;
    const http = createHttp({
      fetch: (async (url: string, init?: RequestInit) =>
        /\/futures\?/.test(url) ? new Response(JSON.stringify({ items })) : hang(init)) as typeof fetch,
    });
    const run = await runToEnd([draftkings, ...others], http);
    expect(run.settled).toBe(true);
    await run.done;
    expect(run.elapsed).toBeLessThan(4 * 60_000);
    const snapshot = run.onDisk();
    for (const a of others) expect(snapshot.sources[a.id]!.status).toBe("ok");
    const block = snapshot.sources.draftkings!;
    // The team markets came from the one request that answered; the athletes timed out.
    expect(block.status).toBe("partial");
    expect(block.coverage.superBowl).toBe(32);
    expect(block.issues.some((i) => i.kind === "timeout")).toBe(true);
  });

  test("a source that never finishes becomes a timeout error after 3 minutes; the rest are saved", async () => {
    vi.useFakeTimers();
    const stuck = fakeAdapter({ id: "draftkings", fetch: () => new Promise(() => {}) });
    const run = await runToEnd([stuck, ...others]);
    expect(run.settled).toBe(true);
    expect(run.elapsed).toBeLessThan(4 * 60_000);
    const snapshot = run.onDisk();
    for (const a of others) expect(snapshot.sources[a.id]!.status).toBe("ok");
    expect(snapshot.sources.draftkings).toMatchObject({ status: "error", error: { kind: "timeout" } });
  });

  test("the snapshot is written as each source finishes, not only at the end", async () => {
    vi.useFakeTimers();
    const root = mkdtempSync(join(tmpdir(), "nfl-hub-deadline-"));
    const stuck = fakeAdapter({ id: "draftkings", fetch: () => new Promise(() => {}) });
    const done = capture({ adapters: [stuck, ...others], date, http: noHttp, root, getContext: async () => context });
    await vi.advanceTimersByTimeAsync(10_000);
    const early = snapshotSchema.parse(JSON.parse(readFileSync(join(root, "data/snapshots/2026", `${date}.json`), "utf8")));
    expect(early.sources.polymarket!.status).toBe("ok");
    expect(early.sources.draftkings).toBeUndefined();
    await vi.advanceTimersByTimeAsync(5 * 60_000);
    await done;
  });
});
