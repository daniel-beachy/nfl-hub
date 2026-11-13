import type { z } from "zod";
import type { AwardMarket, SourceId, SourceKind, SourceTier, TeamMetric } from "../../shared/ids.ts";
import type { AwardCandidate, Issue } from "../../shared/snapshot.ts";
import type { TeamId } from "../../shared/teams.ts";
import type { Http } from "../lib/http.ts";

// The adapter contract (docs/PLAN.md 7.1). One provider is one file implementing this.

export interface AdapterCtx {
  /** The NFL season being captured, from the capture date. */
  season: number;
  /** Capture date, YYYY-MM-DD (UTC). */
  date: string;
}

export interface FetchCtx extends AdapterCtx {
  http: Http;
}

/** What an adapter's `parse` returns: provider values mapped to our ids, not yet checked. */
export interface ParsedSource {
  /** The season the provider says this is, when it says. Checked against the capture season. */
  season: number | null;
  /** When the provider says the values are from, when it says. ISO datetime. */
  observedAt: string | null;
  /** Raw implied probabilities (0 to 1), or a number of wins for `wins`. Not de-vigged. */
  teams: Partial<Record<TeamMetric, Partial<Record<TeamId, number>>>>;
  /** For sportsbooks' two-way make-playoffs markets: the raw implied probability of "no". */
  playoffsNo?: Partial<Record<TeamId, number>>;
  /** Real candidates only (no "Other" or placeholder rows), any order, any length. */
  awards: Partial<Record<AwardMarket, AwardCandidate[]>>;
  /** Problems the adapter saw itself: a market it could not find, a name it could not map. */
  issues: Issue[];
}

export interface SourceAdapter<P = unknown> {
  id: SourceId;
  name: string;
  kind: SourceKind;
  tier: SourceTier;
  /** What this source normally offers. Less than this makes the block `partial`. */
  expects: { teams: readonly TeamMetric[]; awards: readonly AwardMarket[] };
  /**
   * The provider shape we rely on, and nothing else. Unknown keys are stripped, so a
   * payload parsed through this is also what a fixture stores.
   */
  payload: z.ZodType<P>;
  /** Network only, through ctx.http. Returns the raw documents; throws SourceError. */
  fetch(ctx: FetchCtx): Promise<unknown>;
  /** Pure: no network, no clock. */
  parse(payload: P, ctx: AdapterCtx): ParsedSource;
}

/** Keeps each adapter's payload type inside its own file. */
export function defineAdapter<P>(adapter: SourceAdapter<P>): SourceAdapter {
  return adapter as unknown as SourceAdapter;
}
