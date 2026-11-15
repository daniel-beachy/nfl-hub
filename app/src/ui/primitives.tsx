import type { ReactNode } from "react";
import css from "./primitives.module.css";

// The handful of building blocks every page uses. Keep this list short: a page that
// needs something new should first try to compose these.

/** Page title row, with optional controls (season selector, toggles) on the right. */
export function PageHeader({ title, note, children }: { title: string; note?: ReactNode; children?: ReactNode }) {
  return (
    <div className={css.pageHeader}>
      <div>
        <h1>{title}</h1>
        {note && <p className={css.pageNote}>{note}</p>}
      </div>
      {children && <div className={css.pageControls}>{children}</div>}
    </div>
  );
}

/** A surface that groups one chart or one table. `actions` sits right of the title. */
export function Card({ title, actions, children, flush }: { title?: ReactNode; actions?: ReactNode; children: ReactNode; flush?: boolean }) {
  return (
    <section className={css.card}>
      {(title || actions) && (
        <div className={css.cardHead}>
          {title && <h2 className={css.cardTitle}>{title}</h2>}
          {actions && <div className={css.cardActions}>{actions}</div>}
        </div>
      )}
      <div className={flush ? undefined : css.cardBody}>{children}</div>
    </section>
  );
}

/** Responsive card grid: one column on phones, `min` rem wide columns after that. */
export function Grid({ min = 22, children }: { min?: number; children: ReactNode }) {
  return (
    <div className={css.grid} style={{ gridTemplateColumns: `repeat(auto-fill, minmax(min(100%, ${min}rem), 1fr))` }}>
      {children}
    </div>
  );
}

export type Tone = "neutral" | "ok" | "warn" | "bad";

/** Small label: "estimated", "stale since Nov 9", "computed afterwards". */
export function Badge({ tone = "neutral", children, title }: { tone?: Tone; children: ReactNode; title?: string }) {
  return (
    <span className={css.badge} data-tone={tone} title={title}>
      {children}
    </span>
  );
}

/** A quiet message in place of content: loading, nothing yet, could not load. */
export function Notice({ title, children, tone = "neutral" }: { title: string; children?: ReactNode; tone?: Tone }) {
  return (
    <div className={css.notice} data-tone={tone} role={tone === "bad" ? "alert" : "status"}>
      <strong>{title}</strong>
      {children && <p>{children}</p>}
    </div>
  );
}

/** Pill-style choice between a few options (Weekly / Daily). Tabs for sources are SourceTabs. */
export function Segmented<T extends string>({ label, options, value, onChange }: { label: string; options: readonly { value: T; label: string }[]; value: T; onChange: (v: T) => void }) {
  return (
    <div className={css.segmented} role="group" aria-label={label}>
      {options.map((o) => (
        <button key={o.value} type="button" aria-pressed={o.value === value} onClick={() => onChange(o.value)}>
          {o.label}
        </button>
      ))}
    </div>
  );
}
