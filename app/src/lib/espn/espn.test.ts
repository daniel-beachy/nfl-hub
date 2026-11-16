import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { LiveFeed } from "./feed.ts";
import { normalizeScoreboard, normalizeSummary } from "./game.ts";
import { Poller, type PollerEnv } from "./poller.ts";
import { parseScoreboard, parseSummary } from "./schemas.ts";
import { fetchJson, LiveFetchError, type LiveSource } from "./source.ts";

// Fixtures are real ESPN responses recorded 2026-11-16 with `npm run live-fixture`:
// a finished game (SF 46, DAL 40), a game not yet started, and that week's scoreboard.
const load = (name: string): unknown => JSON.parse(readFileSync(join(import.meta.dirname, "fixtures", name), "utf8"));
const FINAL = "summary-401873063.json";
const PRE = "summary-401873065.json";
const BOARD = "scoreboard-2026-11-16.json";

type Json = Record<string, unknown>;
const clone = <T>(v: T): T => structuredClone(v);

function game(raw: unknown, fetchedAt = 0) {
  const parsed = parseSummary(raw);
  if (!parsed.ok) throw new Error(parsed.error);
  return normalizeSummary(parsed.value, fetchedAt, parsed.dropped);
}

describe("summary", () => {
  it("reads a finished game", () => {
    const g = game(load(FINAL))!;
    expect(g).toMatchObject({ id: "401873063", home: "DAL", away: "SF", state: "post", season: 2026, dropped: 0, score: { home: 40, away: 46 } });
    expect(g.plays).toHaveLength(203);
    expect(g.drives).toHaveLength(23);
    const last = g.plays.at(-1)!;
    expect([last.homeScore, last.awayScore, last.type]).toEqual([40, 46, "End of Game"]);
    expect(g.plays.filter((p) => p.homeWp === null).length).toBeLessThanOrEqual(1);
    expect(g.plays.every((p, i) => i === 0 || p.at >= g.plays[i - 1]!.at)).toBe(true);
    expect(g.plays[5]).toMatchObject({ type: "Rush", clock: "14:20", period: 1, yards: 4, start: { down: 2, distance: 5, team: "DAL", text: "2nd & 5" }, wallclock: Date.parse("2026-11-15T21:29:36Z") });
    expect(g.box!.teams.map((t) => t.team).sort()).toEqual(["DAL", "SF"]);
    expect(g.box!.players.find((p) => p.team === "SF" && p.name === "passing")!.players[0]).toMatchObject({ name: "Brock Purdy", stats: expect.arrayContaining(["22/28"]) });
  });

  it("reads a game that has not started", () => {
    expect(game(load(PRE))).toMatchObject({ home: "BAL", away: "LAC", state: "pre", plays: [], drives: [], score: null, kickoff: Date.parse("2026-11-17T01:15Z") });
  });

  it("drops the whole response when the frame is wrong", () => {
    const bad: unknown[] = [null, undefined, 7, "<html>", [], {}, { header: {} }, { header: { id: "1", competitions: [] } }];
    const threeTeams = clone(load(FINAL)) as { header: { competitions: { competitors: unknown[] }[] } };
    threeTeams.header.competitions[0]!.competitors.push(threeTeams.header.competitions[0]!.competitors[0]);
    const oddState = clone(load(FINAL)) as { header: { competitions: { status: { type: Json } }[] } };
    oddState.header.competitions[0]!.status.type.state = "delayed";
    for (const raw of [...bad, threeTeams, oddState]) expect(parseSummary(raw).ok).toBe(false);
  });

  it("leaves out one bad play, drive or point and keeps the rest", () => {
    const raw = clone(load(FINAL)) as { drives: { previous: unknown[] }; winprobability: unknown[] };
    const plays = (raw.drives.previous[0] as { plays: Json[] }).plays;
    delete plays[2]!.homeScore;
    plays[3]!.period = "first";
    raw.drives.previous[1] = "not a drive";
    raw.winprobability[0] = { playId: 5, homeWinPercentage: 3 };
    const parsed = parseSummary(raw);
    expect(parsed).toMatchObject({ ok: true, dropped: 4 });
    const g = game(raw)!;
    expect(g.dropped).toBe(4);
    expect(g.drives).toHaveLength(22);
    expect(g.plays.at(-1)).toMatchObject({ homeScore: 40, awayScore: 46 });
  });

  it("treats broken optional blocks as absent", () => {
    const raw = { ...(load(FINAL) as Json), drives: "none", winprobability: {}, boxscore: [1, 2] };
    expect(game(raw)).toMatchObject({ plays: [], box: null, state: "post" });
  });

  it("refuses a game without two NFL teams or a start time", () => {
    const proBowl = clone(load(FINAL)) as { header: { competitions: { date: string; competitors: { team: { id: string } }[] }[] } };
    proBowl.header.competitions[0]!.competitors[0]!.team.id = "31";
    expect(game(proBowl)).toBeNull();
    const noDate = clone(load(FINAL)) as typeof proBowl;
    noDate.header.competitions[0]!.date = "soon";
    expect(game(noDate)).toBeNull();
  });

  it("merges the drive in progress without repeating plays", () => {
    const raw = clone(load(FINAL)) as { drives: { previous: { id: string; plays: unknown[] }[]; current?: unknown } };
    const lastDrive = raw.drives.previous.at(-1)!;
    // As ESPN does mid-game: `current` is ahead of the same drive's copy in `previous`.
    raw.drives.current = clone(lastDrive);
    lastDrive.plays = lastDrive.plays.slice(0, 1);
    const g = game(raw)!;
    expect(g.plays).toHaveLength(203);
    expect(g.drives).toHaveLength(23);
    // And when `current` is a drive `previous` does not have yet.
    raw.drives.previous.pop();
    expect(game(raw)!.plays).toHaveLength(203);
  });

  it("gives a play without a wallclock a release time that cannot be early", () => {
    const raw = clone(load(FINAL)) as { drives: { previous: { plays: Json[] }[] } };
    const first = raw.drives.previous[0]!.plays;
    delete first[1]!.wallclock;
    first[2]!.wallclock = "garbage";
    // One that claims to be earlier than the play before it.
    first[5]!.wallclock = "2026-11-15T20:00:00Z";
    const lastPlays = raw.drives.previous.at(-1)!.plays;
    delete lastPlays.at(-1)!.wallclock;
    const seen = new Map<string, number>();
    const parsed = parseSummary(raw);
    if (!parsed.ok) throw new Error(parsed.error);
    const g = normalizeSummary(parsed.value, 9e12, 0, seen)!;
    const at = (i: number) => g.plays[i]!.at;
    // Missing in the middle: the next play's time.
    expect(at(1)).toBe(at(3));
    expect(at(2)).toBe(at(3));
    expect(g.plays[2]!.wallclock).toBeNull();
    expect(at(5)).toBe(at(4));
    // Missing at the end: when we first saw it, and that sticks on the next poll.
    expect(g.plays.at(-1)!.at).toBe(9e12);
    expect(normalizeSummary(parsed.value, 9e12 + 10_000, 0, seen)!.plays.at(-1)!.at).toBe(9e12);
  });

  it("never throws, whatever is damaged (500 random mutations)", () => {
    // A small seeded generator, so a failure can be reproduced.
    let seed = 20261116;
    const rand = (n: number) => {
      seed = (seed * 1664525 + 1013904223) >>> 0;
      return seed % n;
    };
    const junk: unknown[] = [null, undefined, 0, -1, "", "x", [], {}, true, NaN, [null], { id: null }];
    const base = load(FINAL);
    for (let i = 0; i < 500; i++) {
      const raw = clone(base);
      for (let hits = 1 + rand(4); hits > 0; hits--) {
        // Walk to a random depth and replace or delete what is there.
        let node = raw as unknown;
        for (let depth = 1 + rand(7); depth > 0; depth--) {
          if (typeof node !== "object" || node === null) break;
          const keys = Object.keys(node);
          if (!keys.length) break;
          const key = keys[rand(keys.length)]!;
          const child = (node as Json)[key];
          if (depth === 1 || typeof child !== "object" || child === null) {
            if (rand(3) === 0) delete (node as Json)[key];
            else (node as Json)[key] = junk[rand(junk.length)];
            break;
          }
          node = child;
        }
      }
      const parsed = parseSummary(raw);
      if (!parsed.ok) continue;
      const g = normalizeSummary(parsed.value, 0, parsed.dropped);
      if (g) expect(g.plays.every((p) => Number.isFinite(p.at) && Number.isFinite(p.homeScore))).toBe(true);
    }
  });
});

describe("scoreboard", () => {
  it("reads the week", () => {
    const parsed = parseScoreboard(load(BOARD));
    if (!parsed.ok) throw new Error(parsed.error);
    const slate = normalizeScoreboard(parsed.value, 5);
    expect(slate).toMatchObject({ season: 2026, week: 10, dropped: 0, fetchedAt: 5 });
    expect(slate.games).toHaveLength(14);
    expect(slate.games.find((g) => g.id === "401873063")).toMatchObject({ home: "DAL", away: "SF", state: "post", score: { home: 40, away: 46 }, detail: "Final", situation: null });
    // Not started: no score, whatever ESPN's "0" says.
    expect(slate.games.at(-1)).toMatchObject({ home: "BAL", away: "LAC", state: "pre", score: null });
  });

  it("keeps the readable games and counts the rest", () => {
    const raw = clone(load(BOARD)) as { events: unknown[] };
    raw.events[0] = { id: "x" };
    (raw.events[1] as { competitions: { competitors: { team: { id: string } }[] }[] }).competitions[0]!.competitors[0]!.team.id = "999";
    (raw.events[2] as { competitions: Json[] }).competitions[0]!.situation = "odd";
    const parsed = parseScoreboard(raw);
    if (!parsed.ok) throw new Error(parsed.error);
    expect(normalizeScoreboard(parsed.value, 0, parsed.dropped)).toMatchObject({ dropped: 2, games: { length: 12 } });
    for (const bad of [null, {}, { events: "none" }, "<html>"]) expect(parseScoreboard(bad).ok).toBe(false);
  });
});

/** Timers and tab visibility under the test's control. */
function fakeEnv() {
  let hidden = false;
  let listener: (() => void) | null = null;
  const timers: { fn: () => void; ms: number }[] = [];
  const env: PollerEnv = {
    setTimeout: (fn, ms) => {
      const t = { fn, ms };
      timers.push(t);
      return t;
    },
    clearTimeout: (h) => void timers.splice(timers.indexOf(h as (typeof timers)[number]) >>> 0, 1),
    isHidden: () => hidden,
    onVisibility: (fn) => {
      listener = fn;
      return () => (listener = null);
    },
  };
  return {
    env,
    timers,
    /** Fire the one pending timer and let its task finish. */
    async tick() {
      timers.shift()!.fn();
      await settle();
    },
    async setHidden(v: boolean) {
      hidden = v;
      listener?.();
      await settle();
    },
  };
}
const settle = async () => {
  for (let i = 0; i < 20; i++) await Promise.resolve();
};

describe("poller", () => {
  it("backs off on failures and recovers", async () => {
    const f = fakeEnv();
    let fail = false;
    let runs = 0;
    const p = new Poller(async () => {
      runs++;
      if (fail) throw new Error("down");
    }, () => 10_000, f.env);
    p.start();
    await settle();
    expect([runs, f.timers[0]!.ms]).toEqual([1, 10_000]);
    fail = true;
    const waits: number[] = [];
    for (let i = 0; i < 6; i++) {
      await f.tick();
      waits.push(f.timers[0]!.ms);
    }
    expect(waits).toEqual([20_000, 40_000, 80_000, 120_000, 120_000, 120_000]);
    fail = false;
    await f.tick();
    expect([p.failures, f.timers[0]!.ms]).toEqual([0, 10_000]);
    p.stop();
    expect(f.timers).toHaveLength(0);
  });

  it("pauses while hidden and runs at once when shown", async () => {
    const f = fakeEnv();
    let runs = 0;
    const p = new Poller(async () => void runs++, () => 10_000, f.env);
    p.start();
    await settle();
    await f.setHidden(true);
    expect([runs, f.timers.length]).toEqual([1, 0]);
    await f.setHidden(false);
    expect([runs, f.timers.length]).toEqual([2, 1]);
    p.stop();
  });

  it("never runs two at once, and stops when the interval is null", async () => {
    const f = fakeEnv();
    let release = () => {};
    let active = 0;
    let most = 0;
    let runs = 0;
    let interval: number | null = 10_000;
    const p = new Poller(
      async () => {
        runs++;
        most = Math.max(most, ++active);
        await new Promise<void>((r) => (release = r));
        active--;
      },
      () => interval,
      f.env,
    );
    p.start();
    p.runNow();
    p.runNow();
    await settle();
    expect([runs, most]).toEqual([1, 1]);
    interval = null;
    release();
    await settle();
    // The runNow calls made during the first run collapse into one more run.
    expect(runs).toBe(2);
    release();
    await settle();
    expect([runs, most, f.timers.length]).toEqual([2, 1, 0]);
    p.stop();
  });
});

describe("feed", () => {
  function setup() {
    const f = fakeEnv();
    const answers = { scoreboard: load(BOARD) as unknown, summary: load(FINAL) as unknown };
    let now = 1_000;
    const source: LiveSource = {
      now: () => now,
      speed: 1,
      scoreboard: async () => {
        if (answers.scoreboard instanceof Error) throw answers.scoreboard;
        return answers.scoreboard;
      },
      summary: async () => {
        if (answers.summary instanceof Error) throw answers.summary;
        return answers.summary;
      },
    };
    const feed = new LiveFeed(source, f.env);
    return { f, feed, answers, advance: (ms: number) => (now += ms) };
  }

  it("keeps the last good data when ESPN fails or sends something else", async () => {
    const { f, feed, answers, advance } = setup();
    let notified = 0;
    feed.subscribe(() => notified++);
    feed.start();
    await settle();
    expect(feed.getState()).toMatchObject({ slate: { games: { length: 14 } }, slateHealth: { status: "ok", lastOkAt: 1_000 } });
    // Nothing live and the next kickoff is hours away: five minutes.
    expect(f.timers[0]!.ms).toBe(300_000);

    for (const bad of [new LiveFetchError("http", "HTTP 503"), { events: 5 }, "<html>busy</html>", { events: [{ id: "x" }] }]) {
      answers.scoreboard = bad;
      advance(60_000);
      await f.tick();
      expect(feed.getState().slate!.games).toHaveLength(14);
      expect(feed.getState().slateHealth).toMatchObject({ status: "retrying", lastOkAt: 1_000 });
    }
    expect(feed.getState().slateHealth).toMatchObject({ failures: 4, error: "Unexpected scoreboard (no readable games)" });
    answers.scoreboard = load(BOARD);
    await f.tick();
    expect(feed.getState().slateHealth).toMatchObject({ status: "ok", failures: 0, error: null });
    expect(notified).toBeGreaterThan(5);
    feed.stop();
  });

  it("polls the open game, stops when it is final, and rejects the wrong or an older game", async () => {
    const { f, feed, answers } = setup();
    const inProgress = clone(load(FINAL)) as { header: { id: string; competitions: { status: { type: Json } }[] }; drives: { previous: unknown[] } };
    inProgress.header.competitions[0]!.status.type.state = "in";
    answers.summary = inProgress;
    feed.start();
    feed.openGame("401873063");
    await settle();
    expect(feed.getState()).toMatchObject({ gameId: "401873063", game: { state: "in", plays: { length: 203 } }, gameHealth: { status: "ok" } });
    const gameTimer = () => f.timers.find((t) => t.ms !== 300_000);
    expect(gameTimer()!.ms).toBe(10_000);

    const fire = async () => {
      const t = gameTimer()!;
      f.timers.splice(f.timers.indexOf(t), 1);
      t.fn();
      await settle();
    };
    const shorter = clone(inProgress);
    shorter.drives.previous = shorter.drives.previous.slice(0, 3);
    for (const bad of [load(PRE), shorter, { header: null }]) {
      answers.summary = bad;
      await fire();
      expect(feed.getState()).toMatchObject({ game: { plays: { length: 203 } }, gameHealth: { status: "retrying" } });
    }
    expect(feed.getState().gameHealth.error).toMatch(/header/);

    answers.summary = load(FINAL);
    await fire();
    expect(feed.getState()).toMatchObject({ game: { state: "post" }, gameHealth: { status: "ok" } });
    // Final: only the scoreboard timer is left.
    expect(gameTimer()).toBeUndefined();

    feed.openGame(null);
    expect(feed.getState()).toMatchObject({ gameId: null, game: null });
    feed.stop();
  });

  it("ignores an answer that arrives after the user moved to another game", async () => {
    const { feed, answers } = setup();
    feed.openGame("401873063");
    feed.start();
    answers.summary = load(PRE);
    feed.openGame("401873065");
    await settle();
    expect(feed.getState()).toMatchObject({ gameId: "401873065", game: { id: "401873065", state: "pre" }, gameHealth: { status: "ok", failures: 0 } });
    feed.stop();
  });
});

describe("fetchJson", () => {
  const answer = (body: string, status = 200) => (async () => new Response(body, { status })) as unknown as typeof fetch;
  it("names each kind of failure", async () => {
    await expect(fetchJson("http://x", "/a", { fetch: answer('{"a":1}') })).resolves.toEqual({ a: 1 });
    await expect(fetchJson("http://x", "/a", { fetch: answer("busy", 503) })).rejects.toMatchObject({ kind: "http", message: "HTTP 503" });
    await expect(fetchJson("http://x", "/a", { fetch: answer("<html>") })).rejects.toMatchObject({ kind: "not-json" });
    const offline = (async () => {
      throw new TypeError("Failed to fetch");
    }) as unknown as typeof fetch;
    await expect(fetchJson("http://x", "/a", { fetch: offline })).rejects.toMatchObject({ kind: "network" });
    const hangs = ((_url: string, init: RequestInit) => new Promise((_, reject) => init.signal!.addEventListener("abort", () => reject(new Error("aborted"))))) as unknown as typeof fetch;
    await expect(fetchJson("http://x", "/a", { fetch: hangs, timeoutMs: 5 })).rejects.toMatchObject({ kind: "timeout" });
  });
});
