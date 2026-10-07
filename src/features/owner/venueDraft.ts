import {
  MAX_OWNER_COURTS, MAX_PHOTO_BYTES, MIN_PHOTO_SIDE, VenueInputError, photoDimensionsAllowed, readOwnerVenueCommand,
  type CourtStatus, type CourtSurface, type OwnedVenueSummary, type OwnerVenue, type OwnerVenueSave, type PhotoType,
} from '@picklyph/domain';

/** `key` is stable for React lists; new courts have no `id` until the server saves them. */
export type CourtDraft = { key: string; id: string | null; name: string; surface: CourtSurface | null; is_indoor: boolean; is_covered: boolean; status: CourtStatus };
export type VenueDraft = { name: string; address_line: string; city: string; province: string; courts: CourtDraft[] };
type Built<T> = { ok: true; command: T } | { ok: false; message: string };

export const SURFACE_LABELS: readonly { value: CourtSurface | null; label: string }[] = [
  { value: 'hard', label: 'Hard' }, { value: 'synthetic', label: 'Synthetic' }, { value: 'other', label: 'Other' }, { value: null, label: 'Not set' },
];

export function draftFrom(venue: OwnerVenue): VenueDraft {
  return {
    name: venue.name, address_line: venue.address_line, city: venue.city, province: venue.province,
    courts: venue.courts.map((court) => ({ key: court.id, id: court.id, name: court.name, surface: court.surface,
      is_indoor: court.is_indoor, is_covered: court.is_covered, status: court.status })),
  };
}

/** A new active court named after the next unused number ("Court 3"). */
export function addCourt(draft: VenueDraft, key: string): VenueDraft {
  const names = new Set(draft.courts.map((court) => court.name.trim().toLowerCase()));
  let number = draft.courts.length + 1;
  while (names.has(`court ${number}`)) number++;
  return { ...draft, courts: [...draft.courts, { key, id: null, name: `Court ${number}`, surface: null, is_indoor: false, is_covered: false, status: 'active' }] };
}

export function updateCourt(draft: VenueDraft, key: string, patch: Partial<Omit<CourtDraft, 'key' | 'id'>>): VenueDraft {
  return { ...draft, courts: draft.courts.map((court) => (court.key === key ? { ...court, ...patch } : court)) };
}

/** Only unsaved courts can be removed; saved courts are deactivated instead, keeping their history. */
export function removeNewCourt(draft: VenueDraft, key: string): VenueDraft {
  return { ...draft, courts: draft.courts.filter((court) => court.key !== key || court.id !== null) };
}

export function isDirty(draft: VenueDraft, venue: OwnerVenue): boolean {
  const strip = ({ key: _key, ...court }: CourtDraft) => court;
  return JSON.stringify({ ...draft, courts: draft.courts.map(strip) }) !== JSON.stringify({ ...draftFrom(venue), courts: draftFrom(venue).courts.map(strip) });
}

/** Normalizes through the shared contract the server also enforces. */
export function saveCommand(draft: VenueDraft, venue: OwnerVenue): Built<OwnerVenueSave> {
  if (draft.courts.length > MAX_OWNER_COURTS) return { ok: false, message: `A venue can list at most ${MAX_OWNER_COURTS} courts.` };
  if (!draft.courts.some((court) => court.status === 'active')) {
    return { ok: false, message: 'Keep at least one court active. To close the venue, contact pickly support.' };
  }
  try {
    const command = readOwnerVenueCommand(JSON.stringify({
      kind: 'save', venue_id: venue.id, expected_updated_at: venue.updated_at,
      venue: { name: draft.name, address_line: draft.address_line, city: draft.city, province: draft.province },
      courts: draft.courts.map(({ key: _key, ...court }) => court),
    }));
    return command.kind === 'save' ? { ok: true, command } : { ok: false, message: 'Check the details and try again.' };
  } catch (error) {
    return { ok: false, message: error instanceof VenueInputError ? error.message : 'Check the details and try again.' };
  }
}

/** Device-side precheck; the server re-reads the real type, size and dimensions from the bytes. */
export function photoProblem(asset: { uri: string; mimeType?: string | null; fileSize?: number | null; width?: number; height?: number }): { type: PhotoType } | { problem: string } {
  const extension = /\.(jpe?g|png)$/i.exec(asset.uri)?.[1]?.toLowerCase();
  const type = asset.mimeType?.toLowerCase() ?? (extension === 'png' ? 'image/png' : extension ? 'image/jpeg' : undefined);
  if (type !== 'image/jpeg' && type !== 'image/png') return { problem: 'Choose a JPEG or PNG photo.' };
  if (typeof asset.fileSize === 'number' && asset.fileSize > MAX_PHOTO_BYTES) return { problem: 'That photo is larger than 5 MB. Choose a smaller photo.' };
  if (asset.width && asset.height && !photoDimensionsAllowed(asset.width, asset.height)) {
    return { problem: `Choose a photo at least ${MIN_PHOTO_SIDE} pixels on each side and no larger than 25 megapixels.` };
  }
  return { type };
}

/** Why a linked venue can or can't be edited, in owner terms. */
export function summaryStatus(venue: Pick<OwnedVenueSummary, 'editable' | 'publication_status'>): { label: string; tone: 'success' | 'pending' | 'error'; note: string | null } {
  if (venue.editable) return { label: 'Published · You manage this venue', tone: 'success', note: null };
  if (venue.publication_status === 'draft') {
    return { label: 'Waiting to be published', tone: 'pending', note: 'pickly is preparing this listing. You can edit it once it’s published.' };
  }
  return { label: 'Not shown on pickly', tone: 'error', note: 'This listing is suspended, so it can’t be edited. Contact pickly support.' };
}
