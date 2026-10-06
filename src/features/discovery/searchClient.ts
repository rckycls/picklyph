import type { CourtSurface, MapBounds, VenueClaimStatus, VenueSearchItem, VenueSearchPage } from '@picklyph/domain';

// Pure T13 client: no app imports, so the contract is testable in Node against the real parser/endpoint.
export const SEARCH_PAGE_SIZE = 25;
const MAX_PAGE = 50;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const CLAIMS: readonly VenueClaimStatus[] = ['unclaimed', 'pending', 'verified'];

export type DiscoveryFilters = { indoor: boolean | null; covered: boolean | null; surface: CourtSurface | null };
export const NO_FILTERS: DiscoveryFilters = { indoor: null, covered: null, surface: null };
export type DiscoveryQuery = DiscoveryFilters & { bounds: MapBounds | null; city?: string | null; name?: string | null };

export type SearchFailure = {
  kind: 'network' | 'rate_limited' | 'unavailable' | 'rejected' | 'not_configured';
  retryAfterSeconds: number | null;
};
export type SearchOutcome = { ok: true; page: VenueSearchPage } | { ok: false; failure: SearchFailure };
export type SearchTransport = {
  endpoint: string;
  apiKey: string;
  /** Verified-user bucket when signed in; null searches as a guest. */
  accessToken: () => Promise<string | null>;
  fetch: (input: string, init: RequestInit) => Promise<Response>;
};

const coordinate = (value: number) => value.toFixed(4);

/** Selectors and filters only; the cursor/limit are page state, not query identity. */
export function filterKey(query: DiscoveryFilters): string {
  return `${query.indoor ?? ''}|${query.covered ?? ''}|${query.surface ?? ''}`;
}

export function searchParams(query: DiscoveryQuery, after: string | null = null, limit = SEARCH_PAGE_SIZE): URLSearchParams {
  const params = new URLSearchParams();
  if (query.bounds) {
    params.set('south', coordinate(query.bounds.south));
    params.set('west', coordinate(query.bounds.west));
    params.set('north', coordinate(query.bounds.north));
    params.set('east', coordinate(query.bounds.east));
  }
  if (query.city) params.set('city', query.city);
  if (query.name) params.set('name', query.name);
  if (query.indoor !== null) params.set('indoor', String(query.indoor));
  if (query.covered !== null) params.set('covered', String(query.covered));
  if (query.surface !== null) params.set('surface', query.surface);
  if (after) params.set('after', after);
  params.set('limit', String(limit));
  return params;
}

export function searchKey(query: DiscoveryQuery): string {
  return searchParams(query).toString();
}

function text(value: unknown, max: number): value is string {
  return typeof value === 'string' && value.length > 0 && value.length <= max;
}

/** Strict response check: an unexpected field type is an unavailable directory, never a guessed listing. */
export function parseSearchPage(body: unknown): VenueSearchPage {
  const fail = () => { throw new Error('Unexpected directory response.'); };
  if (typeof body !== 'object' || body === null) return fail();
  const { venues, next_cursor: next } = body as { venues?: unknown; next_cursor?: unknown };
  if (!Array.isArray(venues) || venues.length > MAX_PAGE) return fail();
  if (next !== null && !(typeof next === 'string' && UUID.test(next))) return fail();
  const items = venues.map((raw): VenueSearchItem => {
    if (typeof raw !== 'object' || raw === null) return fail();
    const item = raw as Record<string, unknown>;
    const { id, latitude, longitude, active_court_count: courts, claim_status: claim } = item;
    if (!(typeof id === 'string' && UUID.test(id)) || !text(item.name, 120) || !text(item.address_line, 240)
      || !text(item.city, 80) || !text(item.province, 80) || item.country_code !== 'PH'
      || typeof latitude !== 'number' || !Number.isFinite(latitude) || Math.abs(latitude) > 90
      || typeof longitude !== 'number' || !Number.isFinite(longitude) || Math.abs(longitude) > 180
      || !CLAIMS.includes(claim as VenueClaimStatus) || !Number.isSafeInteger(courts) || (courts as number) < 0) return fail();
    return {
      id: id.toLowerCase(), name: item.name as string, address_line: item.address_line as string,
      city: item.city as string, province: item.province as string, country_code: 'PH',
      latitude, longitude, claim_status: claim as VenueClaimStatus, active_court_count: courts as number,
    };
  });
  return { venues: items, next_cursor: typeof next === 'string' ? next.toLowerCase() : null };
}

function retryAfter(response: Response, fallback: number | null): number | null {
  const raw = response.headers.get('retry-after');
  if (raw === null || !/^\d{1,6}$/.test(raw.trim())) return fallback;
  return Math.min(Math.max(Number(raw), 1), 3600);
}

/**
 * One page from GET /functions/v1/venue-search. Guests send only the public key, never an SDK
 * fallback bearer. A stale user token is retried once as a guest because discovery is public.
 * Aborts propagate so a superseded query never updates the screen.
 */
export async function searchVenues(
  transport: SearchTransport,
  query: DiscoveryQuery,
  options: { after?: string | null; limit?: number; signal?: AbortSignal } = {},
): Promise<SearchOutcome> {
  const url = `${transport.endpoint}?${searchParams(query, options.after ?? null, options.limit).toString()}`;
  let token: string | null = null;
  try { token = await transport.accessToken(); } catch { token = null; }
  // React Native's AbortSignal polyfill has no throwIfAborted().
  if (options.signal?.aborted) throw new Error('Search superseded.');
  const request = (bearer: string | null) => transport.fetch(url, {
    method: 'GET',
    headers: { apikey: transport.apiKey, Accept: 'application/json', ...(bearer ? { Authorization: `Bearer ${bearer}` } : {}) },
    signal: options.signal,
  });
  let response: Response;
  try {
    response = await request(token);
    if (response.status === 401 && token) response = await request(null);
  } catch (error) {
    if (options.signal?.aborted) throw error;
    return { ok: false, failure: { kind: 'network', retryAfterSeconds: null } };
  }
  if (response.status === 429) return { ok: false, failure: { kind: 'rate_limited', retryAfterSeconds: retryAfter(response, 1) } };
  if (response.status === 400) return { ok: false, failure: { kind: 'rejected', retryAfterSeconds: null } };
  if (!response.ok) return { ok: false, failure: { kind: 'unavailable', retryAfterSeconds: retryAfter(response, null) } };
  try {
    return { ok: true, page: parseSearchPage(await response.json()) };
  } catch (error) {
    if (options.signal?.aborted) throw error;
    return { ok: false, failure: { kind: 'unavailable', retryAfterSeconds: null } };
  }
}
