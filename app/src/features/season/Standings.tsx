import { useEffect, useState } from "react";
import { CONFERENCES, DIVISION_NAMES, type Conference } from "../../../../shared/ids.ts";
import { modelSeasonSchema, type ModelPoint, type ModelSeason } from "../../../../shared/model.ts";
import { teamsInDivision } from "../../../../shared/teams.ts";
import { loadData, type Loaded } from "../../lib/data.ts";
import { usePrefs } from "../../lib/prefs.ts";
import { formatPercent, formatWins } from "../../ui/chart/TeamMetricChart.tsx";
import { shortDate } from "../../ui/chart/model.ts";
import { Card, Grid, Notice } from "../../ui/primitives.tsx";
import { teamColor } from "../../ui/theme.ts";
import css from "./Standings.module.css";

// Standings and playoff picture (plan 8.1), from the hub model's latest point: each
// division's teams ordered by their chance to win it, with playoff, division, 1 seed and
// Super Bowl odds and projected wins. Current records and seeds are not in the model
// file yet (see the M1-7 row in PLAN.md), so they are not shown rather than guessed.

const COLUMNS = [
  { key: "wins", label: "Wins", title: "Projected regular-season wins", format: formatWins },
  { key: "playoffs", label: "Playoffs", title: "Make the playoffs", format: formatPercent },
  { key: "division", label: "Division", title: "Win the division", format: formatPercent },
  { key: "seed1", label: "1 seed", title: "Earn the conference's 1 seed", format: formatPercent },
  { key: "superBowl", label: "Super Bowl", title: "Win the Super Bowl", format: formatPercent },
] as const;

function ConferenceTable({ conference, point }: { conference: Conference; point: ModelPoint }) {
  const { theme, favoriteTeam } = usePrefs();
  return (
    <Card title={conference} flush>
      <div className={css.scroll}>
        <table className={css.table}>
          <thead>
            <tr>
              <th scope="col">Team</th>
              {COLUMNS.map((c) => (
                <th key={c.key} scope="col" title={c.title}>
                  {c.label}
                </th>
              ))}
            </tr>
          </thead>
          {DIVISION_NAMES.map((d) => {
            const teams = teamsInDivision(`${conference} ${d}`).sort((a, b) => {
              const [x, y] = [point.teams[a.id]!, point.teams[b.id]!];
              return y.division - x.division || y.playoffs - x.playoffs || y.wins - x.wins;
            });
            return (
              <tbody key={d}>
                <tr className={css.division}>
                  <th colSpan={COLUMNS.length + 1} scope="colgroup">
                    {conference} {d}
                  </th>
                </tr>
                {teams.map((t) => {
                  const row = point.teams[t.id]!;
                  return (
                    <tr key={t.id} data-team={t.id} data-favorite={t.id === favoriteTeam}>
                      <th scope="row">
                        <span className={css.team}>
                          <span className={css.swatch} style={{ background: teamColor(t.id, theme) }} />
                          {t.id}
                          <span className={css.nick}>{t.nickname}</span>
                        </span>
                      </th>
                      {COLUMNS.map((c) => (
                        <td key={c.key}>{c.format(row[c.key])}</td>
                      ))}
                    </tr>
                  );
                })}
              </tbody>
            );
          })}
        </table>
      </div>
    </Card>
  );
}

export function Standings({ season }: { season: number }) {
  const [model, setModel] = useState<Loaded<ModelSeason> | null>(null);
  useEffect(() => {
    let live = true;
    void loadData(`model/${season}.json`, modelSeasonSchema).then((r) => live && setModel(r));
    return () => void (live = false);
  }, [season]);

  if (model === null) return <Notice title="Loading…" />;
  if (model.state !== "ok") return <Notice tone="bad" title="The hub model's forecast could not be loaded">{model.state === "missing" ? `Nothing has been published for ${season} yet.` : model.message}</Notice>;
  const point = model.data.points.at(-1)!;
  return (
    <>
      <p className={css.note}>
        Hub Model as of {shortDate(point.date)} ({point.phase === "preseason" ? "preseason" : `after week ${point.week}`}). Each division is ordered by the chance to win it, then by playoff chance and wins. Current records and seeds are not shown yet.
      </p>
      <Grid min={30}>
        {CONFERENCES.map((c) => (
          <ConferenceTable key={c} conference={c} point={point} />
        ))}
      </Grid>
    </>
  );
}
