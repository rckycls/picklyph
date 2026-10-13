// Server-side Cloudflare Turnstile check, run before anything is written. A failed check is the visitor's
// (403); an unreachable or odd siteverify is ours and fails closed (503). Testing-key results (Cloudflare's
// dummy secrets) pass only outside production; real results must name our hostname and the register action.

export const TURNSTILE_VERIFY_URL = 'https://challenges.cloudflare.com/turnstile/v0/siteverify';
export const TURNSTILE_ACTION = 'register';
export type TurnstileSettings = { environment: string; secret: string; hostname: string };
export type TurnstileVerifier = (token: string, remoteIp: string | null) => Promise<boolean>;

export class TurnstileUnavailable extends Error {
  constructor() { super('Turnstile unavailable'); this.name = 'TurnstileUnavailable'; }
}

export function createTurnstileVerifier(settings: TurnstileSettings | null, fetcher: typeof fetch = fetch, timeoutMs = 5000): TurnstileVerifier {
  return async (token, remoteIp) => {
    if (!settings) throw new TurnstileUnavailable();
    let body: Record<string, unknown>;
    try {
      const response = await fetcher(TURNSTILE_VERIFY_URL, {
        method: 'POST', cache: 'no-store', signal: AbortSignal.timeout(timeoutMs),
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ secret: settings.secret, response: token, ...(remoteIp ? { remoteip: remoteIp } : {}) }),
      });
      if (!response.ok) throw new TurnstileUnavailable();
      const parsed: unknown = await response.json();
      if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed) || typeof (parsed as { success?: unknown }).success !== 'boolean') {
        throw new TurnstileUnavailable();
      }
      body = parsed as Record<string, unknown>;
    } catch { throw new TurnstileUnavailable(); }
    if (body.success !== true) {
      const codes = Array.isArray(body['error-codes']) ? body['error-codes'] : [];
      // Our own secret or request was refused: that is an outage, not the visitor's fault.
      if (codes.some((code) => code === 'missing-input-secret' || code === 'invalid-input-secret' || code === 'bad-request' || code === 'internal-error')) {
        throw new TurnstileUnavailable();
      }
      return false;
    }
    const testing = (body.metadata as { result_with_testing_key?: unknown } | undefined)?.result_with_testing_key === true;
    if (testing) return settings.environment !== 'production';
    return body.hostname === settings.hostname && body.action === TURNSTILE_ACTION;
  };
}
