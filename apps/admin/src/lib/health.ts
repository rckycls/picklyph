// System health in the console (T51c): turns the database's view into rows for the page and the Overview card.
// Pure, so unit tests run it directly. Wording for problems comes from the monitor's own OPS_CHECKS.
import { OPS_CHECKS, OPS_CHECK_NAMES, OPS_EXTERNAL_CHECKS, isOpsCheckName, type OpsAdminView, type OpsCheckState, type OpsJobName,
  type OpsJobState, type OpsSignalKind, type OpsStatus } from '@picklyph/domain/src/ops.ts';
import type { CrashGroup, CrashKind } from '@picklyph/domain/src/crash.ts';

/** The monitor runs every five minutes; three missed runs mean it stopped. */
export const MONITOR_STALE_MINUTES = 15;

export const STATUS_LABEL: Record<OpsStatus, string> = { ok: 'OK', warn: 'Warning', fail: 'Failing' };
export const JOB_LABEL: Record<OpsJobName, string> = {
  'booking-expiry-sweep': 'Hold expiry sweep', 'push-dispatch': 'Push delivery', 'privacy-retention-sweep': 'Privacy retention sweep',
  'ops-monitor': 'Health monitor', 'storage-sweep': 'Storage cleanup',
};
export const SIGNAL_LABEL: Record<OpsSignalKind, string> = { server_error: 'Server errors', unavailable: '503 answers', limiter_degraded: 'Rate limiter outage' };

export type Freshness = { state: 'never' } | { state: 'current' | 'stale'; minutes: number; ranAt: string };

/** How long ago the monitor last stamped its checks, by the database's clock. */
export function monitorFreshness(view: Pick<OpsAdminView, 'at' | 'monitor_ran_at'>): Freshness {
  if (!view.monitor_ran_at) return { state: 'never' };
  const elapsed = Math.max(0, Date.parse(view.at) - Date.parse(view.monitor_ran_at));
  return { state: elapsed > MONITOR_STALE_MINUTES * 60_000 ? 'stale' : 'current', minutes: Math.floor(elapsed / 60_000), ranAt: view.monitor_ran_at };
}

export function agoText(minutes: number): string {
  if (minutes < 1) return 'less than a minute ago';
  if (minutes < 120) return `${minutes} ${minutes === 1 ? 'minute' : 'minutes'} ago`;
  const hours = Math.floor(minutes / 60);
  return hours < 48 ? `${hours} hours ago` : `${Math.floor(hours / 24)} days ago`;
}

/**
 * One row per check. `live` is this page load's own evaluation (null when only the monitor makes the check, or
 * pg_cron is off); `monitor` is what the monitor last saw and posted (null when it never tracked the check).
 */
export type CheckRow = { check: string; label: string; live: OpsStatus | null; text: string; monitor: OpsCheckState | null };

function problemText(check: string, count: number): string {
  return isOpsCheckName(check) ? OPS_CHECKS[check].problem(count) : `count ${count}`;
}

export function checkRows(view: OpsAdminView): CheckRow[] {
  const live = new Map(view.checks.map((item) => [item.check, item]));
  const stored = new Map(view.state.map((item) => [item.check, item]));
  // Known checks in the monitor's report order, then any a newer database added.
  const extra = [...new Set([...live.keys(), ...stored.keys()])].filter((name) => !isOpsCheckName(name)).sort();
  return [...OPS_CHECK_NAMES, ...extra].map((check) => {
    const now = live.get(check);
    const monitor = stored.get(check) ?? null;
    const label = isOpsCheckName(check) ? OPS_CHECKS[check].label : check;
    let text: string;
    if (now) text = now.status === 'ok' ? '' : problemText(check, now.count);
    else if ((OPS_EXTERNAL_CHECKS as readonly string[]).includes(check)) {
      text = monitor && monitor.status !== 'ok' ? `Checked by the monitor only: ${problemText(check, monitor.count)}` : 'Checked by the monitor only.';
    } else if (check.startsWith('cron.') && view.jobs === null) text = 'pg_cron is off, so there are no job runs to check.';
    else text = 'Not checked on this database.';
    return { check, label, live: now?.status ?? null, text, monitor };
  });
}

/** What needs attention now: live problems, plus the monitor's last word on checks only it makes. */
export function problemCounts(view: OpsAdminView): { fail: number; warn: number } {
  const counts = { fail: 0, warn: 0 };
  for (const row of checkRows(view)) {
    const status = row.live ?? ((OPS_EXTERNAL_CHECKS as readonly string[]).includes(row.check) ? row.monitor?.status ?? null : null);
    if (status === 'fail' || status === 'warn') counts[status] += 1;
  }
  return counts;
}

export function jobStateLabel(job: OpsJobState): string {
  return !job.present ? 'Missing' : !job.active ? 'Inactive' : 'Active';
}

// App crashes (T51d): the mobile app's anonymous crash reports, grouped by the database.
export const CRASH_KIND_LABEL: Record<CrashKind, string> = { fatal: 'App crash', render: 'Screen failed', error: 'Error' };
const VARIANT_ORDER = ['production', 'preview', 'development'] as const;

/** "2 production · 1 development": which builds the group's reports came from, live builds first. */
export function crashVariants(group: Pick<CrashGroup, 'production' | 'preview' | 'development'>): string {
  return VARIANT_ORDER.filter((variant) => group[variant] > 0).map((variant) => `${group[variant]} ${variant}`).join(' · ');
}

/** Only fatal and render reports from preview and production builds raise app.crashes; the rest are listed, not alerted. */
export function crashAlerts(group: Pick<CrashGroup, 'kind' | 'production' | 'preview'>): boolean {
  return group.kind !== 'error' && group.production + group.preview > 0;
}
