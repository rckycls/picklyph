// Pure ownership-review helpers shared by the route handlers and unit tests.

/** Postgres timestamps carry microseconds; the shared Manila formatter accepts at most milliseconds. */
export function toDisplayInstant(value: string): string {
  return value.replace(/(\.\d{3})\d+(?=Z$|[+-]\d{2}:\d{2}$)/, '$1');
}

export type ReviewRejection = { status: number; message: string };

/** Maps the database's machine-readable hint (then SQLSTATE) to a reviewer message. Null = unexpected. */
export function reviewRejection(error: { code?: string | null; hint?: string | null }): ReviewRejection | null {
  switch (error.hint) {
    case 'self_review': return { status: 403, message: 'You can’t review your own submission. Ask another reviewer.' };
    case 'admin_required': return { status: 403, message: 'Only administrators can publish a new listing. Merge or reject it, or ask an administrator.' };
    case 'active_court_required': return { status: 409, message: 'The draft has no active court. Activate a court in the directory, then approve.' };
    case 'reviewer_required': return { status: 403, message: 'Ownership reviewer access required.' };
    case 'already_decided': return { status: 409, message: 'Another reviewer already decided this request. Reload to see the decision.' };
    case 'listing_unavailable': return { status: 409, message: 'That listing or the owner’s draft is suspended or no longer exists. Reload the request.' };
    case 'not_found': return { status: 404, message: 'This request no longer exists.' };
    case 'invalid_input': return { status: 400, message: 'Check the decision and try again.' };
  }
  if (error.code === '42501') return { status: 403, message: 'Ownership reviewer access required.' };
  if (error.code === '22023' || error.code === '22P02') return { status: 400, message: 'Check the decision and try again.' };
  return null;
}

/** Evidence is fetched by the console page itself. Refuse cross-site and embedded-elsewhere requests. */
export function isSameOriginFetch(request: Request): boolean {
  const site = request.headers.get('sec-fetch-site');
  return site === null || site === 'same-origin' || site === 'none';
}

/** Private, uncacheable, never interpreted as anything but the sniffed image type. */
export function evidenceHeaders(type: 'image/jpeg' | 'image/png'): Record<string, string> {
  return {
    'Content-Type': type,
    'Cache-Control': 'private, no-cache, no-store, must-revalidate, max-age=0',
    Expires: '0',
    Pragma: 'no-cache',
    'Content-Disposition': 'inline',
    'Content-Security-Policy': "default-src 'none'; sandbox",
    'Cross-Origin-Resource-Policy': 'same-origin',
    'X-Content-Type-Options': 'nosniff',
    'Referrer-Policy': 'no-referrer',
  };
}
