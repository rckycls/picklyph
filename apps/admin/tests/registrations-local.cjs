// T54b: actual production Next server + local Supabase/Mailpit/Storage + a loopback stand-in for the email provider.
// Never reads mobile env or hosted data; removes everything it creates.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const http = require('node:http');
const net = require('node:net');
const path = require('node:path');
const { execFileSync, spawn } = require('node:child_process');
const { randomBytes, randomUUID } = require('node:crypto');
const { setTimeout: delay } = require('node:timers/promises');
const { createClient } = require('@supabase/supabase-js');
const { generateClaimCode, hashClaimCode } = require('@picklyph/domain/src/claimCode.ts');

const JPEG = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46, 0x00, 0x01, 0xff, 0xd9]);
const SETTING_NAMES = ['PRELAUNCH_CODE_SECRET', 'PRELAUNCH_ORIGIN', 'PRELAUNCH_CONTACT_EMAIL', 'PRELAUNCH_APP_URL', 'EMAIL_API_KEY', 'EMAIL_FROM', 'EMAIL_API_URL'];

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
  const suffix = randomUUID().slice(0, 8);
  const secrets = { code: randomBytes(24).toString('hex'), emailKey: `re_${randomBytes(12).toString('hex')}` };
  const users = {};
  const venues = new Set();
  const evidence = [];
  const registrationKeys = [];
  const messageIds = new Set();
  let child;
  let serverLog = '';
  let mailer;
  let stage = 'startup';
  let cleanupFailed = false;
  const check = (result, message) => { assert.ok(!result.error, message); return result.data; };

  // Loopback stand-in for the email provider's HTTP API (Resend's request shape). It records every attempt.
  const mail = { mode: 'ok', messages: [], attempts: 0 };
  mailer = http.createServer((req, res) => {
    let body = '';
    req.on('data', (chunk) => { body += chunk; });
    req.on('end', () => {
      mail.attempts++;
      const ok = req.headers.authorization === `Bearer ${secrets.emailKey}` && req.url === '/emails' && mail.mode === 'ok';
      if (ok) mail.messages.push({ ...JSON.parse(body), key: req.headers['idempotency-key'], at: Date.now() });
      res.writeHead(ok ? 200 : 500, { 'Content-Type': 'application/json' });
      res.end(ok ? '{"id":"local"}' : '{"error":"down"}');
    });
  });
  await new Promise((resolve) => mailer.listen(0, '127.0.0.1', resolve));
  const sendSettings = {
    PRELAUNCH_CODE_SECRET: secrets.code, PRELAUNCH_ORIGIN: 'http://127.0.0.1:3200', PRELAUNCH_CONTACT_EMAIL: 'hello@pickly.example',
    PRELAUNCH_APP_URL: 'https://apps.apple.com/app/id0000000000', EMAIL_API_KEY: secrets.emailKey, EMAIL_FROM: 'pickly <hello@pickly.example>',
    EMAIL_API_URL: `http://127.0.0.1:${mailer.address().port}/emails`,
  };

  const request = async (route, jar = new Map(), body, overrideHeaders = {}) => {
    const response = await boundedFetch(new URL(route, origin), {
      method: body === undefined ? 'GET' : 'POST', redirect: 'manual',
      headers: { Cookie: [...jar].map(([key, item]) => `${key}=${item}`).join('; '),
        ...(body === undefined ? {} : { 'Content-Type': 'application/json', Origin: origin }), ...overrideHeaders },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    for (const cookie of response.headers.getSetCookie()) {
      const pair = cookie.split(';')[0];
      const separator = pair.indexOf('=');
      const name = pair.slice(0, separator);
      const item = pair.slice(separator + 1);
      if (!item || /Max-Age=0/i.test(cookie)) jar.delete(name); else jar.set(name, item);
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
    assert.equal((await request('/api/auth/request', jar, { email })).status, 200, 'Code request succeeds.');
    assert.equal((await request('/api/auth/verify', jar, { email, code: await readCode(email) })).status, 200, 'Email code sign-in succeeds.');
    return jar;
  };
  const startServer = async (extra) => {
    // The port must be free (a stopped server may hold it for a moment).
    for (let attempt = 0; ; attempt++) {
      const reservation = net.createServer();
      try {
        await new Promise((resolve, reject) => { reservation.once('error', reject); reservation.listen(3100, '127.0.0.1', resolve); });
        await new Promise((resolve) => reservation.close(resolve));
        break;
      } catch (error) { if (attempt >= 20) throw error; await delay(250); }
    }
    const env = { ...process.env };
    for (const name of SETTING_NAMES) delete env[name];
    child = spawn(process.execPath, [require.resolve('next/dist/bin/next'), 'start', '--hostname', '127.0.0.1', '--port', '3100'], {
      cwd: path.join(root, 'apps/admin'), windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'],
      env: { ...env, NODE_ENV: 'production', NEXT_TELEMETRY_DISABLED: '1', ADMIN_ORIGIN: origin, ADMIN_SUPABASE_URL: api.origin,
        ADMIN_SUPABASE_PUBLISHABLE_KEY: settings.ANON_KEY, ADMIN_SUPABASE_SECRET_KEY: settings.SERVICE_ROLE_KEY, ...extra },
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
  const registrationEmail = (label) => `t54b-${label}-${suffix}@example.test`;
  const row = (key) => JSON.parse(value(`select json_build_object('id', r.id, 'venue_id', r.venue_id, 'status', r.status, 'code_hash', r.code_hash,
    'code_version', r.code_version, 'sent_version', r.email_sent_version, 'owner_name', r.owner_name, 'email', r.email, 'phone', r.phone,
    'listing', v.publication_status || ':' || v.claim_status, 'submission_id', r.submission_id)
    from private.venue_registrations r join public.venues v on v.id = r.venue_id where r.request_key = '${key}'::uuid;`));
  const audits = (action) => Number(value(`select count(*) from private.directory_audit_events where action = '${action}' and actor_user_id = '${users.admin.id}'::uuid;`));
  const codeCheck = async (code) => check(await service.rpc('owner_registration_check', { actor_user_id: users.checker.id, code_hash: await hashClaimCode(secrets.code, code) }), 'Code check.').outcome;
  const send = (jar, items, headers) => request('/api/console/registrations/send', jar, { items }, headers);
  const erase = (jar, ids, headers) => request('/api/console/registrations/erase', jar, { ids }, headers);
  const emailedCode = (message) => /Your claim code: ([A-Z0-9]{5}-[A-Z0-9]{5})/.exec(message.text)?.[1]?.replace('-', '');

  try {
    stage = 'SQL on Docker';
    sql(fs.readFileSync(path.join(root, 'supabase/tests/prelaunch.sql'), 'utf8'));
    sql(fs.readFileSync(path.join(root, 'supabase/tests/prelaunch-admin.sql'), 'utf8'));
    console.log('PASS: Docker PostgreSQL T53 registration suite and T54b console suite (admin-only list, rotation, erasure, delivered version); rolled back.');

    stage = 'fixtures';
    for (const role of ['admin', 'moderator', 'claimant', 'checker']) {
      const email = `t54b-${role}-${randomUUID()}@example.invalid`;
      const created = await service.auth.admin.createUser({ email, password: `Local-${randomUUID()}!`, email_confirm: true });
      assert.ok(!created.error && created.data.user?.id, 'Own local fixture user.');
      users[role] = { id: created.data.user.id, email };
    }
    sql(`insert into private.account_roles(user_id, role) values ('${users.admin.id}'::uuid, 'admin'), ('${users.moderator.id}'::uuid, 'moderator');`);
    // Registrations through the T53 command with known codes, at random Sulu Sea spots.
    const fixtures = {};
    for (const label of ['first', 'second', 'claimed', 'spam']) {
      const key = randomUUID();
      registrationKeys.push(key);
      const code = generateClaimCode();
      const registered = check(await service.rpc('prelaunch_register', { request_key: key, code_hash: await hashClaimCode(secrets.code, code), acknowledge_duplicates: true,
        registration: { owner_name: `Owner ${label} ${suffix}`, email: registrationEmail(label), phone: '+639171234567', role: 'owner',
          venue: { name: `T54b ${label} ${suffix}`, address_line: 'Harness road', city: 'Harness City', province: 'Harness',
            latitude: Number((6 + Math.random()).toFixed(5)), longitude: Number((120.5 + Math.random()).toFixed(5)), court_count: 2 },
          courts: { indoor: false, covered: true, surface: null }, note: `Note ${label} ${suffix}`, consent: true } }), 'Fixture registration.');
      assert.equal(registered.outcome, 'created');
      check(await service.rpc('prelaunch_email_sent', { registration_id: registered.registration_id, sent_version: 1 }), 'Fixture delivery.');
      fixtures[label] = { key, code, name: `T54b ${label} ${suffix}`, id: registered.registration_id };
      venues.add(row(key).venue_id);
    }
    const evidencePath = `${users.claimant.id}/${randomUUID()}.jpg`;
    check(await service.storage.from('owner-evidence').upload(evidencePath, JPEG, { contentType: 'image/jpeg', upsert: false }), 'Fixture evidence.');
    evidence.push(evidencePath);
    const redeemed = check(await service.rpc('owner_redeem_registration', { actor_user_id: users.claimant.id, submission_request_id: randomUUID(),
      code_hash: await hashClaimCode(secrets.code, fixtures.claimed.code), evidence_ref: evidencePath, submission_note: null }), 'Fixture redemption.');
    assert.equal(redeemed.outcome, 'created');
    const submissionId = redeemed.submission.id;

    stage = 'production server without email settings';
    assert.ok(fs.existsSync(path.join(root, 'apps/admin/.next/BUILD_ID')), 'Build the admin before integration tests.');
    await startServer({});

    stage = 'guest denial';
    const guestPage = await request('/console/registrations');
    assert.ok([303, 307].includes(guestPage.status) && guestPage.headers.get('location') === '/login', 'Guest page redirects to sign-in.');
    assert.equal((await send(new Map(), [{ id: fixtures.first.id, code_version: 1 }])).status, 401, 'Guest send denied.');
    assert.equal((await erase(new Map(), [fixtures.spam.id])).status, 401, 'Guest erase denied.');

    stage = 'sign-in';
    const jars = { admin: await signIn(users.admin.email), moderator: await signIn(users.moderator.email), claimant: await signIn(users.claimant.email) };

    stage = 'moderator and player denial';
    for (const who of ['moderator', 'claimant']) {
      const html = await (await request('/console/registrations', jars[who])).text();
      assert.ok(html.includes('Administrator access required.') && !html.includes(fixtures.first.name) && !html.includes(registrationEmail('first')), `${who}: no registrations`);
      assert.equal((await send(jars[who], [{ id: fixtures.first.id, code_version: 1 }])).status, 403, `${who}: send denied`);
      assert.equal((await erase(jars[who], [fixtures.spam.id])).status, 403, `${who}: erase denied`);
    }
    const moderatorHome = await (await request('/console', jars.moderator)).text();
    assert.ok(!moderatorHome.includes('/console/registrations'), 'Moderators have no Pre-launch entry.');
    assert.ok((await (await request('/console', jars.admin)).text()).includes('/console/registrations'), 'Admins have the Pre-launch entry.');
    console.log('PASS: guests are sent to sign-in; moderators and players get no list, no Pre-launch entry and 403 on send/erase.');

    stage = 'admin list';
    const listHtml = await (await request(`/console/registrations?email=${encodeURIComponent(registrationEmail('first').toUpperCase())}`, jars.admin)).text();
    for (const shown of [fixtures.first.name, `Owner first ${suffix}`, registrationEmail('first'), '+639171234567', `Note first ${suffix}`, 'Open (1)']) {
      assert.ok(listHtml.includes(shown), `The admin list shows ${shown}.`);
    }
    assert.ok(!listHtml.includes(fixtures.second.name), 'The email search shows only that address.');
    const claimedHtml = await (await request(`/console/registrations?status=claimed&email=${encodeURIComponent(registrationEmail('claimed'))}`, jars.admin)).text();
    assert.ok(claimedHtml.includes(fixtures.claimed.name) && claimedHtml.includes(`/console/ownership/${submissionId}`), 'Claimed rows link their review.');
    for (const secret of [settings.SERVICE_ROLE_KEY, row(fixtures.first.key).code_hash]) assert.ok(!listHtml.includes(secret), 'No key or code hash on the page.');
    const staticDir = path.join(root, 'apps/admin/.next/static');
    const bundle = fs.readdirSync(staticDir, { recursive: true }).filter((file) => String(file).endsWith('.js'))
      .map((file) => fs.readFileSync(path.join(staticDir, String(file)), 'utf8')).join('\n');
    for (const name of SETTING_NAMES) assert.ok(!bundle.includes(name), `The client bundle never names ${name}.`);
    console.log('PASS: admin list: contacts, exact-address search (any case), status tabs with counts, claimed rows link their review; no setting names in the client bundle.');

    stage = 'send without settings';
    const unset = await send(jars.admin, [{ id: fixtures.first.id, code_version: 1 }]);
    assert.equal(unset.status, 503);
    assert.match((await unset.json()).error, /isn’t set up/);
    assert.equal(row(fixtures.first.key).code_version, 1, 'Nothing rotated without email settings.');
    assert.equal(audits('prelaunch.code_send'), 0);
    assert.equal((await send(jars.admin, [{ id: fixtures.first.id, code_version: 1 }], { Origin: 'https://evil.example' })).status, 403, 'Cross-site send refused.');
    assert.equal((await request('/api/console/registrations/send', jars.admin, { items: [{ id: 'nope', code_version: 1 }] })).status, 400, 'Bad input refused.');
    console.log('PASS: without email/code settings Send answers 503 and nothing rotates; cross-site and malformed requests are refused.');
    await stopServer();

    stage = 'production server with email settings';
    await startServer(sendSettings);

    stage = 'send one code';
    assert.equal(await codeCheck(fixtures.first.code), 'valid', 'The registration code works before the send.');
    const sent = await send(jars.admin, [{ id: fixtures.first.id, code_version: 1 }]);
    assert.equal(sent.status, 200);
    assert.deepEqual((await sent.json()).data, { action: 'send', outcomes: [{ id: fixtures.first.id, done: true, message: null }] });
    const firstMail = mail.messages.filter((message) => message.to[0] === registrationEmail('first'));
    assert.equal(firstMail.length, 1, 'One email.');
    const newCode = emailedCode(firstMail[0]);
    assert.ok(newCode && newCode !== fixtures.first.code, 'A new code is emailed.');
    const afterSend = row(fixtures.first.key);
    assert.equal(afterSend.code_hash, await hashClaimCode(secrets.code, newCode), 'The stored hash is the keyed hash of the emailed code.');
    assert.deepEqual([afterSend.code_version, afterSend.sent_version, afterSend.status], [2, 2, 'open'], 'Version 2, delivered.');
    assert.equal(firstMail[0].key, `prelaunch-${fixtures.first.id}-v2`);
    assert.ok(firstMail[0].text.includes('https://apps.apple.com/app/id0000000000') && firstMail[0].text.includes('Your earlier code no longer works'));
    assert.equal(audits('prelaunch.code_send'), 1, 'Audited once, with the admin as actor.');
    assert.equal(await codeCheck(fixtures.first.code), 'invalid', 'The old code stops working.');
    assert.equal(await codeCheck(newCode), 'valid', 'The new code works.');
    console.log('PASS: send: one email whose code matches the stored keyed hash; version 2 recorded as delivered; old code invalid, new code valid; one audit row.');

    stage = 'double send';
    const twice = await (await send(jars.admin, [{ id: fixtures.first.id, code_version: 1 }])).json();
    assert.equal(twice.data.outcomes[0].done, false);
    assert.match(twice.data.outcomes[0].message, /changed after you loaded the list/);
    assert.equal(mail.messages.filter((message) => message.to[0] === registrationEmail('first')).length, 1, 'No second email.');
    assert.equal(row(fixtures.first.key).code_version, 2);

    stage = 'failed send';
    mail.mode = 'fail';
    const failed = await (await send(jars.admin, [{ id: fixtures.second.id, code_version: 1 }])).json();
    assert.deepEqual(failed.data.outcomes, [{ id: fixtures.second.id, done: false,
      message: 'The new code was made but the email didn’t go out, so the earlier code no longer works. Send again.' }]);
    assert.deepEqual([row(fixtures.second.key).code_version, row(fixtures.second.key).sent_version], [2, 1], 'Rotated, not delivered.');
    assert.equal(await codeCheck(fixtures.second.code), 'invalid', 'The old code already stopped working.');
    const undeliveredHtml = await (await request(`/console/registrations?email=${encodeURIComponent(registrationEmail('second'))}`, jars.admin)).text();
    assert.ok(undeliveredHtml.includes('Newest code not delivered'), 'The list shows the undelivered code.');
    mail.mode = 'ok';
    console.log('PASS: a double send is refused with no email; a failed send reports "not delivered", the list shows it and the old code is void.');

    stage = 'bulk send';
    const bulk = await (await send(jars.admin, [{ id: fixtures.second.id, code_version: 2 }, { id: fixtures.first.id, code_version: 2 }, { id: fixtures.claimed.id, code_version: 1 }])).json();
    assert.deepEqual(bulk.data.outcomes.map((outcome) => outcome.done), [true, true, false]);
    assert.match(bulk.data.outcomes[2].message, /claimed or erased/);
    const second = mail.messages.filter((message) => message.to[0] === registrationEmail('second'));
    const firstAgain = mail.messages.filter((message) => message.to[0] === registrationEmail('first'));
    assert.equal(second.length, 1);
    assert.equal(firstAgain.length, 2);
    assert.ok(firstAgain[1].at - second[0].at >= 550, 'Emails are spaced for the provider.');
    assert.deepEqual([row(fixtures.second.key).code_version, row(fixtures.second.key).sent_version], [3, 3]);
    assert.equal(row(fixtures.second.key).code_hash, await hashClaimCode(secrets.code, emailedCode(second[0])));
    assert.equal(await codeCheck(newCode), 'invalid', 'The first new code was replaced too.');
    assert.equal(await codeCheck(emailedCode(firstAgain[1])), 'valid');
    const claimedRow = row(fixtures.claimed.key);
    assert.ok(claimedRow.status === 'claimed' && claimedRow.code_hash === null && claimedRow.code_version === 1, 'The claimed registration is untouched.');
    assert.equal(mail.messages.filter((message) => message.to[0] === registrationEmail('claimed')).length, 0, 'No email to a claimed registration.');
    console.log('PASS: bulk send: both open registrations rotated and emailed, spaced; the claimed one is refused and untouched.');

    stage = 'erase';
    // The checker's wrong tries so far stay under the lockout; start its count again for the last checks.
    sql(`delete from private.claim_code_failures where user_id = '${users.checker.id}'::uuid;`);
    const erased = await (await erase(jars.admin, [fixtures.spam.id, fixtures.claimed.id])).json();
    assert.deepEqual(erased.data.outcomes, [{ id: fixtures.spam.id, done: true, message: null }, { id: fixtures.claimed.id, done: true, message: null }]);
    const spam = row(fixtures.spam.key);
    assert.ok(spam.status === 'erased' && spam.owner_name === null && spam.email === null && spam.phone === null && spam.code_hash === null, 'Spam contacts and code gone.');
    assert.equal(spam.listing, 'suspended:unclaimed', 'Its draft is suspended.');
    assert.equal(await codeCheck(fixtures.spam.code), 'invalid');
    const claimedErased = row(fixtures.claimed.key);
    assert.ok(claimedErased.status === 'erased' && claimedErased.email === null && claimedErased.submission_id === submissionId, 'Claimed contacts gone, link kept.');
    assert.equal(claimedErased.listing, 'draft:pending', 'The claimant\'s draft stays pending review.');
    assert.equal(value(`select status from private.venue_submissions where id = '${submissionId}'::uuid;`), 'pending');
    assert.equal(audits('prelaunch.erase'), 2);
    const again = await (await erase(jars.admin, [fixtures.spam.id])).json();
    assert.deepEqual(again.data.outcomes, [{ id: fixtures.spam.id, done: true, message: 'Already erased.' }]);
    assert.equal(audits('prelaunch.erase'), 2, 'No audit for a repeat.');
    const erasedHtml = await (await request('/console/registrations?status=erased', jars.admin)).text();
    assert.ok(erasedHtml.includes(fixtures.spam.name) && !erasedHtml.includes(`Owner spam ${suffix}`), 'Erased rows show no contacts.');
    const reviewHtml = await (await request(`/console/ownership/${submissionId}`, jars.admin)).text();
    assert.ok(reviewHtml.includes('earlier by an administrator') && !reviewHtml.includes(`Owner claimed ${suffix}`), 'The review panel shows the erasure.');
    console.log('PASS: erase: open → contacts and code gone, draft suspended; claimed → contacts gone, draft stays pending review; repeat → "Already erased"; audited.');

    stage = 'logs';
    const codes = [fixtures.first.code, fixtures.second.code, newCode, ...mail.messages.map(emailedCode)];
    for (const secret of [...codes, secrets.code, secrets.emailKey, registrationEmail('first'), registrationEmail('second')]) {
      assert.ok(!serverLog.includes(secret), 'Nothing sensitive in the server log.');
    }

    stage = 'revocation';
    sql(`delete from private.account_roles where user_id = '${users.admin.id}'::uuid;`);
    assert.equal((await send(jars.admin, [{ id: fixtures.first.id, code_version: 3 }])).status, 403, 'Revoked admin cannot send.');
    assert.ok((await (await request('/console/registrations', jars.admin)).text()).includes('Administrator access required.'), 'Revoked admin loses the list.');
    console.log('PASS: no code, address or secret in the server log; a revoked admin loses the list and the actions at once.');
  } catch (error) {
    // Fixed stage labels and our own assertion messages only: no emails, codes, tokens or SDK errors.
    const detail = error?.code === 'ERR_ASSERTION' && error.generatedMessage === false ? ` (${error.message})` : '';
    throw new Error(`Local registrations verification failed at: ${stage}${detail}.`);
  } finally {
    await stopServer();
    await new Promise((resolve) => mailer.close(resolve));
    if (evidence.length) {
      try { if ((await service.storage.from('owner-evidence').remove(evidence)).error) cleanupFailed = true; } catch { cleanupFailed = true; }
    }
    // Users first: their submissions cascade, so no pending submission ever loses its draft.
    const ids = Object.values(users).map((user) => user.id);
    for (const id of ids) {
      try { if ((await service.auth.admin.deleteUser(id)).error) cleanupFailed = true; } catch { cleanupFailed = true; }
    }
    if (registrationKeys.length) {
      const keys = registrationKeys.map((key) => `'${key}'::uuid`).join(',');
      try { sql(`delete from private.directory_audit_events where target_venue_id in (select venue_id from private.venue_registrations where request_key in (${keys}));
        delete from private.venue_registrations where request_key in (${keys});`); }
      catch { cleanupFailed = true; }
    }
    for (const id of venues) {
      try { if ((await service.from('venues').delete().eq('id', id)).error) cleanupFailed = true; } catch { cleanupFailed = true; }
    }
    if (ids.length) {
      const list = ids.map((id) => `'${id}'::uuid`).join(',');
      try { sql(`delete from private.ownership_audit_events where actor_user_id in (${list}); delete from private.directory_audit_events where actor_user_id in (${list});
        delete from private.claim_code_failures where user_id in (${list});`); }
      catch { cleanupFailed = true; }
    }
    if (messageIds.size) {
      try {
        const removed = await boundedFetch(new URL('/api/v1/messages', inbox), { method: 'DELETE', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ IDs: [...messageIds] }) });
        if (!removed.ok) cleanupFailed = true;
      } catch { cleanupFailed = true; }
    }
    try {
      assert.equal(value(`select count(*) from private.venue_registrations where email like 't54b-%-${suffix}@example.test' or request_key in (${registrationKeys.map((key) => `'${key}'::uuid`).join(',') || 'null'});`), '0');
    } catch { cleanupFailed = true; }
    await service.auth.dispose?.();
    if (cleanupFailed) throw new Error('Own local registrations fixtures could not be fully cleaned up.');
  }
  console.log('PASS: own local accounts, registrations, drafts, evidence, audit rows and mail removed; test servers stopped; no hosted changes.');
}
main().catch((error) => {
  console.error(/^(Local registrations verification failed at:|Own local registrations fixtures)/.test(error.message ?? '') ? error.message : 'Local registrations test setup failed. Check the admin build and local Supabase.');
  process.exitCode = 1;
});
