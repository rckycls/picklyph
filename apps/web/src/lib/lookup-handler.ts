import type { AddressCandidate } from '@picklyph/domain';
import { PrelaunchInputError, readAddressQuery } from '@picklyph/domain/src/prelaunch.ts';
import { RequestError, errorReply, readJsonBody, reply, requireSameOrigin } from './http.ts';
import { LimiterUnavailable, type Limiter } from './limits.ts';

export type LookupDeps = {
  /** The configured origin; throws when address search isn't configured. */
  origin: () => string;
  clientIp: (headers: Headers) => string | null;
  limit: Limiter;
  /** Server-side Geocoding (T15 adapter); only Philippine results inside the pin box come back. */
  geocode: (query: string) => Promise<AddressCandidate[]>;
  log?: (event: string) => void;
};

const UNAVAILABLE = 'Address search is unavailable right now. Move the map to the venue instead.';

/** `POST /api/address` → `{ candidates }`. The browser never holds the Geocoding key. */
export function createLookupHandler(deps: LookupDeps) {
  const log = deps.log ?? (() => {});
  return async (request: Request): Promise<Response> => {
    try {
      let origin: string;
      try { origin = deps.origin(); } catch { log('prelaunch.lookup_not_configured'); throw new RequestError(503, 'unavailable', UNAVAILABLE); }
      requireSameOrigin(request, origin);
      let query: string;
      try { query = readAddressQuery(await readJsonBody(request, 1024)); } catch (error) {
        if (error instanceof PrelaunchInputError) throw new RequestError(400, 'invalid_input', error.message);
        throw error;
      }
      try {
        const decision = await deps.limit('prelaunch-lookup', 'ip', deps.clientIp(request.headers) ?? 'shared');
        if (!decision.allowed) {
          throw new RequestError(429, 'rate_limited', 'Too many searches. Wait a moment, or move the map to the venue.', { 'Retry-After': String(decision.retryAfter) });
        }
      } catch (error) {
        if (!(error instanceof LimiterUnavailable)) throw error;
        log('prelaunch.limiter_unavailable');
        throw new RequestError(503, 'unavailable', UNAVAILABLE, { 'Retry-After': '30' });
      }
      try {
        return reply(200, { candidates: await deps.geocode(query) });
      } catch {
        log('prelaunch.geocoding_unavailable');
        throw new RequestError(503, 'unavailable', UNAVAILABLE, { 'Retry-After': '30' });
      }
    } catch (error) {
      if (error instanceof RequestError) return errorReply(error);
      return errorReply(new RequestError(503, 'unavailable', UNAVAILABLE));
    }
  };
}
