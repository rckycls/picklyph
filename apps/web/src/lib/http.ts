import type { PrelaunchErrorReply } from '@picklyph/domain';

export class RequestError extends Error {
  status: number;
  code: string;
  headers: Record<string, string>;
  constructor(status: number, code: string, message: string, headers: Record<string, string> = {}) {
    super(message); this.status = status; this.code = code; this.headers = headers;
  }
}

/** JSON answers are never cached and never set cookies. */
export function reply(status: number, body: unknown, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), { status, headers: {
    'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff', ...headers,
  } });
}

export function errorReply(error: RequestError): Response {
  const body: PrelaunchErrorReply = { error: error.code, message: error.message };
  return reply(error.status, body, error.headers);
}

/** Same-origin POST only: the browser's Origin must be the configured origin (never the Host header). */
export function requireSameOrigin(request: Request, expectedOrigin: string) {
  if (request.method !== 'POST') throw new RequestError(405, 'method_not_allowed', 'Use the form on this page.', { Allow: 'POST' });
  if (request.headers.get('origin') !== expectedOrigin) throw new RequestError(403, 'origin_not_allowed', 'Use the form on this page.');
}

/** Bound the stream, rather than trusting Content-Length or buffering an unlimited body. */
export async function readJsonBody(request: Request, maxBytes: number): Promise<unknown> {
  if (request.headers.get('content-type')?.split(';')[0]?.trim().toLowerCase() !== 'application/json') {
    throw new RequestError(415, 'unsupported_type', 'Send the form as JSON.');
  }
  const reader = request.body?.getReader();
  if (!reader) throw new RequestError(400, 'invalid_input', 'Check the form and try again.');
  const chunks: Uint8Array[] = [];
  let length = 0;
  try {
    while (true) {
      const chunk = await reader.read();
      if (chunk.done) break;
      length += chunk.value.byteLength;
      if (length > maxBytes) { await reader.cancel(); throw new RequestError(413, 'too_large', 'The form is too large. Shorten the note and try again.'); }
      chunks.push(chunk.value);
    }
    const bytes = new Uint8Array(length);
    let offset = 0;
    for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
    return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes));
  } catch (error) {
    if (error instanceof RequestError) throw error;
    throw new RequestError(400, 'invalid_input', 'Check the form and try again.');
  } finally { reader.releaseLock(); }
}

/** One canonical IPv4/IPv6 address from Vercel's own header, or null (callers then use one shared bucket). */
export function vercelClientIp(headers: Headers): string | null {
  const raw = headers.get('x-vercel-forwarded-for')?.trim();
  if (!raw || raw.length > 45 || /[\s,\[\]%/]/.test(raw)) return null;
  if (/^(?:\d{1,3}\.){3}\d{1,3}$/.test(raw)) {
    const parts = raw.split('.');
    return parts.some((part) => Number(part) > 255 || String(Number(part)) !== part) ? null : parts.join('.');
  }
  if (!raw.includes(':') || !/^[0-9a-f:.]+$/i.test(raw)) return null;
  try { return new URL(`http://[${raw}]/`).hostname.slice(1, -1).toLowerCase(); } catch { return null; }
}
