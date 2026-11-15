import { useCallback, useState } from "react";

// The part of a chart's state that belongs to the reader, not to a data source: which
// lines are isolated, how far back the chart goes, weekly or daily, the hovered day and
// compare mode. It lives in one place, above the source choice, so that changing source
// can only ever change the data (plan 8.2: "switching never resets the view").

export type Resolution = "weekly" | "daily";
/** How far back the chart shows: the whole season or the last N weeks. */
export type Span = "all" | "8w" | "4w";

export interface ChartView {
  isolated: readonly string[];
  toggleIsolated: (id: string) => void;
  clearIsolated: () => void;
  resolution: Resolution;
  setResolution: (r: Resolution) => void;
  span: Span;
  setSpan: (s: Span) => void;
  /** Hovered or tapped day as an ISO date, so it survives a source or resolution switch. */
  hoverDate: string | null;
  setHoverDate: (d: string | null) => void;
  compare: boolean;
  setCompare: (on: boolean) => void;
}

export function useChartView(initial?: { resolution?: Resolution }): ChartView {
  const [isolated, setIsolated] = useState<readonly string[]>([]);
  const [resolution, setResolution] = useState<Resolution>(initial?.resolution ?? "weekly");
  const [span, setSpan] = useState<Span>("all");
  const [hoverDate, setHoverDate] = useState<string | null>(null);
  const [compare, setCompare] = useState(false);
  const toggleIsolated = useCallback((id: string) => setIsolated((cur) => (cur.includes(id) ? cur.filter((x) => x !== id) : [...cur, id])), []);
  const clearIsolated = useCallback(() => setIsolated([]), []);
  return { isolated, toggleIsolated, clearIsolated, resolution, setResolution, span, setSpan, hoverDate, setHoverDate, compare, setCompare };
}

/** The ISO date a span starts at, given the axis's last date. Null for the whole season. */
export function spanStart(span: Span, lastDate: string): string | null {
  if (span === "all") return null;
  const days = span === "8w" ? 56 : 28;
  return new Date(Date.parse(lastDate) - days * 86_400_000).toISOString().slice(0, 10);
}
