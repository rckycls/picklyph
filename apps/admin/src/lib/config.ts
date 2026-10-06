export class AdminConfigurationError extends Error {
  constructor() { super('Admin configuration is unavailable.'); }
}

export function readAdminConfig(env: Record<string, string | undefined>) {
  const url = env.ADMIN_SUPABASE_URL;
  const key = env.ADMIN_SUPABASE_PUBLISHABLE_KEY;
  const origin = env.ADMIN_ORIGIN;
  if (!url || !key || !origin || [url, key, origin].some((value) => value.includes('REPLACE_'))) throw new AdminConfigurationError();
  try {
    for (const value of [url, origin]) {
      const parsed = new URL(value);
      const loopback = ['localhost', '127.0.0.1', '[::1]'].includes(parsed.hostname);
      if (parsed.username || parsed.password || parsed.search || parsed.hash || parsed.pathname !== '/' ||
          !(parsed.protocol === 'https:' || (parsed.protocol === 'http:' && loopback))) throw new AdminConfigurationError();
    }
    // Hosted publishable keys, plus the local CLI's legacy anon JWT. Reject infrastructure keys.
    const legacyRole = key.startsWith('eyJ') ? JSON.parse(atob((key.split('.')[1] ?? '').replaceAll('-', '+').replaceAll('_', '/'))).role : null;
    if (!(key.startsWith('sb_publishable_') || legacyRole === 'anon')) throw new AdminConfigurationError();
  } catch { throw new AdminConfigurationError(); }
  return { url, key, origin: new URL(origin).origin };
}
