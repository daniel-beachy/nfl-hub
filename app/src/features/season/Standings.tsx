import { useEffect, useState } from "react";
import { CONFERENCES, DIVISION_NAMES, type Conference } from "../../../../shared/ids.ts";
import { modelSeasonSchema, type ModelPoint, type ModelSeason, type ModelStandings } from "../../../../shared/model.ts";
import { teamsInDivision } from "../../../../shared/teams.ts";
import { loadData, type Loaded } from "../../lib/data.ts";
import { usePrefs } from "../../lib/prefs.ts";
import { formatPercent, formatWins } from "../../ui/chart/TeamMetricChart.tsx";
import { shortDate } from "../../ui/chart/model.ts";
import { Card, Grid, Notice } from "../../ui/primitives.tsx";
import { teamColor } from "../../ui/theme.ts";
import css from "./Standings.module.css";

// Standings and playoff picture (plan 8.1): each team's record and seed if the season
// ended today, with the hub model's playoff, division, 1 seed and Super Bowl odds and
// projected wins. Records and seeds come from the model file's `standings` (the model's
// own tiebreaker code); before the first game, or in a file without them, divisions are
// ordered by the odds instead and those two columns are left out.

const COLUMNS = [
  { key: "wins", label: "Wins", title: "Projected regular-season wins", format: formatWins },
  { key: "playoffs", label: "Playoffs", title: "Make the playoffs", format: formatPercent },
  { key: "division", label: "Division", title: "Win the division", format: formatPercent },
  { key: "seed1", label: "1 seed", title: "Earn the conference's 1 seed", format: formatPercent },
  { key: "superBowl", label: "Super Bowl", title: "Win the Super Bowl", format: formatPercent },
] as const;

function ConferenceTable({ conference, point, standings }: { conference: Conference; point: ModelPoint; standings: ModelStandings | null }) {
  const { theme, favoriteTeam } = usePrefs();
  const order = standings?.order[conference] ?? null;
  return (
    <Card title={conference} flush>
      <div className={css.scroll}>
        <table className={css.table}>
          <thead>
            <tr>
              <th scope="col">Team</th>
              {standings && (
                <>
                  <th scope="col" title="Record: wins, losses (ties)">
                    W-L
                  </th>
                  <th scope="col" title="Seed if the season ended today">
                    Seed
                  </th>
                </>
              )}
              {COLUMNS.map((c) => (
                <th key={c.key} scope="col" title={c.title}>
                  {c.label}
                </th>
              ))}
            </tr>
          </thead>
          {DIVISION_NAMES.map((d) => {
            const teams = teamsInDivision(`${conference} ${d}`).sort((a, b) => {
              if (order) return order.indexOf(a.id) - order.indexOf(b.id);
              const [x, y] = [point.teams[a.id]!, point.teams[b.id]!];
              return y.division - x.division || y.playoffs - x.playoffs || y.wins - x.wins;
            });
            return (
              <tbody key={d}>
                <tr className={css.division}>
                  <th colSpan={COLUMNS.length + (standings ? 3 : 1)} scope="colgroup">
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
                      {standings && order && <RecordCells r={standings.records[t.id]!} seed={order.indexOf(t.id) + 1} />}
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

function RecordCells({ r, seed }: { r: ModelStandings["records"]["KC"]; seed: number }) {
  return (
    <>
      <td>
        {r.w}-{r.l}
        {r.t > 0 ? `-${r.t}` : ""}
      </td>
      <td className={seed <= 7 ? undefined : css.out} data-seed={seed <= 7 ? seed : undefined}>
        {seed <= 7 ? seed : "–"}
      </td>
    </>
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
  const standings = model.data.standings ?? null;
  return (
    <>
      <p className={css.note}>
        {standings
          ? `Records and seeds as of ${shortDate(standings.date)}, as if the season ended today (seeds 5 to 7 are wild cards). Odds from the Hub Model ${point.phase === "preseason" ? "before the season" : `after week ${point.week}`}.`
          : `Hub Model as of ${shortDate(point.date)} (${point.phase === "preseason" ? "preseason" : `after week ${point.week}`}). Each division is ordered by the chance to win it, then by playoff chance and wins.`}
      </p>
      <Grid min={30}>
        {CONFERENCES.map((c) => (
          <ConferenceTable key={c} conference={c} point={point} standings={standings} />
        ))}
      </Grid>
    </>
  );
}
