import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { parseScoreboard, parseSummary } from "../app/src/lib/espn/schemas.ts";
import { ESPN_BASE_URL } from "../app/src/lib/espn/source.ts";

// Records a real ESPN response as a test fixture, trimmed to the fields the live schemas
// read (what the parser returns is exactly that). One request per run.
//
//   npm run live-fixture -- summary 401873063
//   npm run live-fixture -- scoreboard
//   npm run live-fixture -- summary 401873063 --file saved.json   (trim a saved response)

const [kind, ...rest] = process.argv.slice(2);
const fileAt = rest.indexOf("--file");
const file = fileAt === -1 ? null : rest[fileAt + 1];
const eventId = kind === "summary" ? rest[0] : null;
if ((kind !== "summary" && kind !== "scoreboard") || (kind === "summary" && !/^\d+$/.test(eventId ?? ""))) {
  console.error("usage: npm run live-fixture -- summary <eventId> | scoreboard  [--file saved.json]");
  process.exit(1);
}

const url = `${ESPN_BASE_URL}/${kind === "summary" ? `summary?event=${eventId}` : "scoreboard"}`;
const raw: unknown = file ? JSON.parse(readFileSync(file, "utf8")) : await (await fetch(url)).json();
const parsed = kind === "summary" ? parseSummary(raw) : parseScoreboard(raw);
if (!parsed.ok) {
  console.error(`Does not match the schema: ${parsed.error}`);
  process.exit(1);
}
const name = kind === "summary" ? `summary-${eventId}.json` : `scoreboard-${new Date().toISOString().slice(0, 10)}.json`;
const out = join(import.meta.dirname, "../app/src/lib/espn/fixtures", name);
writeFileSync(out, JSON.stringify(parsed.value) + "\n");
console.log(`${out}: ${parsed.dropped} items dropped`);
