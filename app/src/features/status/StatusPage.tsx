import { useEffect, useState } from "react";
import { AWARD_MARKETS } from "../../../../shared/ids.ts";
import { statusSchema, type SourceHealth, type StageHealth, type Status } from "../../../../shared/status.ts";
import { loadData, type Loaded } from "../../lib/data.ts";
import { Badge, Card, Notice, PageHeader, type Tone } from "../../ui/primitives.tsx";
import { shortDate } from "../../ui/chart/model.ts";
import css from "./StatusPage.module.css";

// Data status (plan 7.4, M1-9): one row per source and pipeline stage, straight from
// status.json, with the open GitHub issue linked. Written for Dan at a glance; the
// detail a fixing session needs is in the issue and docs/RUNBOOK.md.

const ISSUES_URL = "https://github.com/daniel-beachy/nfl-hub/issues";
/** Plan 14: the app says so when the newest snapshot is more than this many days old. */
const SNAPSHOT_STALE_DAYS = 2;

const TONE: Record<string, Tone> = { ok: "ok", partial: "warn", stale: "warn", degraded: "warn", error: "bad", missing: "bad", down: "bad" };
const OVERALL: Record<Status["overall"], string> = { ok: "All good", degraded: "Something is off, the site still works", down: "Down" };
const KIND: Record<SourceHealth["kind"], string> = { model: "Model", forecast: "Forecast", market: "Market" };
const FRESHNESS: Record<string, string> = { snapshots: "Odds snapshots", pbp: "Play-by-play", model: "Hub model" };

const dateTime = (iso: string) => new Date(iso).toLocaleString(undefined, { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" });
const daysBetween = (a: string, b: string) => Math.floor((Date.parse(b) - Date.parse(a)) / 86_400_000);

function Issue({ n }: { n: number | null }) {
  return n === null ? null : (
    <a className={css.issue} href={`${ISSUES_URL}/${n}`}>
      Issue #{n}
    </a>
  );
}

function SourceRow({ s }: { s: SourceHealth }) {
  const teams = s.coverage.superBowl;
  const awards = AWARD_MARKETS.filter((m) => (s.coverage[m] ?? 0) > 0).length;
  const covered = [teams ? `${teams}/32 teams` : null, awards ? `${awards} of ${AWARD_MARKETS.length} awards` : null].filter(Boolean).join(" · ");
  return (
    <li className={css.row} data-source={s.id}>
      <div className={css.name}>
        <strong>{s.name}</strong>
        <span className={css.meta}>
          {KIND[s.kind]} · {s.tier}
        </span>
      </div>
      <Badge tone={TONE[s.status]}>{s.status}</Badge>
      <div className={css.facts}>
        <span>Last ok {s.lastOk ? shortDate(s.lastOk) : "never"}</span>
        {covered && <span>{covered}</span>}
        {s.consecutiveFailures > 0 && <span>{s.consecutiveFailures === 1 ? "1 day failing" : `${s.consecutiveFailures} days failing`}</span>}
      </div>
      {(s.error || s.issue !== null) && (
        <p className={css.problem}>
          {s.error && (
            <>
              <code>{s.error.kind}</code> {s.error.message}{" "}
            </>
          )}
          <Issue n={s.issue} />
        </p>
      )}
    </li>
  );
}

function StageRow({ s }: { s: StageHealth }) {
  return (
    <li className={css.row} data-stage={s.id}>
      <div className={css.name}>
        <strong>{s.id}</strong>
        <span className={css.meta}>pipeline stage</span>
      </div>
      <Badge tone={TONE[s.status]}>{s.status}</Badge>
      <div className={css.facts}>
        <span>Last ok {s.lastOk ? dateTime(s.lastOk) : "never"}</span>
      </div>
      <p className={s.status === "ok" ? css.detail : css.problem}>
        {s.detail} <Issue n={s.issue} />
      </p>
    </li>
  );
}

function StatusView({ status }: { status: Status }) {
  const snapshots = status.dataFreshness.snapshots ?? null;
  const today = new Date().toISOString().slice(0, 10);
  const snapshotsOld = snapshots !== null && daysBetween(snapshots, today) > SNAPSHOT_STALE_DAYS;
  return (
    <>
      <PageHeader title="Data status" note={`Checked ${dateTime(status.generatedAt)} by the daily pipeline.`}>
        <Badge tone={TONE[status.overall]}>{OVERALL[status.overall]}</Badge>
      </PageHeader>
      <div className={css.stack}>
        {snapshotsOld && (
          <Notice tone="warn" title={`No new odds since ${shortDate(snapshots)}`}>
            The daily capture has not run for {daysBetween(snapshots, today)} days. Charts show the last numbers it saved.
          </Notice>
        )}
        <Card title="Sources">
          <ul className={css.list}>
            {status.sources.map((s) => (
              <SourceRow key={s.id} s={s} />
            ))}
          </ul>
        </Card>
        <Card title="Pipeline">
          <ul className={css.list}>
            {status.stages.map((s) => (
              <StageRow key={s.id} s={s} />
            ))}
          </ul>
        </Card>
        <Card title="Newest data">
          <dl className={css.freshness}>
            {Object.entries(status.dataFreshness).map(([k, v]) => (
              <div key={k}>
                <dt>{FRESHNESS[k] ?? k}</dt>
                <dd>{v ? shortDate(v) : "none yet"}</dd>
              </div>
            ))}
          </dl>
          {status.runUrl && (
            <p className={css.run}>
              <a href={status.runUrl}>The pipeline run that wrote this</a> · <a href={ISSUES_URL}>All issues</a>
            </p>
          )}
        </Card>
      </div>
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

  if (result?.state === "ok") return <StatusView status={result.data} />;
  return (
    <>
      <PageHeader title="Data status" />
      {result === null && <Notice title="Loading…" />}
      {result?.state === "missing" && <Notice title="No status has been published yet" />}
      {result?.state === "error" && (
        <Notice tone="bad" title="The status file could not be read">
          {result.message}
        </Notice>
      )}
    </>
  );
}
