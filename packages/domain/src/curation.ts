import type { Court, CourtSurface, CourtStatus, Venue, VenuePublicationStatus } from './directory.ts';

export type VenueInput = Pick<Venue, 'name' | 'address_line' | 'city' | 'province' | 'latitude' | 'longitude'>;
export type CourtInput = { id: string | null; name: string; surface: CourtSurface | null; is_indoor: boolean; is_covered: boolean; status: CourtStatus };
export type DirectoryListing = Venue & { courts: Court[] };
export type DirectoryPage = { items: DirectoryListing[]; next_cursor: string | null };
export type DirectorySave = { id: string | null; expected_updated_at: string | null; venue: VenueInput; courts: CourtInput[] };
export type DirectoryImportEntry = { reference: string; venue: VenueInput; courts: CourtInput[] };
export type DirectoryImportResult = { reference: string; id: string; outcome: 'created' | 'existing' };
export const MAX_DIRECTORY_COURTS = 40;
export const MAX_DIRECTORY_IMPORT = 25;

export class DirectoryInputError extends Error {}
function invalid(message: string): never { throw new DirectoryInputError(message); }
function record(input: unknown, fields: string[]): Record<string, unknown> {
  if (!input || typeof input !== 'object' || Array.isArray(input)) invalid('Expected a JSON object.');
  const value = Object.fromEntries(Object.entries(input));
  if (Object.keys(value).length !== fields.length || fields.some((key) => !Object.hasOwn(value, key))) invalid('Unexpected or missing fields.');
  return value;
}
function text(value: unknown, name: string, max: number): string {
  if (typeof value !== 'string' || value.trim().length === 0 || [...value.trim()].length > max) invalid(`${name} must contain 1–${max} characters.`);
  return value.trim();
}
export function directoryUuid(value: unknown): string {
  if (typeof value !== 'string' || !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value)) invalid('Invalid listing or court identifier.');
  return value.toLowerCase();
}
function version(value: unknown): string {
  if (typeof value !== 'string' || !/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d{1,6})?(?:Z|[+-]\d\d:\d\d)$/.test(value) || !Number.isFinite(Date.parse(value))) invalid('Reload the listing before saving.');
  return value;
}
export function readVenueInput(input: unknown): VenueInput {
  const v = record(input, ['name', 'address_line', 'city', 'province', 'latitude', 'longitude']);
  const coordinate = (value: unknown, label: string, max: number) => {
    if (typeof value !== 'number' || !Number.isFinite(value) || value < -max || value > max) invalid(`${label} must be a number between ${-max} and ${max}.`);
    return value;
  };
  return { name: text(v.name, 'Venue name', 120), address_line: text(v.address_line, 'Address', 240), city: text(v.city, 'City', 80), province: text(v.province, 'Province', 80), latitude: coordinate(v.latitude, 'Latitude', 90), longitude: coordinate(v.longitude, 'Longitude', 180) };
}
export function readCourtInputs(input: unknown): CourtInput[] {
  if (!Array.isArray(input) || input.length > MAX_DIRECTORY_COURTS) invalid(`Use at most ${MAX_DIRECTORY_COURTS} courts per save.`);
  const names = new Set<string>(); const ids = new Set<string>();
  return input.map((item) => {
    const c = record(item, ['id', 'name', 'surface', 'is_indoor', 'is_covered', 'status']);
    const name = text(c.name, 'Court name', 80);
    if (names.has(name)) invalid('Court names must be unique within the venue.'); names.add(name);
    const id = c.id === null ? null : directoryUuid(c.id);
    if (id && ids.has(id)) invalid('A court can only appear once.'); if (id) ids.add(id);
    if (c.surface !== null && c.surface !== 'hard' && c.surface !== 'synthetic' && c.surface !== 'other') invalid('Choose a valid court surface.');
    if (typeof c.is_indoor !== 'boolean' || typeof c.is_covered !== 'boolean') invalid('Court amenities must be true or false.');
    if (c.status !== 'active' && c.status !== 'inactive') invalid('Choose a valid court status.');
    return { id, name, surface: c.surface, is_indoor: c.is_indoor, is_covered: c.is_covered, status: c.status };
  });
}
export function readDirectorySave(input: unknown): DirectorySave {
  const v = record(input, ['id', 'expected_updated_at', 'venue', 'courts']);
  const id = v.id === null ? null : directoryUuid(v.id);
  if (id === null && v.expected_updated_at !== null) invalid('A new draft must have no version.');
  const courts = readCourtInputs(v.courts);
  if (id === null && courts.some((court) => court.id !== null)) invalid('New drafts cannot reuse existing court identifiers.');
  return { id, expected_updated_at: id === null ? null : version(v.expected_updated_at), venue: readVenueInput(v.venue), courts };
}
export function readDirectoryPublication(input: unknown): { id: string; expected_updated_at: string; publication_status: VenuePublicationStatus } {
  const v = record(input, ['id', 'expected_updated_at', 'publication_status']);
  if (v.publication_status !== 'draft' && v.publication_status !== 'approved' && v.publication_status !== 'suspended') invalid('Choose a valid publication status.');
  return { id: directoryUuid(v.id), expected_updated_at: version(v.expected_updated_at), publication_status: v.publication_status };
}
export function readDirectoryImport(input: unknown): DirectoryImportEntry[] {
  const { listings } = record(input, ['listings']);
  if (!Array.isArray(listings) || listings.length < 1 || listings.length > MAX_DIRECTORY_IMPORT) invalid(`Import 1–${MAX_DIRECTORY_IMPORT} listings at a time.`);
  const references = new Set<string>();
  return listings.map((item) => {
    const v = record(item, ['reference', 'venue', 'courts']);
    const reference = text(v.reference, 'Import reference', 120);
    if (references.has(reference)) invalid('Import references must be unique.'); references.add(reference);
    const courts = readCourtInputs(v.courts);
    if (courts.some((c) => c.id !== null)) invalid('Imports cannot reuse court identifiers.');
    return { reference, venue: readVenueInput(v.venue), courts };
  });
}
