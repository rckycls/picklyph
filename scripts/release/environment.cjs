'use strict';
// Release environment checks (T50b), shared by app.config.ts on EAS build workers and
// scripts/release-check.cjs. Pure: callers pass every value in, and problems name settings
// and project refs only, never a setting's value.

const { Buffer } = require('node:buffer');
const crypto = require('node:crypto');

const VARIANTS = ['development', 'preview', 'production'];
const PROJECT_REF = /^[a-z]{20}$/;
const PLACEHOLDER = /REPLACE_WITH_|YOUR_/i;
// An EXPO_PUBLIC_ name with one of these words is almost certainly a server setting.
const SERVER_WORD = /SECRET|SERVICE_ROLE|PRIVATE|TOKEN|PASSWORD/i;

// Edge Function settings every hosted environment needs (see docs/release.md#function-secrets).
const REQUIRED_SECRETS = [
  'DISCOVERY_SUPABASE_URL', 'DISCOVERY_SUPABASE_PUBLISHABLE_KEY', 'DISCOVERY_SUPABASE_SECRET_KEY',
  'UPSTASH_REDIS_REST_URL', 'UPSTASH_REDIS_REST_TOKEN', 'RATE_LIMIT_KEY_SECRET', 'PICKLY_ENV',
  'PUSH_WORKER_SECRET', 'GOOGLE_MAPS_SERVER_API_KEY',
  'APPLE_TEAM_ID', 'APPLE_KEY_ID', 'APPLE_CLIENT_ID', 'APPLE_PRIVATE_KEY',
];
// Settings that must never be shared between staging and production. The Apple key, the
// Maps server key and the Expo access token may be shared.
const ENVIRONMENT_SECRETS = [
  'DISCOVERY_SUPABASE_URL', 'DISCOVERY_SUPABASE_PUBLISHABLE_KEY', 'DISCOVERY_SUPABASE_SECRET_KEY',
  'UPSTASH_REDIS_REST_URL', 'UPSTASH_REDIS_REST_TOKEN', 'RATE_LIMIT_KEY_SECRET', 'PICKLY_ENV',
  'PUSH_WORKER_SECRET',
];
// Server setting names that have no reason to appear in a shipped app bundle.
const SERVER_SETTING_NAMES = [
  'DISCOVERY_SUPABASE_SECRET_KEY', 'UPSTASH_REDIS_REST_URL', 'UPSTASH_REDIS_REST_TOKEN',
  'RATE_LIMIT_KEY_SECRET', 'PUSH_WORKER_SECRET', 'APPLE_PRIVATE_KEY', 'APPLE_KEY_ID',
  'GOOGLE_MAPS_SERVER_API_KEY', 'EXPO_ACCESS_TOKEN', 'ADMIN_SUPABASE_SECRET_KEY',
  'SUPABASE_SERVICE_ROLE_KEY', 'SUPABASE_SECRET_KEYS', 'PAYMONGO_SECRET_KEY', 'PAYMONGO_WEBHOOK_SECRET',
];

const sha256 = (text) => crypto.createHash('sha256').update(text, 'utf8').digest('hex');

function projectRefFromUrl(url) {
  const match = /^https:\/\/([a-z]{20})\.supabase\.co\/?$/.exec(String(url ?? '').trim());
  return match ? match[1] : null;
}

function jwtPayload(token) {
  const parts = String(token ?? '').trim().split('.');
  if (parts.length !== 3 || !parts[1]) return null;
  try {
    const payload = JSON.parse(Buffer.from(parts[1], 'base64url').toString('utf8'));
    return payload && typeof payload === 'object' && !Array.isArray(payload) ? payload : null;
  } catch {
    return null;
  }
}

// A random key body after the prefix. supabase-js itself contains the bare prefix, and Hermes
// stores strings back to back, so `sb_secret_` followed by the next string is not a key.
function hasSupabaseSecretKey(text) {
  for (const match of String(text ?? '').matchAll(/sb_secret_([A-Za-z0-9][A-Za-z0-9_-]{19,})/g)) {
    if (/\d/.test(match[1]) && /[A-Z]/.test(match[1]) && /[a-z]/.test(match[1])) return true;
  }
  return false;
}

// What kind of server credential a value looks like, or null.
function secretKind(value) {
  const text = String(value ?? '');
  if (hasSupabaseSecretKey(text)) return 'a Supabase secret key';
  if (/-----BEGIN [A-Z ]*PRIVATE KEY-----/.test(text)) return 'a private key';
  const role = jwtPayload(text)?.role;
  if (typeof role === 'string' && role !== 'anon') return `a ${role} key`;
  return null;
}

// The backend a variant uses, and the refs of every other backend.
function backendFor(environments, variant) {
  const name = environments?.variants?.[variant];
  const backends = environments?.backends ?? {};
  if (!name || !backends[name]) return null;
  const ref = backends[name].projectRef;
  const others = Object.entries(backends)
    .filter(([other, entry]) => other !== name && PROJECT_REF.test(entry?.projectRef ?? ''))
    .map(([other, entry]) => ({ name: other, ref: entry.projectRef }));
  return { name, ref: PROJECT_REF.test(ref ?? '') ? ref : null, others };
}

// Problems with a backend's recorded ref: unrecorded, malformed or shared with another backend.
function refProblems(backend, purpose) {
  if (!backend.ref) return [`record the ${backend.name} project ref in release/environments.json before ${purpose}`];
  const shared = backend.others.find((other) => other.ref === backend.ref);
  return shared ? [`${backend.name} and ${shared.name} share project ref ${backend.ref}; each environment needs its own project`] : [];
}

function describeRef(ref, backend) {
  const other = backend.others.find((entry) => entry.ref === ref);
  return other ? `${ref}, the ${other.name} project` : `${ref}, not the ${backend.name} project`;
}

// A ref is wrong when it differs from the recorded one, or (before a ref is recorded) when it
// belongs to another backend.
const wrongRef = (ref, backend) => (backend.ref ? ref !== backend.ref : backend.others.some((entry) => entry.ref === ref));

/**
 * Checks the values that end up in the app for one build variant.
 * Development builds load JavaScript from Metro, so only the Maps key and the
 * EXPO_PUBLIC_ boundary apply to them.
 */
function checkMobileEnvironment({ variant, env, environments }) {
  const problems = [];
  if (!VARIANTS.includes(variant)) return { backend: null, problems: [`unknown app variant "${variant}"; use ${VARIANTS.join(', ')}`] };
  const backend = backendFor(environments, variant);
  if (!backend) return { backend: null, problems: [`release/environments.json has no backend for the ${variant} variant`] };

  const mapsKey = env.GOOGLE_MAPS_IOS_API_KEY?.trim();
  if (!mapsKey || PLACEHOLDER.test(mapsKey)) problems.push('set GOOGLE_MAPS_IOS_API_KEY (the restricted iOS Maps key) for this environment');
  for (const [name, value] of Object.entries(env)) {
    if (!name.startsWith('EXPO_PUBLIC_')) continue;
    if (SERVER_WORD.test(name)) problems.push(`${name} looks like a server setting; EXPO_PUBLIC_ values ship inside the app`);
    const kind = secretKind(value);
    if (kind) problems.push(`${name} holds ${kind}; EXPO_PUBLIC_ values ship inside the app`);
  }
  if (variant === 'development') return { backend, problems };

  problems.push(...refProblems(backend, `building ${variant}`));
  const url = env.EXPO_PUBLIC_SUPABASE_URL?.trim();
  const urlRef = projectRefFromUrl(url);
  if (!url || PLACEHOLDER.test(url)) problems.push('set EXPO_PUBLIC_SUPABASE_URL for this environment');
  else if (!urlRef) problems.push(`EXPO_PUBLIC_SUPABASE_URL must be https://<project ref>.supabase.co for ${variant} builds`);
  else if (wrongRef(urlRef, backend)) problems.push(`EXPO_PUBLIC_SUPABASE_URL points at ${describeRef(urlRef, backend)}`);

  const key = env.EXPO_PUBLIC_SUPABASE_PUBLISHABLE_KEY?.trim();
  if (!key || PLACEHOLDER.test(key)) problems.push('set EXPO_PUBLIC_SUPABASE_PUBLISHABLE_KEY for this environment');
  else if (!key.startsWith('sb_publishable_')) {
    const payload = jwtPayload(key);
    if (!payload) problems.push('EXPO_PUBLIC_SUPABASE_PUBLISHABLE_KEY is not a Supabase publishable key');
    else if (payload.role === 'anon' && typeof payload.ref !== 'string') problems.push('EXPO_PUBLIC_SUPABASE_PUBLISHABLE_KEY names no project');
    else if (payload.role === 'anon' && wrongRef(payload.ref, backend)) {
      problems.push(`EXPO_PUBLIC_SUPABASE_PUBLISHABLE_KEY belongs to ${describeRef(payload.ref, backend)}`);
    }
    // A non-anon role was already reported by the EXPO_PUBLIC_ scan above.
  }
  return { backend, problems };
}

/** Scans exported app files (text or Hermes bytecode) for the wrong backend and server credentials. */
function scanBundle({ variant, files, environments }) {
  const problems = [];
  const backend = backendFor(environments, variant);
  if (!backend) return [`release/environments.json has no backend for the ${variant} variant`];
  if (variant !== 'development') problems.push(...refProblems(backend, `checking a ${variant} bundle`));
  const found = new Set();
  const report = (problem) => { if (!found.has(problem)) { found.add(problem); problems.push(problem); } };
  let sawExpected = false;
  for (const { name, text } of files) {
    if (backend.ref && text.includes(`${backend.ref}.supabase.co`)) sawExpected = true;
    for (const other of backend.others) {
      if (text.includes(other.ref)) report(`${name} contains the ${other.name} project ref ${other.ref}`);
    }
    for (const setting of SERVER_SETTING_NAMES) {
      if (text.includes(setting)) report(`${name} contains the server setting name ${setting}`);
    }
    if (hasSupabaseSecretKey(text)) report(`${name} contains a Supabase secret key`);
    if (/-----BEGIN [A-Z ]*PRIVATE KEY-----/.test(text)) report(`${name} contains a private key`);
    if (/[a-z0-9-]+\.upstash\.io/i.test(text)) report(`${name} contains an Upstash Redis address`);
    for (const [token] of text.matchAll(/eyJ[A-Za-z0-9_-]{8,}\.eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}/g)) {
      const payload = jwtPayload(token);
      if (typeof payload?.role === 'string' && payload.role !== 'anon') report(`${name} contains a ${payload.role} key`);
      const other = backend.others.find((entry) => entry.ref === payload?.ref);
      if (other) report(`${name} contains a key for the ${other.name} project`);
    }
  }
  if (variant !== 'development' && backend.ref && !sawExpected) {
    problems.push(`no file contains https://${backend.ref}.supabase.co; export the bundle with the ${variant} environment`);
  }
  return problems;
}

/** Parses `supabase secrets list` output: JSON ([{name, value|digest}]) or its text table. */
function parseSecretsList(text) {
  const secrets = new Map();
  const trimmed = String(text ?? '').trim();
  if (trimmed.startsWith('[') || trimmed.startsWith('{')) {
    const parsed = JSON.parse(trimmed);
    const rows = Array.isArray(parsed) ? parsed : parsed.secrets;
    if (!Array.isArray(rows)) throw new Error('JSON secrets list must be an array of {name, value}');
    for (const row of rows) {
      const digest = row?.value ?? row?.digest;
      if (typeof row?.name === 'string' && typeof digest === 'string') secrets.set(row.name.trim(), digest.trim().toLowerCase());
    }
    return secrets;
  }
  for (const line of trimmed.split(/\r?\n/)) {
    const cells = line.split(/[|│]/).map((cell) => cell.replace(/`/g, '').trim()).filter(Boolean);
    if (cells.length !== 2 || !/^[A-Z][A-Z0-9_]*$/.test(cells[0]) || !/^[0-9a-f]{64}$/i.test(cells[1])) continue;
    secrets.set(cells[0], cells[1].toLowerCase());
  }
  return secrets;
}

/**
 * Checks one backend's Edge Function secrets by digest (Supabase lists the SHA-256 of each
 * value), and optionally that environment-scoped settings differ from another backend's.
 */
function checkFunctionSecrets({ backendName, secrets, environments, other, otherName }) {
  const problems = [];
  const entry = environments?.backends?.[backendName];
  if (!entry) return [`release/environments.json has no ${backendName} backend`];
  const ref = PROJECT_REF.test(entry.projectRef ?? '') ? entry.projectRef : null;
  if (!ref) problems.push(`record the ${backendName} project ref in release/environments.json before checking its secrets`);
  if (secrets.size === 0) return [...problems, 'the secrets list is empty or unreadable; save `supabase secrets list -o json` output'];

  for (const name of REQUIRED_SECRETS) if (!secrets.has(name)) problems.push(`${name} is not set`);
  if (secrets.has('PICKLY_ENV') && secrets.get('PICKLY_ENV') !== sha256(backendName)) problems.push(`PICKLY_ENV is not "${backendName}"`);
  if (ref && secrets.has('DISCOVERY_SUPABASE_URL')) {
    const url = `https://${ref}.supabase.co`;
    if (![sha256(url), sha256(`${url}/`)].includes(secrets.get('DISCOVERY_SUPABASE_URL'))) {
      problems.push(`DISCOVERY_SUPABASE_URL is not ${url}`);
    }
  }
  const bundleId = environments.iosBundleIdentifier;
  if (bundleId && secrets.has('APPLE_CLIENT_ID') && secrets.get('APPLE_CLIENT_ID') !== sha256(bundleId)) {
    problems.push(`APPLE_CLIENT_ID is not the app's bundle identifier ${bundleId}`);
  }
  if (other) {
    if (secrets.has('SUPABASE_URL') && secrets.get('SUPABASE_URL') === other.get('SUPABASE_URL')) {
      problems.push(`both secrets lists come from the same project; list ${otherName} with its own --project-ref`);
    }
    for (const name of ENVIRONMENT_SECRETS) {
      if (name === 'PICKLY_ENV') continue; // Covered by the value check above.
      if (secrets.has(name) && secrets.get(name) === other.get(name)) problems.push(`${name} is the same in ${backendName} and ${otherName}`);
    }
  }
  return problems;
}

/** The Supabase CLI's linked project must be the variant's backend before migrations or deploys. */
function checkLinkedProject({ variant, linkedRef, environments }) {
  const backend = backendFor(environments, variant);
  if (!backend) return [`release/environments.json has no backend for the ${variant} variant`];
  const problems = refProblems(backend, 'pushing migrations or deploying functions');
  if (!linkedRef) problems.push('no linked Supabase project; run `supabase link --project-ref <ref>` first');
  else if (wrongRef(linkedRef, backend)) problems.push(`the linked project is ${describeRef(linkedRef, backend)}`);
  return problems;
}

module.exports = {
  VARIANTS, REQUIRED_SECRETS, ENVIRONMENT_SECRETS, SERVER_SETTING_NAMES,
  sha256, projectRefFromUrl, jwtPayload, hasSupabaseSecretKey, secretKind, backendFor,
  checkMobileEnvironment, scanBundle, parseSecretsList, checkFunctionSecrets, checkLinkedProject,
};
