import { useState } from "react";
import { delayToShow, MAX_DELAY_SECONDS } from "../../lib/espn/timeshift.ts";
import { setPrefs, usePrefs } from "../../lib/prefs.ts";
import { Badge, Card, Segmented } from "../../ui/primitives.tsx";
import css from "./Live.module.css";
import { useFeedState, useLiveFeed } from "./useLive.tsx";

// The spoiler delay's controls (plan 9.3): always says how far behind the page is, with a
// one-tap live switch, 5 s nudges, and "Sync to my TV" on a game page.

export function DelayBar() {
  const { liveDelaySeconds: seconds, liveDelayOn: on } = usePrefs();
  const { game } = useFeedState();
  const feed = useLiveFeed();
  const [syncing, setSyncing] = useState(false);
  const delayed = on && seconds > 0;
  const nudge = (by: number) => setPrefs({ liveDelaySeconds: Math.min(MAX_DELAY_SECONDS, Math.max(0, seconds + by)), liveDelayOn: true });
  // Calibration is the one place that reads the newest plays: it has to, to offer the play that is on TV now.
  const recent = game?.plays.slice(-8).reverse() ?? [];

  return (
    <Card flush>
      <div className={css.delay} data-testid="delay" data-delay={delayed ? seconds : 0}>
        <Badge tone={delayed ? "warn" : "ok"}>{delayed ? `Delayed ${seconds} s` : "Live, no delay"}</Badge>
        <Segmented label="Delay" value={on ? "delayed" : "live"} onChange={(v) => setPrefs({ liveDelayOn: v === "delayed" })} options={[{ value: "delayed", label: "Delayed" }, { value: "live", label: "Live" }]} />
        <span className={css.nudge}>
          <button type="button" onClick={() => nudge(-5)} disabled={seconds === 0} aria-label="5 seconds less delay">
            −5 s
          </button>
          <button type="button" onClick={() => nudge(5)} disabled={seconds >= MAX_DELAY_SECONDS} aria-label="5 seconds more delay">
            +5 s
          </button>
        </span>
        {recent.length > 0 && (
          <button type="button" className={css.sync} aria-expanded={syncing} onClick={() => setSyncing(!syncing)}>
            Sync to my TV
          </button>
        )}
      </div>
      {syncing && recent.length > 0 && (
        <div className={css.syncPanel}>
          <p className={css.meta}>
            Tap the play that just happened on your TV. These are the newest plays ESPN has, so this list can be ahead of your broadcast. If ESPN itself is behind your TV, the page cannot catch up; the delay can only hold things back.
          </p>
          <ol className={css.list}>
            {recent.map((p) => (
              <li key={p.id}>
                <button
                  type="button"
                  className={css.syncPlay}
                  data-sync-play={p.id}
                  onClick={() => {
                    setPrefs({ liveDelaySeconds: delayToShow(p, feed.source.now()), liveDelayOn: true });
                    setSyncing(false);
                  }}
                >
                  <span className={css.meta}>
                    Q{p.period} {p.clock}
                  </span>
                  <span>{p.text || p.type}</span>
                </button>
              </li>
            ))}
          </ol>
        </div>
      )}
    </Card>
  );
}
