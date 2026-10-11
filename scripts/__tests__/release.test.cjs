const assert = require('node:assert/strict');
const { Buffer } = require('node:buffer');
const { spawnSync } = require('node:child_process');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { test } = require('node:test');

const root = path.resolve(path.dirname(module.filename), '../..');
const release = require(path.join(root, 'scripts/release/environment.cjs'));
const cli = require(path.join(root, 'scripts/release-check.cjs'));
const committed = JSON.parse(fs.readFileSync(path.join(root, 'release/environments.json'), 'utf8'));

const STAGING = 'fkdusdurzdgbfwwigrqw';
const PRODUCTION = 'prodprodprodprodprod';
const withProduction = { ...committed, backends: { ...committed.backends, production: { projectRef: PRODUCTION } } };
const url = (ref) => `https://${ref}.supabase.co`;

// Credential-shaped fixtures are assembled at run time so no key-like literal is committed.
const random = (bytes = 24) => crypto.randomBytes(bytes).toString('base64url');
const secretKey = () => `${'sb_'}${'secret_'}Aa1${random()}`;
const publishable = () => `sb_publishable_${random()}`;
const jwt = (payload) => [{ alg: 'HS256', typ: 'JWT' }, payload].map((part) => Buffer.from(JSON.stringify(part)).toString('base64url')).join('.') + `.${random(32)}`;
const privateKey = () => `-----BEGIN ${'PRIVATE'} KEY-----\n${random(48)}\n-----END PRIVATE KEY-----`;
const mapsKey = 'test-only-native-maps-key';
const appEnv = (ref, extra = {}) => ({ EXPO_PUBLIC_SUPABASE_URL: url(ref), EXPO_PUBLIC_SUPABASE_PUBLISHABLE_KEY: publishable(), GOOGLE_MAPS_IOS_API_KEY: mapsKey, ...extra });
const mobile = (variant, env, environments = committed) => release.checkMobileEnvironment({ variant, env, environments }).problems;

test('the committed environments map development and preview to staging and leave production unrecorded', () => {
  assert.equal(committed.backends.staging.projectRef, STAGING);
  assert.equal(committed.backends.production.projectRef, null);
  assert.deepEqual(committed.variants, { development: 'staging', preview: 'staging', production: 'production' });
  assert.equal(committed.iosBundleIdentifier, 'com.rckycls.picklyph');
});

test('eas.json has development, preview and production profiles on their own environments', () => {
  const eas = JSON.parse(fs.readFileSync(path.join(root, 'eas.json'), 'utf8'));
  assert.equal(eas.cli.appVersionSource, 'remote');
  for (const variant of release.VARIANTS) {
    assert.equal(eas.build[variant].environment, variant);
    assert.equal(eas.build[variant].env.APP_VARIANT, variant);
  }
  assert.equal(eas.build.development.developmentClient, true);
  assert.equal(eas.build.preview.distribution, 'internal');
  assert.equal(eas.build.preview.developmentClient, undefined);
  assert.equal(eas.build.production.distribution, 'store');
  assert.equal(eas.build.production.autoIncrement, true);
  assert.deepEqual(eas.submit.production, {});
});

test('URL, JWT and secret helpers recognise only the shapes they claim', () => {
  assert.equal(release.projectRefFromUrl(url(STAGING)), STAGING);
  assert.equal(release.projectRefFromUrl(`${url(STAGING)}/`), STAGING);
  for (const bad of ['http://fkdusdurzdgbfwwigrqw.supabase.co', 'http://127.0.0.1:54321', `${url(STAGING)}/rest/v1`, 'https://example.com', '', undefined]) {
    assert.equal(release.projectRefFromUrl(bad), null, String(bad));
  }
  assert.equal(release.secretKind(secretKey()), 'a Supabase secret key');
  assert.equal(release.secretKind(privateKey()), 'a private key');
  assert.equal(release.secretKind(jwt({ role: 'service_role', ref: STAGING })), 'a service_role key');
  assert.equal(release.secretKind(jwt({ role: 'anon', ref: STAGING })), null);
  assert.equal(release.secretKind(publishable()), null);
  // Hermes packs strings back to back: supabase-js's bare prefix check followed by another string.
  assert.equal(release.hasSupabaseSecretKey('sb_secret__internal_exampleIdentifierText1234'), false);
  assert.equal(release.hasSupabaseSecretKey(`${'sb_'}secret_lowercaseonlywordsfollowinghere`), false);
});

test('preview builds accept only the staging project with a publishable key and a Maps key', () => {
  assert.deepEqual(mobile('preview', appEnv(STAGING)), []);
  assert.deepEqual(mobile('preview', appEnv(STAGING, { EXPO_PUBLIC_SUPABASE_URL: `${url(STAGING)}/` })), []);
  assert.deepEqual(mobile('preview', appEnv(STAGING, { EXPO_PUBLIC_SUPABASE_PUBLISHABLE_KEY: jwt({ role: 'anon', ref: STAGING }) })), []);
  assert.match(mobile('preview', appEnv(PRODUCTION), withProduction).join('\n'), /points at prodprodprodprodprod, the production project/);
  assert.match(mobile('preview', appEnv('otherotherotherother')).join('\n'), /points at otherotherotherother, not the staging project/);
  assert.match(mobile('preview', appEnv(STAGING, { EXPO_PUBLIC_SUPABASE_URL: 'http://127.0.0.1:54321' })).join('\n'), /must be https:\/\/<project ref>\.supabase\.co/);
  assert.match(mobile('preview', appEnv(STAGING, { EXPO_PUBLIC_SUPABASE_URL: 'https://YOUR_PROJECT_REF.supabase.co' })).join('\n'), /set EXPO_PUBLIC_SUPABASE_URL/);
  assert.match(mobile('preview', appEnv(STAGING, { GOOGLE_MAPS_IOS_API_KEY: 'REPLACE_WITH_IOS_RESTRICTED_MAPS_KEY' })).join('\n'), /GOOGLE_MAPS_IOS_API_KEY/);
  assert.match(mobile('preview', appEnv(STAGING, { EXPO_PUBLIC_SUPABASE_PUBLISHABLE_KEY: '' })).join('\n'), /set EXPO_PUBLIC_SUPABASE_PUBLISHABLE_KEY/);
});

test('production builds need the recorded production project and never the staging one', () => {
  const unrecorded = mobile('production', appEnv(STAGING)).join('\n');
  assert.match(unrecorded, /record the production project ref/);
  assert.match(unrecorded, /points at fkdusdurzdgbfwwigrqw, the staging project/);
  assert.deepEqual(mobile('production', appEnv(PRODUCTION), withProduction), []);
  assert.match(mobile('production', appEnv(STAGING), withProduction).join('\n'), /the staging project/);
  const shared = { ...committed, backends: { ...committed.backends, production: { projectRef: STAGING } } };
  assert.match(mobile('production', appEnv(STAGING), shared).join('\n'), /production and staging share project ref/);
  assert.match(mobile('production', appEnv(PRODUCTION, { EXPO_PUBLIC_SUPABASE_PUBLISHABLE_KEY: jwt({ role: 'anon', ref: STAGING }) }), withProduction).join('\n'),
    /PUBLISHABLE_KEY belongs to fkdusdurzdgbfwwigrqw, the staging project/);
  assert.match(mobile('production', appEnv(PRODUCTION, { EXPO_PUBLIC_SUPABASE_PUBLISHABLE_KEY: jwt({ role: 'anon' }) }), withProduction).join('\n'), /names no project/);
});

test('server keys and server setting names are refused in EXPO_PUBLIC_ values for every variant', () => {
  const secret = secretKey();
  const serviceRole = jwt({ role: 'service_role', ref: PRODUCTION });
  const pem = privateKey();
  for (const variant of release.VARIANTS) {
    const problems = mobile(variant, appEnv(PRODUCTION, {
      EXPO_PUBLIC_SUPABASE_PUBLISHABLE_KEY: secret, EXPO_PUBLIC_UPSTASH_REDIS_REST_TOKEN: 'x', EXPO_PUBLIC_APPLE_KEY: pem, EXPO_PUBLIC_ADMIN_KEY: serviceRole,
    }), withProduction);
    const text = problems.join('\n');
    assert.match(text, /EXPO_PUBLIC_SUPABASE_PUBLISHABLE_KEY holds a Supabase secret key/, variant);
    assert.match(text, /EXPO_PUBLIC_UPSTASH_REDIS_REST_TOKEN looks like a server setting/, variant);
    assert.match(text, /EXPO_PUBLIC_APPLE_KEY holds a private key/, variant);
    assert.match(text, /EXPO_PUBLIC_ADMIN_KEY holds a service_role key/, variant);
    for (const value of [secret, serviceRole, pem]) assert(!text.includes(value), 'problems never repeat a value');
  }
  // Server names without the public prefix stay out of the bundle and are not this check's concern.
  assert.deepEqual(mobile('preview', appEnv(STAGING, { UPSTASH_REDIS_REST_TOKEN: random(), DISCOVERY_SUPABASE_SECRET_KEY: secretKey() })), []);
});

test('development dev-client builds need only the Maps key, because Metro serves their JavaScript', () => {
  assert.deepEqual(mobile('development', { GOOGLE_MAPS_IOS_API_KEY: mapsKey }), []);
  assert.deepEqual(mobile('development', { GOOGLE_MAPS_IOS_API_KEY: mapsKey, EXPO_PUBLIC_SUPABASE_URL: 'http://192.168.1.20:54321' }), []);
  assert.match(mobile('development', {}).join('\n'), /GOOGLE_MAPS_IOS_API_KEY/);
  assert.match(mobile('staging', appEnv(STAGING)).join('\n'), /unknown app variant "staging"/);
});

test('bundle scans find the other project, server setting names and credential-shaped values', () => {
  const file = (text) => [{ name: 'entry.hbc', text }];
  const scan = (variant, text, environments = committed) => release.scanBundle({ variant, files: file(text), environments });
  assert.deepEqual(scan('preview', `xx${url(STAGING)}yy sb_secret__internal_exampleIdentifierText1234`), []);
  assert.match(scan('preview', 'no backend here').join('\n'), /no file contains https:\/\/fkdusdurzdgbfwwigrqw\.supabase\.co/);
  assert.match(scan('preview', `${url(STAGING)} ${url(PRODUCTION)}`, withProduction).join('\n'), /contains the production project ref/);
  const production = scan('production', `${url(STAGING)}`, withProduction).join('\n');
  assert.match(production, /entry\.hbc contains the staging project ref fkdusdurzdgbfwwigrqw/);
  assert.match(production, /no file contains https:\/\/prodprodprodprodprod\.supabase\.co/);
  const leaky = scan('production', [
    url(PRODUCTION), 'PUSH_WORKER_SECRET', 'UPSTASH_REDIS_REST_TOKEN', secretKey(), privateKey(), 'https://eu1-proud-cat-12345.upstash.io',
    jwt({ role: 'service_role', ref: PRODUCTION }), jwt({ role: 'anon', ref: STAGING }),
  ].join('\u0000'), withProduction).join('\n');
  for (const expected of [/server setting name PUSH_WORKER_SECRET/, /server setting name UPSTASH_REDIS_REST_TOKEN/, /a Supabase secret key/, /a private key/,
    /an Upstash Redis address/, /a service_role key/, /a key for the staging project/]) assert.match(leaky, expected);
  assert.match(scan('production', url(PRODUCTION)).join('\n'), /record the production project ref/);
});

function digests(values) {
  return new Map(Object.entries(values).map(([name, value]) => [name, release.sha256(value)]));
}
function hostedSecrets(backend, ref, overrides = {}) {
  const values = Object.fromEntries(release.REQUIRED_SECRETS.map((name) => [name, `${backend}-${name}-${random(8)}`]));
  Object.assign(values, { PICKLY_ENV: backend, DISCOVERY_SUPABASE_URL: url(ref), APPLE_CLIENT_ID: 'com.rckycls.picklyph', SUPABASE_URL: url(ref) }, overrides);
  return values;
}

test('secrets lists parse from JSON, markdown tables and boxed tables', () => {
  const digest = release.sha256('staging');
  assert.deepEqual([...release.parseSecretsList(JSON.stringify([{ name: 'PICKLY_ENV', value: digest.toUpperCase() }]))], [['PICKLY_ENV', digest]]);
  assert.deepEqual([...release.parseSecretsList(JSON.stringify([{ name: 'PICKLY_ENV', digest }]))], [['PICKLY_ENV', digest]]);
  const markdown = `|NAME|DIGEST|\n|-|-|\n|\`PICKLY_ENV\`|\`${digest}\`|\n`;
  assert.deepEqual([...release.parseSecretsList(markdown)], [['PICKLY_ENV', digest]]);
  const boxed = `\n   NAME        │ DIGEST\n  ─────────────┼──────────\n   PICKLY_ENV  │ ${digest}\n`;
  assert.deepEqual([...release.parseSecretsList(boxed)], [['PICKLY_ENV', digest]]);
  assert.equal(release.parseSecretsList('Cannot find project ref. Have you run supabase link?').size, 0);
});

test('function secrets must be complete, point at their own project and differ from the other environment', () => {
  const check = (backendName, values, other, environments = withProduction) => release.checkFunctionSecrets({
    backendName, secrets: digests(values), environments, other: other && digests(other), otherName: backendName === 'staging' ? 'production' : 'staging',
  });
  const staging = hostedSecrets('staging', STAGING);
  const production = hostedSecrets('production', PRODUCTION);
  assert.deepEqual(check('staging', staging), []);
  assert.deepEqual(check('production', production, staging), []);
  assert.deepEqual(check('production', { ...production, DISCOVERY_SUPABASE_URL: `${url(PRODUCTION)}/` }, staging), []);

  const missing = { ...production };
  delete missing.APPLE_PRIVATE_KEY;
  assert.match(check('production', missing).join('\n'), /APPLE_PRIVATE_KEY is not set/);
  assert.match(check('production', { ...production, PICKLY_ENV: 'staging' }).join('\n'), /PICKLY_ENV is not "production"/);
  assert.match(check('production', { ...production, DISCOVERY_SUPABASE_URL: url(STAGING) }).join('\n'), /DISCOVERY_SUPABASE_URL is not https:\/\/prodprodprodprodprod\.supabase\.co/);
  assert.match(check('production', { ...production, APPLE_CLIENT_ID: 'com.example.other' }).join('\n'), /APPLE_CLIENT_ID is not the app's bundle identifier/);
  const reused = check('production', { ...production, UPSTASH_REDIS_REST_TOKEN: staging.UPSTASH_REDIS_REST_TOKEN, PUSH_WORKER_SECRET: staging.PUSH_WORKER_SECRET }, staging).join('\n');
  assert.match(reused, /UPSTASH_REDIS_REST_TOKEN is the same in production and staging/);
  assert.match(reused, /PUSH_WORKER_SECRET is the same in production and staging/);
  // Shared Apple and Maps settings are allowed across environments.
  assert.deepEqual(check('production', { ...production, APPLE_PRIVATE_KEY: staging.APPLE_PRIVATE_KEY, GOOGLE_MAPS_SERVER_API_KEY: staging.GOOGLE_MAPS_SERVER_API_KEY }, staging), []);
  // T51a: the monitor secret and alert webhook are required; one Discord webhook may serve both, a heartbeat may not.
  const unmonitored = { ...production };
  delete unmonitored.OPS_MONITOR_SECRET;
  delete unmonitored.OPS_ALERT_WEBHOOK_URL;
  assert.match(check('production', unmonitored).join('\n'), /OPS_MONITOR_SECRET is not set[\s\S]*OPS_ALERT_WEBHOOK_URL is not set/);
  assert.deepEqual(check('production', { ...production, OPS_ALERT_WEBHOOK_URL: staging.OPS_ALERT_WEBHOOK_URL }, staging), []);
  const sharedOps = check('production', { ...production, OPS_MONITOR_SECRET: staging.OPS_MONITOR_SECRET, OPS_HEARTBEAT_URL: 'https://hc.example/x' },
    { ...staging, OPS_HEARTBEAT_URL: 'https://hc.example/x' }).join('\n');
  assert.match(sharedOps, /OPS_MONITOR_SECRET is the same in production and staging/);
  assert.match(sharedOps, /OPS_HEARTBEAT_URL is the same in production and staging/);
  assert.match(check('production', production, production).join('\n'), /both secrets lists come from the same project/);
  assert.match(check('production', production, undefined, committed).join('\n'), /record the production project ref/);
  assert.match(release.checkFunctionSecrets({ backendName: 'staging', secrets: new Map(), environments: committed }).join('\n'), /empty or unreadable/);
});

test('the linked Supabase project must be the variant backend', () => {
  const linked = (variant, linkedRef, environments = withProduction) => release.checkLinkedProject({ variant, linkedRef, environments });
  assert.deepEqual(linked('preview', STAGING), []);
  assert.deepEqual(linked('production', PRODUCTION), []);
  assert.match(linked('production', STAGING).join('\n'), /the linked project is fkdusdurzdgbfwwigrqw, the staging project/);
  assert.match(linked('preview', PRODUCTION).join('\n'), /the production project/);
  assert.match(linked('preview', null).join('\n'), /no linked Supabase project/);
  assert.match(linked('production', STAGING, committed).join('\n'), /record the production project ref/);
});

test('env files parse the way eas env:pull writes them', () => {
  const env = cli.parseEnvFile([
    '# Environment: production', 'EXPO_PUBLIC_SUPABASE_URL=https://a.supabase.co', 'export QUOTED="two words"', "SINGLE='it''s'",
    'COMMENTED=value # trailing note', '# SECRET_ONLY=hidden', '', 'MULTI="line\\nbreak"',
  ].join('\r\n'));
  assert.deepEqual(env, { EXPO_PUBLIC_SUPABASE_URL: 'https://a.supabase.co', QUOTED: 'two words', SINGLE: "it''s", COMMENTED: 'value', MULTI: 'line\nbreak' });
});

test('release:check runs each chosen check, prints names only and exits non-zero on any problem', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'picklyph-release-'));
  try {
    const write = (name, text) => { fs.mkdirSync(path.dirname(path.join(dir, name)), { recursive: true }); fs.writeFileSync(path.join(dir, name), text); };
    const secret = secretKey();
    write('environments.json', JSON.stringify(withProduction));
    write('prod.env', `\uFEFF${Object.entries(appEnv(PRODUCTION)).map(([k, v]) => `${k}=${v}`).join('\n')}`);
    write('leaky.env', Object.entries(appEnv(PRODUCTION, { EXPO_PUBLIC_SUPABASE_PUBLISHABLE_KEY: secret })).map(([k, v]) => `${k}=${v}`).join('\n'));
    write('export/_expo/static/js/ios/entry.hbc', `..${url(PRODUCTION)}..`);
    write('ipa/Payload/PicklyPH.app/main.jsbundle', `..${url(STAGING)}..`);
    write('export/assets/icon.png', url(STAGING)); // Images are not scanned.
    const staging = hostedSecrets('staging', STAGING);
    const production = hostedSecrets('production', PRODUCTION);
    const asJson = (values) => JSON.stringify([...digests(values)].map(([name, value]) => ({ name, value })));
    // As Windows PowerShell 5.1 redirection writes it: UTF-16 with a byte-order mark.
    write('staging.json', Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from(asJson(staging), 'utf16le')]));
    write('production.json', asJson(production));
    write('reused.json', asJson({ ...production, RATE_LIMIT_KEY_SECRET: staging.RATE_LIMIT_KEY_SECRET }));
    write('supabase/.temp/linked-project.json', JSON.stringify({ ref: PRODUCTION, name: 'picklyph-production' }));

    const run = (...args) => {
      const lines = [];
      const code = cli.run([...args, '--environments', 'environments.json'], { cwd: dir, log: (line) => lines.push(line) });
      return { code, out: lines.join('\n') };
    };
    let result = run('--variant', 'production', '--env-file', 'prod.env', '--bundle', 'export', '--secrets', 'production.json', '--compare', 'staging.json', '--linked');
    assert.equal(result.code, 0, result.out);
    assert.match(result.out, /release:check production → production \(prodprodprodprodprod\)/);
    assert.match(result.out, /All 4 checks passed\./);

    result = run('--variant', 'production', '--env-file', 'leaky.env', '--secrets', 'reused.json', '--compare', 'staging.json');
    assert.equal(result.code, 1);
    assert.match(result.out, /FAIL app environment \(leaky\.env\)/);
    assert.match(result.out, /RATE_LIMIT_KEY_SECRET is the same in production and staging/);
    assert.match(result.out, /2 of 2 checks failed\./);
    assert(!result.out.includes(secret), 'output never repeats a value');

    result = run('--variant', 'preview', '--linked', '--bundle', 'export');
    assert.equal(result.code, 1);
    assert.match(result.out, /the linked project is prodprodprodprodprod, the production project/);
    assert.match(result.out, /entry\.hbc contains the production project ref/);

    result = run('--variant', 'production', '--bundle', 'ipa');
    assert.equal(result.code, 1);
    assert.match(result.out, /Payload\/PicklyPH\.app\/main\.jsbundle contains the staging project ref/);

    result = run('--variant', 'production', '--env-file', 'missing.env');
    assert.equal(result.code, 1);
    assert.match(result.out, /could not run: .*missing\.env does not exist/);
    assert.equal(run('--variant', 'production').code, 2);
    assert.equal(run('--variant', 'preview', '--compare', 'staging.json').code, 2);
    assert.equal(run('--variant', 'preview', '--bogus').code, 2);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// The real Expo config loader, as an EAS build worker runs it (no .env files).
function expoConfig(env) {
  const result = spawnSync(process.execPath, [require.resolve('expo/bin/cli', { paths: [root] }), 'config', '--type', 'public', '--json'], {
    cwd: root, encoding: 'utf8', env: { ...process.env, EXPO_NO_DOTENV: '1', EXPO_NO_TELEMETRY: '1', CI: '1', ...env }, timeout: 120000,
  });
  return { code: result.status, stdout: result.stdout, out: `${result.stdout}\n${result.stderr}` };
}

test('EAS build workers evaluate the real app config with the variant checks', () => {
  const worker = { EAS_BUILD_PLATFORM: 'ios', GOOGLE_MAPS_IOS_API_KEY: mapsKey, EXPO_PUBLIC_SUPABASE_PUBLISHABLE_KEY: publishable() };

  const preview = expoConfig({ ...worker, APP_VARIANT: 'preview', EXPO_PUBLIC_SUPABASE_URL: url(STAGING) });
  assert.equal(preview.code, 0, preview.out);
  const config = JSON.parse(preview.stdout);
  assert.deepEqual(config.plugins.find((entry) => Array.isArray(entry) && entry[0] === 'expo-notifications'), ['expo-notifications', { mode: 'production' }]);
  assert.equal(config.ios.bundleIdentifier, 'com.rckycls.picklyph');

  const production = expoConfig({ ...worker, APP_VARIANT: 'production', EXPO_PUBLIC_SUPABASE_URL: url(STAGING) });
  assert.notEqual(production.code, 0);
  assert.match(production.out, /The production build environment is not releasable/);
  assert.match(production.out, /record the production project ref/);
  assert.match(production.out, /points at fkdusdurzdgbfwwigrqw, the staging project/);

  const wrongBackend = expoConfig({ ...worker, APP_VARIANT: 'preview', EXPO_PUBLIC_SUPABASE_URL: 'http://127.0.0.1:54321' });
  assert.notEqual(wrongBackend.code, 0);
  assert.match(wrongBackend.out, /The preview build environment is not releasable/);

  const development = expoConfig({ EAS_BUILD_PLATFORM: 'ios', GOOGLE_MAPS_IOS_API_KEY: mapsKey, APP_VARIANT: 'development' });
  assert.equal(development.code, 0, development.out);
  assert.deepEqual(JSON.parse(development.stdout).plugins.find((entry) => Array.isArray(entry) && entry[0] === 'expo-notifications'), ['expo-notifications', { mode: 'development' }]);
});
