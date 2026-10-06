import type { OwnerSubmission, OwnerSubmissionRequest } from '@picklyph/domain';

import { fetchWithDeadline } from '@/lib/fetchWithDeadline';
import { getSupabase } from '@/lib/supabase';

import {
  findNearbyListings, parseMySubmissions, searchAddress, submitOwner,
  type EvidenceFile, type OwnerOutcome, type OwnerTransport,
} from './ownerClient';
import type { Pin } from './ownerForm';

let transport: OwnerTransport | null | undefined;

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
      // React Native's FormData streams this { uri, name, type } file part from disk;
      // the DOM typings used for type checking only describe Blob parts.
      evidencePart: (file) => ({ uri: file.uri, name: file.name, type: file.type }) as unknown as Blob,
    };
  } catch {
    transport = null;
  }
  return transport;
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
