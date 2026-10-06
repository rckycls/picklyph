// Rollback-only SQL + own local API fixtures. Never reads mobile/hosted env.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { randomUUID } = require('node:crypto');
const { createClient } = require('@supabase/supabase-js');

async function main() {
  const desktopDocker = process.env.LOCALAPPDATA
    ? path.join(process.env.LOCALAPPDATA, 'Programs/DockerDesktop/resources/bin/docker.exe') : '';
  const docker = desktopDocker && fs.existsSync(desktopDocker) ? desktopDocker : 'docker';
  const run = (args, input) => execFileSync(docker, args, {
    input, encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'], timeout: 30000,
  });
  const context = run(['context', 'show']).trim();
  const host = process.env.DOCKER_HOST || run(['context', 'inspect', context, '--format', '{{.Endpoints.docker.Host}}']).trim();
  assert.ok(host.startsWith('npipe://') || host.startsWith('unix://'), 'Only a local Docker engine is supported.');
  const container = 'supabase_db_picklyph';
  const label = run(['inspect', container, '--format', '{{index .Config.Labels "com.supabase.cli.project"}}']).trim();
  assert.equal(label, 'picklyph', 'Expected this project’s local Supabase database.');
  const sql = fs.readFileSync(path.join(path.dirname(module.filename), 'authorization.sql'), 'utf8');
  run(['exec', '-i', container, 'psql', '-U', 'postgres', '-d', 'postgres', '-X', '-q', '-v', 'ON_ERROR_STOP=1', '-o', '/dev/null'], sql);
  console.log('PASS: authorization allow/deny suite on local Docker PostgreSQL; fixtures rolled back.');

  // CLI credentials remain in memory. Never read the mobile/hosted environment.
  const cli = path.resolve('node_modules/@supabase/cli-windows-x64/bin/supabase.exe');
  const config = JSON.parse(execFileSync(cli, ['status', '-o', 'json'], {
    stdio: ['ignore', 'pipe', 'pipe'], timeout: 20000,
  }));
  const api = new URL(config.API_URL);
  assert.ok(api.protocol === 'http:' && ['localhost', '127.0.0.1'].includes(api.hostname)
    && api.port === '54321', 'Expected this project’s loopback API.');
  const options = {
    auth: { persistSession: false, autoRefreshToken: false },
    global: { fetch: (url, init) => fetch(url, { ...init, signal: AbortSignal.timeout(10000) }) },
  };
  const server = createClient(api.href, config.SERVICE_ROLE_KEY, options);
  const users = [];
  const clients = [server];
  const venueId = randomUUID();
  let venueCreated = false;
  const check = (response, message) => { assert.ok(!response.error, message); return response.data; };
  try {
    for (let i = 0; i < 2; i++) {
      const email = `authorization-${randomUUID()}@example.test`;
      const password = `Local-${randomUUID()}!`;
      const created = check(await server.auth.admin.createUser({ email, password, email_confirm: true,
        user_metadata: { role: 'admin', owner: true } }), 'Local fixture signup must succeed.');
      assert.ok(created.user?.id, 'Fixture must return an Auth user.');
      users.push(created.user.id);
      const client = createClient(api.href, config.ANON_KEY, options);
      clients.push(client);
      check(await client.auth.signInWithPassword({ email, password }), 'Local fixture sign-in must succeed.');
      const profile = check(await client.from('profiles').select('id,display_name'), 'Own profile must be readable.');
      assert.ok(profile.length === 1 && profile[0].id === created.user.id && profile[0].display_name === null,
        'Profile trigger must ignore signup metadata.');
      const access = check(await client.rpc('my_account_access'), 'Self access RPC must succeed.');
      assert.ok(access.length === 1 && access[0].privileged_roles.length === 0 && access[0].owned_venue_ids.length === 0,
        'Signup metadata must not grant privileges through the API.');
    }
    const adminUserId = users[0];
    const ownerUserId = users[1];
    assert.ok(/^[a-f0-9-]{36}$/.test(adminUserId), 'SQL bootstrap requires the generated fixture UUID.');
    run(['exec', '-i', container, 'psql', '-U', 'postgres', '-d', 'postgres', '-X', '-q', '-v', 'ON_ERROR_STOP=1'],
      `insert into private.account_roles(user_id,role) values ('${adminUserId}'::uuid,'admin');`);
    const adminClient = clients[1];
    const ownerClient = clients[2];
    check(await ownerClient.from('profiles').update({ display_name: 'Local test player' }).eq('id', ownerUserId), 'Own profile edit must succeed.');
    const otherProfile = check(await ownerClient.from('profiles').select('id').eq('id', adminUserId), 'Other profile read must be safely filtered.');
    assert.equal(otherProfile.length, 0, 'Other profiles must remain private.');
    const roleChange = { actor_user_id: adminUserId, target_user_id: ownerUserId, assigned_role: 'moderator', enabled: true };
    assert.ok((await adminClient.rpc('set_account_role', roleChange)).error?.code === '42501',
      'Even the admin user must use a verified server operation to change roles.');
    check(await server.rpc('set_account_role', roleChange), 'Verified admin actor must be able to grant a role.');
    const roles = check(await ownerClient.rpc('my_account_access'), 'Updated self access must succeed.');
    assert.ok(roles[0].privileged_roles.includes('moderator'), 'Role changes must be visible without token refresh.');
    check(await server.rpc('set_account_role', { ...roleChange, enabled: false }), 'Role revocation must succeed.');
    check(await server.from('venues').insert({ id: venueId, name: 'Authorization API fixture', address_line: 'Local test',
      city: 'Manila', province: 'Metro Manila', latitude: 14.6, longitude: 121,
      publication_status: 'approved', claim_status: 'verified' }), 'Local venue fixture must be created.');
    venueCreated = true;
    const ownership = { actor_user_id: adminUserId, target_venue_id: venueId, owner_user_id: ownerUserId, enabled: true };
    check(await server.rpc('set_verified_venue_owner', ownership), 'Verified server ownership assignment must succeed.');
    const scope = check(await ownerClient.rpc('my_account_access'), 'Owner scope read must succeed.');
    assert.ok(scope[0].privileged_roles.length === 0 && scope[0].owned_venue_ids.length === 1
      && scope[0].owned_venue_ids[0] === venueId, 'Owner scope must be tied to the verified venue.');
    const guard = { actor_user_id: ownerUserId, target_venue_id: venueId };
    check(await server.rpc('authorize_venue_management', guard), 'Server must authorize the verified venue owner.');
    assert.ok((await ownerClient.rpc('authorize_venue_management', guard)).error?.code === '42501',
      'Owner cannot call server-only commands directly.');
    check(await server.rpc('set_verified_venue_owner', { ...ownership, enabled: false }), 'Ownership revocation must succeed.');
    assert.ok((await server.rpc('authorize_venue_management', guard)).error?.code === '42501',
      'Revoked owner must be rejected through the actual API.');
    console.log('PASS: local API signup/profile privacy, metadata spoofing, server-only commands, role refresh and owner revocation.');
  } finally {
    const cleanup = [
      ...(venueCreated ? [async () => check(await server.from('venues').delete().eq('id', venueId), 'Own local venue fixture cleanup must succeed.')] : []),
      ...users.map((userId) => async () => check(await server.auth.admin.deleteUser(userId), 'Own local Auth fixture cleanup must succeed.')),
      ...clients.map((client) => () => client.auth.stopAutoRefresh()),
    ];
    let clean = true;
    // FK cascades share rows: attempt every cleanup, sequentially. No other
    // users/venues are selected for deletion, even if one step fails.
    for (const step of cleanup) {
      try { await step(); } catch { clean = false; }
    }
    assert.ok(clean, 'Own local fixture cleanup must succeed.');
  }
  console.log('PASS: own local API fixtures removed; no hosted accounts, emails or credentials used.');
}

main().catch((error) => {
  // Do not print full child-process output or infrastructure configuration.
  console.error(`Local authorization check failed: ${error instanceof assert.AssertionError ? error.message : 'Verify Docker is running and local migrations are applied.'}`);
  process.exitCode = 1;
});
