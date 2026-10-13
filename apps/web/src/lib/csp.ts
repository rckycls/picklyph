// Google's documented Maps JavaScript API origins (allowlist form) and Cloudflare Turnstile; nothing else
// loads. Next's own inline scripts carry the per-request nonce. No cookies or sessions are ever set.
const MAPS = 'https://*.googleapis.com https://*.gstatic.com https://*.google.com https://*.googleusercontent.com https://*.ggpht.com';
const TURNSTILE = 'https://challenges.cloudflare.com';

/** `development` adds only the dev server's hot-reload socket. */
export function contentSecurityPolicy(nonce: string, secure: boolean, development = false): string {
  return [
    "default-src 'self'",
    // Google's reference policy for the Maps JavaScript API includes 'unsafe-eval'.
    `script-src 'self' 'nonce-${nonce}' 'unsafe-eval' ${MAPS} ${TURNSTILE} blob:`,
    `style-src 'self' 'unsafe-inline' https://fonts.googleapis.com`,
    `img-src 'self' data: blob: ${MAPS}`,
    "font-src 'self' https://fonts.gstatic.com",
    `connect-src 'self' ${MAPS} data: blob:${development ? ' ws:' : ''}`,
    `frame-src https://*.google.com ${TURNSTILE}`,
    'worker-src blob:',
    "object-src 'none'",
    "base-uri 'none'",
    "form-action 'self'",
    "frame-ancestors 'none'",
    ...(secure ? ['upgrade-insecure-requests'] : []),
  ].join('; ');
}
