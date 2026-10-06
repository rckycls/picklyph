// Pure ownership-review helpers shared by the route handlers and unit tests.

export type ReviewRejection = { status: number; message: string };

/** Maps the database's machine-readable hint (then SQLSTATE) to a reviewer message. Null = unexpected. */
export function reviewRejection(error: { code?: string | null; hint?: string | null }): ReviewRejection | null {
  switch (error.hint) {
    case 'self_review': return { status: 403, message: 'You can’t review your own submission. Ask another reviewer.' };
    case 'admin_required': return { status: 403, message: 'Only administrators can create a new listing. Merge or reject it, or ask an administrator.' };
    case 'reviewer_required': return { status: 403, message: 'Ownership reviewer access required.' };
    case 'already_decided': return { status: 409, message: 'Another reviewer already decided this request. Reload to see the decision.' };
    case 'listing_unavailable': return { status: 409, message: 'That listing is suspended or no longer exists. Choose another listing.' };
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
