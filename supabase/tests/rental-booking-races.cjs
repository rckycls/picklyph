// T26 extension of the local-only harness; all IDs/SQL workers belong to its fixtures.
const assert = require('node:assert/strict');
const { randomUUID } = require('node:crypto');
const mobile = require('../../src/features/rental/__tests__/helpers.cjs');

module.exports = async function rentalBookingRaces(h) {
  const { psql, query, waitFor, users, venue, courts, quote, command, post, change, get, daily, mobileTransport } = h;
  const owner = users[0]; const player = users[1];
  const result = worker => {
    assert.equal(worker.code, 0, worker.error);
    return JSON.parse(worker.output.trim());
  };
  const read = async id => {
    const response = await get(1, { section: 'booking', booking_id: id });
    assert.equal(response.status, 200);
    return (await response.json()).booking;
  };
  const requestSql = c => `select public.rental_booking_request('${player}','${c.court_id}','${c.request_id}',
    '${c.starts_at}','${c.ends_at}','${JSON.stringify(c.expected_quote)}');`;
  const changeSql = (actor, kind, id) => `select public.rental_booking_change('${actor}','${id}','${kind}');`;
  const reserve = async minute => {
    const c = command(minute, await quote(minute));
    const response = await post(1, c); assert.equal(response.status, 200);
    return { c, b: (await response.json()).booking };
  };
  const events = id => JSON.parse(psql(`select coalesce(jsonb_object_agg(action,n),'{}') from
    (select action,count(*) n from private.rental_events where booking_id='${id}' group by action) counts;`));
  const oneRecord = (c, id) => {
    assert.equal(psql(`select count(*) from private.court_allocations a join private.rental_bookings b on b.id=a.id
      join private.rental_snapshots s on s.allocation_id=a.id
      where a.requested_by='${player}' and a.request_id='${c.request_id}' and a.id='${id}';`), '1');
  };
  const counts = () => psql(`select jsonb_build_array(
    (select count(*) from private.court_allocations where venue_id='${venue}'),
    (select count(*) from private.rental_bookings b join private.court_allocations a on a.id=b.id where a.venue_id='${venue}'),
    (select count(*) from private.rental_snapshots s join private.court_allocations a on a.id=s.allocation_id where a.venue_id='${venue}'),
    (select count(*) from private.rental_events e join private.court_allocations a on a.id=e.booking_id where a.venue_id='${venue}'));`);
  const policySql = confirmation => {
    const revision = psql(`select private.venue_policy_view('${venue}')->>'revision';`);
    return `select public.owner_venue_policy_save('${owner}','${venue}','${revision}',
      '{"confirmation":"${confirmation}","payment":"arrival"}');`;
  };
  const scheduleSql = rate => {
    const revision = psql(`select revision from private.venue_schedules where venue_id='${venue}';`);
    return `select public.venue_schedule_save('${owner}','${venue}','${revision}','${JSON.stringify(daily(rate))}');`;
  };
  const race = async (firstSql, secondSql, label) => {
    const holder = query(`begin; ${firstSql}`, `${label}-first`, true);
    await waitFor(`${label}-first`);
    const waiter = query(secondSql, `${label}-waits`);
    await waitFor(`${label}-waits`, true); holder.finish();
    return Promise.all([holder, waiter]);
  };

  const overlapping = await Promise.all(Array.from({ length: 6 }, async (_, i) => {
    const minute = 1500 + (i % 2) * 30;
    return post(1 + i % 2, command(minute, await quote(minute)));
  }));
  assert.deepEqual(overlapping.map(r => r.status).sort(), [200, 409, 409, 409, 409, 409]);
  const winner = (await overlapping.find(r => r.status === 200).json()).booking;
  assert.deepEqual(events(winner.id), { request: 1 });
  assert.equal(psql(`select count(*) from private.court_allocations where venue_id='${venue}'
    and starts_at>='${h.at(1500)}' and starts_at<='${h.at(1530)}';`), '1');
  const separate = await Promise.all([[1620, courts[0]], [1680, courts[0]], [1770, courts[0]], [1770, courts[1]]]
    .map(async ([minute, court]) => post(1, command(minute, await quote(minute, court), randomUUID(), court))));
  assert.ok(separate.every(r => r.status === 200), 'Concurrent adjacent and different-court reservations');
  console.log('PASS: T26 six partially overlapping rentals yield one booking/event; concurrent adjacency and different courts all succeed.');

  // Both serializations are forced by observing a real PostgreSQL lock wait.
  for (const [i, first] of ['accept', 'cancel'].entries()) {
    const { c, b } = await reserve(1860 + i * 90); assert.equal(b.status, 'pending');
    const second = first === 'accept' ? 'cancel' : 'accept';
    const pair = await race(changeSql(first === 'accept' ? owner : player, first, b.id),
      changeSql(second === 'accept' ? owner : player, second, b.id), `t26-${first}-cancel`);
    result(pair[0]);
    if (second === 'cancel') result(pair[1]);
    else { assert.notEqual(pair[1].code, 0); assert.match(pair[1].error, /invalid_transition/); }
    const final = await read(b.id); assert.equal(final.status, 'cancelled'); assert.equal(final.allocation.state, 'released');
    assert.deepEqual(final.snapshot, b.snapshot);
    assert.deepEqual(events(b.id), first === 'accept' ? { request: 1, accept: 1, cancel: 1 } : { request: 1, cancel: 1 });
    const before = counts();
    const retry = await post(1, c); assert.equal(retry.status, 200);
    assert.equal((await retry.json()).booking.status, 'cancelled'); assert.equal(counts(), before); oneRecord(c, b.id);
  }
  for (const [i, kind] of ['accept', 'decline', 'cancel', 'expire'].entries()) {
    const { b } = await reserve(2040 + i * 90);
    if (kind === 'expire') psql(`update private.court_allocations set expires_at=clock_timestamp()-interval '1 second' where id='${b.id}';`);
    const replies = await Promise.all(Array.from({ length: 6 }, () => change(kind === 'cancel' ? 1 : 0, kind, b.id)));
    assert.ok(replies.every(r => r.status === 200));
    const bodies = await Promise.all(replies.map(r => r.json()));
    assert.equal(bodies.filter(r => r.outcome !== 'existing').length, 1);
    assert.deepEqual(events(b.id), { request: 1, [kind]: 1 });
    for (const reply of bodies) assert.deepEqual(reply.booking.snapshot, b.snapshot);
    const final = await read(b.id);
    assert.equal(final.status, { accept: 'confirmed', decline: 'declined', cancel: 'cancelled', expire: 'expired' }[kind]);
    assert.equal(final.allocation.state, kind === 'accept' ? 'active' : kind === 'expire' ? 'expired' : 'released');
  }
  console.log('PASS: T26 accept/cancel in both lock orders and six-way duplicate accept/decline/cancel/expire preserve snapshots and exactly one event per action.');

  const old = await reserve(2400);
  psql(`update private.court_allocations set expires_at=clock_timestamp()-interval '1 second' where id='${old.b.id}';`);
  const replacement = command(2400, await quote(2400));
  const expiryPair = await race(requestSql(replacement), changeSql(owner, 'accept', old.b.id), 't26-replace-expired');
  const newer = result(expiryPair[0]).booking; const ended = result(expiryPair[1]).booking;
  assert.equal(newer.status, 'pending'); assert.equal(ended.status, 'expired');
  assert.equal(ended.allocation.state, 'expired'); assert.deepEqual(ended.snapshot, old.b.snapshot);
  const beforeExpiredRetry = counts();
  assert.equal((await (await post(1, old.c)).json()).booking.status, 'expired');
  assert.equal(counts(), beforeExpiredRetry); oneRecord(old.c, old.b.id);
  assert.deepEqual(events(old.b.id), { request: 1, expire: 1 });
  const accepted = await reserve(2490);
  const acceptedPair = await race(changeSql(owner, 'accept', accepted.b.id), changeSql(player, 'expire', accepted.b.id), 't26-accept-expire');
  result(acceptedPair[0]); assert.equal(result(acceptedPair[1]).booking.status, 'confirmed');
  assert.deepEqual(events(accepted.b.id), { request: 1, accept: 1 });
  console.log('PASS: T26 replacement acquires elapsed inventory before waited acceptance; original retry cannot revive it; expiry after acceptance cannot release a firm booking.');

  // Request-first complements the editor-first stale-review cases in the main harness.
  for (const [i, edit] of ['schedule', 'policy'].entries()) {
    const minute = 2580 + i * 90; const c = command(minute, await quote(minute));
    const pair = await race(requestSql(c), edit === 'schedule' ? scheduleSql(61000) : policySql('instant'), `t26-request-${edit}`);
    const booked = result(pair[0]).booking; result(pair[1]);
    assert.equal(booked.snapshot.total_centavos, c.expected_quote.total_centavos);
    assert.equal(booked.snapshot.schedule_revision, c.expected_quote.schedule_revision);
    assert.equal(booked.snapshot.policy_revision, c.expected_quote.policy_revision);
    const before = counts();
    assert.equal((await post(1, { ...c, request_id: randomUUID() })).status, 409, 'New key cannot use stale review');
    const retried = await post(1, c); assert.equal(retried.status, 200);
    assert.deepEqual((await retried.json()).booking.snapshot, booked.snapshot);
    assert.equal(counts(), before); oneRecord(c, booked.id);
  }
  psql(policySql('approval'));
  const revokeSql = `select id from public.venues where id='${venue}' for update;
    delete from private.venue_owners where venue_id='${venue}' and user_id='${owner}';`;
  const revoked = await reserve(2760);
  let pair = await race(revokeSql, changeSql(owner, 'accept', revoked.b.id), 't26-revoke-accept');
  assert.equal(pair[0].code, 0); assert.notEqual(pair[1].code, 0); assert.match(pair[1].error, /not_owner/);
  assert.equal((await read(revoked.b.id)).status, 'pending'); assert.deepEqual(events(revoked.b.id), { request: 1 });
  psql(`insert into private.venue_owners(user_id,venue_id) values('${owner}','${venue}');`);
  pair = await race(changeSql(owner, 'accept', revoked.b.id), revokeSql, 't26-accept-revoke');
  result(pair[0]); assert.equal(pair[1].code, 0);
  assert.equal((await read(revoked.b.id)).status, 'confirmed'); assert.deepEqual(events(revoked.b.id), { request: 1, accept: 1 });
  assert.equal((await change(0, 'accept', revoked.b.id)).status, 403, 'Retry rechecks revoked ownership');
  assert.equal((await get(0, { section: 'requests', venue_id: venue })).status, 403);
  assert.equal((await change(1, 'cancel', revoked.b.id)).status, 200, 'Original player still releases inventory');
  psql(`insert into private.venue_owners(user_id,venue_id) values('${owner}','${venue}');`);
  console.log('PASS: T26 request-first rate/policy edits preserve original snapshots; revocation/acceptance in both lock orders respects current ownership and player cancellation.');

  // Drop a committed reply, change current rules, end the booking, then recreate the mobile journal.
  for (const [i, terminal] of ['cancelled', 'expired'].entries()) {
    const store = mobile.memory(); const journal = mobile.createAttemptJournal(store, `local.t26.${terminal}`);
    const c = command(2850 + i * 90, await quote(2850 + i * 90)); let committed;
    const transport = { ...mobileTransport, fetch: async (url, init) => {
      const reply = await mobileTransport.fetch(url, init);
      if (init.method === 'POST' && JSON.parse(init.body).kind === 'request' && !committed) {
        assert.equal(reply.status, 200); committed = (await reply.json()).booking;
        throw new Error('Lost committed reply');
      }
      return reply;
    } };
    assert.equal((await journal.run(c, original => mobile.client.requestRental(transport, original))).failure.kind, 'network');
    if (terminal === 'cancelled') assert.equal((await change(1, 'cancel', committed.id)).status, 200);
    else psql(`update private.court_allocations set expires_at=clock_timestamp()-interval '1 second' where id='${committed.id}';`);
    psql(scheduleSql(62000 + i * 1000)); psql(policySql('instant'));
    const before = counts(); const restored = mobile.createAttemptJournal(store, `local.t26.${terminal}`);
    assert.deepEqual(mobile.plain(await restored.read()), c);
    const reply = await restored.run(await restored.read(), original => mobile.client.requestRental(transport, original));
    assert.equal(reply.ok, true); assert.equal(reply.value.outcome, 'existing'); assert.equal(reply.value.booking.status, terminal);
    assert.deepEqual(mobile.plain(reply.value.booking.snapshot), mobile.plain(mobile.client.parseBooking(committed).snapshot));
    assert.equal(await restored.read(), null); assert.equal(counts(), before); oneRecord(c, committed.id);
    psql(policySql('approval'));
  }
  console.log('PASS: T26 mobile restart after lost commit + rate/policy edits recovers cancelled/expired status and original snapshot without new inventory/events.');
  return { counts, events };
};
