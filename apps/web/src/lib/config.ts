// Server settings for the pre-launch registration page (T53). Pure: callers pass the environment in, and
// errors never include a setting's value. Only server code reads these; the page receives the two public
// browser values (Turnstile site key, Maps browser key) and the contact address as props at request time.

export type WebEnvironment = 'local' | 'staging' | 'production';

export class WebConfigurationError extends Error {
  constructor() { super('Registration is not configured.'); this.name = 'WebConfigurationError'; }
}

type Env = Record<string, string | undefined>;
const LOOPBACK = ['localhost', '127.0.0.1', '[::1]'];
const EMAIL = /^[^\s@<>]+@[^\s@<>]+\.[^\s@<>]+$/;
// Cloudflare's published dummy secrets; they never pass in production.
const TURNSTILE_TEST_SECRET = /^[123]x0{31}AA$/;

function value(env: Env, name: string): string {
  const text = env[name]?.trim();
  if (!text || /REPLACE_WITH_/i.test(text)) throw new WebConfigurationError();
  return text;
}

function endpoint(text: string, { allowLoopbackHttp, allowPath, allowAnyHttp = false }: { allowLoopbackHttp: boolean; allowPath: boolean; allowAnyHttp?: boolean }): URL {
  let url: URL;
  try { url = new URL(text); } catch { throw new WebConfigurationError(); }
  const loopback = LOOPBACK.includes(url.hostname);
  if (url.username || url.password || url.search || url.hash || (!allowPath && url.pathname !== '/')
    || !(url.protocol === 'https:' || (url.protocol === 'http:' && ((loopback && allowLoopbackHttp) || allowAnyHttp)))) throw new WebConfigurationError();
  return url;
}

export function readEnvironment(env: Env): WebEnvironment {
  const environment = env.PICKLY_ENV;
  if (environment !== 'local' && environment !== 'staging' && environment !== 'production') throw new WebConfigurationError();
  return environment;
}

/** The page's own origin; every POST must come from it. Hosted environments must be https; a local run may use
 * plain http, including a LAN address so a phone on the same network can try the page. */
export function readOrigin(env: Env): string {
  const environment = readEnvironment(env);
  return endpoint(value(env, 'PRELAUNCH_ORIGIN'), { allowLoopbackHttp: environment !== 'production', allowAnyHttp: environment === 'local', allowPath: false }).origin;
}

/** Values the browser needs. Neither is secret: the Maps key is referrer-restricted, the site key is public. */
export function readPageConfig(env: Env) {
  const mapsBrowserKey = value(env, 'GOOGLE_MAPS_BROWSER_API_KEY');
  const turnstileSiteKey = value(env, 'TURNSTILE_SITE_KEY');
  if (!/^[A-Za-z0-9_-]{8,128}$/.test(mapsBrowserKey) || !/^[A-Za-z0-9_-]{8,128}$/.test(turnstileSiteKey)) throw new WebConfigurationError();
  return { mapsBrowserKey, turnstileSiteKey, contactEmail: readContactAddress(env) };
}

export function readContactAddress(env: Env): string {
  const contact = value(env, 'PRELAUNCH_CONTACT_EMAIL').toLowerCase();
  if (contact.length > 254 || !EMAIL.test(contact)) throw new WebConfigurationError();
  return contact;
}

/** Vercel's own client IP header is trusted only when the code runs on Vercel; otherwise one shared bucket. */
export function readTrustVercelIp(env: Env): boolean {
  return env.VERCEL === '1';
}

export function readSupabaseConfig(env: Env) {
  const environment = readEnvironment(env);
  const url = endpoint(value(env, 'PRELAUNCH_SUPABASE_URL'), { allowLoopbackHttp: environment === 'local', allowPath: false }).origin;
  const key = value(env, 'PRELAUNCH_SUPABASE_SECRET_KEY');
  try {
    const role = key.startsWith('eyJ') ? JSON.parse(atob((key.split('.')[1] ?? '').replaceAll('-', '+').replaceAll('_', '/'))).role : null;
    if (!(key.startsWith('sb_secret_') || role === 'service_role')) throw new WebConfigurationError();
  } catch { throw new WebConfigurationError(); }
  return { url, key };
}

/** Upstash REST settings. Local runs may use a loopback stand-in; hosted ones only a real Upstash database. */
export function readLimiterConfig(env: Env) {
  const environment = readEnvironment(env);
  const url = endpoint(value(env, 'UPSTASH_REDIS_REST_URL'), { allowLoopbackHttp: environment === 'local', allowPath: false });
  if (!(url.hostname.endsWith('.upstash.io') || (environment === 'local' && LOOPBACK.includes(url.hostname))) || url.port && !LOOPBACK.includes(url.hostname)) {
    throw new WebConfigurationError();
  }
  const token = value(env, 'UPSTASH_REDIS_REST_TOKEN');
  const salt = value(env, 'RATE_LIMIT_KEY_SECRET');
  if (salt.length < 32) throw new WebConfigurationError();
  return { environment, url: url.origin, token, salt };
}

export function readTurnstileConfig(env: Env) {
  const environment = readEnvironment(env);
  const secret = value(env, 'TURNSTILE_SECRET_KEY');
  if (secret.length > 256 || /\s/.test(secret) || (environment === 'production' && TURNSTILE_TEST_SECRET.test(secret))) throw new WebConfigurationError();
  return { environment, secret, hostname: new URL(readOrigin(env)).hostname };
}

export function readGeocodingKey(env: Env): string {
  const key = value(env, 'GOOGLE_MAPS_SERVER_API_KEY');
  if (!/^[A-Za-z0-9_-]{8,128}$/.test(key)) throw new WebConfigurationError();
  return key;
}

/** The keyed hash of claim codes; T54 redemption needs the same secret. */
export function readCodeSecret(env: Env): string {
  const secret = value(env, 'PRELAUNCH_CODE_SECRET');
  if (secret.length < 32) throw new WebConfigurationError();
  return secret;
}

/** Resend's HTTP API by default; a local harness may point at a loopback stand-in. */
export function readEmailConfig(env: Env) {
  const environment = readEnvironment(env);
  const apiUrl = endpoint(env.EMAIL_API_URL?.trim() || 'https://api.resend.com/emails', { allowLoopbackHttp: environment === 'local', allowPath: true }).href;
  const apiKey = value(env, 'EMAIL_API_KEY');
  const from = value(env, 'EMAIL_FROM');
  const address = /<([^<>]+)>$/.exec(from)?.[1] ?? from;
  if (/[\r\n]/.test(from) || from.length > 200 || !EMAIL.test(address) || /\s/.test(apiKey)) throw new WebConfigurationError();
  return { apiUrl, apiKey, from, replyTo: readContactAddress(env) };
}
