export class RequestError extends Error {
  status: number;
  constructor(status: number, message: string) { super(message); this.status = status; }
}

export function requireSameOrigin(request: Request, expectedOrigin: string) {
  if (request.headers.get('origin') !== expectedOrigin) throw new RequestError(403, 'Request origin is not allowed.');
}

/** Bound the stream, rather than trusting Content-Length or buffering an unlimited body. */
export async function readJsonBody(request: Request): Promise<Record<string, unknown>> {
  if (request.headers.get('content-type')?.split(';')[0]?.trim() !== 'application/json') throw new RequestError(415, 'Send JSON input.');
  const reader = request.body?.getReader();
  if (!reader) throw new RequestError(400, 'Missing input.');
  const chunks: Uint8Array[] = [];
  let length = 0;
  try {
    while (true) {
      const chunk = await reader.read();
      if (chunk.done) break;
      length += chunk.value.byteLength;
      if (length > 4096) { await reader.cancel(); throw new RequestError(413, 'Input is too large.'); }
      chunks.push(chunk.value);
    }
    const bytes = new Uint8Array(length);
    let offset = 0;
    for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
    const parsed: unknown = JSON.parse(new TextDecoder().decode(bytes));
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new RequestError(400, 'Invalid input.');
    return Object.fromEntries(Object.entries(parsed));
  } catch (error) {
    if (error instanceof RequestError) throw error;
    throw new RequestError(400, 'Invalid input.');
  } finally { reader.releaseLock(); }
}

export function readEmail(input: Record<string, unknown>): string {
  if (typeof input.email !== 'string') throw new RequestError(400, 'Enter a valid email address.');
  const email = input.email.trim().toLowerCase();
  if (email.length > 254 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) throw new RequestError(400, 'Enter a valid email address.');
  return email;
}
