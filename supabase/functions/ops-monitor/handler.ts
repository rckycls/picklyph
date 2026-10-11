import { OPS_ENVIRONMENTS, isOpsEnvironment, isOpsHeartbeatUrl, isOpsWebhookUrl, opsAlertMessage, type OpsAlert, type OpsCheck, type OpsRun } from '../../../packages/domain/src/ops.ts';

/** Each Redis call gets this long; the marker outlives a few missed runs. */
export const REDIS_BUDGET_MS = 3000;
export const REDIS_MARKER_SECONDS = 2 * 86400;
export const markerKey = (environment: string) => `pickly:${environment}:ops:environment`;

export type RedisProbe = {
  ping: () => Promise<unknown>;
  mark: (key: string, value: string, seconds: number) => Promise<unknown>;
  exists: (keys: string[]) => Promise<number>;
};
type Dependencies = {
  /** OPS_MONITOR_SECRET: at least 32 characters, also stored in Vault for the pg_cron caller. */
  secret: string | undefined;
  /** PICKLY_ENV, the same value the rate guard namespaces Redis keys with. */
  environment: string | undefined;
  /** OPS_ALERT_WEBHOOK_URL: the operators' Discord channel webhook. */
  webhook: string | undefined;
  /** OPS_HEARTBEAT_URL (optional): pinged after a completed run, so an outside service notices when runs stop. */
  heartbeat?: string;
  /** Null when the Upstash settings are missing or invalid. */
  redis: RedisProbe | null;
  run: (external: OpsCheck[]) => Promise<OpsRun>;
  confirm: (alerts: OpsAlert[]) => Promise<number>;
  /** Never throws; true only when the channel accepted the message. */
  post: (url: string, content: string) => Promise<boolean>;
  /** Never throws. */
  ping: (url: string) => Promise<void>;
};

async function sameSecret(presented: string, expected: string): Promise<boolean> {
  const digest = async (value: string) => new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value)));
  const [a, b] = await Promise.all([digest(presented), digest(expected)]);
  let difference = 0;
  for (let i = 0; i < a.length; i++) difference |= a[i]! ^ b[i]!;
  return difference === 0;
}

async function within<T>(task: Promise<T>, ms: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([task, new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error('Redis deadline')), ms); })]);
  } finally { if (timer !== undefined) clearTimeout(timer); }
}

/**
 * Reachability with this environment's settings, then isolation: each environment's monitor leaves a
 * marker under its own namespace, so another environment's marker in the same database means two
 * environments share it (H02 requires separate databases). Isolation is left out when Redis is down.
 */
export async function redisChecks(redis: RedisProbe | null, environment: string | undefined, budgetMs = REDIS_BUDGET_MS): Promise<OpsCheck[]> {
  const unreachable: OpsCheck[] = [{ check: 'redis.reachable', status: 'fail', count: 1 }];
  if (!redis || !isOpsEnvironment(environment)) return unreachable;
  try {
    await within(redis.ping(), budgetMs);
    await within(redis.mark(markerKey(environment), environment, REDIS_MARKER_SECONDS), budgetMs);
    const others = await within(redis.exists(OPS_ENVIRONMENTS.filter((name) => name !== environment).map(markerKey)), budgetMs);
    if (!Number.isSafeInteger(others) || others < 0 || others > OPS_ENVIRONMENTS.length) return unreachable;
    return [{ check: 'redis.reachable', status: 'ok', count: 0 }, { check: 'redis.isolation', status: others > 0 ? 'fail' : 'ok', count: others }];
  } catch { return unreachable; }
}

/**
 * POST /functions/v1/ops-monitor (T51a): called every five minutes by pg_cron through pg_net. Only the
 * OPS_MONITOR_SECRET bearer is accepted. One run: Redis checks → ops_monitor_run → one Discord message
 * for the alerts due → ops_alerts_confirm once Discord accepted it → heartbeat. A failed post is not
 * confirmed, so the next run posts it again.
 */
export function createOpsMonitorHandler(deps: Dependencies) {
  return async (request: Request): Promise<Response> => {
    const respond = (status: number, body: unknown, headers: Record<string, string> = {}) => new Response(JSON.stringify(body), {
      status, headers: { 'Cache-Control': 'private, no-store', 'Content-Type': 'application/json', ...headers },
    });
    if (request.method !== 'POST') return respond(405, { error: 'method_not_allowed' }, { Allow: 'POST' });
    if (!deps.secret || deps.secret.length < 32) return respond(503, { error: 'not_configured' });
    const presented = /^Bearer ([^\s]{1,512})$/i.exec(request.headers.get('authorization') ?? '')?.[1];
    if (!presented || !(await sameSecret(presented, deps.secret))) return respond(401, { error: 'unauthorized' });
    if (!isOpsWebhookUrl(deps.webhook, deps.environment) || (deps.heartbeat !== undefined && !isOpsHeartbeatUrl(deps.heartbeat, deps.environment))) {
      return respond(503, { error: 'not_configured' });
    }
    // The body carries nothing; the database decides what is due.
    await request.body?.cancel().catch(() => {});
    let run: OpsRun;
    try { run = await deps.run(await redisChecks(deps.redis, deps.environment)); }
    catch { return respond(503, { error: 'temporarily_unavailable' }, { 'Retry-After': '60' }); }
    const summary = { checks: run.checks.map(({ check, status, count }) => ({ check, status, count })), alerts: run.alerts.length };
    if (run.alerts.length > 0) {
      if (!(await deps.post(deps.webhook, opsAlertMessage(deps.environment, run.alerts)))) return respond(502, { error: 'delivery_failed', ...summary });
      try { await deps.confirm(run.alerts); }
      catch { return respond(503, { error: 'temporarily_unavailable', ...summary }, { 'Retry-After': '60' }); }
    }
    if (deps.heartbeat) await deps.ping(deps.heartbeat);
    return respond(200, summary);
  };
}
