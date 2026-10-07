// Local Docker only; no mobile/hosted env or external APIs.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { randomUUID } = require('node:crypto');
const { execFileSync, spawn } = require('node:child_process');

async function main() {
  const dockerPath = path.join(process.env.LOCALAPPDATA ?? '', 'Programs/DockerDesktop/resources/bin/docker.exe');
  const docker = fs.existsSync(dockerPath) ? dockerPath : 'docker';
  const run = (args, input) => execFileSync(docker, args, { input, encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'], timeout: 60000 });
  const context = run(['context', 'show']).trim();
  const host = process.env.DOCKER_HOST || run(['context', 'inspect', context, '--format', '{{.Endpoints.docker.Host}}']).trim();
  assert.ok(host.startsWith('npipe://') || host.startsWith('unix://'), 'Local Docker required');
  assert.equal(run(['inspect', 'supabase_db_picklyph', '--format', '{{index .Config.Labels "com.supabase.cli.project"}}']).trim(), 'picklyph');
  const args = ['exec', '-i', 'supabase_db_picklyph', 'psql', '-U', 'postgres', '-d', 'postgres', '-X', '-q', '-t', '-A', '-v', 'ON_ERROR_STOP=1'];
  const psql = sql => run(args, sql).trim();
  run([...args, '-o', '/dev/null'], fs.readFileSync(path.join(__dirname, 'rentals.sql'), 'utf8'));
  console.log('PASS: Docker rental SQL boundaries, permissions, rollback, rates/policy edits, immutable retries, overnight and overflow; fixtures rolled back.');
  const owner = randomUUID(); const player = randomUUID(); const venue = randomUUID(); const court = randomUUID();
  const prefix = `pickly-rental-${randomUUID().slice(0, 8)}`;
  const day = new Date(Date.now() + 8 * 3600000 + 2 * 86400000).toISOString().slice(0, 10);
  const at = minute => new Date(Date.parse(`${day}T00:00:00+08:00`) + minute * 60000).toISOString();
  const daily = rate => JSON.stringify({ weekly: Array.from({ length: 7 }, () => [{ start_minute: 0, end_minute: 1440,
    rates: [{ start_minute: 0, end_minute: 1440, hourly_centavos: rate }] }]), exceptions: [] });
  const acquire = (minute, request = randomUUID(), expiry = 'null') =>
    `select private.rental_acquire('${player}','${court}','${at(minute)}','${at(minute + 60)}',${expiry},'${request}');`;
  const schedule = (revision, rate) => `select public.venue_schedule_save('${owner}','${venue}','${revision}','${daily(rate)}');`;
  const policy = (revision, confirmation) => `select public.owner_venue_policy_save('${owner}','${venue}','${revision}','{"confirmation":"${confirmation}","payment":"arrival"}');`;
  const workers = new Set();
  const query = (sql, label, hold = false) => {
    const child = spawn(docker, args, { stdio: ['pipe', 'pipe', 'pipe'] }); workers.add(child);
    let output = ''; let error = '';
    child.stdout.on('data', data => { output += data; }); child.stderr.on('data', data => { error += data; });
    const result = new Promise(resolve => {
      child.once('error', err => { workers.delete(child); resolve({ code: -1, output, error: err.message }); });
      child.once('close', code => { workers.delete(child); resolve({ code, output, error }); });
    });
    const input = `set application_name='${prefix}-${label}'; ${sql}\n`;
    if (hold) child.stdin.write(input); else child.stdin.end(input);
    result.finish = () => child.stdin.end('commit;\n');
    return result;
  };
  const waitFor = async (label, locking = false) => {
    const deadline = Date.now() + 8000;
    while (Date.now() < deadline) {
      if (psql(`select exists(select 1 from pg_stat_activity where application_name='${prefix}-${label}'
        and ${locking ? "wait_event_type='Lock'" : "state='idle in transaction'"});`) === 't') return;
      await new Promise(resolve => setTimeout(resolve, 15));
    }
    throw new Error(`Worker ${label} did not reach expected ${locking ? 'lock wait' : 'lock holder'}`);
  };
  const success = result => { assert.equal(result.code, 0, result.error); return result.output.trim().split('\n').filter(Boolean).map(line => JSON.parse(line)); };
  try {
    psql(`insert into auth.users(id) values ('${owner}'),('${player}');
      insert into public.venues(id,name,address_line,city,province,latitude,longitude,publication_status,claim_status)
      values('${venue}','Local Rental Fixture','Fixture','Fixture','Fixture',14.6,121,'approved','verified');
      insert into public.courts(id,venue_id,name,status) values('${court}','${venue}','A','active');
      insert into private.venue_owners(user_id,venue_id) values('${owner}','${venue}');
      select public.venue_schedule_save('${owner}','${venue}',null,'${daily(10001)}');`);
    // Booking first: editor must wait. Snapshot old revision/price; next booking sees new.
    let holder = query(`begin; ${acquire(60)}`, 'acquire-first', true);
    await waitFor('acquire-first');
    let waiter = query(schedule(1, 20001), 'schedule-waits'); await waitFor('schedule-waits', true);
    holder.finish();
    let [a, b] = await Promise.all([holder, waiter]);
    let snapshot = success(a)[0].snapshot; success(b);
    assert.equal(snapshot.total_centavos, 10001); assert.equal(snapshot.schedule_revision, '1');
    snapshot = JSON.parse(psql(acquire(150))).snapshot;
    assert.equal(snapshot.total_centavos, 20001); assert.equal(snapshot.schedule_revision, '2');
    // Editor first: a booking that entered before editor commit must resolve the NEW rules.
    holder = query(`begin; ${schedule(2, 30001)}`, 'schedule-first', true);
    await waitFor('schedule-first'); waiter = query(acquire(240), 'acquire-waits'); await waitFor('acquire-waits', true);
    holder.finish();
    [a, b] = await Promise.all([holder, waiter]); success(a); snapshot = success(b)[0].snapshot;
    assert.equal(snapshot.total_centavos, 30001); assert.equal(snapshot.schedule_revision, '3');
    // Identical lock behavior for policy edits in both orders.
    holder = query(`begin; ${acquire(330)}`, 'policy-acquire-first', true);
    await waitFor('policy-acquire-first'); waiter = query(policy(0, 'approval'), 'policy-waits'); await waitFor('policy-waits', true);
    holder.finish();
    [a, b] = await Promise.all([holder, waiter]); snapshot = success(a)[0].snapshot; success(b);
    assert.equal(snapshot.policy.confirmation, 'instant'); assert.equal(snapshot.policy_revision, '0');
    holder = query(`begin; ${policy(1, 'instant')}`, 'policy-first', true);
    await waitFor('policy-first'); waiter = query(acquire(420), 'policy-acquire-waits'); await waitFor('policy-acquire-waits', true);
    holder.finish();
    [a, b] = await Promise.all([holder, waiter]); success(a); snapshot = success(b)[0].snapshot;
    assert.equal(snapshot.policy.confirmation, 'instant'); assert.equal(snapshot.policy_revision, '2');
    console.log('PASS: Real PostgreSQL sessions serialize snapshot/rate and snapshot/policy races in both orders; waiting rentals see committed rules.');
    const request = randomUUID();
    const results = await Promise.all(Array.from({ length: 6 }, (_, i) => query(acquire(510, request), `retry-${i}`)));
    const rentals = results.map(result => success(result)[0]);
    assert.equal(rentals.filter(r => r.outcome === 'created').length, 1);
    for (const rental of rentals) assert.deepEqual(rental.snapshot, rentals[0].snapshot);
    assert.equal(psql(`select count(*) from private.rental_snapshots s join private.court_allocations a on a.id=s.allocation_id where a.request_id='${request}';`), '1');
    // Expired retry returns its snapshot and cannot revive the hold, even after rate edits.
    const holdRequest = randomUUID();
    const held = JSON.parse(psql(acquire(600, holdRequest, "clock_timestamp()+interval '400 milliseconds'")));
    psql("select pg_sleep(0.5);");
    const retried = JSON.parse(psql(acquire(600, holdRequest, "clock_timestamp()+interval '1 minute'")));
    assert.equal(retried.allocation.state, 'expired'); assert.deepEqual(retried.snapshot, held.snapshot);
    // Failure in the surrounding booking command rolls both foundation writes back.
    const failedRequest = randomUUID();
    const failed = await query(`begin; ${acquire(690, failedRequest)} do $$ begin raise exception 'Later booking failure'; end $$; commit;`, 'rollback');
    assert.notEqual(failed.code, 0);
    assert.equal(psql(`select count(*) from private.court_allocations where request_id='${failedRequest}';`), '0');
    assert.equal(psql(`select count(*) from private.rental_snapshots s left join private.court_allocations a on a.id=s.allocation_id where a.id is null;`), '0');
    console.log('PASS: Six concurrent retries create one allocation/snapshot; expired holds remain expired; later transaction failure rolls inventory/snapshot back.');
  } finally {
    // Wait for own transaction processes before removing only own fixtures.
    if (workers.size) {
      psql(`select pg_terminate_backend(pid) from pg_stat_activity where application_name like '${prefix}-%';`);
      await new Promise(resolve => setTimeout(resolve, 100));
    }
    psql(`delete from public.venues where id='${venue}'; delete from private.directory_audit_events where target_venue_id='${venue}';
      delete from auth.users where id in ('${owner}','${player}');`);
    assert.equal(psql(`select count(*) from public.venues where id='${venue}';`), '0');
    assert.equal(psql(`select count(*) from auth.users where id in ('${owner}','${player}');`), '0');
    console.log('PASS: Own local rental fixtures/accounts/audit removed.');
  }
}
main().catch(error => { console.error(error); process.exitCode = 1; });
