import Link from 'next/link';
import { formatManilaDateTime } from '@picklyph/domain';
import type { OpsCheckState, OpsStatus } from '@picklyph/domain/src/ops.ts';
import { readDirectoryAccess } from '@/lib/directory-server';
import { readHealthView } from '@/lib/health-server';
import { JOB_LABEL, SIGNAL_LABEL, STATUS_LABEL, agoText, checkRows, jobStateLabel, monitorFreshness, problemCounts } from '@/lib/health';
import { AccessProblem, Unavailable } from '@/components/console-state';
import { PageHeader } from '@/components/page-header';

// Formatted on the server so the browser hydrates the same text. The view's timestamps are already validated.
const stamp = (value: string) => formatManilaDateTime(value);
const DASH = '—';

function Status({ status }: { status: OpsStatus }) {
  return <span className={`badge health-${status}`}>{STATUS_LABEL[status]}</span>;
}

/** What the operators' channel was last told about this check. */
function Posted({ state }: { state: OpsCheckState | null }) {
  if (!state) return <>{DASH}</>;
  if (!state.notified_status || !state.notified_at) {
    return state.status === 'ok' ? <span className="cell-sub">Nothing to post</span>
      : <><span className="badge neutral">Not posted yet</span><span className="cell-sub">Due on the monitor’s next run</span></>;
  }
  const what = state.notified_status === 'ok' ? 'Recovery' : STATUS_LABEL[state.notified_status];
  return <>{`${what} posted`}<span className="cell-sub">{stamp(state.notified_at)}</span>
    {state.notified_status !== state.status && <span className="cell-sub">The change to {STATUS_LABEL[state.status].toLowerCase()} is not posted yet</span>}</>;
}

export default async function HealthPage() {
  // Layouts may persist in the router. Every data-bearing page verifies independently.
  const access = await readDirectoryAccess();
  if (access.status !== 'allowed') return <AccessProblem area="health" status={access.status} />;
  const view = await readHealthView(access.actorId).catch(() => null);
  if (!view) return <Unavailable area="health" />;
  const freshness = monitorFreshness(view);
  const rows = checkRows(view);
  const problems = problemCounts(view);
  const summary = problems.fail + problems.warn === 0 ? 'No problems' : [problems.fail && `${problems.fail} failing`, problems.warn && `${problems.warn} warning`].filter(Boolean).join(', ');

  return <>
    <PageHeader title="System health" meta={`The monitor’s checks evaluated now (${stamp(view.at)}, Manila), beside what the monitor last saw and posted to the operators’ channel. Counts only.`}
      actions={<Link className="button secondary" href="/console/health" prefetch={false}>Check again</Link>} />
    {freshness.state === 'never'
      ? <p className="notice health-notice warn" role="status">No monitor run is recorded on this database, so nothing is posted to the operators’ channel. The checks below are this page’s own. Set the monitor up as in docs/monitoring.md (Setup per environment).</p>
      : freshness.state === 'stale'
        ? <p className="notice health-notice warn" role="status">{`The monitor last ran ${agoText(freshness.minutes)} (${stamp(freshness.ranAt)}). It runs every five minutes, so it has stopped: check the ops-monitor job below, its Vault secrets and the function’s logs.`}</p>
        : <p className="notice health-notice" role="status">{`The monitor last ran ${agoText(freshness.minutes)} (${stamp(freshness.ranAt)}).`}</p>}

    <section className="panel" aria-labelledby="checks-heading">
      <div className="panel-head"><h2 id="checks-heading">Checks <span className="count">{summary}</span></h2></div>
      <div className="table-wrap"><table className="data-table">
        <thead><tr><th scope="col">Check</th><th scope="col">Now</th><th scope="col">Monitor</th><th scope="col">Posted</th></tr></thead>
        <tbody>{rows.map((row) => <tr key={row.check}>
          <td>{row.label}<span className="cell-sub"><code>{row.check}</code></span></td>
          <td>{row.live ? <Status status={row.live} /> : <span className="badge neutral">Not live</span>}{row.text && <span className="cell-sub">{row.text}</span>}</td>
          <td>{row.monitor
            ? <><Status status={row.monitor.status} /><span className="cell-sub">{`Since ${stamp(row.monitor.since)}`}</span>
              <span className="cell-sub">{row.monitor.checked_at ? `Checked ${stamp(row.monitor.checked_at)}` : 'Not checked since this page was added'}</span></>
            : <span className="cell-sub">Never checked by the monitor</span>}</td>
          <td><Posted state={row.monitor} /></td>
        </tr>)}</tbody></table></div>
    </section>

    <section className="panel" aria-labelledby="jobs-heading">
      <div className="panel-head"><h2 id="jobs-heading">Scheduled jobs <span className="count">Last 24 hours</span></h2></div>
      {!view.jobs ? <p className="panel-empty">pg_cron is off on this database, so no jobs run: holds are released only when read, and nothing sweeps, delivers or monitors. See docs/monitoring.md.</p>
        : <div className="table-wrap"><table className="data-table">
          <thead><tr><th scope="col">Job</th><th scope="col">State</th><th scope="col">Schedule (UTC)</th><th scope="col">Last run</th><th scope="col">Last success</th>
            <th scope="col" className="num">Failed</th><th scope="col">Latest failure</th></tr></thead>
          <tbody>{view.jobs.map((job) => <tr key={job.job}>
            <td>{JOB_LABEL[job.job]}<span className="cell-sub"><code>{job.job}</code></span></td>
            <td><span className={`badge health-${job.present && job.active ? 'ok' : 'fail'}`}>{jobStateLabel(job)}</span></td>
            <td>{job.schedule ? <code>{job.schedule}</code> : DASH}</td>
            <td className="nowrap">{job.last_run_at ? <>{stamp(job.last_run_at)}<span className="cell-sub">{job.last_status}</span></> : <span className="cell-sub">None</span>}</td>
            <td className="nowrap">{job.last_success_at ? stamp(job.last_success_at) : <span className="cell-sub">None</span>}</td>
            <td className="num">{job.failures}</td>
            <td>{job.last_failure_at ? <>{stamp(job.last_failure_at)}{job.last_failure && <span className="cell-sub failure-text">{job.last_failure}</span>}</> : DASH}</td>
          </tr>)}</tbody></table></div>}
    </section>

    <section className="panel" aria-labelledby="signals-heading">
      <div className="panel-head"><h2 id="signals-heading">Edge function signals <span className="count">Last 24 hours</span></h2></div>
      {view.signals.length === 0 ? <p className="panel-empty">No Edge function reported a server error, a 503 answer or a rate-limiter outage in the last 24 hours.</p>
        : <div className="table-wrap"><table className="data-table">
          <thead><tr><th scope="col">Function</th><th scope="col">Signal</th><th scope="col" className="num">15 min</th><th scope="col" className="num">1 hour</th>
            <th scope="col" className="num">24 hours</th><th scope="col">Last seen</th></tr></thead>
          <tbody>{view.signals.map((signal) => <tr key={`${signal.source}:${signal.kind}`}>
            <td><code>{signal.source}</code></td>
            <td>{SIGNAL_LABEL[signal.kind]}</td>
            <td className="num">{signal.last_15m}</td>
            <td className="num">{signal.last_hour}</td>
            <td className="num">{signal.last_day}</td>
            <td className="nowrap">{stamp(signal.last_at)}</td>
          </tr>)}</tbody></table></div>}
    </section>
  </>;
}
