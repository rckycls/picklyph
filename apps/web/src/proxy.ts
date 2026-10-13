import { NextResponse, type NextRequest } from 'next/server';
import { contentSecurityPolicy } from './lib/csp.ts';

export function proxy(request: NextRequest) {
  const nonce = btoa(crypto.randomUUID());
  const policy = contentSecurityPolicy(nonce, request.nextUrl.protocol === 'https:', process.env.NODE_ENV === 'development');
  const headers = new Headers(request.headers);
  headers.set('x-nonce', nonce);
  headers.set('Content-Security-Policy', policy);
  const response = NextResponse.next({ request: { headers } });
  response.headers.set('Content-Security-Policy', policy);
  response.headers.set('Cache-Control', 'private, no-store');
  return response;
}

export const config = {
  matcher: [{
    source: '/((?!api|_next/static|_next/image|favicon.ico|court-pin.svg|mark.svg|mark-white.svg).*)',
    missing: [{ type: 'header', key: 'next-router-prefetch' }, { type: 'header', key: 'purpose', value: 'prefetch' }],
  }],
};
