import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { normalizeSummary, type LiveBox, type LiveSlate, type SlateGame } from "./game.ts";
import { summaryAt } from "./replay.ts";
import { parseSummary, type EspnPlay } from "./schemas.ts";
import { cutoffFor, delayToShow, remember, slateAt, viewAt, type Stamped } from "./timeshift.ts";

// M2-2 done-when: nothing shown is newer than the delay. The fixture game is replayed as
// ESPN would have served it, poll by poll, and every view is compared with the truth
// read straight from the fixture.

const parsed = parseSummary(JSON.parse(readFileSync(join(import.meta.dirname, "fixtures/summary-401873063.json"), "utf8")));
if (!parsed.ok) throw new Error(parsed.error);
const full = parsed.value;
const truth = full.drives!.previous.flatMap((d) => d.plays).map((p: EspnPlay) => ({ id: p.id, at: Date.parse(p.wallclock!), home: p.homeScore, away: p.awayScore }));
const FIRST = truth[0]!.at;
const LAST = truth.at(-1)!.at;
const DELAY = 45;

/** ESPN's newest game at time `t`, with a box score that names the moment it is from. */
function poll(t: number) {
  const game = normalizeSummary(summaryAt(full, t), t)!;
  const seen = truth.filter((p) => p.at <= t).length;
  const box: LiveBox | null = seen ? { teams: [{ team: "SF", stats: [{ name: "playsSeen", label: "plays", value: String(seen) }] }], players: [] } : null;
  const state = game.state;
  const tile: SlateGame = { id: game.id, kickoff: game.kickoff, state, home: game.home, away: game.away, score: game.score, period: null, clock: null, detail: null, situation: null };
  const slate: LiveSlate = { fetchedAt: 0, season: 2026, week: 10, games: [tile], dropped: 0 };
  return { game: { ...game, box }, slate };
}

/** Runs the feed's bookkeeping from `start`, polling every 10 s and drawing every 3.7 s. */
function watch(start: number, end: number, delayOn = true, each: (now: number, cutoff: number, v: ReturnType<typeof viewAt>, s: NonNullable<ReturnType<typeof slateAt>>) => void = () => {}) {
  let boxes: Stamped<LiveBox | null>[] = [];
  let slates: Stamped<LiveSlate>[] = [];
  let newest = poll(start);
  let nextPoll = start;
  for (let now = start; now <= end; now += 3_700) {
    if (now >= nextPoll) {
      newest = poll(now);
      boxes = remember(boxes, now, newest.game.box);
      slates = remember(slates, now, newest.slate);
      nextPoll = now + 10_000;
    }
    const cutoff = cutoffFor(now, DELAY, delayOn);
    each(now, cutoff, viewAt(newest.game, cutoff, boxes), slateAt(slates, cutoff)!);
  }
}

describe("spoiler delay", () => {
  it("never shows a play, score, box score, drive result or slate score newer than the delay", () => {
    let checked = 0;
    let sawBox = 0;
    watch(FIRST - 120_000, LAST + 120_000, true, (now, cutoff, v, s) => {
      const visible = truth.filter((p) => p.at <= cutoff);
      const hidden = truth.slice(visible.length);
      const last = visible.at(-1);
      expect(cutoff).toBe(now - DELAY * 1000);
      expect(v.plays.map((p) => p.id)).toEqual(visible.map((p) => p.id));
      expect(v.score).toEqual(last ? { home: last.home, away: last.away } : { home: 0, away: 0 });
      expect(v.status).toBe(!last ? "pre" : hidden.length ? "in" : "final");
      // Nothing anywhere in the view mentions a play the viewer has not reached.
      const text = JSON.stringify(v);
      for (const p of hidden.slice(0, 3)) expect(text).not.toContain(`"${p.id}"`);
      if (hidden.length) {
        expect(v.drives.at(-1)?.result ?? null).toBeNull();
        expect(v.plays.every((p) => p.homeWp === null || p.at <= cutoff)).toBe(true);
      }
      // The box score counts no more plays than the viewer has seen.
      if (v.box.state === "ok") {
        sawBox++;
        expect(Number(v.box.box.teams[0]!.stats[0]!.value)).toBeLessThanOrEqual(visible.length);
      }
      // The slate tile is the game as it stood at some moment at or before the cutoff.
      const tile = s.games[0]!;
      if (!tile.syncing && tile.score) {
        expect(tile.score.home + tile.score.away).toBeLessThanOrEqual((last?.home ?? 0) + (last?.away ?? 0));
        expect(truth.some((p) => p.home === tile.score!.home && p.away === tile.score!.away && p.at <= cutoff)).toBe(true);
      }
      if (tile.state === "post") expect(hidden).toHaveLength(0);
      checked++;
    });
    expect(checked).toBeGreaterThan(3000);
    expect(sawBox).toBeGreaterThan(2500);
  });

  it("cold start mid-game: plays are right at once, box score and slate wait until synced", () => {
    const start = FIRST + 3600_000;
    const states: string[] = [];
    watch(start, start + 80_000, true, (now, cutoff, v, s) => {
      const visible = truth.filter((p) => p.at <= cutoff);
      expect(v.plays).toHaveLength(visible.length);
      expect(v.score).toEqual({ home: visible.at(-1)!.home, away: visible.at(-1)!.away });
      const waited = now - start;
      const tile = s.games[0]!;
      if (waited < DELAY * 1000) {
        expect(v.box).toEqual({ state: "syncing", seconds: Math.ceil((DELAY * 1000 - waited) / 1000) });
        expect(tile).toMatchObject({ syncing: true, score: null, clock: null });
        expect(s.syncingSeconds).toBe(Math.ceil((DELAY * 1000 - waited) / 1000));
      } else {
        expect(v.box.state).toBe("ok");
        expect(tile).toMatchObject({ syncing: false, state: "in" });
        expect(s.syncingSeconds).toBeNull();
      }
      states.push(v.box.state);
    });
    expect(new Set(states)).toEqual(new Set(["syncing", "ok"]));
  });

  it("with the delay off shows the newest of everything, whatever the device clock says", () => {
    expect(cutoffFor(5, 45, false)).toBe(Infinity);
    expect(cutoffFor(5, 0, true)).toBe(Infinity);
    const t = FIRST + 3600_000;
    const { game, slate } = poll(t);
    // A device clock an hour slow.
    const v = viewAt(game, cutoffFor(t - 3600_000, 45, false), []);
    expect(v.plays).toHaveLength(game.plays.length);
    expect(v.box.state).toBe("ok");
    expect(slateAt([{ at: t, value: slate }], Infinity)!.games[0]).toMatchObject({ syncing: false, score: game.score });
  });

  it("a finished game needs no waiting, and a game ESPN has no plays for is only trusted once surely over", () => {
    const done = normalizeSummary(full, LAST + 3600_000)!;
    const v = viewAt(done, LAST + 3600_000 - 45_000, []);
    expect(v).toMatchObject({ status: "final", score: { home: 40, away: 46 }, situation: null, box: { state: "ok" } });
    expect(v.drives.every((d) => d.over)).toBe(true);
    // Open ten seconds after the end with a delay: the last plays are still to come.
    const early = viewAt(normalizeSummary(full, LAST + 10_000)!, LAST - 35_000, []);
    expect(early).toMatchObject({ status: "in", box: { state: "none" } });
    expect(early.plays.length).toBeLessThan(203);

    const noPlays = { ...done, plays: [], drives: [] };
    expect(viewAt({ ...noPlays, fetchedAt: done.kickoff + 4 * 3600_000 }, done.kickoff + 4 * 3600_000, [])).toMatchObject({ status: "in", score: null, box: { state: "none" } });
    expect(viewAt({ ...noPlays, fetchedAt: done.kickoff + 7 * 3600_000 }, done.kickoff + 6.5 * 3600_000, [])).toMatchObject({ status: "final", score: { home: 40, away: 46 } });
    const tile = poll(LAST + 1).slate;
    expect(slateAt([{ at: done.kickoff + 7 * 3600_000, value: tile }], done.kickoff + 6.5 * 3600_000)!.games[0]).toMatchObject({ syncing: false, state: "post" });
    expect(slateAt([], 0)).toBeNull();
  });

  it("keeps history short, keeps one old copy, and does not restamp unchanged content", () => {
    let h: Stamped<number>[] = [];
    for (let t = 0; t <= 3600_000; t += 10_000) h = remember(h, t, Math.floor(t / 30_000));
    expect(h.length).toBeLessThan(26);
    expect(h[0]!.at).toBeLessThanOrEqual(3600_000 - 660_000);
    expect(h[1]!.at).toBeGreaterThan(3600_000 - 660_000);
    expect(h.at(-1)).toEqual({ at: 3600_000, value: 120 });
    expect(remember(h, 3610_000, 120)).toBe(h);
  });

  it("calibration: the tapped play becomes the newest one visible", () => {
    const game = poll(FIRST + 3600_000).game;
    const now = FIRST + 3600_000 + 2_000;
    const tapped = game.plays.at(-3)!;
    const delay = delayToShow(tapped, now);
    const v = viewAt(game, cutoffFor(now, delay, true), []);
    // Whole seconds, so it may land on the play before, never on a later one.
    expect(v.plays.at(-1)!.at).toBeLessThanOrEqual(tapped.at);
    expect(v.plays.length).toBeGreaterThanOrEqual(game.plays.length - 3);
    expect(delayToShow(game.plays[0]!, now)).toBe(600);
    expect(delayToShow(tapped, tapped.at - 5_000)).toBe(0);
  });
});
