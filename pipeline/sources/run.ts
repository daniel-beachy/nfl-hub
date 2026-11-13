import type { SourceBlock } from "../../shared/snapshot.ts";
import { SourceError, toSourceError } from "../lib/http.ts";
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

/** Run one adapter end to end. Never throws: any failure becomes an error block. */
export async function runAdapter(adapter: SourceAdapter, ctx: FetchCtx, now: () => Date = () => new Date()): Promise<RunResult> {
  const started = now();
  const timing = () => ({ fetchedAt: started.toISOString(), durationMs: Math.max(0, now().getTime() - started.getTime()) });
  let raw: unknown;
  try {
    raw = await adapter.fetch(ctx);
    const block = { ...parsePayload(adapter, raw, ctx), ...timing() };
    return { block, failedPayload: block.status === "ok" ? null : JSON.stringify(raw) };
  } catch (err) {
    const e = toSourceError(err);
    const issue = e.toIssue();
    return {
      block: { status: "error", observedAt: null, error: issue, issues: [issue], teams: {}, awards: {}, coverage: {}, raw: {}, ...timing() },
      failedPayload: e.payload ?? (raw === undefined ? null : JSON.stringify(raw)),
    };
  }
}
