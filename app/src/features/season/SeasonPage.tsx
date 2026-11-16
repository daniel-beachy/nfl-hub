import { CONFERENCES, DIVISION_NAMES } from "../../../../shared/ids.ts";
import type { SeasonSeries } from "../../../../shared/series.ts";
import { teamsInConference, teamsInDivision } from "../../../../shared/teams.ts";
import { TeamMetricChart } from "../../ui/chart/TeamMetricChart.tsx";
import { Grid, Notice, PageHeader } from "../../ui/primitives.tsx";
import { seasonList, useSeasonFiles, useSelectedSeason } from "./useSeason.ts";
import css from "./SeasonPage.module.css";

// Season Outlook (plan 8.1): every team metric over the season, each chart with its own
// source tabs (TeamMetricChart). A chart with no data for the season is left out by the
// chart itself, so nothing here is ever empty. Standings, Awards and Leaders follow.

const conf = (c: (typeof CONFERENCES)[number]) => teamsInConference(c).map((t) => t.id);

function SeasonSelect({ season, onChange }: { season: number; onChange: (s: number) => void }) {
  return (
    <label className={css.select}>
      <span>Season</span>
      <select value={season} onChange={(e) => onChange(Number(e.target.value))}>
        {seasonList().map((s) => (
          <option key={s} value={s}>
            {s}
          </option>
        ))}
      </select>
    </label>
  );
}

function Outlook({ daily, weekly }: { daily: SeasonSeries; weekly: SeasonSeries | null }) {
  const files = { daily, weekly };
  return (
    <div className={css.stack}>
      <TeamMetricChart title="Win the Super Bowl" metric="superBowl" {...files} />
      <Grid min={30}>
        {CONFERENCES.map((c) => (
          <TeamMetricChart key={c} title={`Make the Super Bowl: ${c}`} metric="conference" teams={conf(c)} {...files} height={240} />
        ))}
      </Grid>
      <h2 className={css.section}>Win the division</h2>
      <Grid min={22}>
        {CONFERENCES.flatMap((c) =>
          DIVISION_NAMES.map((d) => (
            <TeamMetricChart key={`${c} ${d}`} title={`${c} ${d}`} metric="division" teams={teamsInDivision(`${c} ${d}`).map((t) => t.id)} {...files} height={180} />
          )),
        )}
      </Grid>
      <Grid min={30}>
        {CONFERENCES.map((c) => (
          <TeamMetricChart key={c} title={`Make the playoffs: ${c}`} metric="playoffs" teams={conf(c)} {...files} height={240} />
        ))}
      </Grid>
      <TeamMetricChart title="Projected wins" metric="wins" {...files} />
      <Grid min={30}>
        {CONFERENCES.map((c) => (
          <TeamMetricChart key={c} title={`Earn the 1 seed: ${c}`} metric="seed1" teams={conf(c)} {...files} height={240} />
        ))}
      </Grid>
    </div>
  );
}

export function SeasonPage() {
  const [season, setSeason] = useSelectedSeason();
  const files = useSeasonFiles(season);
  const past = season < 2026;

  return (
    <>
      <PageHeader
        title="Season"
        note={
          past
            ? `${season} from the Hub Model only: odds were not captured before 2026, so these forecasts were computed afterwards from results known at the time.`
            : `${season} championship, division and playoff odds, over the season.`
        }
      >
        <SeasonSelect season={season} onChange={setSeason} />
      </PageHeader>
      {files === null && <Notice title="Loading…" />}
      {files && files.daily.state !== "ok" && (
        <Notice tone="bad" title="Season numbers could not be loaded">
          {files.daily.state === "missing" ? `Nothing has been published for ${season} yet.` : files.daily.message}
        </Notice>
      )}
      {files?.daily.state === "ok" && <Outlook key={season} daily={files.daily.data} weekly={files.weekly.state === "ok" ? files.weekly.data : null} />}
    </>
  );
}
