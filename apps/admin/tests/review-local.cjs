// T17/T46: actual production Next server + local Supabase/Mailpit/Storage. Never reads mobile env or hosted data.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const net = require('node:net');
const path = require('node:path');
const { execFileSync, spawn } = require('node:child_process');
const { randomUUID } = require('node:crypto');
const { setTimeout: delay } = require('node:timers/promises');
const { createClient } = require('@supabase/supabase-js');

const JPEG = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46, 0x00, 0x01, 0xff, 0xd9]);

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
  const boundedFetch = (url, init = {}) => fetch(url, { ...init, signal: AbortSignal.timeout(15000) });
  const options = { auth: { persistSession: false, autoRefreshToken: false }, global: { fetch: boundedFetch } };
  const service = createClient(api.href, settings.SERVICE_ROLE_KEY, options);
  const origin = 'http://127.0.0.1:3100';
  const users = {};
  const venues = new Set();
  const evidence = [];
  const messageIds = new Set();
  const clients = [];
  let child;
  let stage = 'startup';
  let cleanupFailed = false;
  const check = (result, message) => { assert.ok(!result.error, message); return result.data; };

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
  const decide = (jar, subject_id, decision, rejection_reason = null, target_venue_id = null, headers) =>
    request('/api/console/ownership/decide', jar, { subject_id, decision, target_venue_id, rejection_reason }, headers);

  try {
    stage = 'review SQL on Docker';
    sql(fs.readFileSync(path.join(root, 'supabase/tests/review.sql'), 'utf8'));
    console.log('PASS: Docker PostgreSQL ownership review suite (reviewer-only reads, decisions, duplicates, retries, self-review, revocation, audit); rolled back.');

    stage = 'fixtures';
    for (const role of ['admin', 'moderator', 'claimant', 'submitter']) {
      const email = `review-${role}-${randomUUID()}@example.invalid`;
      const password = `Local-${randomUUID()}!`;
      const created = await service.auth.admin.createUser({ email, password, email_confirm: true });
      assert.ok(!created.error && created.data.user?.id, 'Own local fixture user.');
      users[role] = { id: created.data.user.id, email, password };
    }
    sql(`insert into private.account_roles(user_id, role) values ('${users.admin.id}'::uuid, 'admin'), ('${users.moderator.id}'::uuid, 'moderator');`);
    // A random Sulu Sea spot keeps duplicate matches to this run's own fixtures.
    const latitude = Number((6 + Math.random()).toFixed(5));
    const longitude = Number((120.5 + Math.random()).toFixed(5));
    const venueId = randomUUID();
    const fixtureName = `Review Fixture ${venueId.slice(0, 8)}`;
    const proposedName = `Review New ${venueId.slice(0, 8)}`;
    check(await service.from('venues').insert({ id: venueId, name: fixtureName, address_line: 'Fixture address', city: 'Fixture City',
      province: 'Fixture', latitude, longitude, publication_status: 'approved' }), 'Fixture venue.');
    venues.add(venueId);
    check(await service.from('courts').insert({ venue_id: venueId, name: 'Court 1' }), 'Fixture court.');
    const upload = async (owner) => {
      const objectPath = `${owner}/${randomUUID()}.jpg`;
      check(await service.storage.from('owner-evidence').upload(objectPath, JPEG, { contentType: 'image/jpeg', upsert: false }), 'Fixture evidence.');
      evidence.push(objectPath);
      return objectPath;
    };
    // Real T15 commands create the review queue.
    const claimPath = await upload(users.claimant.id);
    const claimed = check(await service.rpc('owner_submit_claim', { actor_user_id: users.claimant.id, submission_request_id: randomUUID(),
      target_venue_id: venueId, evidence_ref: claimPath, claim_note: 'Local review fixture' }), 'Fixture claim.');
    assert.equal(claimed.outcome, 'created');
    const claimId = claimed.submission.id;
    const venuePath = await upload(users.submitter.id);
    // About 55 m from the approved fixture: a public duplicate the submitter acknowledged.
    const submitted = check(await service.rpc('owner_submit_venue', { actor_user_id: users.submitter.id, submission_request_id: randomUUID(),
      venue_input: { name: proposedName, address_line: 'Fixture road', city: 'Fixture City', province: 'Fixture',
        latitude: Number((latitude + 0.0005).toFixed(5)), longitude, court_count: 2 },
      evidence_ref: venuePath, submission_note: null, acknowledge_duplicates: true }), 'Fixture submission.');
    assert.equal(submitted.outcome, 'created');
    const submissionId = submitted.submission.id;
    // The submission is the owner's private draft from the start.
    const draftId = submitted.submission.venue_id;
    venues.add(draftId);
    assert.equal(value(`select publication_status || ':' || claim_status from public.venues where id = '${draftId}';`), 'draft:pending', 'Owner draft is private.');

    stage = 'production server';
    const reservation = net.createServer();
    await new Promise((resolve, reject) => { reservation.once('error', reject); reservation.listen(3100, '127.0.0.1', resolve); });
    await new Promise((resolve) => reservation.close(resolve));
    assert.ok(fs.existsSync(path.join(root, 'apps/admin/.next/BUILD_ID')), 'Build the admin before integration tests.');
    child = spawn(process.execPath, [require.resolve('next/dist/bin/next'), 'start', '--hostname', '127.0.0.1', '--port', '3100'], {
      cwd: path.join(root, 'apps/admin'), windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'],
      env: { ...process.env, NODE_ENV: 'production', NEXT_TELEMETRY_DISABLED: '1', ADMIN_ORIGIN: origin, ADMIN_SUPABASE_URL: api.origin,
        ADMIN_SUPABASE_PUBLISHABLE_KEY: settings.ANON_KEY, ADMIN_SUPABASE_SECRET_KEY: settings.SERVICE_ROLE_KEY },
    });
    child.stdout.on('data', () => {}); child.stderr.on('data', () => {});
    let started = false;
    for (let attempt = 0; attempt < 60; attempt++) {
      if (child.exitCode !== null) break;
      try { if ((await request('/login')).status === 200) { started = true; break; } } catch {}
      await delay(250);
    }
    assert.ok(started, 'Production admin must start.');

    stage = 'guest denial';
    const guestPage = await request('/console/ownership');
    assert.ok([303, 307].includes(guestPage.status) && guestPage.headers.get('location') === '/login', 'Guest review page redirects to sign-in.');
    assert.equal((await decide(new Map(), claimId, 'approve')).status, 401, 'Guest decision denied.');
    assert.equal((await request(`/api/console/ownership/evidence/${claimId}`)).status, 401, 'Guest evidence denied.');

    stage = 'sign-in';
    const jars = { admin: await signIn(users.admin.email), moderator: await signIn(users.moderator.email), claimant: await signIn(users.claimant.email) };

    stage = 'player denial';
    const playerHtml = await (await request('/console/ownership', jars.claimant)).text();
    assert.ok(playerHtml.includes('Reviewer access required.') && !playerHtml.includes(fixtureName), 'Players see no review queue.');
    assert.equal((await decide(jars.claimant, claimId, 'approve')).status, 403, 'Player cannot decide, even their own claim.');
    assert.equal((await request(`/api/console/ownership/evidence/${claimId}`, jars.claimant)).status, 403, 'Player cannot read evidence, even their own.');

    stage = 'queue and detail pages';
    const queueHtml = await (await request('/console/ownership', jars.moderator)).text();
    assert.ok(queueHtml.includes(fixtureName) && queueHtml.includes(proposedName), 'Moderator queue lists both requests.');
    for (const secret of [claimPath, venuePath, settings.SERVICE_ROLE_KEY]) assert.ok(!queueHtml.includes(secret), 'Queue exposes no evidence path or key.');
    const detailHtml = await (await request(`/console/ownership/${submissionId}`, jars.moderator)).text();
    assert.ok(detailHtml.includes(proposedName) && detailHtml.includes(fixtureName) && detailHtml.includes('Possible duplicates'), 'Detail shows the duplicate listing.');
    assert.ok(!detailHtml.includes(venuePath) && !detailHtml.includes(settings.SERVICE_ROLE_KEY), 'Detail exposes no evidence path or key.');
    assert.equal((await request(`/console/ownership/${randomUUID()}`, jars.moderator)).status, 404, 'Unknown request is not found.');

    stage = 'evidence streaming';
    const photo = await request(`/api/console/ownership/evidence/${claimId}`, jars.moderator);
    assert.equal(photo.status, 200, 'Reviewer receives evidence.');
    assert.equal(photo.headers.get('content-type'), 'image/jpeg');
    assert.match(photo.headers.get('cache-control') ?? '', /no-store/);
    assert.match(photo.headers.get('content-security-policy') ?? '', /sandbox/);
    assert.equal(photo.headers.get('x-content-type-options'), 'nosniff');
    assert.equal(photo.headers.get('cross-origin-resource-policy'), 'same-origin');
    assert.ok(Buffer.from(await photo.arrayBuffer()).equals(JPEG), 'Evidence bytes stream unchanged.');
    assert.equal((await request(`/api/console/ownership/evidence/${claimId}`, jars.moderator, undefined, { 'Sec-Fetch-Site': 'cross-site' })).status, 403, 'Cross-site evidence fetch denied.');
    assert.equal((await request('/api/console/ownership/evidence/not-a-uuid', jars.moderator)).status, 404);
    assert.equal((await request(`/api/console/ownership/evidence/${randomUUID()}`, jars.moderator)).status, 404);

    stage = 'decision input, CSRF and admin-only listing';
    assert.equal((await decide(jars.moderator, claimId, 'approve', null, null, { Origin: 'https://attacker.invalid' })).status, 403, 'Cross-site decision denied.');
    const smuggled = await request('/api/console/ownership/decide', jars.moderator, { subject_id: claimId, decision: 'approve', target_venue_id: null, rejection_reason: null, actor_user_id: users.admin.id });
    assert.equal(smuggled.status, 400, 'Caller cannot supply an actor.');
    assert.equal((await decide(jars.moderator, submissionId, 'approve_new')).status, 400, 'The retired decision is rejected.');
    assert.equal((await decide(jars.moderator, submissionId, 'approve')).status, 403, 'Moderators cannot publish listings.');
    assert.equal(value(`select publication_status from public.venues where id = '${draftId}';`), 'draft', 'Denied approval published nothing.');

    stage = 'concurrent conflicting decisions';
    const raced = await Promise.all([decide(jars.moderator, claimId, 'approve'), decide(jars.admin, claimId, 'reject', 'not_owner')]);
    assert.deepEqual(raced.map((response) => response.status).sort(), [200, 409], 'Exactly one concurrent decision wins.');
    const approved = raced[0].status === 200;
    assert.equal(value(`select status from private.venue_claims where id = '${claimId}';`), approved ? 'approved' : 'rejected');
    assert.equal(value(`select count(*) from private.ownership_audit_events where subject_id = '${claimId}' and action in ('claim.approve', 'claim.reject');`), '1', 'One decision audit row.');
    assert.equal(value(`select count(*) from private.venue_owners where venue_id = '${venueId}' and user_id = '${users.claimant.id}';`), approved ? '1' : '0', 'Owner linked only on approval.');
    const repeat = approved ? await decide(jars.admin, claimId, 'approve') : await decide(jars.moderator, claimId, 'reject', 'not_owner');
    assert.equal(repeat.status, 200);
    assert.equal((await repeat.json()).data.outcome, 'existing', 'Repeating the recorded decision is retry-safe.');
    const publicClient = createClient(api.href, settings.ANON_KEY, options);
    clients.push(publicClient);
    const listed = check(await publicClient.from('venues').select('claim_status').eq('id', venueId), 'Public read.');
    assert.equal(listed[0].claim_status, approved ? 'verified' : 'unclaimed', 'Public badge follows the decision.');

    stage = 'new listing approval';
    const created = await decide(jars.admin, submissionId, 'approve');
    assert.equal(created.status, 200, 'Admin approves and publishes the owner draft.');
    const item = (await created.json()).data.item;
    assert.equal(item.review.resolved_venue_id, draftId, 'Approval resolves to the owner draft.');
    assert.equal(item.review.resolution, 'new');
    assert.equal(check(await publicClient.from('venues').select('id').eq('id', draftId), 'Public read.').length, 1, 'Approved listing is public.');
    assert.equal(value(`select publication_status || ':' || claim_status || ':' || (select count(*) from public.courts c where c.venue_id = v.id) from public.venues v where id = '${draftId}';`), 'approved:verified:2');
    assert.equal(value(`select count(*) from private.venue_owners where venue_id = '${draftId}' and user_id = '${users.submitter.id}';`), '1', 'Submitter owns the listing.');
    const audit = check(await service.rpc('directory_admin_audit_read', { actor_user_id: users.admin.id, target_venue_id: draftId }), 'Directory audit.');
    assert.deepEqual(audit.items.map((event) => event.action).sort(), ['directory.publish', 'owner.create'], 'Draft creation and publication are directory-audited.');

    stage = 'submitter privacy';
    const mobile = createClient(api.href, settings.ANON_KEY, options);
    clients.push(mobile);
    check(await mobile.auth.signInWithPassword({ email: users.submitter.email, password: users.submitter.password }), 'Submitter sign-in.');
    const mine = check(await mobile.rpc('my_owner_submissions'), 'Own submissions.');
    const own = mine.find((entry) => entry.id === submissionId);
    assert.ok(own && own.status === 'approved' && own.venue_id === draftId, 'Submitter sees approval and the resolved listing.');
    assert.deepEqual(Object.keys(own).sort(), ['city', 'created_at', 'id', 'kind', 'name', 'status', 'venue_id']);
    assert.ok(!JSON.stringify(mine).includes(venuePath) && !JSON.stringify(mine).includes(venueId), 'No evidence path or reviewer duplicate snapshot.');
    assert.equal((await mobile.rpc('ownership_review_read', { actor_user_id: users.admin.id, subject_id: submissionId })).error?.code, '42501', 'Clients cannot call review RPCs.');
    assert.equal(value(`select string_agg(action, ',' order by action) from private.ownership_audit_events where subject_id in ('${claimId}', '${submissionId}');`),
      `${approved ? 'claim.approve' : 'claim.reject'},claim.submit,venue.approve,venue.submit`, 'One audit row per command.');

    stage = 'moderation console';
    // T46: a player's report on the claimed listing, then moderation through the production console.
    const reported = check(await service.rpc('venue_report_submit', { actor_user_id: users.submitter.id,
      report_input: { request_id: randomUUID(), venue_id: venueId, reason: 'unsafe', details: 'Broken fence by court 1' } }), 'Fixture report.');
    const reportId = reported.report.id;
    const moderate = (jar, body, headers) => request('/api/console/moderation/decide', jar, body, headers);
    const reportsGuest = await request('/console/reports');
    assert.ok([303, 307].includes(reportsGuest.status) && reportsGuest.headers.get('location') === '/login', 'Guest reports page redirects to sign-in.');
    const suspend = { venue_id: venueId, decision: 'suspend', reason: 'unsafe', report_ids: [reportId] };
    assert.equal((await moderate(new Map(), suspend)).status, 401, 'Guest moderation denied.');
    const playerReports = await (await request('/console/reports', jars.claimant)).text();
    assert.ok(playerReports.includes('Moderator access required.') && !playerReports.includes(fixtureName), 'Players see no reports.');
    assert.equal((await moderate(jars.claimant, suspend)).status, 403, 'Player cannot moderate.');
    const reportsHtml = await (await request('/console/reports', jars.moderator)).text();
    assert.ok(reportsHtml.includes(fixtureName), 'Moderator queue lists the reported listing.');
    const reportHtml = await (await request(`/console/reports/${venueId}`, jars.moderator)).text();
    assert.ok(reportHtml.includes('Broken fence by court 1') && reportHtml.includes('Suspend listing') && !reportHtml.includes(settings.SERVICE_ROLE_KEY), 'Detail shows the report.');
    assert.equal((await request(`/console/reports/${randomUUID()}`, jars.moderator)).status, 404, 'Unknown listing is not found.');
    assert.equal((await moderate(jars.moderator, suspend, { Origin: 'https://attacker.invalid' })).status, 403, 'Cross-site moderation denied.');
    assert.equal((await moderate(jars.moderator, { ...suspend, actor_user_id: users.admin.id })).status, 400, 'Caller cannot supply an actor.');
    const suspended = await moderate(jars.moderator, suspend);
    assert.equal(suspended.status, 200, 'Moderator suspends the listing.');
    assert.equal((await suspended.json()).data.item.venue.publication_status, 'suspended');
    assert.equal(check(await publicClient.from('venues').select('id').eq('id', venueId), 'Public read.').length, 0, 'Suspended listing leaves Discover.');
    assert.equal((await (await moderate(jars.admin, suspend)).json()).data.outcome, 'existing', 'Repeating the suspension is retry-safe.');
    const revoked = await request('/api/console/moderation/revoke', jars.moderator, { venue_id: venueId, owner_user_id: users.claimant.id, reason: 'not_owner' });
    assert.equal(revoked.status, 200, 'Moderator removes an owner.');
    assert.equal((await revoked.json()).data.outcome, approved ? 'decided' : 'existing', 'Only a linked owner is removed.');
    assert.equal(value(`select count(*) from private.venue_owners where venue_id = '${venueId}';`), '0');
    const reinstated = await moderate(jars.admin, { venue_id: venueId, decision: 'reinstate', reason: null, report_ids: [] });
    assert.equal(reinstated.status, 200, 'Administrator lifts the suspension.');
    assert.equal(check(await publicClient.from('venues').select('claim_status').eq('id', venueId), 'Public read.')[0]?.claim_status, 'unclaimed', 'Published again, unclaimed.');
    assert.equal(value(`select string_agg(action, ',' order by id) from private.moderation_audit_events where target_venue_id = '${venueId}';`),
      `report.submit,venue.suspend,report.resolve,${approved ? 'owner.revoke,' : ''}venue.reinstate`, 'One moderation audit row per change.');
    console.log('PASS: production moderation console: guest/player denial, reviewer queue/detail, CSRF/actor rejection, suspend (retry-safe) leaves Discover, owner removal, admin reinstatement, audited once each.');

    stage = 'revocation';
    sql(`delete from private.account_roles where user_id = '${users.moderator.id}'::uuid;`);
    assert.equal((await moderate(jars.moderator, suspend)).status, 403, 'Revoked moderator cannot moderate.');
    assert.equal((await request(`/api/console/ownership/evidence/${claimId}`, jars.moderator)).status, 403, 'Revoked reviewer loses evidence access.');
    assert.equal((await decide(jars.moderator, claimId, 'approve')).status, 403, 'Revoked reviewer cannot decide.');
    assert.ok((await (await request('/console/ownership', jars.moderator)).text()).includes('Reviewer access required.'), 'Revoked reviewer loses the queue.');
    console.log('PASS: production review console: guest/player/revoked denial, reviewer-only queue/detail, no-store sandboxed evidence, CSRF/actor rejection, admin-only listings.');
    console.log(`PASS: concurrent approve/reject: one winner (${approved ? 'approve' : 'reject'}), one 409, one audit row; retry returns existing; submitter sees no evidence or snapshot.`);
  } catch (error) {
    // Fixed stage labels and our own assertion messages only: no emails, codes, tokens or SDK errors.
    const detail = error?.code === 'ERR_ASSERTION' && error.generatedMessage === false ? ` (${error.message})` : '';
    throw new Error(`Local review verification failed at: ${stage}${detail}.`);
  } finally {
    if (child && child.exitCode === null) {
      child.kill();
      await new Promise((resolve) => { child.once('exit', resolve); setTimeout(resolve, 3000); });
    }
    for (const client of clients) { try { await client.auth.signOut({ scope: 'local' }); await client.auth.dispose?.(); } catch {} }
    if (evidence.length) {
      try { if ((await service.storage.from('owner-evidence').remove(evidence)).error) cleanupFailed = true; } catch { cleanupFailed = true; }
    }
    // Users first: their submissions cascade, so no pending submission ever loses its draft.
    const ids = Object.values(users).map((user) => user.id);
    for (const id of ids) {
      try { if ((await service.auth.admin.deleteUser(id)).error) cleanupFailed = true; } catch { cleanupFailed = true; }
    }
    for (const id of venues) {
      try { if ((await service.from('venues').delete().eq('id', id)).error) cleanupFailed = true; } catch { cleanupFailed = true; }
    }
    // Audit tables have no cascading FKs; trusted local SQL removes only this run's actor history.
    if (ids.length) {
      const list = ids.map((id) => `'${id}'::uuid`).join(',');
      try { sql(`delete from private.ownership_audit_events where actor_user_id in (${list}); delete from private.directory_audit_events where actor_user_id in (${list}); delete from private.moderation_audit_events where actor_user_id in (${list});`); }
      catch { cleanupFailed = true; }
    }
    if (messageIds.size) {
      try {
        const removed = await boundedFetch(new URL('/api/v1/messages', inbox), { method: 'DELETE', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ IDs: [...messageIds] }) });
        if (!removed.ok) cleanupFailed = true;
      } catch { cleanupFailed = true; }
    }
    await service.auth.dispose?.();
    if (cleanupFailed) throw new Error('Own local review fixtures could not be fully cleaned up.');
  }
  console.log('PASS: own local accounts, venues, evidence, audit rows and mail removed; test server stopped; no hosted changes.');
}
main().catch((error) => {
  console.error(/^(Local review verification failed at:|Own local review fixtures)/.test(error.message ?? '') ? error.message : 'Local review test setup failed. Check the admin build and local Supabase.');
  process.exitCode = 1;
});
