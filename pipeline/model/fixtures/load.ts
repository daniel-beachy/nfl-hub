import { fromCompact, type CompactGame } from "../games.ts";
import type { ModelGame } from "../types.ts";
import raw from "./games-2020-2025.json" with { type: "json" };

/** Every real game of 2020 to 2025 (regular season and playoffs), for tests. */
export function fixtureGames(): ModelGame[] {
  return fromCompact(raw as CompactGame[]);
}
