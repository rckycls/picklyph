import type { NextConfig } from 'next';

// Pages get their nonce-based Content-Security-Policy from src/proxy.ts; API answers allow nothing to load.
const config: NextConfig = {
  poweredByHeader: false,
  transpilePackages: ['@picklyph/domain'],
  async headers() {
    return [
      { source: '/:path*', headers: [
        { key: 'X-Content-Type-Options', value: 'nosniff' },
        { key: 'X-Frame-Options', value: 'DENY' },
        // The browser Maps key is restricted by referrer, so cross-origin requests keep the origin (never the path).
        { key: 'Referrer-Policy', value: 'strict-origin-when-cross-origin' },
        { key: 'Permissions-Policy', value: 'camera=(), microphone=(), geolocation=(), payment=(), usb=()' },
        { key: 'Strict-Transport-Security', value: 'max-age=63072000' },
      ] },
      { source: '/api/:path*', headers: [
        { key: 'Content-Security-Policy', value: "default-src 'none'; frame-ancestors 'none'" },
        { key: 'Cache-Control', value: 'no-store' },
      ] },
    ];
  },
};
export default config;
