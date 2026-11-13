import { z } from "zod";
import { ISSUE_KINDS, type Issue } from "../../shared/snapshot.ts";
import { getTeam, isTeamId, teamFromEspnAbbr, teamFromKalshiCode, type Team } from "../../shared/teams.ts";
import { SourceError, toSourceError } from "../lib/http.ts";

// Small helpers shared by the sportsbook and exchange adapters. Pure.

/**
 * American odds to raw implied probability: "+500" is 100 / 600, "-150" is 150 / 250.
 * Accepts "EVEN" (Bovada's +100). Null for anything else, never a guess.
 */
export function americanToProb(odds: string | number): number | null {
  const text = String(odds).trim().toUpperCase();
  if (text === "EVEN" || text === "EV") return 0.5;
  if (!/^[+-]?\d+(\.\d+)?$/.test(text)) return null;
  const n = Number(text);
  if (n >= 100) return 100 / (n + 100);
  if (n <= -100) return -n / (-n + 100);
  return null; // American odds between -100 and +100 do not exist
}

/** A team from a short code as books write it: "KC", "LAR", "JAC", "WSH". */
export function teamFromAbbr(code: string): Team | undefined {
  const c = code.trim().toUpperCase();
  return (isTeamId(c) ? getTeam(c) : undefined) ?? teamFromEspnAbbr(c) ?? teamFromKalshiCode(c);
}

/**
 * The NFL season a futures market settles for, from its settlement or start time.
 * Season N's futures settle between June N and May N+1 (awards are announced in February
 * or March), which is why this is not `seasonForDate`.
 */
export function seasonOfSettlement(time: string | number | undefined): number | null {
  if (time === undefined) return null;
  const d = new Date(time);
  if (Number.isNaN(d.getTime())) return null;
  return d.getUTCMonth() >= 5 ? d.getUTCFullYear() : d.getUTCFullYear() - 1;
}

/** A failed request among several, recorded in the payload so `parse` can report it. */
export const partFailure = z.object({ part: z.string(), kind: z.enum(ISSUE_KINDS), message: z.string() });
export type PartFailure = z.infer<typeof partFailure>;

/**
 * Run `fn` over `items`, at most `limit` at a time. A failing item becomes a PartFailure
 * instead of failing the whole source; if every item fails, the first error is thrown so
 * the block gets that error's kind.
 */
export async function fetchParts<T, R>(
  items: readonly T[],
  limit: number,
  name: (item: T) => string,
  fn: (item: T) => Promise<R>,
): Promise<{ results: Map<T, R>; failures: PartFailure[] }> {
  const results = new Map<T, R>();
  const failures: PartFailure[] = [];
  let firstError: SourceError | undefined;
  let next = 0;
  const worker = async () => {
    while (next < items.length) {
      const item = items[next++]!;
      try {
        results.set(item, await fn(item));
      } catch (err) {
        const e = toSourceError(err);
        firstError ??= e;
        failures.push({ part: name(item), kind: e.kind, message: e.message });
      }
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  if (items.length > 0 && results.size === 0 && firstError) throw firstError;
  failures.sort((a, b) => a.part.localeCompare(b.part));
  return { results, failures };
}

export const failureIssue = (f: PartFailure): Issue => ({
  kind: f.kind,
  message: `${f.part}: ${f.message}`,
  httpStatus: null,
  detail: f.part,
});
