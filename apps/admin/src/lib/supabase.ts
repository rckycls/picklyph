import 'server-only';
import { createServerClient } from '@supabase/ssr';
import { cookies } from 'next/headers';
import type { Database } from '@picklyph/domain';
import { readAdminConfig } from './config';

export const adminCookieOptions = () => ({
  httpOnly: true, sameSite: 'lax' as const, secure: process.env.NODE_ENV === 'production', path: '/',
});

export async function createAdminClient(writable = false) {
  const config = readAdminConfig(process.env);
  const store = await cookies();
  return createServerClient<Database>(config.url, config.key, {
    cookieOptions: adminCookieOptions(),
    global: { fetch: (url, init) => fetch(url, { ...init, cache: 'no-store', signal: AbortSignal.timeout(10000) }) },
    cookies: {
      getAll: () => store.getAll(),
      setAll: (items) => {
        // Server components read cookies refreshed by proxy. Route handlers persist changes.
        if (writable) for (const { name, value, options } of items) store.set(name, value, options);
      },
    },
  });
}
