import { createContext, useContext, useEffect, useState, useSyncExternalStore, type ReactNode } from "react";
import { useSearchParams } from "react-router";
import { LiveFeed, type FeedState } from "../../lib/espn/feed.ts";
import { loadReplay } from "../../lib/espn/replay.ts";
import { espnSource } from "../../lib/espn/source.ts";
import { Notice } from "../../ui/primitives.tsx";

// One LiveFeed for the whole Live area, made when the area opens and stopped when it
// closes. With `?replay={eventId}` in the address (plan 9.5) the feed runs on a replay of
// that finished game instead of ESPN: `&speed=20` (game seconds per second, the default)
// and `&from=1800` (start that many seconds after the first play).

const LiveContext = createContext<LiveFeed | null>(null);

export function LiveProvider({ children }: { children: ReactNode }) {
  const [params] = useSearchParams();
  const replay = params.get("replay");
  const speed = Number(params.get("speed")) || 20;
  const from = params.has("from") ? Number(params.get("from")) || 0 : undefined;
  const key = replay ? `${replay}|${speed}|${from}` : "espn";
  const [made, setMade] = useState<{ key: string; feed: LiveFeed | null; error: string | null } | null>(null);

  useEffect(() => {
    let wanted = true;
    let feed: LiveFeed | null = null;
    Promise.resolve(replay ? loadReplay(replay, { speed, from }) : espnSource()).then(
      (source) => {
        if (!wanted) return;
        feed = new LiveFeed(source);
        feed.start();
        setMade({ key, feed, error: null });
      },
      (err: unknown) => wanted && setMade({ key, feed: null, error: err instanceof Error ? err.message : String(err) }),
    );
    return () => {
      wanted = false;
      feed?.stop();
    };
  }, [key, replay, speed, from]);

  const current = made?.key === key ? made : null;
  if (current?.error) return <Notice title="This replay could not be loaded" tone="bad">{current.error}</Notice>;
  if (!current?.feed) return <Notice title="Loading" />;
  return (
    <LiveContext.Provider value={current.feed}>
      {replay && <Notice title={`Replay at ${speed}x`}>A finished game played back as if live. Remove “replay” from the address to see today’s games.</Notice>}
      {children}
    </LiveContext.Provider>
  );
}

export function useLiveFeed(): LiveFeed {
  const feed = useContext(LiveContext);
  if (!feed) throw new Error("useLiveFeed outside LiveProvider");
  return feed;
}

export function useFeedState(): FeedState {
  const feed = useLiveFeed();
  return useSyncExternalStore(feed.subscribe, feed.getState);
}
