/** Bound network work and preserve cancellation supplied by the SDK/caller. */
export async function fetchWithDeadline(input: RequestInfo | URL, init?: RequestInit): Promise<Response> {
  const controller = new AbortController();
  const cancel = () => controller.abort();
  const source = init?.signal ?? (input instanceof Request ? input.signal : undefined);
  if (source?.aborted) controller.abort();
  source?.addEventListener('abort', cancel);
  const timer = setTimeout(cancel, 15000);
  try { return await fetch(input, { ...init, signal: controller.signal }); }
  finally {
    clearTimeout(timer);
    source?.removeEventListener('abort', cancel);
  }
}
