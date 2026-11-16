import type { SeriesSourceId, TeamMetric } from "../../../../shared/ids.ts";
import type { SeasonSeries } from "../../../../shared/series.ts";
import { TEAM_IDS, type TeamId } from "../../../../shared/teams.ts";
import { setSourcePref, usePrefs } from "../../lib/prefs.ts";
import { Badge, Card, Notice, Segmented } from "../primitives.tsx";
import { teamColor } from "../theme.ts";
import { chooseSource, lastValue, nearestIndex, rangeIndexes, shortDate, SOURCE_INFO, sourcesWithData, staleSince, type Values } from "./model.ts";
import { SourceTabs, type SourceTab } from "./SourceTabs.tsx";
import { TimeSeriesChart, type Line } from "./TimeSeriesChart.tsx";
import { spanStart, useChartView, type Resolution, type Span } from "./useChartView.ts";
import css from "./TeamMetricChart.module.css";

// One team metric over the season, with its own source tabs. This is the pattern every
// Season chart follows (plan 8.1 and 8.2):
//   - the view (isolated teams, span, weekly or daily, hovered day) is one state object
//     that the source choice cannot touch;
//   - tabs are computed from the data, so a tab exists exactly when it has something to show;
//   - the chosen source is remembered per metric and silently falls back when it has no data.

export const formatPercent = (v: number) => `${(v * 100).toFixed(v > 0 && v < 0.1 ? 1 : 0)}%`;
export const formatWins = (v: number) => v.toFixed(1);

const RESOLUTIONS: readonly { value: Resolution; label: string }[] = [{ value: "weekly", label: "Weekly" }, { value: "daily", label: "Daily" }];
const SPANS: readonly { value: Span; label: string }[] = [{ value: "all", label: "Season" }, { value: "8w", label: "8 wk" }, { value: "4w", label: "4 wk" }];

export interface TeamMetricChartProps {
  title: string;
  metric: TeamMetric;
  daily: SeasonSeries;
  /** Optional; without it the chart is daily only. */
  weekly?: SeasonSeries | null;
  /** Limit to these teams (a conference or a division). Default: all 32. */
  teams?: readonly TeamId[];
  /** Key the remembered source is stored under. Default: the metric. */
  prefKey?: string;
  height?: number;
}

export function TeamMetricChart({ title, metric, daily, weekly, teams = TEAM_IDS, prefKey = metric, height }: TeamMetricChartProps) {
  const view = useChartView();
  const { theme, favoriteTeam, sources } = usePrefs();

  const hasWeekly = !!weekly && weekly.dates.length > 1;
  const file = view.resolution === "weekly" && hasWeekly ? weekly : daily;
  const blocks = file.metrics[metric] ?? {};
  const lastDate = file.dates.at(-1);
  const range = lastDate ? (rangeIndexes(file.dates, spanStart(view.span, lastDate), null) ?? ([0, file.dates.length - 1] as const)) : null;

  const valuesBySource: Partial<Record<SeriesSourceId, Values[]>> = {};
  for (const [id, block] of Object.entries(blocks) as [SeriesSourceId, NonNullable<(typeof blocks)[SeriesSourceId]>][]) {
    valuesBySource[id] = teams.flatMap((t) => (block.teams[t] ? [block.teams[t]] : []));
  }
  const available = range ? sourcesWithData(valuesBySource, range[0], range[1]) : [];
  const source = chooseSource(available, sources[prefKey]);

  if (!range || !lastDate || !source) {
    return (
      <Card title={title}>
        <Notice title="No numbers for this yet">Nothing has been captured for this chart in this season.</Notice>
      </Card>
    );
  }

  const tabs: SourceTab[] = available.map((id) => {
    const last = blocks[id]!.availability.lastDate;
    return { id, lastDate: last, staleSince: staleSince(last, daily.dates.at(-1) ?? lastDate) };
  });
  const current = tabs.find((t) => t.id === source)!;

  // Compare mode needs exactly one team; otherwise it quietly stays off.
  const only = view.isolated.length === 1 ? (view.isolated[0] as TeamId) : null;
  const comparing = view.compare && only !== null;
  const format = metric === "wins" ? formatWins : formatPercent;

  const teamLines: Line[] = teams.flatMap((t) => {
    const values = blocks[source]?.teams[t];
    return values ? [{ id: t, label: t, color: teamColor(t, theme), values }] : [];
  });
  const lines: Line[] = comparing
    ? available.flatMap((id) => {
        const values = blocks[id]?.teams[only];
        return values ? [{ id, label: SOURCE_INFO[id].label, color: SOURCE_INFO[id].color[theme === "dark" ? 0 : 1], values }] : [];
      })
    : teamLines;

  const legend = teamLines
    .map((l) => ({ line: l, last: lastValue(l.values, range[0], range[1]) }))
    .sort((a, b) => (b.last?.[1] ?? -1) - (a.last?.[1] ?? -1));

  return (
    <Card
      title={
        <>
          {title} {comparing && <Badge>{only} across sources</Badge>}
          {!comparing && current.staleSince && <Badge tone="warn">stale since {shortDate(current.staleSince)}</Badge>}
        </>
      }
      actions={
        <>
          <Segmented label="How far back" options={SPANS} value={view.span} onChange={view.setSpan} />
          {hasWeekly && <Segmented label="Resolution" options={RESOLUTIONS} value={view.resolution} onChange={view.setResolution} />}
        </>
      }
    >
      <div className={css.tabsRow}>
        {comparing ? <span className={css.compareNote}>One line per source for {only}.</span> : <SourceTabs tabs={tabs} value={source} onChange={(id) => setSourcePref(prefKey, id)} label={title} />}
        {only !== null && (
          <button type="button" className={css.compare} aria-pressed={comparing} onClick={() => view.setCompare(!view.compare)}>
            Compare sources
          </button>
        )}
      </div>
      <TimeSeriesChart
        label={`${title}, ${comparing ? `${only} across sources` : SOURCE_INFO[source].label}`}
        dates={file.dates}
        weeks={file.weeks}
        lines={lines}
        range={range}
        format={format}
        zeroBased={metric !== "wins"}
        isolated={comparing ? [] : view.isolated}
        emphasized={comparing ? null : favoriteTeam}
        hoverIndex={view.hoverDate ? nearestIndex(file.dates, view.hoverDate) : null}
        onHover={(i) => view.setHoverDate(i === null ? null : (file.dates[i] ?? null))}
        height={height}
      />
      <div className={css.legend} role="group" aria-label={`Teams in ${title}. Tap to isolate.`}>
        {legend.map(({ line, last }) => (
          <button key={line.id} type="button" className={css.chip} aria-pressed={view.isolated.includes(line.id)} data-favorite={line.id === favoriteTeam} onClick={() => view.toggleIsolated(line.id)}>
            <span className={css.swatch} style={{ background: line.color }} />
            {line.label}
            <span className={css.chipValue}>{last ? format(last[1]) : "–"}</span>
          </button>
        ))}
        {view.isolated.length > 0 && (
          <button type="button" className={css.clear} onClick={view.clearIsolated}>
            Show all
          </button>
        )}
      </div>
    </Card>
  );
}
