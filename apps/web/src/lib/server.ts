import 'server-only';
import { createClient } from '@supabase/supabase-js';
import type { Database } from '@picklyph/domain';
import { createGeocoder } from '../../../../supabase/functions/owner-submissions/geocode.ts';
import {
  readCodeSecret, readContactAddress, readEmailConfig, readGeocodingKey, readLimiterConfig, readOrigin, readSupabaseConfig,
  readTrustVercelIp, readTurnstileConfig,
} from './config.ts';
import { vercelClientIp } from './http.ts';
import { createLimiter } from './limits.ts';
import { createTurnstileVerifier } from './turnstile.ts';
import { createEmailSender } from './email.ts';
import { generateClaimCode, hashClaimCode } from './claim-code.ts';
import { RegisterRpcError, createRegisterHandler } from './register-handler.ts';
import { createLookupHandler } from './lookup-handler.ts';

// Wires the route handlers to process.env. Each setting is read on every request, so a missing one answers
// 503 for that request instead of failing the build; nothing here reaches the browser bundle.
const env = process.env;
const optional = <T>(read: () => T): T | null => { try { return read(); } catch { return null; } };
const clientIp = (headers: Headers) => (readTrustVercelIp(env) ? vercelClientIp(headers) : null);
const log = (event: string) => console.warn(`[prelaunch] ${event}`);

function serviceClient() {
  const config = readSupabaseConfig(env);
  return createClient<Database>(config.url, config.key, {
    auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
    global: { fetch: (url, init) => fetch(url, { ...init, cache: 'no-store', signal: AbortSignal.timeout(10000) }) },
  });
}

export const handleRegister = createRegisterHandler({
  settings: () => {
    // Everything the command needs must be present before anything runs.
    readSupabaseConfig(env); readCodeSecret(env); readEmailConfig(env); readTurnstileConfig(env); readLimiterConfig(env);
    return { origin: readOrigin(env), contactEmail: readContactAddress(env) };
  },
  clientIp,
  verifyTurnstile: (token, ip) => createTurnstileVerifier(optional(() => readTurnstileConfig(env)))(token, ip),
  limit: (action, kind, id) => createLimiter(optional(() => readLimiterConfig(env)))(action, kind, id),
  generateCode: () => generateClaimCode(),
  hashCode: (code) => hashClaimCode(readCodeSecret(env), code),
  register: async (args) => {
    const { data, error } = await serviceClient().rpc('prelaunch_register', args);
    if (error || !data) throw new RegisterRpcError(error?.code ?? null, error?.hint ?? null);
    return data;
  },
  emailSent: async (registrationId, version) => {
    const { data, error } = await serviceClient().rpc('prelaunch_email_sent', { registration_id: registrationId, sent_version: version });
    if (error) throw new RegisterRpcError(error.code ?? null, error.hint ?? null);
    return data === true;
  },
  sendEmail: (email) => createEmailSender(optional(() => readEmailConfig(env)))(email),
  log,
});

export const handleLookup = createLookupHandler({
  origin: () => { readGeocodingKey(env); readLimiterConfig(env); return readOrigin(env); },
  clientIp,
  limit: (action, kind, id) => createLimiter(optional(() => readLimiterConfig(env)))(action, kind, id),
  geocode: (query) => createGeocoder(readGeocodingKey(env))(query),
  log,
});
