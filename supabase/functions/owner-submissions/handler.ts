import {
  MAX_EVIDENCE_BYTES, OwnerInputError, readOwnerLookup, readOwnerSubmission, sniffEvidence,
  type AddressCandidate, type EvidenceType, type OwnerDuplicate, type OwnerSubmissionRequest, type OwnerSubmitResult,
} from '../../../packages/domain/src/owner.ts';
import type { RateAction, RateDecision, RatePrincipal } from '../_shared/rate-limit.ts';

/** A database rejection the client can act on; `reason` is the SQL hint. */
export class CommandRejected extends Error {
  constructor(readonly reason: string) { super(reason); this.name = 'CommandRejected'; }
}
export const REJECTIONS: Record<string, { status: number; error: string }> = {
  invalid_input: { status: 400, error: 'invalid_submission' },
  invalid_evidence: { status: 400, error: 'invalid_evidence' },
  actor_required: { status: 403, error: 'account_required' },
  listing_unavailable: { status: 404, error: 'listing_unavailable' },
  already_verified: { status: 409, error: 'already_verified' },
  already_pending: { status: 409, error: 'already_pending' },
  request_reused: { status: 409, error: 'request_reused' },
  too_many_pending: { status: 409, error: 'too_many_pending' },
};

type Dependencies = {
  verifyUser: (token: string) => Promise<string | null>;
  limit: (action: Extract<RateAction, 'owner-submit' | 'owner-lookup'>, principal: RatePrincipal) => Promise<RateDecision>;
  /** Null when address search is not configured; throws when the provider fails. */
  geocode: ((address: string) => Promise<AddressCandidate[]>) | null;
  nearby: (actor: string, latitude: number, longitude: number, name: string | null) => Promise<OwnerDuplicate[]>;
  upload: (path: string, bytes: Uint8Array, type: EvidenceType) => Promise<void>;
  remove: (path: string) => Promise<void>;
  submit: (actor: string, request: OwnerSubmissionRequest, evidencePath: string) => Promise<OwnerSubmitResult>;
  newId: () => string;
  /** Fixed event names only: never identifiers, input or infrastructure errors. */
  warn?: (event: 'address_search_failed' | 'submission_failed' | 'evidence_cleanup_failed') => void;
};

// Multipart overhead around one evidence file and a small JSON part.
const MAX_BODY = MAX_EVIDENCE_BYTES + 64 * 1024;

async function readBounded(request: Request): Promise<Uint8Array<ArrayBuffer> | null> {
  const declared = request.headers.get('content-length');
  if (declared !== null && (!/^\d{1,9}$/.test(declared) || Number(declared) > MAX_BODY)) return null;
  if (!request.body) return new Uint8Array();
  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > MAX_BODY) { await reader.cancel().catch(() => {}); return null; }
    chunks.push(value);
  }
  const body = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) { body.set(chunk, offset); offset += chunk.byteLength; }
  return body;
}

/**
 * Authenticated owner commands. Native-only: no browser CORS.
 * GET ?address=…                       address suggestions (owner-lookup limit)
 * GET ?latitude=…&longitude=…[&name=…] approved listings nearby (owner-lookup limit)
 * POST multipart {submission, evidence} claim or missing-venue submission (owner-submit limit)
 */
export function createOwnerHandler(deps: Dependencies) {
  return async (request: Request): Promise<Response> => {
    const respond = (status: number, body: unknown, headers: Record<string, string> = {}) => new Response(JSON.stringify(body), {
      status, headers: { 'Cache-Control': 'private, no-store', 'Content-Type': 'application/json', ...headers },
    });
    if (request.method !== 'GET' && request.method !== 'POST') return respond(405, { error: 'method_not_allowed' }, { Allow: 'GET, POST' });
    if (request.url.length > 2048) return respond(400, { error: 'invalid_request' });
    const authorization = request.headers.get('authorization');
    if (authorization === null) return respond(401, { error: 'sign_in_required' });
    const match = /^Bearer ([^\s]{1,4096})$/i.exec(authorization);
    if (!match?.[1]) return respond(401, { error: 'invalid_auth' });
    let actor: string | null;
    try { actor = await deps.verifyUser(match[1]); } catch { return respond(503, { error: 'auth_unavailable' }, { 'Retry-After': '5' }); }
    if (!actor) return respond(401, { error: 'invalid_auth' });
    const principal: RatePrincipal = { kind: 'user', id: actor };

    if (request.method === 'GET') {
      let lookup;
      try { lookup = readOwnerLookup(new URL(request.url).searchParams); } catch { return respond(400, { error: 'invalid_request' }); }
      const decision = await deps.limit('owner-lookup', principal);
      if (!decision.allowed) return respond(decision.status, { error: decision.status === 429 ? 'rate_limited' : 'temporarily_unavailable' }, decision.headers);
      if (lookup.kind === 'address') {
        if (!deps.geocode) return respond(503, { error: 'address_search_unavailable' }, decision.headers);
        try { return respond(200, { candidates: await deps.geocode(lookup.address) }, decision.headers); }
        catch {
          deps.warn?.('address_search_failed');
          return respond(503, { error: 'address_search_unavailable' }, { ...decision.headers, 'Retry-After': '5' });
        }
      }
      try { return respond(200, { duplicates: await deps.nearby(actor, lookup.latitude, lookup.longitude, lookup.name) }, decision.headers); }
      catch (error) {
        if (error instanceof CommandRejected && REJECTIONS[error.reason]) {
          const rejection = REJECTIONS[error.reason]!;
          return respond(rejection.status, { error: rejection.error }, decision.headers);
        }
        return respond(503, { error: 'lookup_unavailable' }, { ...decision.headers, 'Retry-After': '5' });
      }
    }

    // POST: the limiter runs before reading the body or any storage/database side effect.
    const decision = await deps.limit('owner-submit', principal);
    if (!decision.allowed) return respond(decision.status, { error: decision.status === 429 ? 'rate_limited' : 'temporarily_unavailable' }, decision.headers);
    const contentType = request.headers.get('content-type') ?? '';
    if (!/^multipart\/form-data;\s*boundary=/i.test(contentType)) return respond(415, { error: 'multipart_required' }, decision.headers);
    let bytes: Uint8Array;
    let submission: OwnerSubmissionRequest;
    let evidenceType: EvidenceType;
    try {
      const body = await readBounded(request);
      if (!body) return respond(413, { error: 'evidence_too_large' }, decision.headers);
      const form = await new Response(body, { headers: { 'content-type': contentType } }).formData();
      const keys = [...form.keys()];
      if (keys.length !== 2 || new Set(keys).size !== 2 || !keys.includes('submission') || !keys.includes('evidence')) throw new OwnerInputError();
      const json = form.get('submission');
      const file = form.get('evidence');
      if (typeof json !== 'string' || file === null || typeof file === 'string') throw new OwnerInputError();
      submission = readOwnerSubmission(json);
      if (file.size < 1) throw new OwnerInputError();
      if (file.size > MAX_EVIDENCE_BYTES) return respond(413, { error: 'evidence_too_large' }, decision.headers);
      bytes = new Uint8Array(await file.arrayBuffer());
      const sniffed = sniffEvidence(bytes);
      if (!sniffed) return respond(415, { error: 'unsupported_evidence' }, decision.headers);
      evidenceType = sniffed;
    } catch { return respond(400, { error: 'invalid_submission' }, decision.headers); }

    // Server-chosen object name under the verified user's folder; never client input.
    const path = `${actor}/${deps.newId()}.${evidenceType === 'image/png' ? 'png' : 'jpg'}`;
    try { await deps.upload(path, bytes, evidenceType); }
    catch {
      deps.warn?.('submission_failed');
      return respond(503, { error: 'submission_unavailable' }, { ...decision.headers, 'Retry-After': '5' });
    }
    let result: OwnerSubmitResult | null = null;
    let rejected: { status: number; error: string } | null = null;
    try {
      result = await deps.submit(actor, submission, path);
    } catch (error) {
      if (error instanceof CommandRejected && REJECTIONS[error.reason]) rejected = REJECTIONS[error.reason]!;
      else deps.warn?.('submission_failed');
    }
    // Only a newly created record keeps this upload; retries reuse the original evidence.
    if (result?.outcome !== 'created') await deps.remove(path).catch(() => deps.warn?.('evidence_cleanup_failed'));
    if (result?.outcome === 'created') return respond(201, { submission: result.submission, duplicates: result.duplicates }, decision.headers);
    if (result?.outcome === 'existing') return respond(200, { submission: result.submission, duplicates: [] }, decision.headers);
    if (result?.outcome === 'duplicates') return respond(409, { error: 'possible_duplicates', duplicates: result.duplicates }, decision.headers);
    if (rejected) return respond(rejected.status, { error: rejected.error }, decision.headers);
    return respond(503, { error: 'submission_unavailable' }, { ...decision.headers, 'Retry-After': '5' });
  };
}
