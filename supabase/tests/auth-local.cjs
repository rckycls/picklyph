// Disposable local Supabase/Mailpit only. Never reads the mobile environment.
const assert = require('node:assert/strict');
const { Buffer } = require('node:buffer');
const { execFileSync } = require('node:child_process');
const { randomUUID } = require('node:crypto');
const path = require('node:path');
const { setTimeout: delay } = require('node:timers/promises');
const { createClient } = require('@supabase/supabase-js');
const { createSecureStorage } = require('../../src/features/auth/secureStorage.ts');
const { requestEmailCode, verifyEmailCode } = require('../../src/features/auth/actions.ts');

async function main() {
  const cli = path.resolve('node_modules/@supabase/cli-windows-x64/bin/supabase.exe');
  const config = JSON.parse(execFileSync(cli, ['status', '-o', 'json'], {
    stdio: ['ignore', 'pipe', 'pipe'], timeout: 20000,
  }));
  const api = new URL(config.API_URL);
  const inbox = new URL(config.INBUCKET_URL ?? config.MAILPIT_URL);
  for (const url of [api, inbox]) {
    assert.ok(url.protocol === 'http:' && ['127.0.0.1', 'localhost'].includes(url.hostname),
      'Auth fixtures require a loopback local stack.');
  }
  assert.equal(api.port, '54321', 'Expected PicklyPH local API port.');
  assert.equal(inbox.port, '54324', 'Expected PicklyPH local mail port.');
  const boundedFetch = (url, options = {}) => fetch(url, {
    ...options, signal: AbortSignal.timeout(10000),
  });
  const admin = createClient(api.href, config.SERVICE_ROLE_KEY, {
    global: { fetch: boundedFetch }, auth: { persistSession: false, autoRefreshToken: false },
  });
  const userIds = [];
  const fixtureEmails = new Set();
  const messageIds = [];
  const clients = [admin];
  const mailbox = async (route, options) => {
    const response = await boundedFetch(new URL(route, inbox), options);
    assert.ok(response.ok, 'Local Mailpit request failed.');
    return response;
  };
  const readCode = async (email) => {
    for (let attempt = 0; attempt < 30; attempt++) {
      const page = await (await mailbox('/api/v1/messages?limit=200')).json();
      const item = page.messages.find((message) => message.To.some((to) => to.Address === email));
      if (item) {
        messageIds.push(item.ID);
        const message = await (await mailbox(`/api/v1/message/${encodeURIComponent(item.ID)}`)).json();
        assert.equal(message.Subject, 'Your PicklyPH sign-in code');
        // Boolean assertions keep OTPs/email contents out of failure output.
        assert.ok(!message.HTML.includes('/auth/v1/verify'), 'Expected the code-only template.');
        const code = message.HTML.match(/>\s*(\d{6})\s*</)?.[1];
        assert.ok(code, 'Email template must contain a six-digit code.');
        return code;
      }
      await delay(200);
    }
    throw new Error('No local verification email arrived.');
  };
  try {
    for (const returning of [false, true]) {
      const email = `picklyph-auth-${randomUUID()}@example.invalid`;
      fixtureEmails.add(email);
      if (returning) {
        const created = await admin.auth.admin.createUser({ email, email_confirm: true });
        assert.ok(!created.error && created.data.user, 'Local returning-user fixture creation failed.');
        userIds.push(created.data.user.id);
      }
      const saved = new Map();
      const driver = {
        getItem: async (key) => saved.get(key) ?? null,
        setItem: async (key, value) => {
          assert.ok(Buffer.byteLength(value) <= 2000, 'Native storage chunk exceeded its payload limit.');
          saved.set(key, value);
        },
        removeItem: async (key) => { saved.delete(key); },
      };
      const coldClient = () => {
        const client = createClient(api.href, config.ANON_KEY, {
          global: { fetch: boundedFetch },
          auth: {
            storageKey: `fixture-${email}`, storage: createSecureStorage(driver, randomUUID),
            persistSession: true, autoRefreshToken: false, detectSessionInUrl: false,
          },
        });
        clients.push(client);
        return client;
      };
      const first = coldClient();
      await requestEmailCode(first.auth, email);
      const code = await readCode(email);
      await assert.rejects(verifyEmailCode(first.auth, email, code === '000000' ? '111111' : '000000'),
        /incorrect or expired/);
      await verifyEmailCode(first.auth, email, code);
      const signedIn = await first.auth.getSession();
      assert.ok(!signedIn.error && signedIn.data.session, 'Local code verification must create a session.');
      const userId = signedIn.data.session.user.id;
      if (!returning) userIds.push(userId);
      await first.auth.dispose();

      const restored = coldClient();
      const session = await restored.auth.getSession();
      assert.ok(!session.error && session.data.session?.user.id === userId, 'Cold client must restore the same user.');
      const refreshed = await restored.auth.refreshSession();
      assert.ok(!refreshed.error && refreshed.data.session?.user.id === userId, 'Real refresh must preserve identity.');
      const signedOut = await restored.auth.signOut({ scope: 'local' });
      assert.ok(!signedOut.error, 'Local sign-out must succeed.');
      await restored.auth.dispose();
      const guest = await coldClient().auth.getSession();
      assert.ok(!guest.error && guest.data.session === null, 'Sign-out must survive a cold start.');
      assert.equal(saved.size, 0, 'Sign-out must clear the secure manifest and chunks.');
      console.log(`PASS: ${returning ? 'returning' : 'new'} email user: invalid code, verification, cold restore, refresh, sign-out.`);
    }
  } finally {
    // A failed verification can leave a newly created unconfirmed user. Match
    // only this run's random addresses; never clear unrelated local accounts.
    for (let page = 1; ; page++) {
      const listed = await admin.auth.admin.listUsers({ page, perPage: 100 });
      assert.ok(!listed.error, 'Auth fixture cleanup lookup failed.');
      for (const user of listed.data.users) {
        if (fixtureEmails.has(user.email) && !userIds.includes(user.id)) userIds.push(user.id);
      }
      if (listed.data.users.length < 100) break;
    }
    for (const id of userIds) {
      const deleted = await admin.auth.admin.deleteUser(id);
      assert.ok(!deleted.error, 'Auth fixture user cleanup failed.');
    }
    if (messageIds.length) await mailbox('/api/v1/messages', {
      method: 'DELETE', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ IDs: messageIds }),
    });
    for (const client of clients) await client.auth.dispose();
  }
  console.log('PASS: local auth fixtures removed; no hosted users, emails or credentials used.');
}
main().catch(() => {
  // SDK/CLI error objects may contain credentials or mail bodies. Do not dump them.
  console.error('Local auth verification failed. Check the local stack and email-code configuration.');
  process.exitCode = 1;
});
