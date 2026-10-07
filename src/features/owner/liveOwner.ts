import type {
  AllocationBlock, CourtHoursSave, OwnerPhotoAdd, OwnerSubmission, OwnerSubmissionRequest, OwnerVenueSave, ScheduleSave, VenuePolicySave,
} from '@picklyph/domain';
import { File as DeviceFile } from 'expo-file-system';

import { fetchWithDeadline } from '@/lib/fetchWithDeadline';
import { getSupabase } from '@/lib/supabase';

import { blockCourt, loadCalendar, loadVenueSchedule, releaseBlock, saveCourtHours, saveVenueSchedule } from './calendarClient';
import {
  findNearbyListings, parseMySubmissions, searchAddress, submitOwner,
  type EvidenceFile, type OwnerOutcome, type OwnerTransport,
} from './ownerClient';
import type { Pin } from './ownerForm';
import {
  addVenuePhoto, listOwnedVenues, loadOwnedVenue, removeVenuePhoto, saveOwnedVenue,
  loadVenuePolicy, saveVenuePolicy,
  type OwnerHttpTransport, type PhotoFile, type VenueTransport,
} from './venueClient';

let transport: OwnerTransport | null | undefined;
let venueTransport: VenueTransport | null | undefined;
let scheduleTransport: OwnerHttpTransport | null | undefined;

/** Public URL/key plus the signed-in user's token; every server secret stays in the function. */
function liveTransport(): OwnerTransport | null {
  if (transport !== undefined) return transport;
  try {
    const client = getSupabase();
    transport = {
      endpoint: `${process.env.EXPO_PUBLIC_SUPABASE_URL?.trim() ?? ''}/functions/v1/owner-submissions`,
      apiKey: process.env.EXPO_PUBLIC_SUPABASE_PUBLISHABLE_KEY?.trim() ?? '',
      accessToken: async () => (await client.auth.getSession()).data.session?.access_token ?? null,
      // Photo uploads on mobile data can take longer than an ordinary request.
      fetch: (input, init) => fetchWithDeadline(input, init, init.method === 'POST' ? 60_000 : 15_000),
      // expo/fetch (the iOS global fetch) rejects React Native's { uri, name, type } parts with
      // "Unsupported FormDataPart". An expo-file-system File implements Blob and reads its bytes.
      // The server ignores client names/types and sniffs the bytes itself.
      evidencePart: (file) => new DeviceFile(file.uri) as unknown as Blob,
    };
  } catch {
    transport = null;
  }
  return transport;
}

/** Same public URL/key and token; photos stream from an expo-file-system File (see evidencePart). */
function liveVenueTransport(): VenueTransport | null {
  if (venueTransport !== undefined) return venueTransport;
  try {
    const client = getSupabase();
    venueTransport = {
      endpoint: `${process.env.EXPO_PUBLIC_SUPABASE_URL?.trim() ?? ''}/functions/v1/owner-venues`,
      apiKey: process.env.EXPO_PUBLIC_SUPABASE_PUBLISHABLE_KEY?.trim() ?? '',
      accessToken: async () => (await client.auth.getSession()).data.session?.access_token ?? null,
      // Photo uploads (multipart, not a JSON string) can take longer on mobile data.
      fetch: (input, init) => fetchWithDeadline(input, init, init.body && typeof init.body !== 'string' ? 60_000 : 15_000),
      photoPart: (file) => new DeviceFile(file.uri) as unknown as Blob,
    };
  } catch {
    venueTransport = null;
  }
  return venueTransport;
}

/** Same public URL/key and token for the owner-schedules function (calendar, blocks, hours). */
function liveScheduleTransport(): OwnerHttpTransport | null {
  if (scheduleTransport !== undefined) return scheduleTransport;
  try {
    const client = getSupabase();
    scheduleTransport = {
      endpoint: `${process.env.EXPO_PUBLIC_SUPABASE_URL?.trim() ?? ''}/functions/v1/owner-schedules`,
      apiKey: process.env.EXPO_PUBLIC_SUPABASE_PUBLISHABLE_KEY?.trim() ?? '',
      accessToken: async () => (await client.auth.getSession()).data.session?.access_token ?? null,
      fetch: (input, init) => fetchWithDeadline(input, init, 15_000),
    };
  } catch {
    scheduleTransport = null;
  }
  return scheduleTransport;
}

const notConfigured = { ok: false, failure: { kind: 'not_configured', retryAfterSeconds: null } } as const;

export function liveAddressSearch(address: string, signal?: AbortSignal) {
  const live = liveTransport();
  return live ? searchAddress(live, address, signal) : Promise.resolve(notConfigured);
}

export function liveNearbyListings(pin: Pin, name: string | null, signal?: AbortSignal) {
  const live = liveTransport();
  return live ? findNearbyListings(live, pin, name, signal) : Promise.resolve(notConfigured);
}

export function liveSubmit(request: OwnerSubmissionRequest, evidence: EvidenceFile): ReturnType<typeof submitOwner> {
  const live = liveTransport();
  return live ? submitOwner(live, request, evidence) : Promise.resolve(notConfigured);
}

/** Self-only status list: the RPC derives the caller from their token and reads only their records. */
export async function loadMySubmissions(): Promise<OwnerOutcome<OwnerSubmission[]>> {
  try {
    const { data, error } = await getSupabase().rpc('my_owner_submissions');
    if (error) return { ok: false, failure: { kind: error.code === '42501' ? 'sign_in' : 'unavailable', retryAfterSeconds: null } };
    return { ok: true, value: parseMySubmissions(data) };
  } catch {
    return { ok: false, failure: { kind: 'network', retryAfterSeconds: null } };
  }
}

export function liveOwnedVenues(signal?: AbortSignal): ReturnType<typeof listOwnedVenues> {
  const live = liveVenueTransport();
  return live ? listOwnedVenues(live, signal) : Promise.resolve(notConfigured);
}

export function liveOwnedVenue(venueId: string, signal?: AbortSignal): ReturnType<typeof loadOwnedVenue> {
  const live = liveVenueTransport();
  return live ? loadOwnedVenue(live, venueId, signal) : Promise.resolve(notConfigured);
}

export function liveSaveVenue(command: OwnerVenueSave): ReturnType<typeof saveOwnedVenue> {
  const live = liveVenueTransport();
  return live ? saveOwnedVenue(live, command) : Promise.resolve(notConfigured);
}

export function liveVenuePolicy(venueId: string, signal?: AbortSignal): ReturnType<typeof loadVenuePolicy> {
  const live = liveVenueTransport();
  return live ? loadVenuePolicy(live, venueId, signal) : Promise.resolve(notConfigured);
}

export function liveSavePolicy(command: VenuePolicySave, signal?: AbortSignal): ReturnType<typeof saveVenuePolicy> {
  const live = liveVenueTransport();
  return live ? saveVenuePolicy(live, command, signal) : Promise.resolve(notConfigured);
}

export function liveAddVenuePhoto(request: OwnerPhotoAdd, file: PhotoFile): ReturnType<typeof addVenuePhoto> {
  const live = liveVenueTransport();
  return live ? addVenuePhoto(live, request, file) : Promise.resolve(notConfigured);
}

export function liveRemoveVenuePhoto(venueId: string, photoId: string): ReturnType<typeof removeVenuePhoto> {
  const live = liveVenueTransport();
  return live ? removeVenuePhoto(live, { venue_id: venueId, photo_id: photoId }) : Promise.resolve(notConfigured);
}

/** How many venues this account currently manages (self-only RPC; current DB state, never JWT claims). */
export async function loadManagedVenueCount(): Promise<number | null> {
  try {
    const { data, error } = await getSupabase().rpc('my_account_access');
    if (error || !Array.isArray(data) || !data[0] || !Array.isArray(data[0].owned_venue_ids)) return null;
    return data[0].owned_venue_ids.length;
  } catch {
    return null;
  }
}

export function liveCalendar(venueId: string, startDate: string, days: number, signal?: AbortSignal): ReturnType<typeof loadCalendar> {
  const live = liveScheduleTransport();
  return live ? loadCalendar(live, venueId, startDate, days, signal) : Promise.resolve(notConfigured);
}

export function liveVenueSchedule(venueId: string, startDate: string, signal?: AbortSignal): ReturnType<typeof loadVenueSchedule> {
  const live = liveScheduleTransport();
  return live ? loadVenueSchedule(live, venueId, startDate, signal) : Promise.resolve(notConfigured);
}

export function liveSaveVenueSchedule(command: ScheduleSave, signal?: AbortSignal): ReturnType<typeof saveVenueSchedule> {
  const live = liveScheduleTransport();
  return live ? saveVenueSchedule(live, command, signal) : Promise.resolve(notConfigured);
}

export function liveSaveCourtHours(command: CourtHoursSave, signal?: AbortSignal): ReturnType<typeof saveCourtHours> {
  const live = liveScheduleTransport();
  return live ? saveCourtHours(live, command, signal) : Promise.resolve(notConfigured);
}

export function liveBlockCourt(command: AllocationBlock): ReturnType<typeof blockCourt> {
  const live = liveScheduleTransport();
  return live ? blockCourt(live, command) : Promise.resolve(notConfigured);
}

export function liveReleaseBlock(allocationId: string): ReturnType<typeof releaseBlock> {
  const live = liveScheduleTransport();
  return live ? releaseBlock(live, allocationId) : Promise.resolve(notConfigured);
}
