const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { test } = require('node:test');
const { storageStub } = require('./platform.cjs');

const REDEEM = 'public.owner_redeem_registration(uuid,uuid,text,text,text)';
const CHECK = 'public.owner_registration_check(uuid,text)';
const SWEEP = 'private.privacy_retention_sweep(integer)';
// Each mutation weakens one rule; the suite must notice every one. Pairs apply together.
const mutations = [
  [REDEEM, [["if locked is not null then\n    return private.claim_code_refusal(locked) || jsonb_build_object('submission'",
    "if false then\n    return private.claim_code_refusal(locked) || jsonb_build_object('submission'"]]],
  [CHECK, [["if locked is not null then\n    return private.claim_code_refusal(locked) || jsonb_build_object('registration'",
    "if false then\n    return private.claim_code_refusal(locked) || jsonb_build_object('registration'"]]],
  ['private.claim_code_fail(uuid,timestamp with time zone)', [['when f.failures + 1 >= 5 then', 'when f.failures + 1 >= 6 then']]],
  ['private.claim_code_fail(uuid,timestamp with time zone)', [["<= at_time - interval '60 minutes'", "<= at_time - interval '600 minutes'"]]],
  ['private.claim_code_lock_seconds(uuid,timestamp with time zone)', [['if until is not null and until > at_time then', 'if until is not null then']]],
  [REDEEM, [["where v.id = listing.id and v.claim_status = 'unclaimed';", 'where false;']]],
  [REDEEM, [["insert into private.ownership_audit_events (actor_user_id, action, subject_id, target_venue_id)\n    values (actor_user_id, 'registration.claim', saved_id, listing.id);", 'perform 1;']]],
  [REDEEM, [['claim_email_matched = coalesce(account_email = r.email, false)', 'claim_email_matched = true']]],
  [REDEEM, [['where x.id <> listing.id;', ';']]],
  [REDEEM, [["if listing.claim_status = 'verified' then", 'if false then']]],
  [REDEEM, [["if listing.publication_status = 'suspended' then", 'if false then']]],
  [CHECK, [["if listing.publication_status = 'suspended' then", 'if false then']]],
  [REDEEM, [["if exists (select 1 from private.venue_submissions s where s.submitter_user_id = actor_user_id and s.status = 'pending'",
    "if false and exists (select 1 from private.venue_submissions s where s.submitter_user_id = actor_user_id and s.status = 'pending'"]]],
  [REDEEM, [['perform private.require_owner_pending_capacity(actor_user_id);', '']]],
  [REDEEM, [['perform private.require_owner_evidence(actor_user_id, evidence_ref);', '']]],
  [REDEEM, [['delete from private.claim_code_failures f where f.user_id = actor_user_id;', '']]],
  [REDEEM, [['if exists (select 1 from private.venue_registrations r where r.submission_id = existing_id) then', 'if false then']]],
  ['public.ownership_review_queue(uuid,timestamp with time zone,uuid)', [['exists (select 1 from private.venue_registrations r where r.submission_id = s.id)', 'false']]],
  ['public.ownership_review_read(uuid,uuid)', [["private.has_account_role(actor_user_id, 'admin')", 'true']]],
  ['public.ownership_review_read(uuid,uuid)', [["where r.submission_id = subject_id and r.status = 'claimed';", 'where r.submission_id = subject_id;']]],
  ['private.registration_review(uuid)', [["'erased', r.status = 'erased'", "'erased', false"]]],
  [SWEEP, [["(s.reviewed_at is null or s.reviewed_at >= clock_timestamp() - interval '30 days'))\n    order by", "(s.reviewed_at is null or s.reviewed_at >= clock_timestamp() - interval '0 days'))\n    order by"],
    ["(s.reviewed_at is null or s.reviewed_at >= clock_timestamp() - interval '30 days')) for update", "(s.reviewed_at is null or s.reviewed_at >= clock_timestamp() - interval '0 days')) for update"]]],
  [SWEEP, [["(s.reviewed_at is null or s.reviewed_at >= clock_timestamp() - interval '30 days'))\n    order by", "(s.reviewed_at >= clock_timestamp() - interval '30 days'))\n    order by"],
    ["(s.reviewed_at is null or s.reviewed_at >= clock_timestamp() - interval '30 days')) for update", "(s.reviewed_at >= clock_timestamp() - interval '30 days')) for update"]]],
  [SWEEP, [["'prelaunch_registrations', erased + claimed", "'prelaunch_registrations', erased"]]],
];

test('pre-launch claims (T54): code checks, the wrong-code lockout, redemption into a pending submission, retries, refusals, reviewer contacts and the sweep on PostgreSQL/PostGIS; every mutation is caught', async () => {
  const { PGlite } = await import('@electric-sql/pglite');
  const { postgis } = await import('@electric-sql/pglite-postgis');
  const { pg_trgm } = await import('@electric-sql/pglite/contrib/pg_trgm');
  const { btree_gist } = await import('@electric-sql/pglite/contrib/btree_gist');
  const db = new PGlite({ extensions: { postgis, pg_trgm, btree_gist } });
  try {
    // Redemption compares the account email, so this stub (unlike the shared one) carries it.
    await db.exec(`create role anon; create role authenticated; create role service_role bypassrls;
      create schema auth; grant usage on schema auth to anon, authenticated, service_role;
      create table auth.users(id uuid primary key, email text, raw_user_meta_data jsonb default '{}');
      create function auth.uid() returns uuid language sql stable as $$
        select (nullif(current_setting('request.jwt.claims', true), '')::jsonb ->> 'sub')::uuid; $$;
      ${storageStub}`);
    const root = path.resolve(__dirname, '..');
    for (const file of fs.readdirSync(path.join(root, 'migrations')).filter((f) => f.endsWith('.sql')).sort()) {
      await db.exec(fs.readFileSync(path.join(root, 'migrations', file), 'utf8'));
    }
    const suite = fs.readFileSync(path.join(__dirname, 'prelaunch-claims.sql'), 'utf8');
    await db.exec(suite);
    for (const table of ['private.venue_registrations', 'private.venue_submissions', 'private.claim_code_failures', 'private.ownership_audit_events', 'public.venues']) {
      assert.equal((await db.query(`select count(*)::integer as n from ${table}`)).rows[0].n, 0, `${table} fixtures roll back`);
    }
    assert.equal((await db.query("select to_regnamespace('pc_test') is null as gone")).rows[0].gone, true);

    for (const [fn, pairs] of mutations) {
      let def = (await db.query('select pg_get_functiondef($1::regprocedure) d', [fn])).rows[0].d;
      for (const [from, to] of pairs) {
        assert.equal(def.split(from).length, 2, `${fn} contains the mutated text once: ${from}`);
        def = def.replace(from, to);
      }
      await db.exec('begin;'); await db.exec(def);
      await assert.rejects(db.exec(suite), /assertion failed/i, `${fn}: ${pairs.map(([, to]) => to).join(' / ')}`);
      await db.exec('rollback;');
    }
  } catch (e) { throw new Error(`Prelaunch claims SQL ${e.code ?? ''}: ${e.message}${e.where ? ` (${e.where})` : ''}`); }
  finally { await db.close(); }
});
