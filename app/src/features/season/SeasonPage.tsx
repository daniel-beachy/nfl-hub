import { useEffect, useState } from "react";
import { seasonSeriesSchema, type SeasonSeries } from "../../../../shared/series.ts";
import { loadData, type Loaded } from "../../lib/data.ts";
import { TeamMetricChart } from "../../ui/chart/TeamMetricChart.tsx";
import { Notice, PageHeader } from "../../ui/primitives.tsx";

// M1-6 exemplar: two charts that prove the chart and source-tab pattern on real data.
// M1-7 replaces this page with the full Outlook, Standings and Awards pages and the
// season selector; build every chart there the way these two are built.

const SEASON = 2026;

export function SeasonPage() {
  const [daily, setDaily] = useState<Loaded<SeasonSeries> | null>(null);
  const [weekly, setWeekly] = useState<Loaded<SeasonSeries> | null>(null);
  useEffect(() => {
    let live = true;
    void loadData(`season/${SEASON}/series.json`, seasonSeriesSchema).then((r) => live && setDaily(r));
    void loadData(`season/${SEASON}/weekly.json`, seasonSeriesSchema).then((r) => live && setWeekly(r));
    return () => void (live = false);
  }, []);

  return (
    <>
      <PageHeader title="Season" note={`${SEASON} championship odds and projected wins. More charts, standings, leaders and awards are still to come.`} />
      {(daily === null || weekly === null) && <Notice title="Loading…" />}
      {daily && weekly && daily.state !== "ok" && (
        <Notice tone="bad" title="Season numbers could not be loaded">
          {daily.state === "missing" ? "The season file has not been published yet." : daily.message}
        </Notice>
      )}
      {daily?.state === "ok" && weekly !== null && (
        <div style={{ display: "grid", gap: "var(--space-3)" }}>
          <TeamMetricChart title="Win the Super Bowl" metric="superBowl" daily={daily.data} weekly={weekly.state === "ok" ? weekly.data : null} />
          <TeamMetricChart title="Projected wins" metric="wins" daily={daily.data} weekly={weekly.state === "ok" ? weekly.data : null} />
        </div>
      )}
    </>
  );
}
