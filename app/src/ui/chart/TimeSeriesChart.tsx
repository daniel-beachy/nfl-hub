import { scaleLinear } from "d3-scale";
import { useEffect, useMemo, useRef, useState, type PointerEvent } from "react";
import { lastValue, segments, shortDate, spreadLabels, type Values } from "./model.ts";
import css from "./TimeSeriesChart.module.css";

// A line chart over the season, drawn in SVG. It knows nothing about sources, teams or
// preferences: it draws the lines it is given and reports the hovered day. All state
// that must survive a source switch is passed in (see useChartView).

export interface Line {
  id: string;
  label: string;
  color: string;
  values: Values;
}

export interface TimeSeriesChartProps {
  /** Accessible summary, e.g. "Super Bowl odds, Consensus". */
  label: string;
  dates: readonly string[];
  /** Week number per date (weekly resolution); the axis then reads "Wk 5". */
  weeks?: readonly number[];
  lines: readonly Line[];
  /** Visible index range, inclusive. */
  range: readonly [number, number];
  format: (v: number) => string;
  /** Ids drawn at full strength while everything else is dimmed. Empty means no isolation. */
  isolated?: readonly string[];
  /** Drawn thicker and on top: the favorite team. */
  emphasized?: string | null;
  hoverIndex: number | null;
  onHover: (index: number | null) => void;
  /** Keep the y axis at 0 to 1 scale floor for probabilities. */
  zeroBased?: boolean;
  height?: number;
}

const M = { top: 10, right: 46, bottom: 24, left: 40 };
const TOOLTIP_ROWS = 8;

function useWidth() {
  const ref = useRef<HTMLDivElement>(null);
  const [width, setWidth] = useState(0);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const ro = new ResizeObserver(([entry]) => entry && setWidth(Math.round(entry.contentRect.width)));
    ro.observe(el);
    return () => ro.disconnect();
  }, []);
  return [ref, width] as const;
}

export function TimeSeriesChart({ label, dates, weeks, lines, range, format, isolated = [], emphasized = null, hoverIndex, onHover, zeroBased = true, height = 300 }: TimeSeriesChartProps) {
  const [ref, width] = useWidth();
  const [i0, i1] = range;
  const innerW = Math.max(0, width - M.left - M.right);
  const innerH = height - M.top - M.bottom;
  const isolating = isolated.length > 0;
  const strong = (id: string) => (isolating ? isolated.includes(id) : true);

  // The y scale follows the lines the reader is looking at: the isolated ones if any.
  const y = useMemo(() => {
    let lo = Infinity;
    let hi = -Infinity;
    for (const line of lines) {
      if (isolating && !isolated.includes(line.id)) continue;
      for (let i = i0; i <= i1; i++) {
        const v = line.values[i];
        if (v != null) [lo, hi] = [Math.min(lo, v), Math.max(hi, v)];
      }
    }
    if (lo === Infinity) [lo, hi] = [0, 1];
    if (zeroBased) lo = 0;
    if (hi === lo) hi = lo + (lo === 0 ? 1 : Math.abs(lo) * 0.1);
    return scaleLinear().domain([lo, hi]).nice(4).range([innerH, 0]);
  }, [lines, isolated, isolating, i0, i1, zeroBased, innerH]);

  // Weekly points are evenly spaced. Daily points sit at their real dates, because the
  // axis can mix weekly and daily captures and two days must not look like two weeks.
  const xs = useMemo(() => {
    const t = dates.map((d, i) => (weeks ? i : Date.parse(d)));
    const [t0, t1] = [t[i0] ?? 0, t[i1] ?? 0];
    return t.map((ti) => (t1 === t0 ? innerW / 2 : ((ti - t0) / (t1 - t0)) * innerW));
  }, [dates, weeks, i0, i1, innerW]);
  const x = (i: number) => xs[i] ?? 0;
  const path = (pts: readonly (readonly [number, number])[]) => pts.map(([i, v], k) => `${k ? "L" : "M"}${x(i).toFixed(1)} ${y(v).toFixed(1)}`).join("");

  // Draw order: dimmed lines, then normal, then isolated, then the favorite on top.
  const rank = (l: Line) => (l.id === emphasized ? 3 : isolating && isolated.includes(l.id) ? 2 : strong(l.id) ? 1 : 0);
  const ordered = [...lines].sort((a, b) => rank(a) - rank(b));

  // End labels: every strong line when isolating or when there are few lines; otherwise
  // the top five by latest value plus the favorite. Spread so they never overlap.
  const ends = lines
    .filter((l) => strong(l.id))
    .map((l) => ({ line: l, last: lastValue(l.values, i0, i1) }))
    .filter((e): e is { line: Line; last: readonly [number, number] } => e.last !== null)
    .sort((a, b) => b.last[1] - a.last[1]);
  const labelled = isolating || lines.length <= 6 ? ends : ends.filter((e, k) => k < 5 || e.line.id === emphasized);
  const labelYs = spreadLabels(labelled.map((e) => y(e.last[1])), 12, 4, innerH);

  // Ticks from the latest point backwards, skipping any that would crowd the previous one.
  const xTicks = useMemo(() => {
    const minGap = weeks ? 44 : 58;
    const ticks: number[] = [];
    let prev = Infinity;
    for (let i = i1; i >= i0; i--) {
      const xi = xs[i] ?? 0;
      if (prev - xi >= minGap) {
        ticks.push(i);
        prev = xi;
      }
    }
    return ticks;
  }, [i0, i1, xs, weeks]);

  const onPointer = (e: PointerEvent<SVGRectElement>) => {
    const box = e.currentTarget.getBoundingClientRect();
    const px = e.clientX - box.left;
    let best = i0;
    for (let i = i0; i <= i1; i++) if (Math.abs((xs[i] ?? 0) - px) < Math.abs((xs[best] ?? 0) - px)) best = i;
    onHover(best);
  };

  const hover = hoverIndex !== null && hoverIndex >= i0 && hoverIndex <= i1 ? hoverIndex : null;
  const rows =
    hover === null
      ? []
      : lines
          .filter((l) => strong(l.id) && l.values[hover] != null)
          .map((l) => ({ line: l, value: l.values[hover]! }))
          .sort((a, b) => b.value - a.value);
  const shown = rows.filter((r, k) => k < TOOLTIP_ROWS || r.line.id === emphasized);
  const hoverDate = hover !== null ? dates[hover] : undefined;

  return (
    <div ref={ref} className={css.chart} style={{ height }}>
      {width > 0 && (
        <svg width={width} height={height} role="img" aria-label={label}>
          <g transform={`translate(${M.left},${M.top})`}>
            {y.ticks(4).map((t) => (
              <g key={t} transform={`translate(0,${y(t)})`}>
                <line x2={innerW} className={css.grid} />
                <text x={-8} dy="0.32em" textAnchor="end" className={css.tick}>
                  {format(t)}
                </text>
              </g>
            ))}
            {xTicks.map((i) => (
              <text key={i} x={x(i)} y={innerH + 16} textAnchor="middle" className={css.tick}>
                {weeks ? (weeks[i] === 0 ? "Pre" : `Wk ${weeks[i]}`) : shortDate(dates[i] ?? "")}
              </text>
            ))}
            {ordered.map((line) => {
              const { runs, bridges } = segments(line.values, i0, i1);
              const isFav = line.id === emphasized;
              const dim = !strong(line.id);
              return (
                <g key={line.id} data-line={line.id} stroke={line.color} fill={line.color} opacity={dim ? 0.12 : isFav || isolating ? 1 : 0.8} strokeWidth={isFav ? 3 : isolating && !dim ? 2.25 : 1.5}>
                  {bridges.map((b, k) => (
                    <path key={`b${k}`} d={path(b)} className={css.bridge} />
                  ))}
                  {runs.map((run, k) => (run.length === 1 ? <circle key={`r${k}`} cx={x(run[0]![0])} cy={y(run[0]![1])} r={isFav ? 3 : 2} stroke="none" /> : <path key={`r${k}`} d={path(run)} className={css.line} />))}
                </g>
              );
            })}
            {labelled.map((e, k) => (
              <text key={e.line.id} x={innerW + 6} y={labelYs[k]} dy="0.32em" fill={e.line.color} className={e.line.id === emphasized ? css.endLabelStrong : css.endLabel}>
                {e.line.label}
              </text>
            ))}
            {hover !== null && (
              <g pointerEvents="none">
                <line x1={x(hover)} x2={x(hover)} y2={innerH} className={css.rule} />
                {shown.map((r) => (
                  <circle key={r.line.id} cx={x(hover)} cy={y(r.value)} r={3.5} fill={r.line.color} className={css.dot} />
                ))}
              </g>
            )}
            {/* One hit area for mouse and touch: move or tap to read a day; pan-y keeps page scrolling. */}
            <rect width={innerW} height={innerH} fill="transparent" style={{ touchAction: "pan-y" }} onPointerDown={onPointer} onPointerMove={onPointer} onPointerLeave={(e) => e.pointerType === "mouse" && onHover(null)} />
          </g>
        </svg>
      )}
      {hover !== null && hoverDate && shown.length > 0 && (
        <div className={css.tooltip} data-side={x(hover) > innerW / 2 ? "left" : "right"} role="status">
          <div className={css.tooltipHead}>
            {weeks ? (weeks[hover] === 0 ? "Preseason" : `Week ${weeks[hover]}`) + " · " : ""}
            {shortDate(hoverDate)}
          </div>
          {shown.map((r) => (
            <div key={r.line.id} className={css.tooltipRow} data-strong={r.line.id === emphasized}>
              <span className={css.swatch} style={{ background: r.line.color }} />
              <span>{r.line.label}</span>
              <span className={css.value}>{format(r.value)}</span>
            </div>
          ))}
          {rows.length > shown.length && <div className={css.more}>and {rows.length - shown.length} more</div>}
        </div>
      )}
    </div>
  );
}
