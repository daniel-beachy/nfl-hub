import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { gzipSync } from "node:zlib";
import { parseScoreboard, parseSummary } from "../app/src/lib/espn/schemas.ts";
import { ESPN_BASE_URL } from "../app/src/lib/espn/source.ts";

// Records one game as ESPN serves it while live, to check what the live schemas could
// not be checked against (docs/SOURCES.md, "Not verified"). Polls at the app's own
// rates: the summary every 10 s, the scoreboard every 30 s, from 5 minutes before
// kickoff until 2 minutes after the game is final. Raw responses go to
// tmp/live-recordings/{eventId}/ (gzipped, not committed) with a report.json of findings.
//
//   npx tsx scripts/record-live.ts 401873065

const eventId = process.argv[2];
if (!eventId || !/^\d+$/.test(eventId)) {
  console.error("usage: npx tsx scripts/record-live.ts <eventId>");
  process.exit(1);
}
const dir = join(import.meta.dirname, "../tmp/live-recordings", eventId);
mkdirSync(dir, { recursive: true });
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const get = async (path: string): Promise<unknown> => (await fetch(`${ESPN_BASE_URL}${path}`, { signal: AbortSignal.timeout(12_000) })).json();
const stamp = () => new Date().toISOString().replace(/[:.]/g, "-");

const report = {
  eventId,
  polls: 0,
  fetchErrors: 0,
  frameFailures: [] as string[],
  maxDropped: 0,
  sawCurrentDrive: 0,
  currentAlsoInPrevious: 0,
  playsFirstSeen: 0,
  playsFirstSeenWithoutWallclock: 0,
  /** Seconds from a play's wallclock to the poll that first showed it. */
  lagSeconds: [] as number[],
  situationSamples: [] as unknown[],
  scoreboardDropped: 0,
};
const seen = new Set<string>();
const save = () => {
  const lag = [...report.lagSeconds].sort((a, b) => a - b);
  const at = (q: number) => lag[Math.floor((lag.length - 1) * q)] ?? null;
  writeFileSync(join(dir, "report.json"), JSON.stringify({ ...report, lagSeconds: undefined, lag: { min: at(0), median: at(0.5), p90: at(0.9), max: at(1) } }, null, 2));
};

const first = parseSummary(await get(`/summary?event=${eventId}`));
if (!first.ok) throw new Error(first.error);
const kickoff = Date.parse(first.value.header.competitions[0]!.date);
const wait = kickoff - 5 * 60_000 - Date.now();
if (wait > 0) {
  console.log(`Waiting ${Math.round(wait / 60_000)} min for kickoff at ${new Date(kickoff).toISOString()}`);
  await sleep(wait);
}

let finalSince: number | null = null;
let primed = false;
for (let i = 0; Date.now() < kickoff + 6 * 3600_000; i++) {
  const started = Date.now();
  try {
    const raw = await get(`/summary?event=${eventId}`);
    report.polls++;
    writeFileSync(join(dir, `summary-${stamp()}.json.gz`), gzipSync(JSON.stringify(raw)));
    const parsed = parseSummary(raw);
    if (!parsed.ok) {
      if (report.frameFailures.length < 20) report.frameFailures.push(parsed.error);
    } else {
      report.maxDropped = Math.max(report.maxDropped, parsed.dropped);
      const { previous = [], current } = parsed.value.drives ?? {};
      if (current) {
        report.sawCurrentDrive++;
        if (previous.some((d) => d.id === current.id)) report.currentAlsoInPrevious++;
      }
      for (const p of [...previous, ...(current ? [current] : [])].flatMap((d) => d.plays)) {
        if (seen.has(p.id)) continue;
        seen.add(p.id);
        // Plays already there on the first poll say nothing about lag.
        if (!primed) continue;
        report.playsFirstSeen++;
        const t = Date.parse(p.wallclock ?? "");
        if (Number.isFinite(t)) report.lagSeconds.push(Math.round((started - t) / 1000));
        else report.playsFirstSeenWithoutWallclock++;
      }
      primed = true;
      if (parsed.value.header.competitions[0]!.status.type.state === "post") finalSince ??= Date.now();
    }
    if (i % 3 === 0) {
      const board = await get("/scoreboard");
      writeFileSync(join(dir, `scoreboard-${stamp()}.json.gz`), gzipSync(JSON.stringify(board)));
      const b = parseScoreboard(board);
      if (b.ok) report.scoreboardDropped = Math.max(report.scoreboardDropped, b.dropped);
      const ev = (board as { events?: { id: string; competitions?: { situation?: unknown }[] }[] }).events?.find((e) => e.id === eventId);
      const situation = ev?.competitions?.[0]?.situation;
      if (situation && i % 90 === 0 && report.situationSamples.length < 12) report.situationSamples.push(situation);
    }
  } catch (err) {
    report.fetchErrors++;
    console.error(String(err));
  }
  if (i % 30 === 0) save();
  if (finalSince && Date.now() - finalSince > 120_000) break;
  await sleep(Math.max(0, 10_000 - (Date.now() - started)));
}
save();
console.log(`Done: ${report.polls} polls. See ${join(dir, "report.json")}`);
