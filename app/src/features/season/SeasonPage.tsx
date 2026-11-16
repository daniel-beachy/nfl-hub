import { Navigate, Route, Routes, useLocation, useNavigate } from "react-router";
import { AWARD_MARKETS, CONFERENCES, DIVISION_NAMES, type AwardMarket } from "../../../../shared/ids.ts";
import type { SeasonSeries } from "../../../../shared/series.ts";
import { teamsInConference, teamsInDivision } from "../../../../shared/teams.ts";
import { AwardChart, hasAward } from "../../ui/chart/AwardChart.tsx";
import { TeamMetricChart } from "../../ui/chart/TeamMetricChart.tsx";
import { Grid, Notice, PageHeader, Segmented } from "../../ui/primitives.tsx";
import { Standings } from "./Standings.tsx";
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

const AWARD_TITLES: Record<AwardMarket, string> = {
  mvp: "MVP",
  opoy: "Offensive Player of the Year",
  dpoy: "Defensive Player of the Year",
  oroy: "Offensive Rookie of the Year",
  droy: "Defensive Rookie of the Year",
  coy: "Coach of the Year",
  cpoy: "Comeback Player of the Year",
};

function Awards({ daily, weekly }: { daily: SeasonSeries; weekly: SeasonSeries | null }) {
  return (
    <Grid min={30}>
      {AWARD_MARKETS.filter((m) => hasAward(daily, m)).map((m) => (
        <AwardChart key={m} title={AWARD_TITLES[m]} market={m} daily={daily} weekly={weekly} />
      ))}
    </Grid>
  );
}

type View = "outlook" | "standings" | "awards";

/** Outlook, Standings, Awards: only the views this season has data for, so none can be empty. */
function SubNav({ views }: { views: readonly { value: View; label: string }[] }) {
  const { pathname, search } = useLocation();
  const navigate = useNavigate();
  const value: View = pathname.endsWith("/awards") ? "awards" : pathname.endsWith("/standings") ? "standings" : "outlook";
  if (views.length < 2) return null;
  return <Segmented label="Season view" options={views} value={value} onChange={(v) => navigate({ pathname: v === "outlook" ? "/season" : `/season/${v}`, search })} />;
}

function Loaded({ season, daily, weekly }: { season: number; daily: SeasonSeries; weekly: SeasonSeries | null }) {
  const { search } = useLocation();
  const awards = AWARD_MARKETS.some((m) => hasAward(daily, m));
  const views = [{ value: "outlook" as const, label: "Outlook" }, { value: "standings" as const, label: "Standings" }, ...(awards ? [{ value: "awards" as const, label: "Awards" }] : [])];
  return (
    <>
      <div className={css.subnav}>
        <SubNav views={views} />
      </div>
      <Routes>
        <Route index element={<Outlook daily={daily} weekly={weekly} />} />
        <Route path="standings" element={<Standings season={season} />} />
        {awards && <Route path="awards" element={<Awards daily={daily} weekly={weekly} />} />}
        <Route path="*" element={<Navigate to={{ pathname: "/season", search }} replace />} />
      </Routes>
    </>
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
      {files?.daily.state === "ok" && <Loaded key={season} season={season} daily={files.daily.data} weekly={files.weekly.state === "ok" ? files.weekly.data : null} />}
    </>
  );
}
