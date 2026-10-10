/**
 * Sign in with Apple token revocation (T50a), server-only. Apple asks apps that offer Sign in with Apple to revoke the
 * user's tokens when the account is deleted. The phone sends a fresh authorization code; this module exchanges it for
 * tokens with an ES256 client secret signed by the Sign in with Apple key (.p8), then revokes them.
 * See docs/privacy.md#sign-in-with-apple-revocation-t50a.
 */
export const APPLE_ORIGIN = 'https://appleid.apple.com';
export type AppleConfig = { teamId: string; keyId: string; clientId: string; privateKey: string };
/** Tokens from one exchange, for the Apple ID in `subject`. Held in memory for one request only, never stored. */
export type AppleGrant = { subject: string; token: string; hint: 'refresh_token' | 'access_token' };
export type AppleRevocation = {
  /** `null` when Apple refuses the code (`invalid_grant`: invalid, expired or already used); throws on any other failure. */
  exchange: (code: string) => Promise<AppleGrant | null>;
  revoke: (grant: AppleGrant) => Promise<void>;
};
type Fetch = (input: string, init: RequestInit) => Promise<Response>;

const APPLE_ID = /^[A-Z0-9]{10}$/;
const BUNDLE_ID = /^[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)+$/;
const SUBJECT = /^[\x21-\x7e]{1,255}$/;
/** Apple's client secret may live up to six months; a fresh five-minute one per request is cheaper to reason about. */
export const CLIENT_SECRET_SECONDS = 300;

/** All four settings or none: a partial or malformed configuration counts as missing, so Apple accounts fail closed. */
export function readAppleConfig(env: (name: string) => string | undefined): AppleConfig | null {
  const teamId = env('APPLE_TEAM_ID')?.trim(), keyId = env('APPLE_KEY_ID')?.trim(), clientId = env('APPLE_CLIENT_ID')?.trim();
  const privateKey = env('APPLE_PRIVATE_KEY')?.trim();
  if (!teamId || !keyId || !clientId || !privateKey || !APPLE_ID.test(teamId) || !APPLE_ID.test(keyId) || !BUNDLE_ID.test(clientId)
    || !privateKey.includes('PRIVATE KEY-----')) return null;
  return { teamId, keyId, clientId, privateKey };
}

const base64url = (bytes: Uint8Array) => btoa(Array.from(bytes, (b) => String.fromCharCode(b)).join('')).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
const segment = (value: unknown) => base64url(new TextEncoder().encode(JSON.stringify(value)));

/** The .p8 file as PEM; secret stores often keep newlines as literal `\n`. */
function pkcs8(pem: string): Uint8Array<ArrayBuffer> {
  const body = pem.replace(/\\n/g, '\n').replace(/-----(?:BEGIN|END) PRIVATE KEY-----/g, '').replace(/\s+/g, '');
  if (!/^[A-Za-z0-9+/]+={0,2}$/.test(body)) throw new Error('APPLE_PRIVATE_KEY is not a PEM private key.');
  return Uint8Array.from(atob(body), (c) => c.charCodeAt(0));
}

/** Claims of the ID token Apple's token endpoint returned to us directly over TLS (OIDC Core 3.1.3.7 step 6: no signature check needed). */
function claims(token: unknown): Record<string, unknown> {
  const part = typeof token === 'string' ? token.split('.')[1] : undefined;
  if (!part) throw new Error('Unexpected Apple ID token.');
  const bytes = Uint8Array.from(atob(part.replace(/-/g, '+').replace(/_/g, '/')), (c) => c.charCodeAt(0));
  const value: unknown = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes));
  if (typeof value !== 'object' || value === null || Array.isArray(value)) throw new Error('Unexpected Apple ID token.');
  return value as Record<string, unknown>;
}

export function createAppleRevocation(config: AppleConfig, request: Fetch, now: () => number = Date.now): AppleRevocation {
  let key: Promise<CryptoKey> | null = null;
  const signingKey = () => key ??= crypto.subtle.importKey('pkcs8', pkcs8(config.privateKey), { name: 'ECDSA', namedCurve: 'P-256' }, false, ['sign'])
    .catch((error) => { key = null; throw error; });

  async function clientSecret(): Promise<string> {
    const iat = Math.floor(now() / 1000);
    const unsigned = `${segment({ alg: 'ES256', kid: config.keyId })}.${segment({ iss: config.teamId, iat, exp: iat + CLIENT_SECRET_SECONDS, aud: APPLE_ORIGIN, sub: config.clientId })}`;
    // WebCrypto ECDSA signatures are already the raw r||s form that JWS ES256 uses.
    const signature = await crypto.subtle.sign({ name: 'ECDSA', hash: 'SHA-256' }, await signingKey(), new TextEncoder().encode(unsigned));
    return `${unsigned}.${base64url(new Uint8Array(signature))}`;
  }

  async function post(path: '/auth/token' | '/auth/revoke', fields: Record<string, string>): Promise<Response> {
    const body = new URLSearchParams({ client_id: config.clientId, client_secret: await clientSecret(), ...fields }).toString();
    return await request(`${APPLE_ORIGIN}${path}`, { method: 'POST', redirect: 'error', body,
      headers: { 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json' } });
  }

  return {
    exchange: async (code) => {
      const response = await post('/auth/token', { grant_type: 'authorization_code', code });
      const body: unknown = await response.json().catch(() => null);
      const reply = typeof body === 'object' && body !== null && !Array.isArray(body) ? body as Record<string, unknown> : {};
      if (response.status === 400 && reply.error === 'invalid_grant') return null;
      if (!response.ok) throw new Error(`Apple token endpoint answered ${response.status}.`);
      const identity = claims(reply.id_token);
      if (identity.iss !== APPLE_ORIGIN || identity.aud !== config.clientId || typeof identity.sub !== 'string' || !SUBJECT.test(identity.sub)) {
        throw new Error('Unexpected Apple ID token.');
      }
      // Revoking the refresh token ends the app's whole Apple authorization; the access token is the fallback.
      const refresh = reply.refresh_token, access = reply.access_token;
      if (typeof refresh === 'string' && refresh.length > 0) return { subject: identity.sub, token: refresh, hint: 'refresh_token' };
      if (typeof access === 'string' && access.length > 0) return { subject: identity.sub, token: access, hint: 'access_token' };
      throw new Error('Apple returned no token.');
    },
    revoke: async (grant) => {
      const response = await post('/auth/revoke', { token: grant.token, token_type_hint: grant.hint });
      await response.text().catch(() => '');
      if (!response.ok) throw new Error(`Apple revoke endpoint answered ${response.status}.`);
    },
  };
}
