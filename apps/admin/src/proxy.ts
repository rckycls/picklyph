import { createServerClient } from '@supabase/ssr';
import { NextResponse, type NextRequest } from 'next/server';
import type { Database } from '@picklyph/domain';
import { readAdminConfig } from './lib/config';
import { adminCookieOptions } from './lib/supabase';

/** Cookie refresh only. Every protected page/operation independently checks current roles. */
export async function proxy(request: NextRequest) {
  let response = NextResponse.next({ request });
  response.headers.set('Cache-Control', 'private, no-store');
  response.headers.set('Expires', '0');
  response.headers.set('Pragma', 'no-cache');
  try {
    const settings = readAdminConfig(process.env);
    const client = createServerClient<Database>(settings.url, settings.key, {
      cookieOptions: adminCookieOptions(),
      global: { fetch: (url, init) => fetch(url, { ...init, cache: 'no-store', signal: AbortSignal.timeout(10000) }) },
      cookies: {
        getAll: () => request.cookies.getAll(),
        setAll: (items, cacheHeaders) => {
          for (const { name, value } of items) request.cookies.set(name, value);
          response = NextResponse.next({ request });
          response.headers.set('Cache-Control', 'private, no-store');
          response.headers.set('Expires', '0');
          response.headers.set('Pragma', 'no-cache');
          for (const [name, value] of Object.entries(cacheHeaders)) response.headers.set(name, value);
          for (const { name, value, options } of items) response.cookies.set(name, value, options);
        },
      },
    });
    await client.auth.getUser();
  } catch {
    // Configuration/network failure is handled safely by the independent page/API guard.
  }
  return response;
}

export const config = { matcher: ['/', '/login', '/console/:path*', '/api/:path*'] };
