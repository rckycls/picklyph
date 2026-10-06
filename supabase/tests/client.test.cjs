const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { test } = require('node:test');
const vm = require('node:vm');
const ts = require('typescript');

const root = path.resolve(path.dirname(module.filename), '../..');
const compiled = ts.transpileModule(fs.readFileSync(path.join(root, 'src/lib/supabase.ts'), 'utf8'), {
  compilerOptions: { module: ts.ModuleKind.CommonJS },
}).outputText;

function loadClient(env) {
  const module = { exports: {} };
  vm.runInNewContext(compiled, {
    module, exports: module.exports, process: { env },
    // Node already has URL; mobile loads the actual polyfill in Metro.
    URL,
    require: (name) => {
      if (name === 'react-native-url-polyfill/auto') return {};
      if (name === '@/features/auth/sessionStorage') return { sessionStorage: {
        getItem: async () => null, setItem: async () => {}, removeItem: async () => {},
      } };
      if (name === './fetchWithDeadline') return { fetchWithDeadline: () => { throw new Error('Unexpected network request'); } };
      return require(name);
    },
  });
  return module.exports;
}

test('missing/placeholder configuration fails only when the directory client is requested', () => {
  const client = loadClient({});
  assert.throws(() => client.getSupabase(), /Configure the staging Supabase/);
});

test('the mobile client rejects secret/service-role keys and invalid project URLs', () => {
  for (const env of [
    { EXPO_PUBLIC_SUPABASE_URL: 'https://test-project.supabase.co', EXPO_PUBLIC_SUPABASE_PUBLISHABLE_KEY: 'sb_secret_test-only' },
    { EXPO_PUBLIC_SUPABASE_URL: 'https://test-project.supabase.co', EXPO_PUBLIC_SUPABASE_PUBLISHABLE_KEY: 'test-only-legacy-service-role-token' },
    { EXPO_PUBLIC_SUPABASE_URL: 'https://YOUR_PROJECT_REF.supabase.co', EXPO_PUBLIC_SUPABASE_PUBLISHABLE_KEY: 'sb_publishable_test-only' },
    { EXPO_PUBLIC_SUPABASE_URL: 'http://test-project.supabase.co', EXPO_PUBLIC_SUPABASE_PUBLISHABLE_KEY: 'sb_publishable_test-only' },
  ]) assert.throws(() => loadClient(env).getSupabase(), /Configure the staging Supabase/);
});

test('valid public settings create a reusable client with persistent auth', async () => {
  const { getSupabase } = loadClient({
    EXPO_PUBLIC_SUPABASE_URL: 'https://test-project.supabase.co',
    EXPO_PUBLIC_SUPABASE_PUBLISHABLE_KEY: 'sb_publishable_test-only',
  });
  const client = getSupabase();
  assert.equal(client, getSupabase());
  assert.equal(client.auth.persistSession, true);
  assert.equal(client.auth.autoRefreshToken, true);
  await client.auth.stopAutoRefresh();
});
