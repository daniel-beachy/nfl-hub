import { useEffect, useId, useRef } from "react";
import type { SeriesSourceId } from "../../../../shared/ids.ts";
import { SOURCE_INFO } from "./model.ts";
import css from "./SourceTabs.module.css";

// One tab per source that has data for this chart, and nothing else: no disabled tabs,
// no "not available" message. The parent decides which sources those are
// (`sourcesWithData`) and owns the choice; this only draws it.

export interface SourceTab {
  id: SeriesSourceId;
  /** Last date the source had a value, when that is behind the chart's last date. */
  staleSince: string | null;
  /** Last date the source had any value. */
  lastDate: string;
}

const shortDate = (iso: string) => new Date(`${iso}T12:00:00Z`).toLocaleDateString(undefined, { month: "short", day: "numeric", timeZone: "UTC" });

export function SourceTabs({ tabs, value, onChange, label }: { tabs: readonly SourceTab[]; value: SeriesSourceId; onChange: (id: SeriesSourceId) => void; label: string }) {
  const infoId = useId();
  // On a narrow phone the row scrolls sideways; keep the chosen tab in view (it may be a
  // remembered one that starts off screen).
  const row = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const el = row.current?.querySelector<HTMLElement>('[aria-selected="true"]');
    const box = row.current;
    if (el && box) box.scrollLeft = Math.max(0, el.offsetLeft - box.offsetLeft - (box.clientWidth - el.offsetWidth) / 2);
  }, [value]);
  const current = tabs.find((t) => t.id === value);
  const info = SOURCE_INFO[value];
  return (
    <div className={css.wrap}>
      <div ref={row} className={css.tabs} role="tablist" aria-label={`Source for ${label}`}>
        {tabs.map((t) => (
          <button
            key={t.id}
            type="button"
            role="tab"
            aria-selected={t.id === value}
            className={css.tab}
            data-source={t.id}
            title={t.staleSince ? `Stale since ${shortDate(t.staleSince)}` : undefined}
            onClick={() => onChange(t.id)}
          >
            {SOURCE_INFO[t.id].label}
            {t.staleSince && <span className={css.stale} aria-label={`, stale since ${shortDate(t.staleSince)}`} />}
          </button>
        ))}
      </div>
      <button type="button" className={css.info} popoverTarget={infoId} aria-label={`About ${info.label}`}>
        i
      </button>
      <div id={infoId} popover="auto" className={css.popover}>
        <p className={css.kind}>{info.kind}</p>
        <h3>{info.label}</h3>
        <p>{info.about}</p>
        <p>{info.values}</p>
        {current && (
          <p className={current.staleSince ? css.staleText : css.fresh}>
            {current.staleSince ? `Stale since ${shortDate(current.staleSince)}: no newer value has been captured.` : `Last captured ${shortDate(current.lastDate)}.`}
          </p>
        )}
      </div>
    </div>
  );
}
