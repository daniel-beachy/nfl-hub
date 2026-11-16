import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { normalizeScoreboard, normalizeSummary } from "./game.ts";
import { replaySource } from "./replay.ts";
import { parseScoreboard, parseSummary, type EspnPlay } from "./schemas.ts";

const raw: unknown = JSON.parse(readFileSync(join(import.meta.dirname, "fixtures/summary-401873063.json"), "utf8"));
// The truth, read straight from the fixture: every play with its time.
const truth = (raw as { drives: { previous: { plays: EspnPlay[] }[] } }).drives.previous.flatMap((d) => d.plays).map((p) => ({ ...p, at: Date.parse(p.wallclock!) }));
const FIRST = truth[0]!.at;
const LAST = truth.at(-1)!.at;

/** A replay whose real clock the test moves by hand. */
function setup(speed: number, from?: number) {
  let real = 0;
  const source = replaySource(raw, { speed, from, realNow: () => real });
  const game = async () => {
    const parsed = parseSummary(await source.summary("401873063"));
    if (!parsed.ok) throw new Error(parsed.error);
    return normalizeSummary(parsed.value, source.now(), parsed.dropped)!;
  };
  const slate = async () => {
    const parsed = parseScoreboard(await source.scoreboard());
    if (!parsed.ok) throw new Error(parsed.error);
    return normalizeScoreboard(parsed.value, source.now(), parsed.dropped);
  };
  return { source, game, slate, wait: (ms: number) => (real += ms) };
}

describe("replay", () => {
  it("starts a minute before the first play, with nothing to see", async () => {
    const r = setup(20);
    expect(r.source.now()).toBe(FIRST - 60_000);
    expect(await r.game()).toMatchObject({ state: "pre", plays: [], score: null, box: null, home: "DAL", away: "SF" });
    expect((await r.slate()).games).toMatchObject([{ id: "401873063", state: "pre", score: null }]);
  });

  it("shows exactly the plays up to its clock, at every moment of the game", async () => {
    const r = setup(20);
    // 97 real seconds a step is 1,940 game seconds: about 370 steps across the game, out of phase with the plays.
    for (let step = 0; r.source.now() < LAST; step++) {
      r.wait(97_000 / 20 + step);
      const now = r.source.now();
      const expected = truth.filter((p) => p.at <= now);
      if (expected.length === truth.length) break;
      const g = await r.game();
      expect(g.plays.map((p) => p.id)).toEqual(expected.map((p) => p.id));
      const last = expected.at(-1);
      expect(g.state).toBe(last ? "in" : "pre");
      expect(g.score).toEqual(last ? { home: last.homeScore, away: last.awayScore } : null);
      // No box score mid-game, no result on the drive in progress, no win probability from the future.
      expect(g.box).toBeNull();
      expect(g.drives.at(-1)?.result ?? null).toBeNull();
      expect(JSON.stringify(await r.source.summary("401873063"))).not.toContain(truth[expected.length]!.id + '"');
      const s = (await r.slate()).games[0]!;
      expect([s.state, s.score, s.clock]).toEqual([g.state, g.score, last?.clock.displayValue ?? null]);
    }
  });

  it("ends as the full final game", async () => {
    const r = setup(1000, 0);
    expect((await r.game()).plays).toHaveLength(1);
    r.wait((LAST - FIRST) / 1000);
    const g = await r.game();
    expect(g).toMatchObject({ state: "post", score: { home: 40, away: 46 }, plays: { length: 203 } });
    expect(g.box).not.toBeNull();
    expect(g.drives.at(-1)!.result).not.toBeNull();
    expect((await r.slate()).games[0]).toMatchObject({ state: "post", detail: "Final", score: { home: 40, away: 46 } });
  });

  it("refuses another game and a game it cannot time", async () => {
    await expect(setup(20).source.summary("1")).rejects.toThrow(/Only the replayed game/);
    expect(() => replaySource({ nope: true }, { speed: 20 })).toThrow(/cannot be replayed/);
    const pre: unknown = JSON.parse(readFileSync(join(import.meta.dirname, "fixtures/summary-401873065.json"), "utf8"));
    expect(() => replaySource(pre, { speed: 20 })).toThrow(/no plays/);
  });
});
