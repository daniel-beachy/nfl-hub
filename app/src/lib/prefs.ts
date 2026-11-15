import { useSyncExternalStore } from "react";
import { z } from "zod";
import { TEAM_IDS } from "../../../shared/teams.ts";

// Everything the app remembers about Dan lives here and nowhere else. Today it is one
// localStorage entry; if a login is ever added, only `storage` below changes (plan
// section 3, "Login"). Nothing else in the app may touch localStorage.
//
// A value that is missing, corrupt or from an older version falls back to its default
// field by field, so bad storage can never stop the app from starting (QA X8).

export const PREFS_KEY = "nfl-hub:prefs:v1";

const prefsSchema = z.object({
  theme: z.enum(["dark", "light"]).catch("dark"),
  favoriteTeam: z.enum(TEAM_IDS).nullable().catch(null),
  /** Last source chosen per chart metric (plan 8.2). Validated by the chart, not here. */
  sources: z.record(z.string(), z.string()).catch({}),
  /** Spoiler delay for live games, in seconds (plan 9.3). */
  liveDelaySeconds: z.number().min(0).max(600).catch(0),
});
export type Prefs = z.infer<typeof prefsSchema>;

export function parsePrefs(raw: string | null): Prefs {
  let value: unknown = {};
  try {
    value = raw === null ? {} : JSON.parse(raw);
  } catch {
    // Not JSON: use the defaults.
  }
  const isObject = typeof value === "object" && value !== null && !Array.isArray(value);
  return prefsSchema.parse(isObject ? value : {});
}

// Private browsing and blocked storage throw on access; the app then runs on defaults
// and simply forgets on reload.
const storage = {
  read(): string | null {
    try {
      return globalThis.localStorage?.getItem(PREFS_KEY) ?? null;
    } catch {
      return null;
    }
  },
  write(raw: string): void {
    try {
      globalThis.localStorage?.setItem(PREFS_KEY, raw);
    } catch {
      // Nothing useful to do.
    }
  },
};

let current: Prefs | null = null;
const listeners = new Set<() => void>();

export function getPrefs(): Prefs {
  current ??= parsePrefs(storage.read());
  return current;
}

export function setPrefs(patch: Partial<Prefs>): void {
  current = prefsSchema.parse({ ...getPrefs(), ...patch });
  storage.write(JSON.stringify(current));
  listeners.forEach((fn) => fn());
}

/** Remember the source chosen for one chart metric. */
export function setSourcePref(metric: string, source: string): void {
  setPrefs({ sources: { ...getPrefs().sources, [metric]: source } });
}

function subscribe(fn: () => void): () => void {
  listeners.add(fn);
  // Another tab changed the preferences.
  const onStorage = (e: StorageEvent) => {
    if (e.key !== PREFS_KEY && e.key !== null) return;
    current = null;
    fn();
  };
  globalThis.addEventListener?.("storage", onStorage);
  return () => {
    listeners.delete(fn);
    globalThis.removeEventListener?.("storage", onStorage);
  };
}

export function usePrefs(): Prefs {
  return useSyncExternalStore(subscribe, getPrefs);
}

/** Tests only: forget the cached value so the next read comes from storage. */
export function resetPrefsCache(): void {
  current = null;
}
