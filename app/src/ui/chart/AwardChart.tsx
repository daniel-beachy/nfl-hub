import type { AwardMarket, SeriesSourceId } from "../../../../shared/ids.ts";
import type { SeasonSeries } from "../../../../shared/series.ts";
import { setSourcePref, usePrefs } from "../../lib/prefs.ts";
import { Badge, Card, Segmented } from "../primitives.tsx";
import { teamColor } from "../theme.ts";
import { chooseSource, lastValue, nearestIndex, rangeIndexes, shortDate, SOURCE_INFO, sourcesWithData, staleSince, type Values } from "./model.ts";
import { SourceTabs, type SourceTab } from "./SourceTabs.tsx";
import { TimeSeriesChart, type Line } from "./TimeSeriesChart.tsx";
import { formatPercent } from "./TeamMetricChart.tsx";
import { spanStart, useChartView, type Resolution, type Span } from "./useChartView.ts";
import css from "./TeamMetricChart.module.css";

// One award market over the season: the same pattern as TeamMetricChart, over
// awards[market][source].candidates. Candidates have no player ids yet, so a line is
// keyed by the player's name, which is how compile matches them across sources.
// Only the leading candidates of the chosen source are drawn; the rest would be noise.

const RESOLUTIONS: readonly { value: Resolution; label: string }[] = [{ value: "weekly", label: "Weekly" }, { value: "daily", label: "Daily" }];
const SPANS: readonly { value: Span; label: string }[] = [{ value: "all", label: "Season" }, { value: "8w", label: "8 wk" }, { value: "4w", label: "4 wk" }];
const TOP = 8;

export interface AwardChartProps {
  title: string;
  market: AwardMarket;
  daily: SeasonSeries;
  weekly?: SeasonSeries | null;
  height?: number;
}

/** True when any source has an award value for this market in the file (so a page can leave the chart out). */
export const hasAward = (file: SeasonSeries, market: AwardMarket) => Object.values(file.awards[market] ?? {}).some((b) => b.candidates.some((c) => c.values.some((v) => v != null)));

export function AwardChart({ title, market, daily, weekly, height = 260 }: AwardChartProps) {
  const view = useChartView();
  const { theme, favoriteTeam, sources } = usePrefs();
  const prefKey = `award:${market}`;

  const hasWeekly = !!weekly && weekly.dates.length > 1 && hasAward(weekly, market);
  const file = view.resolution === "weekly" && hasWeekly ? weekly : daily;
  const blocks = file.awards[market] ?? {};
  const lastDate = file.dates.at(-1);
  const range = lastDate ? (rangeIndexes(file.dates, spanStart(view.span, lastDate), null) ?? ([0, file.dates.length - 1] as const)) : null;

  const valuesBySource: Partial<Record<SeriesSourceId, Values[]>> = {};
  for (const [id, block] of Object.entries(blocks) as [SeriesSourceId, NonNullable<(typeof blocks)[SeriesSourceId]>][]) valuesBySource[id] = block.candidates.map((c) => c.values);
  const available = range ? sourcesWithData(valuesBySource, range[0], range[1]) : [];
  const source = chooseSource(available, sources[prefKey]);
  if (!range || !lastDate || !source) return null;

  const tabs: SourceTab[] = available.map((id) => {
    const last = blocks[id]!.availability.lastDate;
    return { id, lastDate: last, staleSince: staleSince(last, daily.dates.at(-1) ?? lastDate) };
  });
  const current = tabs.find((t) => t.id === source)!;
  const neutral = SOURCE_INFO.consensus.color[theme === "dark" ? 0 : 1];

  // Leading candidates by their latest value in range, plus anyone isolated.
  const ranked = blocks[source]!.candidates
    .map((c) => ({ c, last: lastValue(c.values, range[0], range[1]) }))
    .filter((r) => r.last !== null)
    .sort((a, b) => b.last![1] - a.last![1]);
  const shown = ranked.filter((r, k) => k < TOP || view.isolated.includes(r.c.name));
  const lines: Line[] = shown.map(({ c }) => ({ id: c.name, label: c.name.split(" ").slice(1).join(" ") || c.name, color: c.team ? teamColor(c.team, theme) : neutral, values: c.values }));
  const favoriteLine = shown.find((r) => r.c.team === favoriteTeam && favoriteTeam !== null)?.c.name ?? null;

  return (
    <Card
      title={
        <>
          {title} {current.staleSince && <Badge tone="warn">stale since {shortDate(current.staleSince)}</Badge>}
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
        <SourceTabs tabs={tabs} value={source} onChange={(id) => setSourcePref(prefKey, id)} label={title} />
      </div>
      <TimeSeriesChart
        label={`${title}, ${SOURCE_INFO[source].label}`}
        dates={file.dates}
        weeks={file.weeks}
        lines={lines}
        range={range}
        format={formatPercent}
        isolated={view.isolated}
        emphasized={favoriteLine}
        hoverIndex={view.hoverDate ? nearestIndex(file.dates, view.hoverDate) : null}
        onHover={(i) => view.setHoverDate(i === null ? null : (file.dates[i] ?? null))}
        height={height}
      />
      <div className={css.legend} role="group" aria-label={`Candidates in ${title}. Tap to isolate.`}>
        {shown.map(({ c, last }) => (
          <button key={c.name} type="button" className={css.chip} aria-pressed={view.isolated.includes(c.name)} onClick={() => view.toggleIsolated(c.name)}>
            <span className={css.swatch} style={{ background: c.team ? teamColor(c.team, theme) : neutral }} />
            {c.name}
            {c.team && <span className={css.chipValue}>{c.team}</span>}
            <span className={css.chipValue}>{last ? formatPercent(last[1]) : "–"}</span>
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
