// T53: the built browser bundle of apps/web must hold no server setting name and nothing shaped like a secret.
// Usage: node apps/web/tests/bundle-scan.cjs (after `npm run web:build`), or require it from the local harness.
const fs = require('node:fs');
const path = require('node:path');
const { SERVER_SETTING_NAMES, hasSupabaseSecretKey, jwtPayload } = require('../../../scripts/release/environment.cjs');

/** Every setting apps/web reads. All are read on the server; the page gets the two public values as props. */
const WEB_SETTING_NAMES = [
  'PICKLY_ENV', 'PRELAUNCH_ORIGIN', 'PRELAUNCH_SUPABASE_URL', 'PRELAUNCH_SUPABASE_SECRET_KEY', 'PRELAUNCH_CODE_SECRET', 'PRELAUNCH_CONTACT_EMAIL',
  'UPSTASH_REDIS_REST_URL', 'UPSTASH_REDIS_REST_TOKEN', 'RATE_LIMIT_KEY_SECRET', 'TURNSTILE_SECRET_KEY', 'TURNSTILE_SITE_KEY',
  'GOOGLE_MAPS_SERVER_API_KEY', 'GOOGLE_MAPS_BROWSER_API_KEY', 'EMAIL_API_KEY', 'EMAIL_API_URL', 'EMAIL_FROM',
];

function files(dir) {
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const full = path.join(dir, entry.name);
    return entry.isDirectory() ? files(full) : [full];
  });
}

/** Problems found in the client output (`.next/static`), naming files and kinds only, never a value. */
function scanWebBundle(root, values = []) {
  const staticDir = path.join(root, '.next', 'static');
  const list = files(staticDir).filter((file) => /\.(js|css|json|txt|map)$/.test(file));
  if (list.length === 0) return [`no client output under ${staticDir}; run npm run web:build first`];
  const problems = new Set();
  for (const file of list) {
    const name = path.relative(root, file);
    const text = fs.readFileSync(file, 'utf8');
    for (const setting of new Set([...WEB_SETTING_NAMES, ...SERVER_SETTING_NAMES])) if (text.includes(setting)) problems.add(`${name} names ${setting}`);
    if (hasSupabaseSecretKey(text)) problems.add(`${name} contains a Supabase secret key`);
    if (/-----BEGIN [A-Z ]*PRIVATE KEY-----/.test(text)) problems.add(`${name} contains a private key`);
    if (/[a-z0-9-]+\.upstash\.io/i.test(text)) problems.add(`${name} contains an Upstash address`);
    if (/AIza[0-9A-Za-z_-]{35}/.test(text)) problems.add(`${name} contains a Google API key`);
    if (/\b0x4AAAAAAA[0-9A-Za-z_-]{10,}/.test(text) || /\b[123]x0{31}AA\b/.test(text)) problems.add(`${name} contains a Turnstile key`);
    if (/\bre_[A-Za-z0-9]{8,}_[A-Za-z0-9]{8,}/.test(text)) problems.add(`${name} contains an email provider key`);
    for (const [token] of text.matchAll(/eyJ[A-Za-z0-9_-]{8,}\.eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}/g)) {
      if (typeof jwtPayload(token)?.role === 'string') problems.add(`${name} contains a Supabase key`);
    }
    for (const value of values) if (value && text.includes(value)) problems.add(`${name} contains a configured setting value`);
  }
  return [...problems];
}

module.exports = { WEB_SETTING_NAMES, scanWebBundle };

if (require.main === module) {
  const problems = scanWebBundle(path.resolve(__dirname, '..'));
  for (const problem of problems) console.error(`FAIL: ${problem}`);
  if (problems.length) process.exit(1);
  console.log('PASS: apps/web client bundle holds no server setting names or secret-shaped values.');
}
