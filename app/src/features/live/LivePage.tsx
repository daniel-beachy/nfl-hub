import { useEffect } from "react";
import { Link, Route, Routes, useLocation, useParams } from "react-router";
import { getTeam } from "../../../../shared/teams.ts";
import type { Health } from "../../lib/espn/feed.ts";
import { Badge, Card, Notice, PageHeader } from "../../ui/primitives.tsx";
import css from "./Live.module.css";
import { DelayBar } from "./DelayBar.tsx";
import { LiveProvider, useDelayed, useFeedState, useLiveFeed } from "./useLive.tsx";

// A bare first version, enough to prove the live client, the replay harness and the
// spoiler delay end to end. M2-5 and M2-6 replace these pages. Whatever they draw must
// come from `useDelayed()` (plan 9.3), as it does here: never from the feed's newest data.
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

const PREVIEW = "Early version: scores and plays only. Set the delay to match your TV.";

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
  const { slateHealth } = useFeedState();
  const { slate } = useDelayed();
  const { search } = useLocation();
  return (
    <>
      <PageHeader title="Live" note={PREVIEW} />
      <div className={css.stack}>
        <DelayBar />
        <Retrying health={slateHealth} />
        {!slate && slateHealth.status === "loading" && <Notice title="Loading games" />}
        {slate && slate.games.length === 0 && <Notice title="No games this week" />}
        {slate && slate.games.length > 0 && (
          <Card title={slate.week ? `Week ${slate.week}` : "This week"} actions={slate.syncingSeconds !== null && <Badge tone="warn">syncing, {slate.syncingSeconds} s</Badge>} flush>
            <ul className={css.list}>
              {slate.games.map((g) => (
                <li key={g.id}>
                  <Link className={css.game} to={{ pathname: `game/${g.id}`, search }} data-game={g.id} data-syncing={g.syncing}>
                    <span>
                      {getTeam(g.away).nickname} at {getTeam(g.home).nickname}
                    </span>
                    <span className={css.num}>{g.score ? `${g.score.away}–${g.score.home}` : ""}</span>
                    <Badge tone={g.state === "in" && !g.syncing ? "ok" : "neutral"}>{g.syncing ? "syncing" : g.state === "in" ? `Q${g.period ?? ""} ${g.clock ?? ""}` : (g.detail ?? (g.state === "post" ? "Final" : "Upcoming"))}</Badge>
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
  const { gameHealth } = useFeedState();
  const { game, cutoff } = useDelayed();
  const { search } = useLocation();
  useEffect(() => {
    feed.openGame(id ?? null);
    return () => feed.openGame(null);
  }, [feed, id]);

  const last = game?.plays.at(-1);
  const status = !game ? "" : game.status === "pre" ? "Not started" : game.status === "final" ? "Final" : game.period ? `Q${game.period} ${game.clock}` : "Under way";
  return (
    <>
      <PageHeader title={game ? `${getTeam(game.away).nickname} at ${getTeam(game.home).nickname}` : "Game"} note={PREVIEW}>
        <Link to={{ pathname: "..", search }}>All games</Link>
      </PageHeader>
      <div className={css.stack}>
        <DelayBar />
        <Retrying health={gameHealth} />
        {!game && gameHealth.status === "loading" && <Notice title="Loading game" />}
        {game && (
          <Card flush>
            <div className={css.score} data-testid="score" data-state={game.status} data-last-play={last?.id ?? ""} data-cutoff={Number.isFinite(cutoff) ? Math.floor(cutoff) : ""}>
              <span>{game.away}</span>
              <strong className={css.num}>{game.score ? `${game.score.away}–${game.score.home}` : "–"}</strong>
              <span>{game.home}</span>
              <Badge tone={game.status === "in" ? "ok" : "neutral"}>{status}</Badge>
              {game.box.state === "syncing" && <Badge tone="warn">box score syncing, {game.box.seconds} s</Badge>}
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
