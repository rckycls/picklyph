import 'server-only';
import { NextResponse } from 'next/server';
import { createAdminClient } from './supabase';
import { readAdminConfig } from './config';
import { RequestError, readJsonBody, readEmail, requireSameOrigin } from './http';

export function jsonResponse(body: object, status = 200) {
  return NextResponse.json(body, { status, headers: { 'Cache-Control': 'private, no-cache, no-store, must-revalidate, max-age=0', Expires: '0', Pragma: 'no-cache' } });
}

export async function handleAuthPost(request: Request, operation: 'request' | 'verify' | 'signout') {
  try {
    const settings = readAdminConfig(process.env);
    requireSameOrigin(request, settings.origin);
    const input = await readJsonBody(request);
    const client = await createAdminClient(true);
    if (operation === 'signout') {
      const result = await client.auth.signOut({ scope: 'local' });
      if (result.error) return jsonResponse({ error: 'Sign-out is unavailable. Please retry.' }, 503);
      return jsonResponse({ ok: true });
    }
    const email = readEmail(input);
    if (operation === 'request') {
      const { error } = await client.auth.signInWithOtp({ email, options: { shouldCreateUser: false } });
      if (error?.status === 429) {
        const response = jsonResponse({ error: 'Please wait before requesting another code.' }, 429);
        response.headers.set('Retry-After', '60');
        return response;
      }
      if (error && (!error.status || error.status >= 500)) return jsonResponse({ error: 'Email sign-in is unavailable. Please retry.' }, 503);
      // Same success response for unknown accounts; do not reveal account existence.
      return jsonResponse({ ok: true });
    }
    if (typeof input.code !== 'string' || !/^\d{6,10}$/.test(input.code)) throw new RequestError(400, 'Enter the verification code from your email.');
    const result = await client.auth.verifyOtp({ email, token: input.code, type: 'email' });
    if (result.error?.status === 429) return jsonResponse({ error: 'Too many attempts. Please wait and try again.' }, 429);
    if (result.error && (!result.error.status || result.error.status >= 500)) return jsonResponse({ error: 'Verification is unavailable. Please retry.' }, 503);
    if (result.error || !result.data.session) return jsonResponse({ error: 'The code is incorrect or expired. Request a new code and try again.' }, 400);
    // Tokens persist only in HttpOnly cookies. No tokens/metadata returned to browser code.
    return jsonResponse({ ok: true });
  } catch (error) {
    if (error instanceof RequestError) return jsonResponse({ error: error.message }, error.status);
    return jsonResponse({ error: 'Admin sign-in is unavailable. Please retry or contact the operator.' }, 503);
  }
}
