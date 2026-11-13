import type { SourceId } from "../../shared/ids.ts";
import { bovada } from "./bovada.ts";
import { draftkings } from "./draftkings.ts";
import { espnFpi } from "./espn-fpi.ts";
import { kalshi } from "./kalshi.ts";
import { polymarket } from "./polymarket.ts";
import type { SourceAdapter } from "./types.ts";

/** Every captured source. Order is the order they are listed on the status page. */
export const ADAPTERS: readonly SourceAdapter[] = [espnFpi, draftkings, polymarket, kalshi, bovada];

export function getAdapter(id: string): SourceAdapter {
  const adapter = ADAPTERS.find((a) => a.id === (id as SourceId));
  if (!adapter) throw new Error(`Unknown source "${id}". Known: ${ADAPTERS.map((a) => a.id).join(", ")}`);
  return adapter;
}
