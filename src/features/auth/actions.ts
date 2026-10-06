import type { SupabaseClient } from '@supabase/supabase-js';

type Auth = Pick<SupabaseClient['auth'], 'signInWithOtp' | 'verifyOtp' | 'signInWithIdToken' | 'updateUser'>;
export const normalizeEmail = (value: string) => value.trim().toLowerCase();
export const validEmail = (value: string) => value.length <= 254 && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value);
export const validCode = (value: string) => /^\d{6,10}$/.test(value.trim());

export function authMessage(error: unknown): string {
  const code = typeof error === 'object' && error !== null && 'code' in error ? error.code : undefined;
  if (code === 'otp_expired' || code === 'invalid_credentials') return 'That code is incorrect or expired. Try again or request a new code.';
  if (code === 'over_email_send_rate_limit' || code === 'over_request_rate_limit') return 'Please wait before trying again. Too many sign-in requests were made.';
  if (code === 'provider_disabled') return 'This sign-in option is temporarily unavailable. Please try email.';
  return 'We couldn’t complete sign-in. Check your connection and try again.';
}

export async function requestEmailCode(auth: Auth, email: string) {
  const normalized = normalizeEmail(email);
  if (!validEmail(normalized)) throw new Error('Enter a valid email address.');
  const { error } = await auth.signInWithOtp({ email: normalized, options: { shouldCreateUser: true } });
  if (error) throw new Error(authMessage(error));
}

export async function verifyEmailCode(auth: Auth, email: string, code: string) {
  if (!validEmail(normalizeEmail(email)) || !validCode(code)) throw new Error('Enter the verification code from your email.');
  const { data, error } = await auth.verifyOtp({ email: normalizeEmail(email), token: code.trim(), type: 'email' });
  if (error || !data.session) throw new Error(error ? authMessage(error) : 'Sign-in was not completed. Request a new code.');
}

export type ApplePort = {
  nonce: () => string;
  hash: (nonce: string) => Promise<string>;
  signIn: (hashedNonce: string) => Promise<{ identityToken: string | null; fullName?: string }>;
};
export async function signInApple(auth: Auth, apple: ApplePort): Promise<boolean> {
  const nonce = apple.nonce();
  let credential: Awaited<ReturnType<ApplePort['signIn']>>;
  try { credential = await apple.signIn(await apple.hash(nonce)); }
  catch (error) {
    if (typeof error === 'object' && error !== null && 'code' in error && error.code === 'ERR_REQUEST_CANCELED') return false;
    throw new Error('Apple sign-in didn’t complete. Try again or use email.');
  }
  if (!credential.identityToken) throw new Error('Apple did not return a sign-in token. Please try again.');
  const { data, error } = await auth.signInWithIdToken({ provider: 'apple', token: credential.identityToken, nonce });
  if (error || !data.session) throw new Error(error ? authMessage(error) : 'Apple sign-in was not completed.');
  // Apple supplies names only at first authorization. Metadata is display data, never a role.
  if (credential.fullName) {
    try { await auth.updateUser({ data: { full_name: credential.fullName } }); }
    catch { /* Sign-in succeeded; profile completion can recover missing display data. */ }
  }
  return true;
}
