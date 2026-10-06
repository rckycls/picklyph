// Actual production Next server + local Supabase/Mailpit. Never reads mobile env.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { execFileSync, spawn } = require('node:child_process');
const { randomUUID } = require('node:crypto');
const { setTimeout: delay } = require('node:timers/promises');
const { createClient } = require('@supabase/supabase-js');
const { Buffer } = require('node:buffer');

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
  const runDocker = (args, input) => execFileSync(docker, args, { input, encoding: 'utf8', timeout: 30000, stdio: ['pipe', 'pipe', 'pipe'] });
  const context = runDocker(['context', 'show']).trim();
  const host = process.env.DOCKER_HOST || runDocker(['context', 'inspect', context, '--format', '{{.Endpoints.docker.Host}}']).trim();
  assert.ok(host.startsWith('npipe://') || host.startsWith('unix://'), 'Expected a local Docker engine.');
  assert.equal(runDocker(['inspect', 'supabase_db_picklyph', '--format', '{{index .Config.Labels "com.supabase.cli.project"}}']).trim(), 'picklyph');
  const sql = (input) => runDocker(['exec', '-i', 'supabase_db_picklyph', 'psql', '-U', 'postgres', '-d', 'postgres', '-X', '-q', '-v', 'ON_ERROR_STOP=1'], input);
  const boundedFetch = (url, init = {}) => fetch(url, { ...init, signal: AbortSignal.timeout(15000) });
  const service = createClient(api.href, settings.SERVICE_ROLE_KEY, { auth: { persistSession: false, autoRefreshToken: false }, global: { fetch: boundedFetch } });
  const fixtures = [];
  const messageIds = new Set();
  const origin = 'http://127.0.0.1:3100';
  let child;
  let stage = 'startup';
  let cleanupFailed = false;

  const request = async (route, jar = new Map(), body, overrideHeaders = {}) => {
    const response = await boundedFetch(new URL(route, origin), {
      method: body === undefined ? 'GET' : 'POST', redirect: 'manual',
      headers: { Cookie: [...jar].map(([key, value]) => `${key}=${value}`).join('; '),
        ...(body === undefined ? {} : { 'Content-Type': 'application/json', Origin: origin }), ...overrideHeaders },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    for (const cookie of response.headers.getSetCookie()) {
      const pair = cookie.split(';')[0];
      const separator = pair.indexOf('=');
      const name = pair.slice(0, separator);
      const value = pair.slice(separator + 1);
      if (!value || /Max-Age=0/i.test(cookie)) jar.delete(name); else jar.set(name, value);
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

  try {
    // Refuse to attach to/terminate an existing server on the fixed test port.
    const net = require('node:net');
    const reservation = net.createServer();
    await new Promise((resolve, reject) => { reservation.once('error', reject); reservation.listen(3100, '127.0.0.1', resolve); });
    await new Promise((resolve) => reservation.close(resolve));
    assert.ok(fs.existsSync(path.join(root, 'apps/admin/.next/BUILD_ID')), 'Build the admin before integration tests.');
    child = spawn(process.execPath, [require.resolve('next/dist/bin/next'), 'start', '--hostname', '127.0.0.1', '--port', '3100'], {
      cwd: path.join(root, 'apps/admin'), windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'],
      env: { ...process.env, NODE_ENV: 'production', NEXT_TELEMETRY_DISABLED: '1', ADMIN_ORIGIN: origin, ADMIN_SUPABASE_URL: api.origin, ADMIN_SUPABASE_PUBLISHABLE_KEY: settings.ANON_KEY },
    });
    // Drain output but never dump runtime logs/SDK objects containing credentials.
    child.stdout.on('data', () => {}); child.stderr.on('data', () => {});
    let started = false;
    for (let attempt = 0; attempt < 60; attempt++) {
      if (child.exitCode !== null) break;
      try { if ((await request('/login')).status === 200) { started = true; break; } } catch {}
      await delay(250);
    }
    assert.ok(started, 'Production admin must start.');
    stage = 'guest and input checks';
    const login = await request('/login');
    const loginHtml = await login.text();
    assert.ok(loginHtml.includes('Send verification code') && !loginHtml.includes(settings.ANON_KEY) && !loginHtml.includes(settings.SERVICE_ROLE_KEY), 'Login renders without exposing configured keys.');
    assert.ok(login.headers.get('cache-control')?.includes('no-store'), 'Login is not publicly cached.');
    const guestPage = await request('/console');
    assert.ok([307, 303].includes(guestPage.status) && guestPage.headers.get('location') === '/login', 'Guest console redirects to sign-in.');
    assert.equal((await request('/api/console/check-access', new Map(), {})).status, 401, 'Guest operation denied.');
    assert.equal((await request('/api/auth/request', new Map(), { email: 'bad' })).status, 400, 'Invalid email denied.');
    assert.equal((await request('/api/auth/request', new Map(), { email: 'nobody@example.invalid' }, { Origin: 'https://attacker.invalid' })).status, 403, 'Cross-site request denied.');

    for (const role of ['player', 'admin', 'moderator']) {
      stage = `${role} account and email sign-in`;
      const email = `console-${role}-${randomUUID()}@example.invalid`;
      const created = await service.auth.admin.createUser({ email, email_confirm: true, user_metadata: { role: 'admin' } });
      assert.ok(!created.error && created.data.user?.id, 'Own local fixture signup must succeed.');
      const id = created.data.user.id;
      fixtures.push(id);
      assert.ok(/^[a-f0-9-]{36}$/.test(id), 'Generated fixture ID must be a UUID.');
      if (role !== 'player') sql(`insert into private.account_roles(user_id,role) values ('${id}'::uuid,'${role}');`);
      const jar = new Map();
      const requested = await request('/api/auth/request', jar, { email });
      assert.equal(requested.status, 200, 'Local code request must succeed.');
      const code = await readCode(email);
      const wrong = await request('/api/auth/verify', jar, { email, code: code === '000000' ? '111111' : '000000' });
      assert.equal(wrong.status, 400, 'Wrong code must not create a session.');
      assert.equal((await request('/api/console/check-access', jar, {})).status, 401, 'Wrong code cannot access operation.');
      const verified = await request('/api/auth/verify', jar, { email, code });
      assert.equal(verified.status, 200, 'Email verification succeeds through production route.');
      const responseText = await verified.text();
      assert.ok(!responseText.includes('access_token') && !responseText.includes('refresh_token'), 'Browser response contains no tokens.');
      assert.ok(verified.headers.getSetCookie().some((item) => /HttpOnly/i.test(item) && /SameSite=lax/i.test(item) && /Secure/i.test(item)), 'Production session cookies are HttpOnly/SameSite/Secure.');
      const usedCode = new Map();
      assert.equal((await request('/api/auth/verify', usedCode, { email, code })).status, 400, 'Consumed code cannot be reused.');
      assert.equal((await request('/api/console/check-access', usedCode, {})).status, 401, 'Consumed code cannot create another session.');

      const tokenCookies = [...jar.keys()].filter((name) => /-auth-token(?:\.\d+)?$/.test(name)).sort();
      assert.ok(tokenCookies.length > 0, 'Session cookie is present.');
      const storageKey = tokenCookies[0].replace(/\.\d+$/, '');
      const encoded = tokenCookies.map((name) => jar.get(name)).join('');
      assert.ok(encoded.startsWith('base64-'), 'Expected SSR encoded session cookie.');
      const session = JSON.parse(Buffer.from(encoded.slice(7), 'base64url').toString('utf8'));
      const replaceSession = (target, value) => {
        for (const name of tokenCookies) target.delete(name);
        target.set(storageKey, `base64-${Buffer.from(JSON.stringify(value)).toString('base64url')}`);
      };
      const forged = new Map(jar);
      replaceSession(forged, { ...session, access_token: 'eyJhbGciOiJub25lIn0.eyJzdWIiOiJmb3JnZWQifQ.', refresh_token: 'invalid-fixture-refresh', expires_at: Math.floor(Date.now() / 1000) + 3600 });
      assert.equal((await request('/api/console/check-access', forged, {})).status, 401, 'Forged JWT/cookie cannot authenticate.');
      // A genuinely expired storage timestamp forces refresh with the real fixture refresh token.
      replaceSession(jar, { ...session, expires_at: 1 });
      const refreshCheck = await request('/api/console/check-access', jar, {});
      assert.equal(refreshCheck.status, role === 'player' ? 403 : 200, 'Real expired session refresh preserves identity and role.');
      assert.ok(refreshCheck.headers.getSetCookie().some((item) => /-auth-token/.test(item)), 'Proxy propagates refreshed cookies to the response.');
      assert.ok(refreshCheck.headers.get('cache-control')?.includes('no-store') && refreshCheck.headers.get('pragma') === 'no-cache' && refreshCheck.headers.get('expires') === '0', 'Cookie refresh carries complete no-cache headers.');

      stage = `${role} page/operation checks`;
      const consolePage = await request('/console', jar);
      const html = await consolePage.text();
      const operation = await request('/api/console/check-access', jar, { actor_user_id: fixtures[0], roles: ['admin'] });
      if (role === 'player') {
        assert.ok(html.includes('Access required.') && !html.includes('Your workspace is ready.'), 'Player cannot render protected workspace.');
        assert.equal(operation.status, 403, 'Metadata and forged body cannot elevate a player.');
      } else {
        assert.ok(html.includes('Your workspace is ready.'), 'Assigned role can render console.');
        assert.equal(operation.status, 200, 'Assigned role can call guarded operation.');
        const payload = await operation.json();
        assert.ok(payload.actorId === id && payload.roles.includes(role), 'Actor/roles derive from verified user and DB, ignoring request body.');
        // Cold browser jar restores the session on subsequent independent HTTP requests.
        assert.equal((await request('/api/console/check-access', new Map(jar), {})).status, 200, 'Cookies restore the same role on a fresh request.');
        sql(`delete from private.account_roles where user_id='${id}'::uuid;`);
        assert.equal((await request('/api/console/check-access', jar, {})).status, 403, 'Role revocation takes effect without refresh.');
        assert.ok((await (await request('/console', jar)).text()).includes('Access required.'), 'Revoked user cannot render workspace.');
      }
      stage = `${role} sign-out`;
      assert.equal((await request('/api/auth/signout', jar, {})).status, 200, 'Sign-out route succeeds.');
      assert.equal((await request('/api/console/check-access', new Map(jar), {})).status, 401, 'Sign-out survives fresh request.');
      console.log(`PASS: ${role} real email code, forged-cookie denial, refresh/restore, protected page/API, role/actor trust and sign-out.`);
    }
    console.log('PASS: production guest denial, CSRF/input checks, private responses and HttpOnly/Secure cookie headers.');
  } catch {
    // Only our fixed stage label; no assertion values, emails, OTPs, SDK/CLI errors or tokens.
    throw new Error(`Local admin verification failed at: ${stage}.`);
  } finally {
    if (child && child.exitCode === null) {
      child.kill();
      await new Promise((resolve) => { child.once('exit', resolve); setTimeout(resolve, 3000); });
    }
    for (const id of fixtures) {
      try { if ((await service.auth.admin.deleteUser(id)).error) cleanupFailed = true; } catch { cleanupFailed = true; }
    }
    if (messageIds.size) {
      try {
        const removed = await boundedFetch(new URL('/api/v1/messages', inbox), { method: 'DELETE', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ IDs: [...messageIds] }) });
        if (!removed.ok) cleanupFailed = true;
      } catch { cleanupFailed = true; }
    }
    await service.auth.dispose();
    if (cleanupFailed) throw new Error('Own local admin fixtures could not be fully cleaned up.');
  }
  console.log('PASS: own local accounts/mail removed and test server stopped; no hosted changes.');
}
main().catch((error) => { console.error(error.message?.startsWith('Local admin verification failed at:') ? error.message : 'Local admin test setup/cleanup failed. Check build and local Supabase.'); process.exitCode = 1; });
