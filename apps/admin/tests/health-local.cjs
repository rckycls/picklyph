// T51c: actual production Next server + local Supabase/Mailpit. The System health page for administrators only,
// live checks, an induced failure and an Edge signal, a monitor run and what it posted, a stopped monitor.
// Never reads mobile env or hosted data; restores the monitor's alert state and signals exactly and removes its accounts.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const net = require('node:net');
const path = require('node:path');
const { execFileSync, spawn } = require('node:child_process');
const { randomUUID } = require('node:crypto');
const { setTimeout: delay } = require('node:timers/promises');
const { createClient } = require('@supabase/supabase-js');

async function main() {
  const root = path.resolve(path.dirname(module.filename), '../../..');
  const cli = path.join(root, 'node_modules/@supabase/cli-windows-x64/bin/supabase.exe');
  const settings = JSON.parse(execFileSync(cli, ['status', '-o', 'json'], { cwd: root, timeout: 20000, stdio: ['ignore', 'pipe', 'pipe'] }));
  const api = new URL(settings.API_URL);
  const inbox = new URL(settings.INBUCKET_URL ?? settings.MAILPIT_URL);
  assert.ok(api.protocol === 'http:' && ['127.0.0.1', 'localhost'].includes(api.hostname) && api.port === '54321', 'Expected the local API only.');
  assert.ok(inbox.protocol === 'http:' && ['127.0.0.1', 'localhost'].includes(inbox.hostname) && inbox.port === '54324', 'Expected local Mailpit only.');
  const desktopDocker = process.env.LOCALAPPDATA ? path.join(process.env.LOCALAPPDATA, 'Programs/DockerDesktop/resources/bin/docker.exe') : '';
  const docker = desktopDocker && fs.existsSync(desktopDocker) ? desktopDocker : 'docker';
  const runDocker = (args, input) => execFileSync(docker, args, { input, encoding: 'utf8', timeout: 60000, stdio: ['pipe', 'pipe', 'pipe'] });
  const context = runDocker(['context', 'show']).trim();
  const host = process.env.DOCKER_HOST || runDocker(['context', 'inspect', context, '--format', '{{.Endpoints.docker.Host}}']).trim();
  assert.ok(host.startsWith('npipe://') || host.startsWith('unix://'), 'Expected a local Docker engine.');
  assert.equal(runDocker(['inspect', 'supabase_db_picklyph', '--format', '{{index .Config.Labels "com.supabase.cli.project"}}']).trim(), 'picklyph');
  const psql = ['exec', '-i', 'supabase_db_picklyph', 'psql', '-U', 'postgres', '-d', 'postgres', '-X', '-q', '-v', 'ON_ERROR_STOP=1'];
  const sql = (input) => runDocker(psql, input);
  const value = (input) => runDocker([...psql, '-t', '-A'], input).trim();
  const boundedFetch = (url, init = {}) => fetch(url, { ...init, signal: AbortSignal.timeout(60000) });
  const options = { auth: { persistSession: false, autoRefreshToken: false }, global: { fetch: boundedFetch } };
  const service = createClient(api.href, settings.SERVICE_ROLE_KEY, options);
  const origin = 'http://127.0.0.1:3100';
  const users = {};
  const messageIds = new Set();
  let child;
  let serverLog = '';
  let stage = 'startup';
  let cleanupFailed = false;
  let snapshot = null;
  const check = (result, message) => { assert.ok(!result.error, message); return result.data; };
  const literal = (rows) => `'${JSON.stringify(rows ?? []).replace(/'/g, "''")}'::jsonb`;

  const request = async (route, jar = new Map()) => {
    const response = await boundedFetch(new URL(route, origin), {
      redirect: 'manual', headers: { Cookie: [...jar].map(([key, item]) => `${key}=${item}`).join('; ') } });
    for (const cookie of response.headers.getSetCookie()) {
      const pair = cookie.split(';')[0];
      const separator = pair.indexOf('=');
      const name = pair.slice(0, separator);
      const item = pair.slice(separator + 1);
      if (!item || /Max-Age=0/i.test(cookie)) jar.delete(name); else jar.set(name, item);
    }
    return response;
  };
  const post = async (route, jar, body) => {
    const response = await boundedFetch(new URL(route, origin), { method: 'POST', redirect: 'manual',
      headers: { Cookie: [...jar].map(([key, item]) => `${key}=${item}`).join('; '), 'Content-Type': 'application/json', Origin: origin }, body: JSON.stringify(body) });
    for (const cookie of response.headers.getSetCookie()) {
      const pair = cookie.split(';')[0];
      const separator = pair.indexOf('=');
      if (!pair.slice(separator + 1) || /Max-Age=0/i.test(cookie)) jar.delete(pair.slice(0, separator)); else jar.set(pair.slice(0, separator), pair.slice(separator + 1));
    }
    return response;
  };
  const readCode = async (email) => {
    for (let attempt = 0; attempt < 30; attempt++) {
      const page = await (await boundedFetch(new URL('/api/v1/messages?limit=200', inbox))).json();
      const item = page.messages.find((message) => message.To.some((to) => to.Address === email));
      if (item) {
        messageIds.add(item.ID);
        const message = await (await boundedFetch(new URL(`/api/v1/message/${item.ID}`, inbox))).json();
        const code = message.HTML.match(/>\s*(\d{6})\s*</)?.[1];
        assert.ok(code, 'Local code template is required.');
        return code;
      }
      await delay(200);
    }
    throw new Error('Local verification email not received.');
  };
  const signIn = async (email) => {
    const jar = new Map();
    assert.equal((await post('/api/auth/request', jar, { email })).status, 200, 'Code request succeeds.');
    assert.equal((await post('/api/auth/verify', jar, { email, code: await readCode(email) })).status, 200, 'Email code sign-in succeeds.');
    return jar;
  };
  const page = async (jar, route = '/console/health') => {
    const response = await request(route, jar);
    assert.equal(response.status, 200, `${route} answers 200.`);
    return response.text();
  };
  const startServer = async () => {
    for (let attempt = 0; ; attempt++) {
      const reservation = net.createServer();
      try {
        await new Promise((resolve, reject) => { reservation.once('error', reject); reservation.listen(3100, '127.0.0.1', resolve); });
        await new Promise((resolve) => reservation.close(resolve));
        break;
      } catch (error) { if (attempt >= 20) throw error; await delay(250); }
    }
    child = spawn(process.execPath, [require.resolve('next/dist/bin/next'), 'start', '--hostname', '127.0.0.1', '--port', '3100'], {
      cwd: path.join(root, 'apps/admin'), windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'],
      env: { ...process.env, NODE_ENV: 'production', NEXT_TELEMETRY_DISABLED: '1', ADMIN_ORIGIN: origin, ADMIN_SUPABASE_URL: api.origin,
        ADMIN_SUPABASE_PUBLISHABLE_KEY: settings.ANON_KEY, ADMIN_SUPABASE_SECRET_KEY: settings.SERVICE_ROLE_KEY },
    });
    child.stdout.on('data', (chunk) => { serverLog += chunk; }); child.stderr.on('data', (chunk) => { serverLog += chunk; });
    for (let attempt = 0; attempt < 60; attempt++) {
      if (child.exitCode !== null) break;
      try { if ((await request('/login')).status === 200) return; } catch {}
      await delay(250);
    }
    throw new Error('Production admin must start.');
  };
  const stopServer = async () => {
    if (child && child.exitCode === null) {
      child.kill();
      await new Promise((resolve) => { child.once('exit', resolve); setTimeout(resolve, 3000); });
    }
  };

  try {
    const cron = value("select exists(select 1 from pg_extension where extname = 'pg_cron');") === 't';
    stage = 'SQL on Docker';
    if (!cron) {
      sql(fs.readFileSync(path.join(root, 'supabase/tests/ops-console.sql'), 'utf8'));
      sql(fs.readFileSync(path.join(root, 'supabase/tests/ops-monitoring.sql'), 'utf8'));
      console.log('PASS: Docker PostgreSQL T51c console-read suite (grants, admin recheck, live checks, stamps, jobs, windows, signals, no writes) and the T51a suite; rolled back.');
    } else console.log('SKIP: Docker ops SQL needs a database without pg_cron (they bring a stand-in); npm run test:ops covers both on PGlite.');

    stage = 'snapshot';
    snapshot = JSON.parse(value(`select jsonb_build_object('state', (select jsonb_agg(to_jsonb(s) order by check_name) from private.ops_alert_state s),
      'signals', (select jsonb_agg(to_jsonb(s) order by minute, source, kind) from private.ops_signals s));`));
    // Other harnesses' served functions leave signals behind; start quiet (both tables are restored at the end).
    sql('delete from private.ops_alert_state; delete from private.ops_signals;');

    stage = 'fixtures';
    for (const role of ['admin', 'moderator', 'player']) {
      const email = `t51c-${role}-${randomUUID()}@example.invalid`;
      const created = await service.auth.admin.createUser({ email, password: `Local-${randomUUID()}!`, email_confirm: true });
      assert.ok(!created.error && created.data.user?.id, 'Own local fixture user.');
      users[role] = { id: created.data.user.id, email };
    }
    sql(`insert into private.account_roles(user_id, role) values ('${users.admin.id}'::uuid, 'admin'), ('${users.moderator.id}'::uuid, 'moderator');`);

    stage = 'production server';
    assert.ok(fs.existsSync(path.join(root, 'apps/admin/.next/BUILD_ID')), 'Build the admin before integration tests.');
    await startServer();

    stage = 'guest denial';
    const guest = await request('/console/health');
    assert.ok([303, 307].includes(guest.status) && guest.headers.get('location') === '/login', 'Guest page redirects to sign-in.');

    stage = 'sign-in';
    const jars = { admin: await signIn(users.admin.email), moderator: await signIn(users.moderator.email), player: await signIn(users.player.email) };

    stage = 'moderator and player denial';
    for (const who of ['moderator', 'player']) {
      const html = await page(jars[who]);
      assert.ok(html.includes('Administrator access required.') && html.includes('System health is available to administrators.') && !html.includes('Hold sweep'), `${who}: no health page`);
    }
    const moderatorHome = await page(jars.moderator, '/console');
    assert.ok(!moderatorHome.includes('/console/health') && !moderatorHome.includes('Health problems'), 'Moderators have no System health entry or card.');
    console.log('PASS: guests are sent to sign-in; moderators and players get "Administrator access required." and no System health entry or card.');

    stage = 'fresh database';
    let html = await page(jars.admin);
    for (const shown of ['System health', 'No monitor run is recorded on this database', 'Scheduled jobs', 'Hold sweep', 'Inventory', 'Redis isolation',
      'Arrival-only pilot', 'Checked by the monitor only.', 'Never checked by the monitor', 'No Edge function reported a server error']) {
      assert.ok(html.includes(shown), `The fresh page shows ${shown}.`);
    }
    assert.ok(html.includes(cron ? 'Hold expiry sweep' : 'pg_cron is off on this database'), 'Jobs section matches pg_cron.');
    let home = await page(jars.admin, '/console');
    assert.ok(home.includes('href="/console/health"') && home.includes('Health problems') && home.includes('Monitor never ran'), 'Admin Overview card and sidebar entry.');
    console.log(`PASS: fresh database: every check listed live, "no monitor run" warning, ${cron ? 'jobs table' : 'pg_cron off'}, no signals; Overview card "Monitor never ran".`);

    stage = 'induced failure and signal';
    check(await service.rpc('ops_signal_record', { signal_source: 'venue-search', signal_kind: 'server_error', occurrences: 3 }), 'Edge signal.');
    // An account deletion started two hours ago whose Auth user still exists: privacy.deletions fails.
    sql(`insert into private.account_deletions(user_id, requested_at) values ('${users.player.id}'::uuid, clock_timestamp() - interval '2 hours');`);
    html = await page(jars.admin);
    for (const shown of ['3 server errors in the last 15 minutes', '1 deletion started over an hour ago, account still present', 'venue-search', 'Server errors']) {
      assert.ok(html.includes(shown), `The live page shows ${shown}.`);
    }
    assert.ok(html.includes('<code>venue-search</code></td><td>Server errors</td><td class="num">3</td><td class="num">3</td><td class="num">3</td>'), 'Signal counts for 15 minutes, an hour and a day.');
    console.log('PASS: live: a recorded Edge signal shows per function (3/3/3) with the edge.errors warning; an unfinished deletion fails privacy.deletions.');

    stage = 'monitor run';
    const run = check(await service.rpc('ops_monitor_run', { external_checks: [{ check: 'redis.reachable', status: 'ok', count: 0 }, { check: 'redis.isolation', status: 'ok', count: 0 }] }), 'Monitor run.');
    const due = run.alerts.filter((alert) => ['edge.errors', 'privacy.deletions'].includes(alert.check));
    assert.equal(due.length, 2, 'Both problems are due.');
    assert.equal(check(await service.rpc('ops_alerts_confirm', { alerts: due.map(({ check: name, status }) => ({ check: name, status })) }), 'Confirm.').confirmed, 2);
    html = await page(jars.admin);
    assert.ok(html.includes('The monitor last ran less than a minute ago') && !html.includes('No monitor run is recorded'), 'Fresh monitor run.');
    assert.ok(html.includes('Failing posted') && html.includes('Warning posted') && html.includes('Not posted yet'), 'Posted and unposted problems.');
    assert.equal(Number(value("select count(*) from private.ops_alert_state where checked_at is null;")), 0, 'The run stamped every check.');
    const stored = value("select string_agg(check_name || '=' || status || '/' || coalesce(notified_status, '-'), ',' order by check_name) from private.ops_alert_state;");
    await page(jars.admin);
    assert.equal(value("select string_agg(check_name || '=' || status || '/' || coalesce(notified_status, '-'), ',' order by check_name) from private.ops_alert_state;"), stored, 'Reading the page changes nothing.');
    console.log('PASS: a monitor run stamps every check; the page shows "ran less than a minute ago", what was posted and what is not posted yet; reading writes nothing.');

    stage = 'stopped monitor';
    sql("update private.ops_alert_state set checked_at = checked_at - interval '20 minutes';");
    html = await page(jars.admin);
    assert.ok(html.includes('The monitor last ran 20 minutes ago') && html.includes('so it has stopped'), 'Stopped monitor warning.');
    home = await page(jars.admin, '/console');
    assert.ok(home.includes('Monitor stopped; last ran 20 minutes ago'), 'Overview card says the monitor stopped.');
    console.log('PASS: a monitor silent for 20 minutes is called stopped on the page and the Overview card.');

    stage = 'privacy and bundle';
    for (const hidden of [users.player.id, users.player.email, users.moderator.email, settings.SERVICE_ROLE_KEY]) assert.ok(!html.includes(hidden), 'No IDs, other emails or keys on the page.');
    const staticDir = path.join(root, 'apps/admin/.next/static');
    const bundle = fs.readdirSync(staticDir, { recursive: true }).filter((file) => String(file).endsWith('.js'))
      .map((file) => fs.readFileSync(path.join(staticDir, String(file)), 'utf8')).join('\n');
    for (const name of ['ADMIN_SUPABASE_SECRET_KEY', 'ops_admin_read', 'readOpsAdminView']) assert.ok(!bundle.includes(name), `The client bundle never has ${name}.`);
    assert.ok(!serverLog.includes(users.player.email) && !serverLog.includes(settings.SERVICE_ROLE_KEY), 'Nothing sensitive in the server log.');

    stage = 'revocation';
    sql(`delete from private.account_roles where user_id = '${users.admin.id}'::uuid;`);
    assert.ok((await page(jars.admin)).includes('Administrator access required.'), 'A revoked admin loses the page at once.');
    console.log('PASS: no other account IDs, emails or keys on the page; no setting or RPC names in the client bundle; a revoked admin loses the page at once.');
  } catch (error) {
    // Fixed stage labels and our own assertion messages only: no emails, tokens or SDK errors.
    const detail = error?.code === 'ERR_ASSERTION' && error.generatedMessage === false ? ` (${error.message})` : '';
    throw new Error(`Local health verification failed at: ${stage}${detail}.`);
  } finally {
    await stopServer();
    const ids = Object.values(users).map((user) => user.id);
    if (ids.length) {
      const list = ids.map((id) => `'${id}'::uuid`).join(',');
      try { sql(`delete from private.account_deletions where user_id in (${list}); delete from private.account_roles where user_id in (${list});`); } catch { cleanupFailed = true; }
    }
    for (const id of ids) {
      try { if ((await service.auth.admin.deleteUser(id)).error) cleanupFailed = true; } catch { cleanupFailed = true; }
    }
    if (snapshot) {
      try {
        sql(`delete from private.ops_alert_state; insert into private.ops_alert_state select * from jsonb_populate_recordset(null::private.ops_alert_state, ${literal(snapshot.state)});
          delete from private.ops_signals; insert into private.ops_signals select * from jsonb_populate_recordset(null::private.ops_signals, ${literal(snapshot.signals)});`);
        const after = JSON.parse(value(`select jsonb_build_object('state', (select jsonb_agg(to_jsonb(s) order by check_name) from private.ops_alert_state s),
          'signals', (select jsonb_agg(to_jsonb(s) order by minute, source, kind) from private.ops_signals s));`));
        assert.deepEqual(after, snapshot);
      } catch { cleanupFailed = true; }
    }
    if (messageIds.size) {
      try {
        const removed = await boundedFetch(new URL('/api/v1/messages', inbox), { method: 'DELETE', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ IDs: [...messageIds] }) });
        if (!removed.ok) cleanupFailed = true;
      } catch { cleanupFailed = true; }
    }
    await service.auth.dispose?.();
    if (cleanupFailed) throw new Error('Own local health fixtures could not be fully cleaned up.');
  }
  console.log('PASS: own local accounts and mail removed; alert state and signals restored exactly; test server stopped; no hosted changes.');
}
main().catch((error) => {
  console.error(/^(Local health verification failed at:|Own local health fixtures)/.test(error.message ?? '') ? error.message : 'Local health test setup failed. Check the admin build and local Supabase.');
  process.exitCode = 1;
});
