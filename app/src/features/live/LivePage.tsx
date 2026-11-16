import { useEffect } from "react";
import { Link, Route, Routes, useLocation, useParams } from "react-router";
import { getTeam } from "../../../../shared/teams.ts";
import type { Health } from "../../lib/espn/feed.ts";
import { Badge, Card, Notice, PageHeader } from "../../ui/primitives.tsx";
import css from "./Live.module.css";
import { LiveProvider, useFeedState, useLiveFeed } from "./useLive.tsx";

// A bare first version, enough to prove the live client and the replay harness end to
// end. It draws the feed's newest data directly, so THERE IS NO SPOILER DELAY YET: M2-2
// replaces what these pages read with delayed views (plan 9.3), and M2-5 and M2-6 replace
// the pages themselves.
export function LivePage() {
  return (
    <LiveProvider>
      <Routes>
        <Route index element={<Slate />} />
        <Route path="game/:id" element={<Game />} />
      </Routes>
    </LiveProvider>
  );
}

const PREVIEW = "Early version: no TV delay yet, so scores here can be ahead of your broadcast.";

/** Plan 7.4: say ESPN is not answering, and leave the last data on screen. */
function Retrying({ health }: { health: Health }) {
  if (health.status !== "retrying") return null;
  return (
    <Notice title="ESPN not responding, retrying" tone="warn">
      {health.lastOkAt ? "Showing the last data received." : health.error}
    </Notice>
  );
}

function Slate() {
  const { slate, slateHealth } = useFeedState();
  const { search } = useLocation();
  return (
    <>
      <PageHeader title="Live" note={PREVIEW} />
      <div className={css.stack}>
        <Retrying health={slateHealth} />
        {!slate && slateHealth.status === "loading" && <Notice title="Loading games" />}
        {slate && slate.games.length === 0 && <Notice title="No games this week" />}
        {slate && slate.games.length > 0 && (
          <Card title={slate.week ? `Week ${slate.week}` : "This week"} flush>
            <ul className={css.list}>
              {slate.games.map((g) => (
                <li key={g.id}>
                  <Link className={css.game} to={{ pathname: `game/${g.id}`, search }} data-game={g.id}>
                    <span>
                      {getTeam(g.away).nickname} at {getTeam(g.home).nickname}
                    </span>
                    <span className={css.num}>{g.score ? `${g.score.away}–${g.score.home}` : ""}</span>
                    <Badge tone={g.state === "in" ? "ok" : "neutral"}>{g.state === "in" ? `Q${g.period ?? ""} ${g.clock ?? ""}` : (g.detail ?? (g.state === "post" ? "Final" : "Upcoming"))}</Badge>
                  </Link>
                </li>
              ))}
            </ul>
          </Card>
        )}
      </div>
    </>
  );
}

function Game() {
  const { id } = useParams();
  const feed = useLiveFeed();
  const { game, gameHealth } = useFeedState();
  const { search } = useLocation();
  useEffect(() => {
    feed.openGame(id ?? null);
    return () => feed.openGame(null);
  }, [feed, id]);

  const last = game?.plays.at(-1);
  const status = !game ? "" : game.state === "pre" ? "Not started" : game.state === "post" ? "Final" : last ? `Q${last.period} ${last.clock}` : "Starting";
  return (
    <>
      <PageHeader title={game ? `${getTeam(game.away).nickname} at ${getTeam(game.home).nickname}` : "Game"} note={PREVIEW}>
        <Link to={{ pathname: "..", search }}>All games</Link>
      </PageHeader>
      <div className={css.stack}>
        <Retrying health={gameHealth} />
        {!game && gameHealth.status === "loading" && <Notice title="Loading game" />}
        {game && (
          <Card flush>
            <div className={css.score} data-testid="score" data-state={game.state} data-last-play={last?.id ?? ""}>
              <span>{game.away}</span>
              <strong className={css.num}>{last ? `${last.awayScore}–${last.homeScore}` : "0–0"}</strong>
              <span>{game.home}</span>
              <Badge tone={game.state === "in" ? "ok" : "neutral"}>{status}</Badge>
            </div>
          </Card>
        )}
        {game && game.plays.length > 0 && (
          <Card title="Plays" flush>
            <ol className={css.list} data-testid="plays">
              {game.plays
                .slice(-40)
                .reverse()
                .map((p) => (
                  <li key={p.id} className={css.play} data-play={p.id}>
                    <span className={css.meta}>
                      Q{p.period} {p.clock}
                      {p.start.text ? ` · ${p.start.text}` : ""}
                    </span>
                    <span>{p.text || p.type}</span>
                  </li>
                ))}
            </ol>
          </Card>
        )}
      </div>
    </>
  );
}
