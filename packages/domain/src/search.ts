import type { CourtSurface, MapBounds, Venue } from './directory.ts';

export const MAX_SEARCH_PAGE = 50;
export type VenueSearch = {
  bounds: MapBounds | null;
  city: string | null;
  name: string | null;
  indoor: boolean | null;
  covered: boolean | null;
  surface: CourtSurface | null;
  after: string | null;
  limit: number;
};
export type VenueSearchItem = Pick<Venue, 'id' | 'name' | 'address_line' | 'city' | 'province' | 'country_code' | 'latitude' | 'longitude' | 'claim_status'> & {
  active_court_count: number;
};
export type VenueSearchPage = { venues: VenueSearchItem[]; next_cursor: string | null };

export class SearchInputError extends Error {
  constructor() { super('Invalid search query.'); this.name = 'SearchInputError'; }
}

/** GET contract: exact city, literal name substring, intersecting optional filters. */
export function readVenueSearch(params: URLSearchParams): VenueSearch {
  const allowed = new Set(['south', 'west', 'north', 'east', 'city', 'name', 'indoor', 'covered', 'surface', 'after', 'limit']);
  if (params.toString().length > 2048) throw new SearchInputError();
  for (const key of params.keys()) {
    if (!allowed.has(key) || params.getAll(key).length !== 1) throw new SearchInputError();
  }
  function text(key: string, min: number, max: number): string | null {
    const raw = params.get(key);
    if (raw === null) return null;
    const value = raw.trim();
    if ([...value].length < min || [...value].length > max || /[\u0000-\u001f\u007f]/.test(value)) throw new SearchInputError();
    return value;
  }
  const coords = ['south', 'west', 'north', 'east'].map((key) => params.get(key));
  let bounds: MapBounds | null = null;
  if (coords.some((value) => value !== null)) {
    if (coords.some((value) => value === null || !/^-?\d+(?:\.\d+)?$/.test(value))) throw new SearchInputError();
    const [south, west, north, east] = coords.map(Number);
    if (south === undefined || west === undefined || north === undefined || east === undefined ||
      ![south, west, north, east].every(Number.isFinite) || south < -90 || north > 90 || west < -180 || east > 180 ||
      south > north || west > east || north - south > 30 || east - west > 30) throw new SearchInputError();
    bounds = { south, west, north, east };
  }
  const city = text('city', 2, 80);
  const name = text('name', 3, 120);
  if (!bounds && !city && !name) throw new SearchInputError();
  function flag(key: string): boolean | null {
    const raw = params.get(key);
    if (raw === null) return null;
    if (raw !== 'true' && raw !== 'false') throw new SearchInputError();
    return raw === 'true';
  }
  const surface = params.get('surface');
  if (surface !== null && surface !== 'hard' && surface !== 'synthetic' && surface !== 'other') throw new SearchInputError();
  const after = params.get('after');
  if (after !== null && !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(after)) throw new SearchInputError();
  const rawLimit = params.get('limit');
  if (rawLimit !== null && !/^\d{1,2}$/.test(rawLimit)) throw new SearchInputError();
  const limit = rawLimit === null ? 25 : Number(rawLimit);
  if (limit < 1 || limit > MAX_SEARCH_PAGE) throw new SearchInputError();
  return { bounds, city, name, indoor: flag('indoor'), covered: flag('covered'), surface, after: after?.toLowerCase() ?? null, limit };
}
