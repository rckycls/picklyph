// T53 local harness: the production Next server (`next start` on a built apps/web) against local Docker Supabase,
// loopback stand-ins for Upstash REST and the email API, and Cloudflare's real siteverify with its published
// test keys. Never reads mobile or hosted env, never prints secrets or claim codes, and removes its own rows.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const http = require('node:http');
const net = require('node:net');
const path = require('node:path');
const crypto = require('node:crypto');
const { execFileSync, spawn } = require('node:child_process');
const { setTimeout: delay } = require('node:timers/promises');
const { scanWebBundle } = require('./bundle-scan.cjs');

const TURNSTILE_PASS = '1x0000000000000000000000000000000AA';
const TURNSTILE_FAIL = '2x0000000000000000000000000000000AA';
const DUMMY_TOKEN = 'XXXX.DUMMY.TOKEN.XXXX';
const PORT = 3300;
const origin = `http://127.0.0.1:${PORT}`;
const random = (bytes = 24) => crypto.randomBytes(bytes).toString('base64url');

async function main() {
  const root = path.resolve(__dirname, '../../..');
  const web = path.join(root, 'apps/web');
  const cli = path.join(root, 'node_modules/@supabase/cli-windows-x64/bin/supabase.exe');
  const settings = JSON.parse(execFileSync(cli, ['status', '-o', 'json'], { cwd: root, timeout: 60000, stdio: ['ignore', 'pipe', 'pipe'] }));
  const api = new URL(settings.API_URL);
  assert.ok(api.protocol === 'http:' && ['127.0.0.1', 'localhost'].includes(api.hostname) && api.port === '54321', 'Expected the local API only.');
  const desktopDocker = process.env.LOCALAPPDATA ? path.join(process.env.LOCALAPPDATA, 'Programs/DockerDesktop/resources/bin/docker.exe') : '';
  const docker = desktopDocker && fs.existsSync(desktopDocker) ? desktopDocker : 'docker';
  const runDocker = (args, input) => execFileSync(docker, args, { input, encoding: 'utf8', timeout: 60000, stdio: ['pipe', 'pipe', 'pipe'] });
  assert.equal(runDocker(['inspect', 'supabase_db_picklyph', '--format', '{{index .Config.Labels "com.supabase.cli.project"}}']).trim(), 'picklyph');
  const psql = (input) => runDocker(['exec', '-i', 'supabase_db_picklyph', 'psql', '-U', 'postgres', '-d', 'postgres', '-X', '-q', '-t', '-A', '-v', 'ON_ERROR_STOP=1'], input);
  const sqlJson = (query) => JSON.parse(psql(`select coalesce((${query})::text, 'null');`).trim());
  const boundedFetch = (url, init = {}) => fetch(url, { ...init, signal: AbortSignal.timeout(20000) });

  const suffix = crypto.randomBytes(4).toString('hex');
  const city = `T53 Harness ${suffix}`;
  const emailOf = (label) => `t53-${label}-${suffix}@example.test`;
  const secrets = { code: random(36), salt: random(36), upstashToken: random(), emailKey: `re_${random(12)}`, mapsServer: `AIzaHarnessServer${random(12)}` };
  const venueIds = new Set();
  let stage = 'startup';
  let child = null;
  let serverLog = '';

  // Loopback stand-in for Upstash REST /multi-exec: SET NX PX, INCR and PTTL, like the real transaction.
  const redis = { mode: 'ok', store: new Map(), calls: 0 };
  const upstash = http.createServer((req, res) => {
    let body = '';
    req.on('data', (chunk) => { body += chunk; });
    req.on('end', () => {
      redis.calls++;
      if (req.headers.authorization !== `Bearer ${secrets.upstashToken}` || req.url !== '/multi-exec' || redis.mode === 'fail') {
        res.writeHead(redis.mode === 'fail' ? 500 : 401, { 'Content-Type': 'application/json' }); res.end('{"error":"ERR unavailable"}'); return;
      }
      const now = Date.now();
      const results = JSON.parse(body).map(([command, key, ...args]) => {
        const entry = redis.store.get(key);
        const live = entry && entry.expires > now ? entry : null;
        if (command === 'SET') {
          if (live) return { result: null };
          redis.store.set(key, { value: Number(args[0]), expires: now + Number(args[2]) }); return { result: 'OK' };
        }
        if (command === 'INCR') { if (!live) return { error: 'ERR no key' }; live.value++; return { result: redis.mode === 'deny' ? 999 : live.value }; }
        if (command === 'PTTL') return { result: live ? live.expires - now : -2 };
        return { error: 'ERR unknown command' };
      });
      res.writeHead(200, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(results));
    });
  });
  // Loopback stand-in for the email provider's HTTP API (Resend's request shape). It records every attempt.
  const mail = { mode: 'ok', messages: [] };
  const mailer = http.createServer((req, res) => {
    let body = '';
    req.on('data', (chunk) => { body += chunk; });
    req.on('end', () => {
      const ok = req.headers.authorization === `Bearer ${secrets.emailKey}` && req.url === '/emails' && mail.mode === 'ok';
      mail.messages.push({ ...JSON.parse(body), idempotency: req.headers['idempotency-key'], delivered: ok });
      res.writeHead(ok ? 200 : 500, { 'Content-Type': 'application/json' }); res.end(ok ? '{"id":"fake"}' : '{"message":"unavailable"}');
    });
  });
  await new Promise((resolve) => upstash.listen(0, '127.0.0.1', resolve));
  await new Promise((resolve) => mailer.listen(0, '127.0.0.1', resolve));

  // The shell's own environment minus anything this page reads, so only the values below configure the server.
  const inherited = Object.fromEntries(Object.entries(process.env).filter(([name]) =>
    !/^(PICKLY_|PRELAUNCH_|UPSTASH_|RATE_LIMIT_|TURNSTILE_|GOOGLE_MAPS_|EMAIL_|VERCEL|NEXT_PUBLIC_|EXPO_)/.test(name)));
  const env = (turnstileSecret) => ({
    ...inherited, NODE_ENV: 'production', NEXT_TELEMETRY_DISABLED: '1',
    PICKLY_ENV: 'local', PRELAUNCH_ORIGIN: origin, PRELAUNCH_SUPABASE_URL: api.origin, PRELAUNCH_SUPABASE_SECRET_KEY: settings.SERVICE_ROLE_KEY,
    UPSTASH_REDIS_REST_URL: `http://127.0.0.1:${upstash.address().port}`, UPSTASH_REDIS_REST_TOKEN: secrets.upstashToken, RATE_LIMIT_KEY_SECRET: secrets.salt,
    TURNSTILE_SECRET_KEY: turnstileSecret, TURNSTILE_SITE_KEY: '1x00000000000000000000AA',
    GOOGLE_MAPS_BROWSER_API_KEY: 'AIzaHarnessBrowserKey', GOOGLE_MAPS_SERVER_API_KEY: secrets.mapsServer,
    PRELAUNCH_CODE_SECRET: secrets.code, EMAIL_API_KEY: secrets.emailKey, EMAIL_FROM: 'pickly <hello@pickly.example>',
    EMAIL_API_URL: `http://127.0.0.1:${mailer.address().port}/emails`, PRELAUNCH_CONTACT_EMAIL: 'hello@pickly.example',
  });
  const start = async (turnstileSecret) => {
    const reservation = net.createServer();
    await new Promise((resolve, reject) => { reservation.once('error', reject); reservation.listen(PORT, '127.0.0.1', resolve); });
    await new Promise((resolve) => reservation.close(resolve));
    child = spawn(process.execPath, [require.resolve('next/dist/bin/next'), 'start', '--hostname', '127.0.0.1', '--port', String(PORT)],
      { cwd: web, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'], env: env(turnstileSecret) });
    // Kept in memory to prove no code or address is logged; never printed.
    child.stdout.on('data', (chunk) => { serverLog += chunk; }); child.stderr.on('data', (chunk) => { serverLog += chunk; });
    for (let attempt = 0; attempt < 80; attempt++) {
      try { if ((await boundedFetch(`${origin}/privacy`)).ok) return; } catch { /* starting */ }
      await delay(250);
    }
    throw new Error('Next server did not start.');
  };
  const stop = async () => {
    if (child && child.exitCode === null) { child.kill(); await new Promise((resolve) => child.once('exit', resolve)); }
    child = null;
  };
  const registrationBody = (label, patch = {}, venuePatch = {}) => ({
    request_key: crypto.randomUUID(), turnstile_token: DUMMY_TOKEN, acknowledge_duplicates: false,
    registration: {
      owner_name: 'Harness Owner', email: emailOf(label), phone: '0917 123 4567', role: 'owner',
      venue: { name: `Harness Courts ${label}`, address_line: '1 Harness St', city, province: 'Bohol', latitude: 9.64, longitude: 123.85, court_count: 3, ...venuePatch },
      courts: { indoor: false, covered: true, surface: 'hard' }, note: null, consent: true,
    },
    ...patch,
  });
  const register = (body, headers = {}) => boundedFetch(`${origin}/api/register`, {
    method: 'POST', headers: { Origin: origin, 'Content-Type': 'application/json', ...headers }, body: JSON.stringify(body) });
  const rows = (email) => sqlJson(`select coalesce(json_agg(json_build_object('id', r.id, 'venue_id', r.venue_id, 'status', r.status, 'code_hash', r.code_hash,
    'code_version', r.code_version, 'sent', r.email_sent_at is not null, 'phone', r.phone, 'role', r.role, 'nearby', r.nearby_venue_ids,
    'acknowledged', r.duplicates_acknowledged) order by r.created_at), '[]') from private.venue_registrations r where r.email = '${email}'`);
  const hash = (code) => crypto.createHmac('sha256', secrets.code).update(`pickly-claim-code:v1:${code}`).digest('hex');
  const codeOf = (message) => /([A-Z2-9]{5})-([A-Z2-9]{5})/.exec(message.text)?.slice(1).join('');
  const anon = (route, init = {}) => boundedFetch(`${api.origin}${route}`, { ...init, headers: { apikey: settings.ANON_KEY, 'Content-Type': 'application/json', ...init.headers } });
  const service = (route, init = {}) => boundedFetch(`${api.origin}${route}`, { ...init,
    headers: { apikey: settings.SERVICE_ROLE_KEY, Authorization: `Bearer ${settings.SERVICE_ROLE_KEY}`, 'Content-Type': 'application/json', ...init.headers } });

  try {
    stage = 'Docker SQL suite';
    assert.ok(sqlJson("select to_regprocedure('public.prelaunch_register(uuid,jsonb,text,boolean)') is not null"), 'Apply the T53 migration locally first (supabase migration up --local).');
    psql(fs.readFileSync(path.join(root, 'supabase/tests/prelaunch.sql'), 'utf8'));
    console.log('PASS: Docker prelaunch.sql: grants, validation, draft + registration + audit, duplicates, rotation, delivery records, cap, invisibility, delete blocker, 180-day sweep (rolled back).');

    stage = 'bundle scan';
    assert.ok(fs.existsSync(path.join(web, '.next/BUILD_ID')), 'Build apps/web first (npm run web:build).');
    assert.deepEqual(scanWebBundle(web, Object.values(secrets)), []);
    console.log('PASS: client bundle holds no server setting names or secret-shaped values.');

    stage = 'Cloudflare siteverify reachable';
    const probe = await boundedFetch('https://challenges.cloudflare.com/turnstile/v0/siteverify', { method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ secret: TURNSTILE_PASS, response: DUMMY_TOKEN }) });
    assert.equal((await probe.json()).success, true, 'Cloudflare test keys must be reachable for this harness.');

    stage = 'pages';
    await start(TURNSTILE_PASS);
    const page = await boundedFetch(`${origin}/register`);
    assert.equal(page.status, 200);
    const csp = page.headers.get('content-security-policy');
    const nonce = /'nonce-([^']+)'/.exec(csp)?.[1];
    assert.ok(nonce && csp.includes("frame-ancestors 'none'") && csp.includes('https://challenges.cloudflare.com'), 'page CSP');
    const html = await page.text();
    const scripts = [...html.matchAll(/<script\b[^>]*>/g)].map(([tag]) => tag);
    assert.ok(scripts.length > 0 && scripts.every((tag) => tag.includes(`nonce="${nonce}"`)), 'every script carries the nonce');
    assert.equal(page.headers.get('set-cookie'), null);
    assert.equal(page.headers.get('x-frame-options'), 'DENY');
    assert.ok(html.includes('Put your courts on pickly before launch') && html.includes('1x00000000000000000000AA') && html.includes('AIzaHarnessBrowserKey'));
    for (const value of [...Object.values(secrets), settings.SERVICE_ROLE_KEY]) assert.ok(!html.includes(value), 'no secret in the page');
    const privacy = (await (await boundedFetch(`${origin}/privacy`)).text()).replaceAll('<!-- -->', '');
    assert.ok(privacy.includes('Republic Act No. 10173') && privacy.includes('hello@pickly.example') && privacy.includes('180 days'));
    assert.equal((await boundedFetch(`${origin}/api/register`)).status, 405);
    console.log('PASS: /register and /privacy render with a per-request nonce CSP (Maps + Turnstile only), no cookies, no secrets; GET on the API is refused.');

    stage = 'cross-site and malformed requests';
    const cross = await register(registrationBody('cross'), { Origin: 'http://evil.example' });
    assert.equal(cross.status, 403);
    assert.equal((await register(registrationBody('huge', {}, { name: 'x'.repeat(20000) }))).status, 413);
    assert.deepEqual(rows(emailOf('cross')), []);
    console.log('PASS: cross-site POST 403 and oversized body 413, nothing written.');

    stage = 'registration';
    const first = registrationBody('main');
    const created = await register(first);
    assert.equal(created.status, 200);
    const createdText = await created.text();
    assert.deepEqual(JSON.parse(createdText), { status: 'sent', venue_name: 'Harness Courts main' });
    const [row] = rows(emailOf('main'));
    venueIds.add(row.venue_id);
    assert.deepEqual([row.status, row.code_version, row.sent, row.phone, row.role], ['open', 1, true, '+639171234567', 'owner']);
    const draft = sqlJson(`select json_build_object('publication', v.publication_status, 'claim', v.claim_status, 'courts',
      (select string_agg(c.name || ':' || c.surface || ':' || c.is_covered, ',' order by c.name) from public.courts c where c.venue_id = v.id),
      'audit', (select json_agg(e.action || ':' || (e.actor_user_id = '${row.id}')) from private.directory_audit_events e where e.target_venue_id = v.id),
      'owners', (select count(*) from private.venue_owners o where o.venue_id = v.id)) from public.venues v where v.id = '${row.venue_id}'`);
    assert.deepEqual(draft, { publication: 'draft', claim: 'unclaimed', courts: 'Court 1:hard:true,Court 2:hard:true,Court 3:hard:true', audit: ['prelaunch.register:true'], owners: 0 });
    const sent = mail.messages.filter((message) => message.to[0] === emailOf('main'));
    assert.equal(sent.length, 1);
    const code = codeOf(sent[0]);
    assert.ok(code, 'code emailed');
    assert.equal(hash(code), row.code_hash, 'the stored hash is the keyed hash of the emailed code');
    assert.ok(sent[0].html.includes(`${code.slice(0, 5)}-${code.slice(5)}`) && sent[0].text.includes('Harness Courts main') && sent[0].text.includes('hello@pickly.example'));
    assert.equal(sent[0].idempotency, `prelaunch-${row.id}-v1`);
    console.log('PASS: registration → one private unclaimed draft (Court 1–3) + registration + prelaunch.register audit; one email whose code matches the stored keyed hash.');

    stage = 'draft invisibility';
    assert.deepEqual(await (await anon(`/rest/v1/venues?id=eq.${row.venue_id}&select=id`)).json(), []);
    assert.deepEqual(await (await anon(`/rest/v1/courts?venue_id=eq.${row.venue_id}&select=id`)).json(), []);
    const bounds = await (await anon('/rest/v1/rpc/venues_in_bounds', { method: 'POST', body: JSON.stringify({ south: 9.5, west: 123.7, north: 9.8, east: 124 }) })).json();
    assert.ok(Array.isArray(bounds) && !bounds.some((venue) => venue.id === row.venue_id));
    const search = await (await service('/rest/v1/rpc/directory_search', { method: 'POST', body: JSON.stringify({ search: { city } }) })).json();
    assert.deepEqual(search.venues, [], 'search skips drafts');
    for (const [fn, args] of [['prelaunch_register', { request_key: crypto.randomUUID(), registration: first.registration, code_hash: 'a'.repeat(64), acknowledge_duplicates: true }],
      ['prelaunch_email_sent', { registration_id: row.id, sent_version: 1 }]]) {
      const denied = await anon(`/rest/v1/rpc/${fn}`, { method: 'POST', body: JSON.stringify(args) });
      assert.ok([401, 403].includes(denied.status), `anon cannot call ${fn}`);
      assert.equal((await denied.json()).code, '42501');
    }
    console.log('PASS: anon REST read, bounds read and directory search never show the draft; anon cannot call the commands.');

    stage = 'retry';
    const retried = await register(first);
    assert.equal(retried.status, 200);
    assert.equal(await retried.text(), createdText, 'the retry answers exactly like the original');
    assert.equal(rows(emailOf('main')).length, 1);
    assert.equal(rows(emailOf('main'))[0].code_hash, row.code_hash);
    assert.equal(mail.messages.filter((message) => message.to[0] === emailOf('main')).length, 1, 'no second email');
    console.log('PASS: a retried submit returns the original: same reply, no second draft or email, code unchanged.');

    stage = 'send failure and rotation';
    mail.mode = 'fail';
    const flaky = registrationBody('flaky');
    const failed = await register(flaky);
    assert.equal(failed.status, 502);
    assert.match((await failed.json()).message, /try again/i);
    const [pending] = rows(emailOf('flaky'));
    venueIds.add(pending.venue_id);
    assert.deepEqual([pending.sent, pending.code_version], [false, 1]);
    const lostCode = codeOf(mail.messages.at(-1));
    assert.equal(hash(lostCode), pending.code_hash);
    mail.mode = 'ok';
    const recovered = await register(flaky);
    assert.equal(recovered.status, 200);
    const [rotated] = rows(emailOf('flaky'));
    const newCode = codeOf(mail.messages.at(-1));
    assert.deepEqual([rotated.id, rotated.sent, rotated.code_version], [pending.id, true, 2]);
    assert.equal(hash(newCode), rotated.code_hash);
    assert.notEqual(hash(lostCode), rotated.code_hash, 'the old code stopped working');
    assert.equal(mail.messages.at(-1).idempotency, `prelaunch-${pending.id}-v2`);
    console.log('PASS: a failed send answers 502 and keeps the registration; the retry rotates the code (old hash gone) and sends once.');

    stage = 'duplicates';
    const nearby = psql(`insert into public.venues (name, address_line, city, province, latitude, longitude, publication_status)
      values ('Harness Approved Hall', '2 Harness St', '${city}', 'Bohol', 9.70, 123.90, 'approved') returning id;`).trim();
    venueIds.add(nearby);
    const near = registrationBody('near', {}, { latitude: 9.7001, longitude: 123.9001 });
    const warned = await register(near);
    const warning = await warned.json();
    assert.equal(warning.status, 'duplicates');
    assert.equal(warning.duplicates.length, 1);
    assert.deepEqual({ ...warning.duplicates[0], distance_m: warning.duplicates[0].distance_m < 30 }, { name: 'Harness Approved Hall', address_line: '2 Harness St', city, distance_m: true });
    assert.deepEqual(rows(emailOf('near')), []);
    const acknowledged = await register({ ...near, acknowledge_duplicates: true });
    assert.equal(acknowledged.status, 200);
    const [nearRow] = rows(emailOf('near'));
    venueIds.add(nearRow.venue_id);
    assert.ok(nearRow.acknowledged && nearRow.nearby.includes(nearby), 'reviewers keep the nearby IDs');
    console.log('PASS: an approved listing within 150 m must be acknowledged first (nothing written before); the reviewer snapshot keeps its ID.');

    stage = 'limits and Redis outage';
    redis.mode = 'deny';
    const limited = await register(registrationBody('limited'));
    assert.equal(limited.status, 429);
    assert.ok(Number(limited.headers.get('retry-after')) > 0);
    redis.mode = 'fail';
    const down = await register(registrationBody('down'));
    assert.equal(down.status, 503);
    assert.ok(down.headers.get('retry-after'));
    redis.mode = 'ok';
    assert.deepEqual([rows(emailOf('limited')), rows(emailOf('down'))], [[], []]);
    assert.ok(redis.calls > 0 && [...redis.store.keys()].every((key) => /^pickly:local:prelaunch-register:(ip|email):[0-9a-f]{64}$/.test(key)), 'keyed identifiers only');
    console.log('PASS: over the limit 429 with Retry-After; Redis outage 503; neither writes; Redis keys hold only keyed identifiers.');

    stage = 'logs';
    for (const value of [code, lostCode, newCode, emailOf('main'), ...Object.values(secrets)]) assert.ok(!serverLog.includes(value), 'nothing sensitive logged');
    console.log('PASS: server logs hold no claim code, address or secret.');

    stage = 'Turnstile refusal';
    await stop();
    await start(TURNSTILE_FAIL);
    const refused = await register(registrationBody('refused'));
    assert.equal(refused.status, 403);
    assert.deepEqual(rows(emailOf('refused')), []);
    console.log('PASS: with Cloudflare\'s always-fail test secret the submit answers 403 before any limit or write.');
  } catch (error) {
    console.error(`FAIL at ${stage}: ${error.message}`);
    process.exitCode = 1;
  } finally {
    await stop();
    upstash.close(); mailer.close();
    try {
      const ids = [...venueIds].map((id) => `'${id}'`).join(',') || 'null';
      psql(`begin;
        delete from private.venue_registrations where email like 't53-%-${suffix}@example.test' or venue_id in (${ids});
        delete from private.directory_audit_events where target_venue_id in (${ids});
        delete from public.venues where id in (${ids});
        commit;`);
      assert.equal(sqlJson(`select count(*) from public.venues where city = '${city}'`), 0);
      assert.equal(sqlJson(`select count(*) from private.venue_registrations where email like '%-${suffix}@example.test'`), 0);
      console.log('PASS: own registrations, drafts, courts and audit rows removed; test server and stand-ins stopped.');
    } catch (error) {
      console.error(`FAIL: cleanup: ${error.message}`);
      process.exitCode = 1;
    }
  }
}

main();
