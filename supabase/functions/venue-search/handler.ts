import { readVenueSearch, SearchInputError, type VenueSearch, type VenueSearchPage } from '../../../packages/domain/src/search.ts';
import type { RateDecision, RatePrincipal } from '../_shared/rate-limit.ts';

type Dependencies = {
  verifyUser: (token: string) => Promise<string | null>;
  guestSource: (headers: Headers) => string;
  limit: (principal: RatePrincipal) => Promise<RateDecision>;
  search: (query: VenueSearch) => Promise<VenueSearchPage>;
  degraded?: () => void;
};
const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, OPTIONS',
  'Access-Control-Allow-Headers': 'authorization, apikey, content-type, x-client-info',
  'Access-Control-Expose-Headers': 'Retry-After, X-RateLimit-Limit, X-RateLimit-Remaining, X-RateLimit-Reset',
};
export function createSearchHandler(deps: Dependencies) {
  return async (request: Request): Promise<Response> => {
    const respond = (status: number, body: unknown, headers: Record<string, string> = {}) => new Response(JSON.stringify(body), {
      status, headers: { ...CORS, 'Cache-Control': 'private, no-store', 'Content-Type': 'application/json', ...headers },
    });
    if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers: { ...CORS, 'Cache-Control': 'no-store' } });
    if (request.method !== 'GET') return respond(405, { error: 'method_not_allowed' }, { Allow: 'GET, OPTIONS' });
    let query: VenueSearch;
    try {
      if (request.url.length > 4096) throw new SearchInputError();
      query = readVenueSearch(new URL(request.url).searchParams);
    } catch { return respond(400, { error: 'invalid_search' }); }
    let principal: RatePrincipal = { kind: 'guest', id: deps.guestSource(request.headers) };
    const authorization = request.headers.get('authorization');
    if (authorization !== null) {
      const match = /^Bearer ([^\s]{1,4096})$/i.exec(authorization);
      if (!match?.[1]) return respond(401, { error: 'invalid_auth' });
      try {
        const id = await deps.verifyUser(match[1]);
        if (!id) return respond(401, { error: 'invalid_auth' });
        principal = { kind: 'user', id };
      } catch { return respond(503, { error: 'auth_unavailable' }, { 'Retry-After': '5' }); }
    }
    const decision = await deps.limit(principal);
    if (!decision.allowed) return respond(decision.status, { error: decision.status === 429 ? 'rate_limited' : 'temporarily_unavailable' }, decision.headers);
    if (decision.state === 'degraded') deps.degraded?.();
    try { return respond(200, await deps.search(query), decision.headers); }
    catch { return respond(503, { error: 'search_unavailable' }, { ...decision.headers, 'Retry-After': '5' }); }
  };
}
