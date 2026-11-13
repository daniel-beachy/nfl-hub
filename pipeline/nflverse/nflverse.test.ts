import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, test } from "vitest";
import { computeStatus } from "../health.ts";
import { SourceError, type Http } from "../lib/http.ts";
import { DATASETS } from "./datasets.ts";
import { ensureAsset, type Asset } from "./download.ts";
import { missingColumns } from "./read.ts";
import { checkRows, parseSeasons, runStage } from "./stage.ts";

// The nflverse stage without the network. Reading real parquet is proved by the stage
// itself in the Daily workflow (and by `npm run nflverse` locally).

const dirs: string[] = [];
const tempDir = () => {
  const d = mkdtempSync(join(tmpdir(), "nflverse-test-"));
  dirs.push(d);
  return d;
};
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

const asset = (over: Partial<Asset> = {}): Asset => ({
  name: "games.parquet",
  size: 4,
  updated_at: "2026-11-13T21:16:42Z",
  browser_download_url: "https://github.com/nflverse/nflverse-data/releases/download/schedules/games.parquet",
  ...over,
});

function fakeHttp(opts: { bytes?: Uint8Array; release?: unknown } = {}) {
  const calls: string[] = [];
  const http: Http = {
    getJson: async (url) => {
      calls.push(url);
      return opts.release ?? { assets: [] };
    },
    getBytes: async (url) => {
      calls.push(url);
      return opts.bytes ?? new Uint8Array([1, 2, 3, 4]);
    },
  };
  return { http, calls };
}

describe("asset cache", () => {
  test("downloads once, then serves the cached copy while updated_at is unchanged", async () => {
    const dir = tempDir();
    const { http, calls } = fakeHttp();
    const first = await ensureAsset(http, dir, "schedules", asset());
    expect(first.downloaded).toBe(true);
    expect([...readFileSync(first.path)]).toEqual([1, 2, 3, 4]);
    const again = await ensureAsset(http, dir, "schedules", asset());
    expect(again.downloaded).toBe(false);
    expect(calls).toHaveLength(1);
  });

  test("a newer updated_at downloads again", async () => {
    const dir = tempDir();
    const { http, calls } = fakeHttp();
    await ensureAsset(http, dir, "schedules", asset());
    const next = await ensureAsset(http, dir, "schedules", asset({ updated_at: "2026-11-14T08:00:00Z" }));
    expect(next.downloaded).toBe(true);
    expect(next.meta.updatedAt).toBe("2026-11-14T08:00:00Z");
    expect(calls).toHaveLength(2);
  });

  test("a truncated download is refused and leaves no file", async () => {
    const dir = tempDir();
    const { http } = fakeHttp({ bytes: new Uint8Array([1, 2]) });
    await expect(ensureAsset(http, dir, "schedules", asset())).rejects.toMatchObject({ kind: "network" });
    expect(existsSync(join(dir, "schedules/games.parquet"))).toBe(false);
  });
});

describe("checks", () => {
  test("missing columns are named", () => {
    expect(missingColumns(["a", "b"], ["a", "c", "d"])).toEqual(["c", "d"]);
  });

  test("a per-season file with another season's rows is a problem", () => {
    expect(checkRows(DATASETS.pbp, 2025, [{ season: 2025 }, { season: 2025 }], 2026)).toEqual([]);
    expect(checkRows(DATASETS.pbp, 2025, [{ season: 2025 }, { season: 2024 }], 2026)).toEqual([
      "play_by_play_2025.parquet has a row for season 2024",
    ]);
    expect(checkRows(DATASETS.pbp, 2025, [], 2026)).toEqual(["play_by_play_2025.parquet has no rows"]);
  });

  test("games must reach last season; players must look complete", () => {
    expect(checkRows(DATASETS.games, null, [{ season: 2023 }], 2026)).toEqual(["games.parquet ends at season 2023"]);
    expect(checkRows(DATASETS.games, null, [{ season: 2026 }], 2026)).toEqual([]);
    expect(checkRows(DATASETS.players, null, [{ espn_id: "1" }], 2026)[0]).toMatch(/looks thin/);
  });

  test("season ranges", () => {
    expect(parseSeasons("2020-2022,2026")).toEqual([2020, 2021, 2022, 2026]);
    expect(parseSeasons("2025")).toEqual([2025]);
    expect(() => parseSeasons("soon")).toThrow();
  });
});

describe("stage", () => {
  const quiet = () => {};

  test("before mid-September, a missing current-season file is noted, not a failure", async () => {
    const { http } = fakeHttp({ release: { assets: [] } });
    const manifest = await runStage({ http, today: "2026-08-20", seasons: [2026], datasets: ["pbp"], cacheDir: tempDir(), log: quiet });
    expect(manifest.notPublished).toEqual(["play_by_play_2026.parquet"]);
    expect(manifest.files).toEqual([]);
  });

  test("in season, a missing file fails the stage", async () => {
    const { http } = fakeHttp({ release: { assets: [] } });
    await expect(
      runStage({ http, today: "2026-11-13", seasons: [2026], datasets: ["pbp"], cacheDir: tempDir(), log: quiet }),
    ).rejects.toThrow(/play_by_play_2026.parquet is not in the nflverse-data "pbp" release/);
  });

  test("a failing release listing fails the stage with the reason", async () => {
    const http: Http = {
      getJson: async () => {
        throw new SourceError("http-error", "HTTP 403 from api.github.com", { httpStatus: 403 });
      },
      getBytes: async () => new Uint8Array(),
    };
    await expect(
      runStage({ http, today: "2026-11-13", seasons: [2025], datasets: ["games"], cacheDir: tempDir(), log: quiet }),
    ).rejects.toThrow(/listing release "schedules": HTTP 403/);
  });

  test("health reports pbp freshness and the stage detail from the manifest", () => {
    const status = computeStatus({
      adapters: [], snapshots: [], today: "2026-11-13", now: new Date("2026-11-13T09:00:00Z"),
      jobs: { capture: "success", nflverse: "success" },
      nflverse: {
        schemaVersion: 1, generatedAt: "2026-11-13T08:30:00Z", seasons: [2025, 2026], notPublished: [],
        files: [
          { dataset: "pbp", season: 2025, name: "play_by_play_2025.parquet", updatedAt: "2026-08-13T12:26:09Z", size: 1, rows: 1 },
          { dataset: "pbp", season: 2026, name: "play_by_play_2026.parquet", updatedAt: "2026-11-13T17:11:44Z", size: 1, rows: 1 },
        ],
      },
    });
    expect(status.dataFreshness.pbp).toBe("2026-11-13");
    expect(status.stages.find((s) => s.id === "nflverse")?.detail).toBe("pbp 2026 updated 2026-11-13T17:11:44Z; 2 files loaded");
  });
});
