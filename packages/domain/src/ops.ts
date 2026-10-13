/**
 * T51a: backend health checks and operator alerts. Checks have fixed names and carry counts only, never
 * IDs, names, emails or secret values, because alerts leave the system (a Discord channel). See
 * docs/monitoring.md.
 */
export const OPS_SIGNAL_SOURCES = ['venue-search', 'owner-submissions', 'owner-venues', 'owner-schedules', 'rental-bookings',
  'owner-sessions', 'session-bookings', 'venue-reports', 'account-deletion', 'push-devices', 'push-dispatch', 'storage-sweep', 'crash-reports'] as const;
export type OpsSignalSource = typeof OPS_SIGNAL_SOURCES[number];
/** 5xx other than 503; 503 (outage policy or dependency down); rate limiter answered "degraded" (Redis unavailable). */
export const OPS_SIGNAL_KINDS = ['server_error', 'unavailable', 'limiter_degraded'] as const;
export type OpsSignalKind = typeof OPS_SIGNAL_KINDS[number];
export const OPS_STATUSES = ['ok', 'warn', 'fail'] as const;
export type OpsStatus = typeof OPS_STATUSES[number];
export const OPS_ENVIRONMENTS = ['local', 'staging', 'production'] as const;
export type OpsEnvironment = typeof OPS_ENVIRONMENTS[number];
/** Discord rejects longer message content. */
export const OPS_MESSAGE_LIMIT = 2000;

const count = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;

/** Every check the monitor reports, in report order, with the operator's wording for a problem. */
export const OPS_CHECKS = {
  'cron.jobs': { label: 'Scheduled jobs', problem: (n: number) => `${count(n, 'expected pg_cron job is', 'expected pg_cron jobs are')} missing or inactive` },
  'cron.failures': { label: 'Scheduled job runs', problem: (n: number) => `${count(n, 'failed run', 'failed runs')} in the last 15 minutes` },
  'cron.stalled': { label: 'Every-minute jobs', problem: (n: number) => `${count(n, 'job has', 'jobs have')} not succeeded in 10 minutes` },
  'holds.overdue': { label: 'Hold sweep', problem: (n: number) => `${count(n, 'elapsed hold is', 'elapsed holds are')} still pending after 10 minutes` },
  'inventory.mismatch': { label: 'Inventory', problem: (n: number) => `${count(n, 'booking or session disagrees', 'bookings or sessions disagree')} with their court or spot inventory` },
  'push.backlog': { label: 'Push outbox', problem: (n: number) => `${count(n, 'notification has', 'notifications have')} waited over 10 minutes for the worker` },
  'push.failures': { label: 'Push delivery', problem: (n: number) => `${count(n, 'notification or receipt', 'notifications or receipts')} failed recently` },
  'push.credentials': { label: 'Push credentials', problem: (n: number) => `${count(n, 'notification was', 'notifications were')} refused for credentials (APNs key or Expo access token)` },
  'edge.errors': { label: 'Edge functions', problem: (n: number) => `${count(n, 'server error', 'server errors')} in the last 15 minutes` },
  'edge.unavailable': { label: 'Edge availability', problem: (n: number) => `${count(n, '503 answer', '503 answers')} in the last 15 minutes` },
  'edge.limiter': { label: 'Rate limiter', problem: (n: number) => `Redis unavailable to functions (${count(n, 'request', 'requests')}): new holds refused, discovery unthrottled` },
  'redis.reachable': { label: 'Redis', problem: () => 'not reachable or not configured from the monitor' },
  'redis.isolation': { label: 'Redis isolation', problem: (n: number) => `this database is also used by ${count(n, 'other environment', 'other environments')}` },
  'privacy.deletions': { label: 'Account deletions', problem: (n: number) => `${count(n, 'deletion started', 'deletions started')} over an hour ago, account still present` },
  'storage.backlog': { label: 'Storage cleanup', problem: (n: number) => `${count(n, 'file is', 'files are')} over a day past their removal date (storage-sweep)` },
  'app.crashes': { label: 'App crashes', problem: (n: number) => `${count(n, 'crash or failed screen', 'crashes or failed screens')} in preview/production builds in the last hour (console: System health)` },
  'rollout.arrival_only': { label: 'Arrival-only pilot', problem: (n: number) => `${count(n, 'venue setting or booking offers', 'venue settings or bookings offer')} online payment` },
} as const;
export type OpsCheckName = keyof typeof OPS_CHECKS;
export const OPS_CHECK_NAMES = Object.keys(OPS_CHECKS) as OpsCheckName[];
/** Only the ops-monitor function can make these; it sends them to ops_monitor_run. */
export const OPS_EXTERNAL_CHECKS = ['redis.reachable', 'redis.isolation'] as const satisfies readonly OpsCheckName[];

export type OpsCheck = { check: OpsCheckName; status: OpsStatus; count: number };
export type OpsAlert = { check: OpsCheckName; status: OpsStatus; previous: OpsStatus; count: number; since: string };
export type OpsRun = { at: string; checks: OpsCheck[]; alerts: OpsAlert[] };

const isStatus = (value: unknown): value is OpsStatus => typeof value === 'string' && (OPS_STATUSES as readonly string[]).includes(value);
export const isOpsCheckName = (value: unknown): value is OpsCheckName => typeof value === 'string' && Object.hasOwn(OPS_CHECKS, value);
export const isOpsEnvironment = (value: unknown): value is OpsEnvironment => typeof value === 'string' && (OPS_ENVIRONMENTS as readonly string[]).includes(value);
const isCount = (value: unknown): value is number => Number.isSafeInteger(value) && (value as number) >= 0 && (value as number) <= 1_000_000;
// PostgreSQL timestamps carry microseconds; JavaScript keeps milliseconds.
const TIMESTAMP = /^(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2})(?:\.(\d{1,6}))?(Z|[+-]\d{2}:\d{2})$/;
function readInstant(value: unknown): string {
  const match = typeof value === 'string' ? TIMESTAMP.exec(value) : null;
  const iso = match ? `${match[1]}.${(match[2] ?? '').padEnd(3, '0').slice(0, 3)}${match[3]}` : '';
  if (!match || Number.isNaN(Date.parse(iso))) throw new Error('Unexpected monitor run.');
  return new Date(iso).toISOString();
}
const object = (raw: unknown) => {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) throw new Error('Unexpected monitor run.');
  return raw as Record<string, unknown>;
};

/** Strict `ops_monitor_run` reply. */
export function readOpsRun(raw: unknown): OpsRun {
  const run = object(raw);
  if (!Array.isArray(run.checks) || run.checks.length > 50 || !Array.isArray(run.alerts) || run.alerts.length > 50) throw new Error('Unexpected monitor run.');
  return {
    at: readInstant(run.at),
    checks: run.checks.map((value) => {
      const item = object(value);
      if (!isOpsCheckName(item.check) || !isStatus(item.status) || !isCount(item.count)) throw new Error('Unexpected monitor run.');
      return { check: item.check, status: item.status, count: item.count };
    }),
    alerts: run.alerts.map((value) => {
      const item = object(value);
      if (!isOpsCheckName(item.check) || !isStatus(item.status) || !isStatus(item.previous) || !isCount(item.count)) throw new Error('Unexpected monitor run.');
      return { check: item.check, status: item.status, previous: item.previous, count: item.count, since: readInstant(item.since) };
    }),
  };
}

/** The scheduled jobs `cron.jobs` expects and the console lists, in order (T51c `ops_admin_read`). */
export const OPS_JOBS = ['booking-expiry-sweep', 'push-dispatch', 'privacy-retention-sweep', 'ops-monitor', 'storage-sweep'] as const;
export type OpsJobName = typeof OPS_JOBS[number];
/** pg_cron's `job_run_details.status` values. */
export const OPS_JOB_RUN_STATUSES = ['starting', 'running', 'sending', 'connecting', 'succeeded', 'failed'] as const;
export type OpsJobRunStatus = typeof OPS_JOB_RUN_STATUSES[number];

/**
 * The console's System health view (T51c). Check names and signal sources are kept as strings, because the database
 * can gain a check or a function before the console is redeployed; known names get their wording from OPS_CHECKS.
 */
export type OpsViewCheck = { check: string; status: OpsStatus; count: number };
export type OpsCheckState = OpsViewCheck & { since: string; checked_at: string | null; notified_status: OpsStatus | null; notified_at: string | null };
export type OpsJobState = {
  job: OpsJobName; present: boolean; active: boolean; schedule: string | null;
  last_run_at: string | null; last_status: OpsJobRunStatus | null; last_success_at: string | null;
  failures: number; last_failure_at: string | null; last_failure: string | null;
};
export type OpsSignalSummary = { source: string; kind: OpsSignalKind; last_15m: number; last_hour: number; last_day: number; last_at: string };
/** `jobs` is null when pg_cron is off. `monitor_ran_at` is null until a monitor run stamps its checks. */
export type OpsAdminView = { at: string; checks: OpsViewCheck[]; state: OpsCheckState[]; monitor_ran_at: string | null; jobs: OpsJobState[] | null; signals: OpsSignalSummary[] };

const CHECK_NAME = /^[a-z]+\.[a-z_]+$/;
const SOURCE_NAME = /^[a-z][a-z-]{0,39}$/;
const viewError = () => new Error('Unexpected health view.');
function viewInstant(value: unknown): string {
  try { return readInstant(value); } catch { throw viewError(); }
}
const viewNullableInstant = (value: unknown) => value === null ? null : viewInstant(value);
const viewObject = (raw: unknown) => { try { return object(raw); } catch { throw viewError(); } };
const viewCount = (value: unknown) => { if (!isCount(value)) throw viewError(); return value; };
const viewStatus = (value: unknown) => { if (!isStatus(value)) throw viewError(); return value; };
const viewText = (value: unknown, max: number) => {
  if (value === null) return null;
  if (typeof value !== 'string' || [...value].length > max) throw viewError();
  return value;
};
const viewList = (value: unknown, max: number) => { if (!Array.isArray(value) || value.length > max) throw viewError(); return value; };
const viewCheck = (value: unknown): OpsViewCheck => {
  const item = viewObject(value);
  if (typeof item.check !== 'string' || !CHECK_NAME.test(item.check)) throw viewError();
  return { check: item.check, status: viewStatus(item.status), count: viewCount(item.count) };
};

/** Strict `ops_admin_read` reply. Timestamps come back as ISO strings in milliseconds. */
export function readOpsAdminView(raw: unknown): OpsAdminView {
  const view = viewObject(raw);
  const jobs = view.jobs === null ? null : viewList(view.jobs, OPS_JOBS.length).map((value, index): OpsJobState => {
    const item = viewObject(value);
    if (item.job !== OPS_JOBS[index] || typeof item.present !== 'boolean' || typeof item.active !== 'boolean'
      || !Number.isSafeInteger(item.failures) || (item.failures as number) < 0) throw viewError();
    if (item.last_status !== null && !(OPS_JOB_RUN_STATUSES as readonly unknown[]).includes(item.last_status)) throw viewError();
    return { job: item.job as OpsJobName, present: item.present, active: item.active, schedule: viewText(item.schedule, 100),
      last_run_at: viewNullableInstant(item.last_run_at), last_status: item.last_status as OpsJobRunStatus | null,
      last_success_at: viewNullableInstant(item.last_success_at), failures: item.failures as number,
      last_failure_at: viewNullableInstant(item.last_failure_at), last_failure: viewText(item.last_failure, 300) };
  });
  if (jobs && jobs.length !== OPS_JOBS.length) throw viewError();
  return {
    at: viewInstant(view.at),
    checks: viewList(view.checks, 50).map(viewCheck),
    state: viewList(view.state, 50).map((value) => {
      const item = viewObject(value);
      return { ...viewCheck({ check: item.check, status: item.status, count: item.count }), since: viewInstant(item.since),
        checked_at: viewNullableInstant(item.checked_at), notified_status: item.notified_status === null ? null : viewStatus(item.notified_status),
        notified_at: viewNullableInstant(item.notified_at) };
    }),
    monitor_ran_at: viewNullableInstant(view.monitor_ran_at),
    jobs,
    signals: viewList(view.signals, 200).map((value) => {
      const item = viewObject(value);
      if (typeof item.source !== 'string' || !SOURCE_NAME.test(item.source) || !(OPS_SIGNAL_KINDS as readonly unknown[]).includes(item.kind)) throw viewError();
      return { source: item.source, kind: item.kind as OpsSignalKind, last_15m: viewCount(item.last_15m), last_hour: viewCount(item.last_hour),
        last_day: viewCount(item.last_day), last_at: viewInstant(item.last_at) };
    }),
  };
}

const manila = new Intl.DateTimeFormat('en-PH', { timeZone: 'Asia/Manila', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });
const MARK: Record<OpsStatus, string> = { fail: '🔴 FAIL', warn: '🟡 WARN', ok: '✅ RESOLVED' };
const STILL: Record<OpsStatus, string> = { fail: '🔴 STILL FAILING', warn: '🟡 STILL WARNING', ok: '' };
const RANK: Record<OpsStatus, number> = { fail: 0, warn: 1, ok: 2 };

/** One Discord message for one run: problems first, then recoveries. Fixed wording and counts only. */
export function opsAlertMessage(environment: string | undefined, alerts: OpsAlert[]): string {
  const name = isOpsEnvironment(environment) ? environment : 'unknown environment';
  const problems = alerts.filter((alert) => alert.status !== 'ok').length;
  const resolved = alerts.length - problems;
  const summary = [problems ? count(problems, 'problem', 'problems') : '', resolved ? `${resolved} resolved` : ''].filter(Boolean).join(', ');
  const lines = [...alerts].sort((a, b) => RANK[a.status] - RANK[b.status] || OPS_CHECK_NAMES.indexOf(a.check) - OPS_CHECK_NAMES.indexOf(b.check)).map((alert) => {
    const check = OPS_CHECKS[alert.check];
    if (alert.status === 'ok') return `${MARK.ok} · ${check.label}`;
    const state = alert.previous === alert.status ? `${STILL[alert.status]} since ${manila.format(new Date(alert.since))} (Manila)`
      : alert.previous === 'ok' ? MARK[alert.status] : `${MARK[alert.status]} (was ${alert.previous.toUpperCase()})`;
    return `${state} · ${check.label}: ${check.problem(alert.count)}`;
  });
  let message = `**PicklyPH ${name}** monitor: ${summary}`;
  for (const line of lines) {
    if (message.length + line.length + 1 > OPS_MESSAGE_LIMIT - 40) return `${message}\n…and more; see docs/monitoring.md`;
    message += `\n${line}`;
  }
  return message;
}

const DISCORD_WEBHOOK = /^https:\/\/(?:(?:ptb|canary)\.)?discord(?:app)?\.com\/api\/webhooks\/\d{5,30}\/[A-Za-z0-9_-]{20,200}$/;
const LOCAL_WEBHOOK = /^http:\/\/(?:127\.0\.0\.1|localhost|host\.docker\.internal):\d{2,5}\/api\/webhooks\/\d{1,30}\/[A-Za-z0-9_-]{1,200}$/;
/** OPS_ALERT_WEBHOOK_URL: a Discord channel webhook. A loopback fake is accepted only in the local environment. */
export function isOpsWebhookUrl(value: unknown, environment: string | undefined): value is string {
  return typeof value === 'string' && (DISCORD_WEBHOOK.test(value) || (environment === 'local' && LOCAL_WEBHOOK.test(value)));
}

/** OPS_HEARTBEAT_URL (optional): an https dead-man's-switch URL pinged after each completed run. */
export function isOpsHeartbeatUrl(value: unknown, environment: string | undefined): value is string {
  if (typeof value !== 'string' || value.length > 500) return false;
  try {
    const url = new URL(value);
    if (url.username || url.password || url.hash) return false;
    if (url.protocol === 'https:') return true;
    return environment === 'local' && url.protocol === 'http:' && ['127.0.0.1', 'localhost', 'host.docker.internal'].includes(url.hostname);
  } catch { return false; }
}
