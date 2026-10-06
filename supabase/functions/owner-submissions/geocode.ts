import { inSubmissionBounds, type AddressCandidate } from '../../../packages/domain/src/owner.ts';

type Component = { longText?: unknown; shortText?: unknown; types?: unknown };
const MAX_RESPONSE = 256 * 1024;

function component(components: Component[], type: string): string | null {
  const found = components.find((part) => Array.isArray(part.types) && part.types.includes(type));
  return typeof found?.longText === 'string' ? found.longText.trim() : null;
}
// Provider text is untrusted: reject control characters rather than display them.
// deno-lint-ignore no-control-regex
const CONTROL = /[\u0000-\u001f\u007f]/;
const fits = (value: string | null, max: number): value is string =>
  value !== null && value.length > 0 && [...value].length <= max && !CONTROL.test(value);

/**
 * Converts Geocoding API v4 results to owner suggestions. Only Philippine results
 * with usable fields survive; nothing is cached or stored by this adapter.
 */
export function parseGeocode(body: unknown): AddressCandidate[] {
  if (typeof body !== 'object' || body === null) throw new Error('Unexpected geocoding response');
  const results = (body as { results?: unknown }).results;
  if (results === undefined) return [];
  if (!Array.isArray(results)) throw new Error('Unexpected geocoding response');
  const candidates: AddressCandidate[] = [];
  for (const raw of results.slice(0, 10)) {
    if (typeof raw !== 'object' || raw === null) continue;
    const result = raw as { formattedAddress?: unknown; location?: { latitude?: unknown; longitude?: unknown }; addressComponents?: unknown };
    const components = Array.isArray(result.addressComponents) ? result.addressComponents as Component[] : [];
    const country = components.find((part) => Array.isArray(part.types) && part.types.includes('country'));
    const latitude = result.location?.latitude;
    const longitude = result.location?.longitude;
    if (country?.shortText !== 'PH' || typeof latitude !== 'number' || typeof longitude !== 'number'
      || !inSubmissionBounds(latitude, longitude) || typeof result.formattedAddress !== 'string') continue;
    const label = result.formattedAddress.trim();
    const number = component(components, 'street_number');
    const route = component(components, 'route');
    const street = route ? (number ? `${number} ${route}` : route) : component(components, 'premise');
    const area = component(components, 'sublocality_level_1') ?? component(components, 'neighborhood');
    const address = [street, area].filter(Boolean).join(', ') || label.split(',')[0]?.trim() || null;
    const city = component(components, 'locality') ?? component(components, 'administrative_area_level_3');
    const province = component(components, 'administrative_area_level_2') ?? component(components, 'administrative_area_level_1');
    if (!fits(label, 240) || !fits(address, 240)) continue;
    candidates.push({
      label, address_line: address,
      city: fits(city, 80) ? city : '', province: fits(province, 80) ? province : '',
      latitude, longitude,
    });
    if (candidates.length === 5) break;
  }
  return candidates;
}

/** Server key travels in a header, never in a URL that could be logged. */
export function createGeocoder(key: string, fetcher: typeof fetch = fetch) {
  return async (address: string): Promise<AddressCandidate[]> => {
    const url = `https://geocode.googleapis.com/v4/geocode/address/${encodeURIComponent(address)}?regionCode=PH&languageCode=en`;
    const response = await fetcher(url, {
      headers: { 'X-Goog-Api-Key': key, Accept: 'application/json' },
      signal: AbortSignal.timeout(4000),
    });
    if (!response.ok) throw new Error('Geocoding unavailable');
    const text = await response.text();
    if (text.length > MAX_RESPONSE) throw new Error('Geocoding response too large');
    return parseGeocode(JSON.parse(text));
  };
}
