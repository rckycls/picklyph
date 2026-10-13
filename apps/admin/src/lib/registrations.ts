// Pre-launch registrations in the console (T54b): settings, the send-new-code and erase runners and their
// messages. Pure: the route handler passes the database and email calls in, so unit tests run these directly.
import { generateClaimCode, hashClaimCode } from '@picklyph/domain/src/claimCode.ts';
import { newCodeEmail, type EmailSender, type EmailSettings } from '@picklyph/domain/src/prelaunchEmail.ts';
import type { RegistrationEraseResult, RegistrationOutcome, RegistrationRotateResult, RegistrationSendItem } from '@picklyph/domain/src/prelaunchAdmin.ts';

export class RegistrationSettingsError extends Error {
  constructor() { super('Sending codes is not configured.'); this.name = 'RegistrationSettingsError'; }
}

/** Server-only settings for sending codes. The same `PRELAUNCH_CODE_SECRET` as the registration page and
 * `owner-submissions`, or the new codes won't match. */
export type RegistrationSettings = { codeSecret: string; email: EmailSettings; origin: string; contactEmail: string; appUrl: string | null };

type Env = Record<string, string | undefined>;
const LOOPBACK = ['localhost', '127.0.0.1', '[::1]'];
const EMAIL = /^[^\s@<>]+@[^\s@<>]+\.[^\s@<>]+$/;

function value(env: Env, name: string): string {
  const text = env[name]?.trim();
  if (!text || /REPLACE_WITH_/i.test(text)) throw new RegistrationSettingsError();
  return text;
}

/** https, or plain http on this machine only (the local harness's stand-ins). */
function url(text: string, { allowPath, httpsOnly = false }: { allowPath: boolean; httpsOnly?: boolean }): URL {
  let parsed: URL;
  try { parsed = new URL(text); } catch { throw new RegistrationSettingsError(); }
  if (parsed.username || parsed.password || parsed.search || parsed.hash || (!allowPath && parsed.pathname !== '/')
    || !(parsed.protocol === 'https:' || (!httpsOnly && parsed.protocol === 'http:' && LOOPBACK.includes(parsed.hostname)))) throw new RegistrationSettingsError();
  return parsed;
}

export function readRegistrationSettings(env: Env): RegistrationSettings {
  const codeSecret = value(env, 'PRELAUNCH_CODE_SECRET');
  if (codeSecret.length < 32) throw new RegistrationSettingsError();
  const contactEmail = value(env, 'PRELAUNCH_CONTACT_EMAIL').toLowerCase();
  if (contactEmail.length > 254 || !EMAIL.test(contactEmail)) throw new RegistrationSettingsError();
  const origin = url(value(env, 'PRELAUNCH_ORIGIN'), { allowPath: false }).origin;
  const apiUrl = url(env.EMAIL_API_URL?.trim() || 'https://api.resend.com/emails', { allowPath: true }).href;
  const apiKey = value(env, 'EMAIL_API_KEY');
  const from = value(env, 'EMAIL_FROM');
  const address = /<([^<>]+)>$/.exec(from)?.[1] ?? from;
  if (/[\r\n]/.test(from) || from.length > 200 || !EMAIL.test(address) || /\s/.test(apiKey)) throw new RegistrationSettingsError();
  const app = env.PRELAUNCH_APP_URL?.trim();
  const appUrl = app ? url(app, { allowPath: true, httpsOnly: true }).href : null;
  return { codeSecret, email: { apiUrl, apiKey, from, replyTo: contactEmail }, origin, contactEmail, appUrl };
}

type RpcError = { code?: string | null; hint?: string | null };
type RpcResult<T> = { data: T | null; error: RpcError | null };

const UNAVAILABLE = 'Unavailable right now. Try again.';
const NOT_DELIVERED = 'The new code was made but the email didn’t go out, so the earlier code no longer works. Send again.';

/** The database's refusal, in the administrator's words. */
export function registrationFailureMessage(error: RpcError): string {
  switch (error.hint) {
    case 'not_open': return 'It was claimed or erased, so it gets no new code.';
    case 'changed': return 'It changed after you loaded the list (another code may have gone out). Reload and check before sending again.';
    case 'listing_unavailable': return 'Its listing is suspended, so a code couldn’t be used.';
    case 'already_verified': return 'Its listing already has a verified owner.';
    case 'not_found': return 'This registration no longer exists.';
    case 'invalid_input': return 'Reload the list and try again.';
  }
  if (error.code === '42501') return 'Administrator access required.';
  if (error.code === '22023' || error.code === '22P02') return 'Reload the list and try again.';
  // PostgREST: no such function, i.e. a database without the T54b migration.
  if (error.code === 'PGRST202') return 'This needs the latest database update. Ask the operator to apply it.';
  return UNAVAILABLE;
}

/** Spacing between emails, under the provider's per-second limit (Resend's default is 2 a second). */
export const EMAIL_SPACING_MS = 600;

export type SendDeps = {
  // Supabase query builders are thenables, not Promises.
  rotate: (id: string, expectedVersion: number, codeHash: string) => PromiseLike<RpcResult<RegistrationRotateResult>>;
  emailSent: (id: string, version: number) => PromiseLike<RpcResult<boolean>>;
  sendEmail: EmailSender;
  generateCode?: () => string;
  pause?: (ms: number) => Promise<void>;
};

/**
 * One registration after another: a new code (rotated in the database, so the old one stops working), its email,
 * then the delivery record. A code collision retries with another code; nothing here retries a failed email,
 * because sending again rotates once more.
 */
export async function sendNewCodes(items: RegistrationSendItem[], settings: RegistrationSettings, deps: SendDeps): Promise<RegistrationOutcome[]> {
  const generate = deps.generateCode ?? (() => generateClaimCode());
  const pause = deps.pause ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  const outcomes: RegistrationOutcome[] = [];
  let emailed = false;
  for (const item of items) {
    try {
      let rotated: RegistrationRotateResult | null = null;
      let code = '';
      let refusal: RpcError | null = null;
      for (let attempt = 0; attempt < 3 && !rotated && !refusal; attempt++) {
        code = generate();
        const { data, error } = await deps.rotate(item.id, item.code_version, await hashClaimCode(settings.codeSecret, code));
        if (error?.hint === 'code_collision') continue;
        if (error || !data) refusal = error ?? {};
        else rotated = data;
      }
      if (!rotated) { outcomes.push({ id: item.id, done: false, message: refusal ? registrationFailureMessage(refusal) : UNAVAILABLE }); continue; }
      if (emailed) await pause(EMAIL_SPACING_MS);
      emailed = true;
      try {
        await deps.sendEmail({ to: rotated.email, ...newCodeEmail({ ownerName: rotated.owner_name, venueName: rotated.venue_name, code,
          contactEmail: settings.contactEmail, origin: settings.origin, appUrl: settings.appUrl }),
          idempotencyKey: `prelaunch-${rotated.registration_id}-v${rotated.code_version}` });
      } catch {
        // The code already rotated: whatever failed, the owner has no working code until the next send.
        outcomes.push({ id: item.id, done: false, message: NOT_DELIVERED });
        continue;
      }
      const recorded = await Promise.resolve(deps.emailSent(rotated.registration_id, rotated.code_version)).catch(() => null);
      outcomes.push({ id: item.id, done: true, message: !recorded || recorded.error || recorded.data !== true ? 'Sent, but the delivery wasn’t recorded. Reload to check it.' : null });
    } catch {
      outcomes.push({ id: item.id, done: false, message: UNAVAILABLE });
    }
  }
  return outcomes;
}

export async function eraseRegistrations(ids: string[], erase: (id: string) => PromiseLike<RpcResult<RegistrationEraseResult>>): Promise<RegistrationOutcome[]> {
  const outcomes: RegistrationOutcome[] = [];
  for (const id of ids) {
    try {
      const { data, error } = await erase(id);
      if (error || !data) outcomes.push({ id, done: false, message: error ? registrationFailureMessage(error) : UNAVAILABLE });
      else outcomes.push({ id, done: true, message: data.outcome === 'existing' ? 'Already erased.' : null });
    } catch {
      outcomes.push({ id, done: false, message: UNAVAILABLE });
    }
  }
  return outcomes;
}
