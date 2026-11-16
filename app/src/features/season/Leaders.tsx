import { useEffect, useState } from "react";
import { LEADER_CATEGORIES, seasonLeadersSchema, type LeaderCategoryId, type SeasonLeaders } from "../../../../shared/leaders.ts";
import { loadData, type Loaded } from "../../lib/data.ts";
import { usePrefs } from "../../lib/prefs.ts";
import { SOURCE_INFO } from "../../ui/chart/model.ts";
import { TimeSeriesChart } from "../../ui/chart/TimeSeriesChart.tsx";
import { useChartView } from "../../ui/chart/useChartView.ts";
import { Card, Grid, Notice } from "../../ui/primitives.tsx";
import { teamColor } from "../../ui/theme.ts";
import chartCss from "../../ui/chart/TeamMetricChart.module.css";
import css from "./Leaders.module.css";

// Stat leaders (plan 8.1, M1-8): the top 10 per category as cards, and one category's
// running totals week by week as a race chart. Regular season, from nflverse, so every
// season since 2020 is real (docs/DATA-CONTRACT.md section 7).

const formatter = (decimals: number) => (v: number) => (decimals ? v.toFixed(decimals) : Math.round(v).toLocaleString());

function Race({ data }: { data: SeasonLeaders }) {
  const { theme, favoriteTeam } = usePrefs();
  const view = useChartView();
  const present = LEADER_CATEGORIES.filter((c) => (data.categories[c.id]?.length ?? 0) > 1);
  const [chosen, setChosen] = useState<LeaderCategoryId>("passingYards");
  const cat = present.find((c) => c.id === chosen) ?? present[0];
  if (!cat || data.weeks.length === 0) return null;
  const leaders = data.categories[cat.id]!;
  const neutral = SOURCE_INFO.consensus.color[theme === "dark" ? 0 : 1];
  const format = formatter(cat.decimals);
  const lines = leaders.map((l) => ({ id: l.playerId, label: l.name.split(" ").slice(1).join(" ") || l.name, color: l.team ? teamColor(l.team, theme) : neutral, values: l.cumulative }));
  const fav = leaders.find((l) => l.team === favoriteTeam && favoriteTeam !== null)?.playerId ?? null;
  return (
    <Card
      title="Season race"
      actions={
        <label className={css.select}>
          <span>Stat</span>
          <select value={cat.id} onChange={(e) => (setChosen(e.target.value as LeaderCategoryId), view.clearIsolated())}>
            {present.map((c) => (
              <option key={c.id} value={c.id}>
                {c.label}
              </option>
            ))}
          </select>
        </label>
      }
    >
      <TimeSeriesChart
        label={`${cat.label}, running total of this season's top 10`}
        dates={data.dates}
        weeks={data.weeks}
        lines={lines}
        range={[0, data.weeks.length - 1]}
        format={format}
        isolated={view.isolated}
        emphasized={fav}
        hoverIndex={view.hoverDate ? Math.max(0, data.dates.indexOf(view.hoverDate)) : null}
        onHover={(i) => view.setHoverDate(i === null ? null : (data.dates[i] ?? null))}
        zeroBased={!cat.id.endsWith("Epa")}
      />
      <div className={chartCss.legend} role="group" aria-label={`Players in the ${cat.label} race. Tap to isolate.`}>
        {leaders.map((l) => (
          <button key={l.playerId} type="button" className={chartCss.chip} aria-pressed={view.isolated.includes(l.playerId)} onClick={() => view.toggleIsolated(l.playerId)}>
            <span className={chartCss.swatch} style={{ background: l.team ? teamColor(l.team, theme) : neutral }} />
            {l.name}
            <span className={chartCss.chipValue}>{format(l.total)}</span>
          </button>
        ))}
        {view.isolated.length > 0 && (
          <button type="button" className={chartCss.clear} onClick={view.clearIsolated}>
            Show all
          </button>
        )}
      </div>
    </Card>
  );
}

function Lists({ data }: { data: SeasonLeaders }) {
  const { theme, favoriteTeam } = usePrefs();
  return (
    <Grid min={18}>
      {LEADER_CATEGORIES.filter((c) => (data.categories[c.id]?.length ?? 0) > 0).map((c) => {
        const format = formatter(c.decimals);
        return (
          <Card key={c.id} title={c.label}>
            <ol className={css.list} data-category={c.id}>
              {data.categories[c.id]!.map((l) => (
                <li key={l.playerId} data-favorite={l.team !== null && l.team === favoriteTeam}>
                  <span className={css.swatch} style={l.team ? { background: teamColor(l.team, theme) } : undefined} />
                  <span className={css.name}>{l.name}</span>
                  <span className={css.meta}>
                    {l.team ?? ""} {l.position ?? ""}
                  </span>
                  <span className={css.total}>{format(l.total)}</span>
                </li>
              ))}
            </ol>
          </Card>
        );
      })}
    </Grid>
  );
}

export function Leaders({ season }: { season: number }) {
  const [file, setFile] = useState<Loaded<SeasonLeaders> | null>(null);
  useEffect(() => {
    let live = true;
    void loadData(`season/${season}/leaders.json`, seasonLeadersSchema).then((r) => live && setFile(r));
    return () => void (live = false);
  }, [season]);

  if (file === null) return <Notice title="Loading…" />;
  if (file.state !== "ok") return <Notice tone="bad" title="Stat leaders could not be loaded">{file.state === "missing" ? `Leaders for ${season} have not been published yet.` : file.message}</Notice>;
  const data = file.data;
  return (
    <div className={css.stack}>
      <p className={css.note}>
        Regular season{data.weeks.length ? `, through week ${data.weeks.at(-1)}` : ""}. From nflverse player stats.
      </p>
      <Race data={data} />
      <Lists data={data} />
    </div>
  );
}
