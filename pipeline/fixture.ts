import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { seasonForDate } from "../shared/ids.ts";
import { isMain, parseArgs, REPO_ROOT, writeFileAtomic } from "./lib/files.ts";
import { createHttp } from "./lib/http.ts";
import { getAdapter } from "./sources/index.ts";
import { parsePayload, validatePayload } from "./sources/run.ts";
import type { FinalizedBlock } from "./sources/finalize.ts";
import type { SourceAdapter } from "./sources/types.ts";

// Fixtures: a real provider payload, trimmed to the fields the adapter reads, plus the
// result it must parse to. `npm run fixture -- <source>` records today's.
//   pipeline/sources/fixtures/<source>/<date>.json            the payload
//   pipeline/sources/fixtures/<source>/<date>.expected.json   what parsing it must produce

export const FIXTURE_DIR = join(REPO_ROOT, "pipeline/sources/fixtures");

export interface Fixture {
  source: string;
  date: string;
  season: number;
  payload: unknown;
  expected: FinalizedBlock;
}

export function loadFixtures(source: string): Fixture[] {
  const dir = join(FIXTURE_DIR, source);
  let files: string[];
  try {
    files = readdirSync(dir);
  } catch {
    return [];
  }
  const read = (name: string) => JSON.parse(readFileSync(join(dir, name), "utf8")) as unknown;
  return files
    .filter((f) => /^\d{4}-\d{2}-\d{2}\.json$/.test(f))
    .sort()
    .map((f) => {
      const date = f.slice(0, 10);
      const expected = read(`${date}.expected.json`) as FinalizedBlock;
      return { source, date, season: seasonForDate(date), payload: read(f), expected };
    });
}

export async function recordFixture(adapter: SourceAdapter, date: string): Promise<string> {
  const ctx = { season: seasonForDate(date), date };
  const raw = await adapter.fetch({ ...ctx, http: createHttp() });
  const payload = validatePayload(adapter, raw); // strips everything the adapter does not read
  const expected = parsePayload(adapter, payload, ctx);
  const base = join(FIXTURE_DIR, adapter.id, date);
  writeFileAtomic(`${base}.json`, `${JSON.stringify(payload)}\n`);
  writeFileAtomic(`${base}.expected.json`, `${JSON.stringify(expected, null, 1)}\n`);
  const coverage = Object.entries(expected.coverage).map(([k, n]) => `${k} ${n}`).join(", ");
  return `${adapter.id} ${date}: ${expected.status} (${coverage})${expected.issues.map((i) => `\n  ${i.kind}: ${i.message}`).join("")}`;
}

if (isMain(import.meta.url)) {
  const args = parseArgs(process.argv.slice(2));
  if (args._.length === 0) throw new Error("Usage: npm run fixture -- <source> [<source>...]");
  const date = new Date().toISOString().slice(0, 10);
  for (const id of args._) console.log(await recordFixture(getAdapter(id), date));
  console.log("Read the .expected.json diff before committing: it is the contract the test enforces.");
}
