import type { z } from "zod";

// The one way the app loads pipeline data. Files sit under ./data/ beside the app on
// Pages. Everything is validated; a file that fails is treated as absent, never shown.

export type Loaded<T> = { state: "ok"; data: T } | { state: "missing" } | { state: "error"; message: string };

export async function loadData<T>(path: string, schema: z.ZodType<T>): Promise<Loaded<T>> {
  try {
    const res = await fetch(`./data/${path}`, { cache: "no-cache" });
    if (res.status === 404) return { state: "missing" };
    if (!res.ok) return { state: "error", message: `HTTP ${res.status}` };
    // A dev server answers unknown paths with index.html; that is "missing", not broken data.
    if (!(res.headers.get("content-type") ?? "").includes("json")) return { state: "missing" };
    const parsed = schema.safeParse(await res.json());
    return parsed.success ? { state: "ok", data: parsed.data } : { state: "error", message: "The file does not match the data contract" };
  } catch (err) {
    return { state: "error", message: err instanceof Error ? err.message : String(err) };
  }
}
