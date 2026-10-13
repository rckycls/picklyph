import type { PrelaunchDuplicate, PrelaunchRegisterResult, PrelaunchRegistration, PrelaunchReply, PrelaunchRequest } from '@picklyph/domain';
import { MAX_OPEN_REGISTRATIONS_PER_EMAIL, MAX_PRELAUNCH_BODY, PrelaunchInputError, readPrelaunchRequest } from '@picklyph/domain/src/prelaunch.ts';
import { RequestError, errorReply, readJsonBody, reply, requireSameOrigin } from './http.ts';
import { LimiterUnavailable, type Limiter } from './limits.ts';
import { TurnstileUnavailable, type TurnstileVerifier } from './turnstile.ts';
import { EmailUnavailable, limitEmail, registrationEmail, type EmailSender } from './email.ts';

/** A PostgREST error from `prelaunch_register`: only its code and hint are used. */
export class RegisterRpcError extends Error {
  code: string | null;
  hint: string | null;
  constructor(code: string | null, hint: string | null) { super('Registration command failed'); this.code = code; this.hint = hint; }
}

export type RegisterDeps = {
  /** The configured page origin and contact address; throws when the server isn't configured. */
  settings: () => { origin: string; contactEmail: string };
  clientIp: (headers: Headers) => string | null;
  verifyTurnstile: TurnstileVerifier;
  limit: Limiter;
  generateCode: () => string;
  hashCode: (code: string) => Promise<string>;
  register: (args: { request_key: string; registration: PrelaunchRegistration; code_hash: string; acknowledge_duplicates: boolean }) => Promise<PrelaunchRegisterResult>;
  emailSent: (registrationId: string, version: number) => Promise<boolean>;
  sendEmail: EmailSender;
  /** Event names only (never codes, addresses or request bodies). */
  log?: (event: string) => void;
};

const UNAVAILABLE = 'Registration is unavailable right now. Try again in a few minutes.';
const LIMITED = 'Too many registrations from here. Try again later.';

function limited(retryAfter: number) {
  return new RequestError(429, 'rate_limited', LIMITED, { 'Retry-After': String(Math.max(1, retryAfter)) });
}

const duplicates = (items: PrelaunchRegisterResult['duplicates']): PrelaunchDuplicate[] =>
  items.slice(0, 10).map((item) => ({ name: item.name, address_line: item.address_line, city: item.city, distance_m: item.distance_m }));

/**
 * `POST /api/register`. Order: configuration, same Origin, bounded JSON, input, Turnstile, IP then email limits,
 * then the database command; the code email goes out after the commit. Created, existing and at-limit
 * registrations answer identically, so the reply never tells whether an address registered before.
 */
export function createRegisterHandler(deps: RegisterDeps) {
  const log = deps.log ?? (() => {});
  return async (request: Request): Promise<Response> => {
    try {
      let settings: { origin: string; contactEmail: string };
      try { settings = deps.settings(); } catch { log('prelaunch.not_configured'); throw new RequestError(503, 'unavailable', UNAVAILABLE, { 'Retry-After': '60' }); }
      requireSameOrigin(request, settings.origin);
      const raw = await readJsonBody(request, MAX_PRELAUNCH_BODY);
      let parsed: PrelaunchRequest;
      try { parsed = readPrelaunchRequest(raw); } catch (error) {
        throw new RequestError(400, 'invalid_input', error instanceof PrelaunchInputError ? error.message : 'Check the form and try again.');
      }
      const ip = deps.clientIp(request.headers);

      let passed: boolean;
      try { passed = await deps.verifyTurnstile(parsed.turnstile_token, ip); } catch (error) {
        if (!(error instanceof TurnstileUnavailable)) throw error;
        log('prelaunch.turnstile_unavailable');
        throw new RequestError(503, 'unavailable', UNAVAILABLE, { 'Retry-After': '30' });
      }
      if (!passed) throw new RequestError(403, 'check_failed', 'The security check didn’t pass. Try it again.');

      try {
        const byIp = await deps.limit('prelaunch-register', 'ip', ip ?? 'shared');
        if (!byIp.allowed) throw limited(byIp.retryAfter);
        const byEmail = await deps.limit('prelaunch-register', 'email', parsed.registration.email);
        if (!byEmail.allowed) throw limited(byEmail.retryAfter);
      } catch (error) {
        if (!(error instanceof LimiterUnavailable)) throw error;
        log('prelaunch.limiter_unavailable');
        throw new RequestError(503, 'unavailable', UNAVAILABLE, { 'Retry-After': '30' });
      }

      let code = '';
      let result: PrelaunchRegisterResult | null = null;
      for (let attempt = 0; attempt < 3 && !result; attempt++) {
        code = deps.generateCode();
        try {
          result = await deps.register({ request_key: parsed.request_key, registration: parsed.registration,
            code_hash: await deps.hashCode(code), acknowledge_duplicates: parsed.acknowledge_duplicates });
        } catch (error) {
          if (error instanceof RegisterRpcError && error.hint === 'code_collision') continue;
          if (error instanceof RegisterRpcError && error.hint === 'invalid_input') throw new RequestError(400, 'invalid_input', 'Check the form and try again.');
          if (error instanceof RegisterRpcError && error.hint === 'request_reused') {
            throw new RequestError(409, 'start_again', 'This form was already used. Reload the page and start again.');
          }
          log('prelaunch.database_unavailable');
          throw new RequestError(503, 'unavailable', UNAVAILABLE, { 'Retry-After': '30' });
        }
      }
      if (!result) { log('prelaunch.code_collisions'); throw new RequestError(503, 'unavailable', UNAVAILABLE, { 'Retry-After': '5' }); }

      if (result.outcome === 'duplicates') {
        const body: PrelaunchReply = { status: 'duplicates', duplicates: duplicates(result.duplicates) };
        return reply(200, body);
      }
      const venueName = result.venue_name;
      const failedSend = () => new RequestError(502, 'email_failed', 'We couldn’t send the email with your claim code. Check the address and try again.');
      if (result.outcome === 'limit') {
        const message = limitEmail({ venueName, contactEmail: settings.contactEmail, origin: settings.origin, max: MAX_OPEN_REGISTRATIONS_PER_EMAIL });
        try {
          await deps.sendEmail({ to: parsed.registration.email, ...message, idempotencyKey: `prelaunch-limit-${parsed.request_key}` });
        } catch (error) {
          if (!(error instanceof EmailUnavailable)) throw error;
          log('prelaunch.email_failed');
          throw failedSend();
        }
        log('prelaunch.limit');
      } else if (result.send && result.registration_id && result.code_version) {
        const message = registrationEmail({ ownerName: parsed.registration.owner_name, venueName, code,
          contactEmail: settings.contactEmail, origin: settings.origin });
        try {
          await deps.sendEmail({ to: parsed.registration.email, ...message,
            idempotencyKey: `prelaunch-${result.registration_id}-v${result.code_version}` });
        } catch (error) {
          if (!(error instanceof EmailUnavailable)) throw error;
          // The registration stays; a retry with the same request key rotates the code and sends again.
          log('prelaunch.email_failed');
          throw failedSend();
        }
        // A lost delivery record only means a retry would rotate the code and send once more.
        try { await deps.emailSent(result.registration_id, result.code_version); } catch { log('prelaunch.delivery_record_failed'); }
        log(result.outcome === 'created' ? 'prelaunch.created' : 'prelaunch.resent');
      } else {
        log('prelaunch.existing');
      }
      const body: PrelaunchReply = { status: 'sent', venue_name: venueName };
      return reply(200, body);
    } catch (error) {
      if (error instanceof RequestError) return errorReply(error);
      log('prelaunch.unexpected');
      return errorReply(new RequestError(503, 'unavailable', UNAVAILABLE, { 'Retry-After': '30' }));
    }
  };
}
