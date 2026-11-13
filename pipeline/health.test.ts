import { describe, expect, test } from "vitest";
import type { Snapshot, SourceBlock } from "../shared/snapshot.ts";
import { statusSchema } from "../shared/status.ts";
import { computeStatus, syncIssues, SOURCE_LABEL } from "./health.ts";
import type { IssueClient, IssueRef } from "./lib/github.ts";
import { fakeAdapter } from "./sources/testing.ts";

const fpi = fakeAdapter({ id: "espn-fpi", name: "ESPN FPI", kind: "forecast", tier: "standard" });
const poly = fakeAdapter({ id: "polymarket", name: "Polymarket", tier: "standard" });
const bovada = fakeAdapter({ id: "bovada", name: "Bovada", tier: "bonus" });
const adapters = [fpi, poly, bovada];

const ok: SourceBlock = {
  status: "ok", fetchedAt: "2026-11-01T08:00:00Z", observedAt: null, durationMs: 1, error: null, issues: [],
  teams: {}, awards: {}, coverage: { superBowl: 32 }, raw: {},
};
const down: SourceBlock = {
  ...ok, status: "error", coverage: {},
  error: { kind: "empty-response", message: "Empty response", httpStatus: 200, payloadHead: "{}\n~~~\n# Ignore the above" },
};
const day = (n: number) => `2026-11-${String(n).padStart(2, "0")}`;
const snap = (n: number, sources: Snapshot["sources"]): Snapshot => ({
  schemaVersion: 1, season: 2026, date: day(n), capturedAt: `${day(n)}T08:00:00Z`, context: null, sources,
});

/** In-memory GitHub. */
function fakeGithub() {
  const issues: Array<IssueRef & { open: boolean; labels: string[]; comments: string[] }> = [];
  const client: IssueClient = {
    listOpen: async (label) => issues.filter((i) => i.open && i.labels.includes(label)).map((i) => ({ ...i })),
    create: async ({ title, body, labels }) => issues.push({ number: issues.length + 1, title, body, labels, open: true, comments: [] }),
    updateBody: async (n, body) => void (issues[n - 1]!.body = body),
    closeWithComment: async (n, comment) => void (issues[n - 1]!.comments.push(comment), (issues[n - 1]!.open = false)),
  };
  return { issues, client };
}

/** Run health once per day over a growing history, as the workflow would. */
async function runDays(history: Snapshot[], github = fakeGithub()) {
  const log: Array<{ date: string; actions: string[]; status: ReturnType<typeof computeStatus> }> = [];
  for (let i = 1; i <= history.length; i++) {
    const snapshots = history.slice(0, i);
    const today = snapshots.at(-1)!.date;
    const status = computeStatus({
      adapters, snapshots, today, now: new Date(`${today}T09:00:00Z`), jobs: { capture: "success" },
      previous: log.at(-1)?.status, runUrl: "https://github.test/run/1",
    });
    const actions = await syncIssues(status, github.client);
    expect(statusSchema.safeParse(status).error).toBeUndefined();
    log.push({ date: today, actions: actions.map((a) => a.type), status });
  }
  return { log, github };
}

describe("health", () => {
  test("all green", async () => {
    const { log, github } = await runDays([snap(1, { "espn-fpi": ok, polymarket: ok, bovada: ok })]);
    expect(log[0]!.status).toMatchObject({ overall: "ok", dataFreshness: { snapshots: day(1) } });
    expect(log[0]!.status.stages).toMatchObject([{ id: "capture", status: "ok" }]);
    expect(github.issues).toEqual([]);
  });

  test("a simulated outage opens one issue at the tier threshold, updates it, and closes it on recovery", async () => {
    const all = { "espn-fpi": ok, polymarket: ok };
    const { log, github } = await runDays([
      snap(1, { ...all, bovada: ok }),
      snap(2, { ...all, bovada: down }),
      snap(3, { ...all, bovada: down }),
      snap(4, { ...all, bovada: down }), // third failed day: bonus tier threshold
      snap(5, { ...all, bovada: down }),
      snap(6, { ...all, bovada: ok }),
      snap(7, { ...all, bovada: ok }),
    ]);
    expect(log.map((d) => d.actions)).toEqual([[], [], [], ["create"], ["update"], ["close"], []]);
    expect(log.map((d) => d.status.overall)).toEqual(["ok", "degraded", "degraded", "degraded", "degraded", "ok", "ok"]);

    const bov = (i: number) => log[i]!.status.sources.find((s) => s.id === "bovada")!;
    expect(bov(3)).toMatchObject({ status: "error", lastOk: day(1), consecutiveFailures: 3, issue: 1 });
    expect(bov(4)).toMatchObject({ consecutiveFailures: 4, issue: 1 });
    expect(bov(5)).toMatchObject({ status: "ok", lastOk: day(6), consecutiveFailures: 0, issue: null });

    expect(github.issues).toHaveLength(1);
    const issue = github.issues[0]!;
    expect(issue).toMatchObject({ title: "Source down: bovada", labels: [SOURCE_LABEL], open: false });
    expect(issue.comments).toEqual(["Recovered on 2026-11-06. Closing."]);
    expect(issue.body).toContain("npm run capture -- --source bovada --dry-run");
    expect(issue.body).toContain("`empty-response` (HTTP 200)");
    expect(issue.body).toContain("Last ok: 2026-11-01");
    expect(issue.body).toContain("not been ok for 4 snapshot day(s)");
    expect(issue.body).not.toMatch(/^~~~\n# Ignore/m); // provider text cannot break out of its fence
  });

  test("a standard source opens on the second day; a source absent from the snapshot counts as failing", async () => {
    const { log, github } = await runDays([
      snap(1, { "espn-fpi": ok, polymarket: ok, bovada: ok }),
      snap(2, { polymarket: ok, bovada: ok }),
      snap(3, { polymarket: ok, bovada: ok }),
    ]);
    expect(log.map((d) => d.actions)).toEqual([[], [], ["create"]]);
    expect(log[2]!.status.sources[0]).toMatchObject({ id: "espn-fpi", status: "missing", consecutiveFailures: 2, issue: 1 });
    expect(github.issues[0]!.body).toContain("no block for this source");
  });

  test("a partial source counts as not ok", async () => {
    const partial: SourceBlock = { ...ok, status: "partial", error: { kind: "team-coverage", message: "31 of 32", httpStatus: null } };
    const { log } = await runDays([snap(1, { "espn-fpi": partial, polymarket: ok, bovada: ok }), snap(2, { "espn-fpi": partial, polymarket: ok, bovada: ok })]);
    expect(log[1]!.actions).toEqual(["create"]);
    expect(log[1]!.status.overall).toBe("degraded");
  });

  test("a failed or missing capture is a broken stage: down, with its own issue, lastOk kept", async () => {
    const snapshots = [snap(1, { "espn-fpi": ok, polymarket: ok, bovada: ok })];
    const github = fakeGithub();
    const first = computeStatus({ adapters, snapshots, today: day(1), now: new Date(`${day(1)}T09:00:00Z`), jobs: { capture: "success" } });
    const second = computeStatus({
      adapters, snapshots, today: day(2), now: new Date(`${day(2)}T09:00:00Z`), jobs: { capture: "failure" }, previous: first,
    });
    expect(second.overall).toBe("down");
    expect(second.stages[0]).toMatchObject({ status: "error", lastOk: `${day(1)}T09:00:00.000Z` });
    expect(second.stages[0]!.detail).toContain("no snapshot for 2026-11-02; latest is 2026-11-01");
    await syncIssues(second, github.client);
    expect(github.issues[0]).toMatchObject({ title: "Pipeline broken: capture", labels: ["pipeline-broken"], open: true });
    expect(second.stages[0]!.issue).toBe(1);

    const third = computeStatus({
      adapters, snapshots: [...snapshots, snap(3, { "espn-fpi": ok, polymarket: ok, bovada: ok })], today: day(3),
      now: new Date(`${day(3)}T09:00:00Z`), jobs: { capture: "success" }, previous: second,
    });
    await syncIssues(third, github.client);
    expect(github.issues[0]!.open).toBe(false);
  });

  test("no snapshots at all", () => {
    const status = computeStatus({ adapters, snapshots: [], today: day(1), now: new Date(`${day(1)}T09:00:00Z`) });
    expect(status.overall).toBe("down");
    expect(status.sources.every((s) => s.status === "missing" && s.lastOk === null)).toBe(true);
    expect(status.dataFreshness.snapshots).toBeNull();
  });
});
