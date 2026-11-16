import { useEffect, useState } from "react";
import { useSearchParams } from "react-router";
import { seasonSeriesSchema, type SeasonSeries } from "../../../../shared/series.ts";
import { loadData, type Loaded } from "../../lib/data.ts";

// Which season the Season pages show, and its two series files. The season sits in the
// URL (#/season?season=2022) so a reload or a shared link keeps it.

export const FIRST_SEASON = 2020;
/** The season in progress, or the last one before September. */
export function currentSeason(now = new Date()): number {
  return now.getUTCMonth() >= 8 ? now.getUTCFullYear() : now.getUTCFullYear() - 1;
}
export const seasonList = (now = new Date()) => Array.from({ length: currentSeason(now) - FIRST_SEASON + 1 }, (_, i) => currentSeason(now) - i);

export function useSelectedSeason(): [number, (s: number) => void] {
  const [params, setParams] = useSearchParams();
  const asked = Number(params.get("season"));
  const season = Number.isInteger(asked) && asked >= FIRST_SEASON && asked <= currentSeason() ? asked : currentSeason();
  const set = (s: number) =>
    setParams(
      (p) => {
        if (s === currentSeason()) p.delete("season");
        else p.set("season", String(s));
        return p;
      },
      { replace: true },
    );
  return [season, set];
}

export interface SeasonFiles {
  season: number;
  daily: Loaded<SeasonSeries>;
  weekly: Loaded<SeasonSeries>;
}

/** Null while loading. */
export function useSeasonFiles(season: number): SeasonFiles | null {
  const [files, setFiles] = useState<SeasonFiles | null>(null);
  useEffect(() => {
    let live = true;
    void Promise.all([loadData(`season/${season}/series.json`, seasonSeriesSchema), loadData(`season/${season}/weekly.json`, seasonSeriesSchema)]).then(
      ([daily, weekly]) => live && setFiles({ season, daily, weekly }),
    );
    return () => void (live = false);
  }, [season]);
  return files?.season === season ? files : null;
}
