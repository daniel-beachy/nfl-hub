import type { SourceBlock } from "../../shared/snapshot.ts";
import { deadlineSignal, SourceError, toSourceError, withSignal } from "../lib/http.ts";
import { finalize, type FinalizedBlock } from "./finalize.ts";
import type { AdapterCtx, FetchCtx, SourceAdapter } from "./types.ts";

/** Validate a raw payload against the adapter's provider schema. Throws schema-drift. */
export function validatePayload(adapter: SourceAdapter, raw: unknown): unknown {
  const result = adapter.payload.safeParse(raw);
  if (result.success) return result.data;
  const detail = result.error.issues
    .slice(0, 5)
    .map((i) => `${i.path.join(".") || "(root)"}: ${i.message}`)
    .join("; ");
  const more = result.error.issues.length > 5 ? ` (+${result.error.issues.length - 5} more)` : "";
  throw new SourceError("schema-drift", `${adapter.name} changed shape at ${detail}${more}`, {
    detail: result.error.issues[0]?.path.join(".") ?? "",
    payload: JSON.stringify(raw),
  });
}

/** Everything after the network: validate, map, check, normalize. Pure; used by fixtures too. */
export function parsePayload(adapter: SourceAdapter, raw: unknown, ctx: AdapterCtx): FinalizedBlock {
  return finalize(adapter, adapter.parse(validatePayload(adapter, raw), ctx), ctx);
}

export interface RunResult {
  block: SourceBlock;
  /** The raw response when the run failed and there was one, for the failed-payloads artifact. */
  failedPayload: string | null;
}

/** How long one source may take, network and all (QA-M0-1: the capture job has 10 minutes). */
export const SOURCE_DEADLINE_MS = 3 * 60_000;
/** After the deadline, how long an adapter gets to hand back the parts it has before it is cut off. */
const GRACE_MS = 5_000;

/**
 * Run one adapter end to end. Never throws: any failure becomes an error block.
 * At `deadlineMs` every request still open is aborted and unfinished parts become `timeout`
 * failures; an adapter that still has not returned shortly after is a `timeout` error.
 */
export async function runAdapter(
  adapter: SourceAdapter, ctx: FetchCtx, now: () => Date = () => new Date(), deadlineMs = SOURCE_DEADLINE_MS,
): Promise<RunResult> {
  const started = now();
  const timing = () => ({ fetchedAt: started.toISOString(), durationMs: Math.max(0, now().getTime() - started.getTime()) });
  const deadline = deadlineSignal(deadlineMs, ctx.signal);
  let cutOff: ReturnType<typeof setTimeout> | undefined;
  const hardStop = new Promise<never>((_, reject) => {
    cutOff = setTimeout(
      () => reject(new SourceError("timeout", `${adapter.name} did not finish within ${Math.round(deadlineMs / 1000)} s`)),
      deadlineMs + GRACE_MS,
    );
  });
  let raw: unknown;
  try {
    raw = await Promise.race([
      adapter.fetch({ ...ctx, http: withSignal(ctx.http, deadline.signal), signal: deadline.signal }),
      hardStop,
    ]);
    const block = { ...parsePayload(adapter, raw, ctx), ...timing() };
    return { block, failedPayload: block.status === "ok" ? null : JSON.stringify(raw) };
  } catch (err) {
    const e = toSourceError(err);
    const issue = e.toIssue();
    return {
      block: { status: "error", observedAt: null, error: issue, issues: [issue], teams: {}, awards: {}, coverage: {}, raw: {}, ...timing() },
      failedPayload: e.payload ?? (raw === undefined ? null : JSON.stringify(raw)),
    };
  } finally {
    clearTimeout(cutOff);
    deadline.clear();
  }
}
