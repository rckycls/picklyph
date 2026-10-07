import {
  MAX_PHOTO_BYTES, readOwnerPhotoAdd, readOwnerVenueCommand, readOwnerVenueQuery,
  type OwnedVenueSummary, type OwnerPhotoAdd, type OwnerPhotoAddResult, type OwnerPhotoRemove, type OwnerPhotoRemoveResult,
  type OwnerVenue, type OwnerVenueCommand, type OwnerVenueSave, type PhotoType,
} from '../../../packages/domain/src/ownerVenues.ts';
import type { RateAction, RateDecision, RatePrincipal } from '../_shared/rate-limit.ts';
import { cleanPhoto } from './photo.ts';
import { readPolicySave, type VenuePolicySave, type VenuePolicyView } from '../../../packages/domain/src/policy.ts';

/** A database rejection the client can act on; `reason` is the SQL hint. */
export class CommandRejected extends Error {
  constructor(readonly reason: string) { super(reason); this.name = 'CommandRejected'; }
}
export const REJECTIONS: Record<string, { status: number; error: string }> = {
  invalid_input: { status: 400, error: 'invalid_request' },
  invalid_photo: { status: 400, error: 'invalid_photo' },
  too_many_courts: { status: 400, error: 'too_many_courts' },
  active_court_required: { status: 400, error: 'active_court_required' },
  actor_required: { status: 403, error: 'account_required' },
  not_owner: { status: 403, error: 'not_owner' },
  merchant_inactive: { status: 403, error: 'merchant_inactive' },
  venue_unavailable: { status: 404, error: 'venue_unavailable' },
  version_conflict: { status: 409, error: 'version_conflict' },
  duplicate_court: { status: 409, error: 'duplicate_court' },
  too_many_photos: { status: 409, error: 'too_many_photos' },
  request_reused: { status: 409, error: 'request_reused' },
};
const PHOTO_PROBLEMS = {
  photo_too_large: 413, unsupported_photo: 415, invalid_photo: 400, photo_dimensions: 400,
} as const;

type Dependencies = {
  verifyUser: (token: string) => Promise<string | null>;
  limit: (action: Extract<RateAction, 'owner-read' | 'owner-edit'>, principal: RatePrincipal) => Promise<RateDecision>;
  list: (actor: string) => Promise<OwnedVenueSummary[]>;
  read: (actor: string, venueId: string) => Promise<OwnerVenue>;
  save: (actor: string, command: OwnerVenueSave) => Promise<OwnerVenue>;
  readPolicy: (actor: string, venueId: string) => Promise<VenuePolicyView>;
  savePolicy: (actor: string, command: VenuePolicySave) => Promise<VenuePolicyView>;
  upload: (path: string, bytes: Uint8Array, type: PhotoType) => Promise<void>;
  remove: (path: string) => Promise<void>;
  addPhoto: (actor: string, request: OwnerPhotoAdd, path: string, width: number, height: number) => Promise<OwnerPhotoAddResult>;
  removePhoto: (actor: string, command: OwnerPhotoRemove) => Promise<OwnerPhotoRemoveResult>;
  newId: () => string;
  /** Fixed event names only: never identifiers, input or infrastructure errors. */
  warn?: (event: 'command_failed' | 'photo_cleanup_failed') => void;
};

const MAX_JSON = 32 * 1024;
// Multipart overhead around one photo and a small JSON part.
const MAX_MULTIPART = MAX_PHOTO_BYTES + 64 * 1024;

async function readBounded(request: Request, max: number): Promise<Uint8Array<ArrayBuffer> | null> {
  const declared = request.headers.get('content-length');
  if (declared !== null && (!/^\d{1,9}$/.test(declared) || Number(declared) > max)) return null;
  if (!request.body) return new Uint8Array();
  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > max) { await reader.cancel().catch(() => {}); return null; }
    chunks.push(value);
  }
  const body = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) { body.set(chunk, offset); offset += chunk.byteLength; }
  return body;
}

/**
 * Verified-owner venue editing. Native-only: no browser CORS.
 * GET                                   your linked venues (owner-read limit)
 * GET ?venue_id=…                       one editable listing (owner-read limit)
 * POST JSON {kind:'save'|'remove_photo'} details/courts, or remove a photo (owner-edit limit)
 * POST multipart {photo, file}          add one public photo (owner-edit limit)
 * Authorization, version checks, limits and audit are enforced again in the database.
 */
export function createVenueHandler(deps: Dependencies) {
  return async (request: Request): Promise<Response> => {
    const respond = (status: number, body: unknown, headers: Record<string, string> = {}) => new Response(JSON.stringify(body), {
      status, headers: { 'Cache-Control': 'private, no-store', 'Content-Type': 'application/json', ...headers },
    });
    const refuse = (error: unknown, headers: Record<string, string>) => {
      if (error instanceof CommandRejected && REJECTIONS[error.reason]) {
        const rejection = REJECTIONS[error.reason]!;
        return respond(rejection.status, { error: rejection.error }, headers);
      }
      deps.warn?.('command_failed');
      return respond(503, { error: 'temporarily_unavailable' }, { ...headers, 'Retry-After': '5' });
    };
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
      let query;
      let policies = false;
      try {
        const params = new URL(request.url).searchParams;
        if (params.has('section')) {
          if (params.getAll('section').length !== 1 || params.get('section') !== 'policies' || !params.has('venue_id')) throw new Error();
          policies = true; params.delete('section');
        }
        query = readOwnerVenueQuery(params);
      } catch { return respond(400, { error: 'invalid_request' }); }
      const decision = await deps.limit('owner-read', principal);
      if (!decision.allowed) return respond(decision.status, { error: decision.status === 429 ? 'rate_limited' : 'temporarily_unavailable' }, decision.headers);
      try {
        if (policies && query.venue_id) return respond(200, { policy: await deps.readPolicy(actor, query.venue_id) }, decision.headers);
        return query.venue_id === null
          ? respond(200, { venues: await deps.list(actor) }, decision.headers)
          : respond(200, { venue: await deps.read(actor, query.venue_id) }, decision.headers);
      } catch (error) { return refuse(error, decision.headers); }
    }

    // POST: the limiter runs before reading the body or any storage/database side effect.
    const decision = await deps.limit('owner-edit', principal);
    if (!decision.allowed) return respond(decision.status, { error: decision.status === 429 ? 'rate_limited' : 'temporarily_unavailable' }, decision.headers);
    const contentType = request.headers.get('content-type') ?? '';

    if (/^application\/json(?:;|$)/i.test(contentType)) {
      let command: OwnerVenueCommand | VenuePolicySave;
      try {
        const body = await readBounded(request, MAX_JSON);
        if (!body) return respond(413, { error: 'request_too_large' }, decision.headers);
        const json = new TextDecoder('utf-8', { fatal: true }).decode(body);
        const raw: unknown = JSON.parse(json);
        command = raw && typeof raw === 'object' && 'kind' in raw && raw.kind === 'save_policy'
          ? readPolicySave(raw) : readOwnerVenueCommand(json);
      } catch { return respond(400, { error: 'invalid_request' }, decision.headers); }
      if (command.kind === 'save_policy') {
        try { return respond(200, { policy: await deps.savePolicy(actor, command) }, decision.headers); }
        catch (error) { return refuse(error, decision.headers); }
      }
      if (command.kind === 'save') {
        try { return respond(200, { venue: await deps.save(actor, command) }, decision.headers); }
        catch (error) { return refuse(error, decision.headers); }
      }
      let removed: OwnerPhotoRemoveResult;
      try { removed = await deps.removePhoto(actor, command); } catch (error) { return refuse(error, decision.headers); }
      // The row is gone (committed); an orphaned object is unreferenced, so only log a failed cleanup.
      if (removed.removed_path) await deps.remove(removed.removed_path).catch(() => deps.warn?.('photo_cleanup_failed'));
      return respond(200, { venue: removed.venue, removed: removed.removed_path !== null }, decision.headers);
    }

    if (!/^multipart\/form-data;\s*boundary=/i.test(contentType)) return respond(415, { error: 'unsupported_media_type' }, decision.headers);
    let photo: OwnerPhotoAdd;
    let file: Blob;
    try {
      const body = await readBounded(request, MAX_MULTIPART);
      if (!body) return respond(413, { error: 'photo_too_large' }, decision.headers);
      const form = await new Response(body, { headers: { 'content-type': contentType } }).formData();
      const keys = [...form.keys()];
      if (keys.length !== 2 || new Set(keys).size !== 2 || !keys.includes('photo') || !keys.includes('file')) throw new Error();
      const json = form.get('photo');
      const part = form.get('file');
      if (typeof json !== 'string' || part === null || typeof part === 'string' || part.size < 1) throw new Error();
      photo = readOwnerPhotoAdd(json);
      file = part;
    } catch { return respond(400, { error: 'invalid_request' }, decision.headers); }
    if (file.size > MAX_PHOTO_BYTES) return respond(413, { error: 'photo_too_large' }, decision.headers);
    const cleaned = cleanPhoto(new Uint8Array(await file.arrayBuffer()));
    if (!cleaned.ok) return respond(PHOTO_PROBLEMS[cleaned.problem], { error: cleaned.problem }, decision.headers);

    // Precheck before any storage write: non-owners never place an object in the public bucket,
    // The add command checks the cap after its retry lookup, under the listing lock.
    // A full gallery must still accept a retry of the sixth successful upload.
    try { await deps.read(actor, photo.venue_id); } catch (error) { return refuse(error, decision.headers); }
    // Server-chosen object name in the venue's folder; never client input.
    const path = `${photo.venue_id}/${deps.newId()}.${cleaned.photo.type === 'image/png' ? 'png' : 'jpg'}`;
    try { await deps.upload(path, cleaned.photo.bytes, cleaned.photo.type); }
    catch { deps.warn?.('command_failed'); return respond(503, { error: 'temporarily_unavailable' }, { ...decision.headers, 'Retry-After': '5' }); }
    let added: OwnerPhotoAddResult | null = null;
    let failure: unknown = null;
    try { added = await deps.addPhoto(actor, photo, path, cleaned.photo.width, cleaned.photo.height); }
    catch (error) { failure = error; }
    // An unknown RPC failure may be a lost reply after COMMIT: keep that object so
    // a committed photo never points at deleted bytes. Retry the same request ID.
    // Only definitive rejections or an 'existing' reply prove this upload unused.
    if (added?.outcome === 'existing' || failure instanceof CommandRejected) {
      await deps.remove(path).catch(() => deps.warn?.('photo_cleanup_failed'));
    }
    if (!added) return refuse(failure, decision.headers);
    return respond(added.outcome === 'created' ? 201 : 200, { venue: added.venue }, decision.headers);
  };
}
