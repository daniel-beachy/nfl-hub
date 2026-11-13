import { useEffect, useState } from "react";
import { statusSchema, type Status } from "../../../../shared/status.ts";
import { loadData, type Loaded } from "../../lib/data.ts";

// Bare status page for the M0 checkpoint. M1-9 replaces the presentation; the data is final.

const ISSUES_URL = "https://github.com/daniel-beachy/nfl-hub/issues";
const MARK = { ok: "●", partial: "◐", error: "○", missing: "○", stale: "◐" } as const;

const when = (iso: string | null) =>
  iso ? new Date(iso).toLocaleString(undefined, { dateStyle: "medium", timeStyle: iso.length > 10 ? "short" : undefined }) : "never";

function Rows({ status }: { status: Status }) {
  return (
    <>
      <p>
        Overall: <strong data-status={status.overall}>{status.overall}</strong>. Checked {when(status.generatedAt)}. Latest
        snapshot: {status.dataFreshness.snapshots ?? "none"}.
      </p>
      <table>
        <thead>
          <tr>
            <th>Source</th>
            <th>Status</th>
            <th>Last ok</th>
            <th>Teams</th>
            <th>Problem</th>
          </tr>
        </thead>
        <tbody>
          {status.sources.map((s) => (
            <tr key={s.id}>
              <td>
                {s.name} <small>{s.kind}</small>
              </td>
              <td data-status={s.status}>
                {MARK[s.status]} {s.status}
              </td>
              <td>{s.lastOk ?? "never"}</td>
              <td>{s.coverage.superBowl ?? 0}/32</td>
              <td>
                {s.error ? `${s.error.kind}: ${s.error.message}` : ""}
                {s.issue !== null && <a href={`${ISSUES_URL}/${s.issue}`}> #{s.issue}</a>}
              </td>
            </tr>
          ))}
          {status.stages.map((s) => (
            <tr key={s.id}>
              <td>
                {s.id} <small>pipeline stage</small>
              </td>
              <td data-status={s.status}>
                {MARK[s.status]} {s.status}
              </td>
              <td>{when(s.lastOk)}</td>
              <td />
              <td>
                {s.status === "ok" ? "" : s.detail}
                {s.issue !== null && <a href={`${ISSUES_URL}/${s.issue}`}> #{s.issue}</a>}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      {status.runUrl && (
        <p>
          <a href={status.runUrl}>Pipeline run that produced this</a>
        </p>
      )}
    </>
  );
}

export function StatusPage() {
  const [result, setResult] = useState<Loaded<Status> | null>(null);
  useEffect(() => {
    let live = true;
    void loadData("status.json", statusSchema).then((r) => live && setResult(r));
    return () => void (live = false);
  }, []);

  return (
    <main>
      <h1>NFL Hub</h1>
      <h2>Data status</h2>
      {result === null && <p>Loading…</p>}
      {result?.state === "missing" && <p>No status has been published yet.</p>}
      {result?.state === "error" && <p>Status could not be loaded ({result.message}).</p>}
      {result?.state === "ok" && <Rows status={result.data} />}
    </main>
  );
}
