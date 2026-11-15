import { useState } from "react";
import { contrast } from "../../../../shared/colors.ts";
import { DIVISION_IDS } from "../../../../shared/ids.ts";
import { teamsInDivision } from "../../../../shared/teams.ts";
import { usePrefs } from "../../lib/prefs.ts";
import { Badge, Card, Grid, Notice, PageHeader, Segmented } from "../../ui/primitives.tsx";
import { SURFACE, teamColor } from "../../ui/theme.ts";
import css from "./Styleguide.module.css";

// Hidden page (#/styleguide): every token and building block in one place, for Dan's
// look-and-feel review and for QA (S17: all 32 team colors readable on both themes).

const COLORS = ["bg", "surface", "surface-2", "surface-3", "border", "border-strong", "text", "text-muted", "text-faint", "accent", "ok", "warn", "bad", "team"];

export function StyleguidePage() {
  const { theme } = usePrefs();
  const [res, setRes] = useState<"weekly" | "daily">("weekly");
  return (
    <>
      <PageHeader title="Style guide" note="The design system on one page. Switch theme and favorite team in the header to check both.">
        <Segmented label="Resolution" value={res} onChange={setRes} options={[{ value: "weekly", label: "Weekly" }, { value: "daily", label: "Daily" }]} />
      </PageHeader>
      <Grid>
        <Card title="Colors">
          <div className={css.swatches}>
            {COLORS.map((c) => (
              <div key={c} className={css.swatch}>
                <span style={{ background: `var(--${c})` }} />
                {c}
              </div>
            ))}
          </div>
        </Card>
        <Card title="Type and numbers" actions={<Badge>estimated</Badge>}>
          <h1>Page title 1,234</h1>
          <h2>Section title 56.7%</h2>
          <h3>Card title</h3>
          <p>Body text. Numbers line up: 111.1 and 888.8.</p>
          <small>Small, muted text for notes and captions.</small>
          <p className={css.row}>
            <Badge>neutral</Badge> <Badge tone="ok">ok</Badge> <Badge tone="warn">stale since Nov 9</Badge> <Badge tone="bad">down</Badge>
          </p>
        </Card>
        <Card title="Messages">
          <div className={css.stack}>
            <Notice title="Nothing here yet">A quiet message in place of content.</Notice>
            <Notice tone="bad" title="Could not load">The last good copy is shown where there is one.</Notice>
          </div>
        </Card>
      </Grid>
      <div className={css.gap} />
      <Card title="Team colors on this theme">
        <p className={css.note}>Each team as a chart line and as text, with its contrast against the card surface (3.0 is the minimum).</p>
        <div className={css.divisions}>
          {DIVISION_IDS.map((d) => (
            <div key={d}>
              <h3 className={css.division}>{d}</h3>
              {teamsInDivision(d).map((t) => {
                const color = teamColor(t.id, theme);
                return (
                  <div key={t.id} className={css.team} style={{ color }}>
                    <svg width="56" height="12" aria-hidden="true">
                      <path d="M0 9 L14 4 L28 7 L42 2 L56 5" fill="none" stroke="currentColor" strokeWidth="2" />
                    </svg>
                    <strong>{t.id}</strong>
                    <span className={css.ratio}>{contrast(color.slice(1), SURFACE[theme]).toFixed(1)}</span>
                  </div>
                );
              })}
            </div>
          ))}
        </div>
      </Card>
    </>
  );
}
