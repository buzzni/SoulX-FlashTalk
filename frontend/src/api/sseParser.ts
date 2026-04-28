/**
 * SSE frame parser that preserves `id:` and `event:` fields.
 *
 * The legacy `parseSSEStream` in api/host.ts only decodes `data:` lines —
 * the old /api/host/generate/stream endpoint never emitted seq numbers.
 * The new /api/jobs/:id/events endpoint emits all three fields per
 * eng-spec §3.2 (id = monotonic per-job seq, event = 'snapshot' /
 * 'candidate' / 'done' / 'fatal' / 'cancelled', data = JSON payload).
 *
 * Yielded shape: { id?: number, event: string, data: <parsed JSON> }.
 * A frame missing `data:` is dropped silently (malformed); a missing
 * `event:` defaults to 'message' per the W3C SSE spec.
 */

export interface SSEFrame {
  id?: number;
  event: string;
  data: unknown;
}

export async function* parseRichSSEStream(
  res: Response,
  signal?: AbortSignal,
): AsyncGenerator<SSEFrame, void, void> {
  if (!res.body) return;
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  try {
    while (true) {
      if (signal?.aborted) break;
      const { value, done } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      let sep: number;
      while ((sep = buffer.indexOf('\n\n')) !== -1) {
        const rawFrame = buffer.slice(0, sep);
        buffer = buffer.slice(sep + 2);
        const parsed = parseFrame(rawFrame);
        if (parsed !== null) yield parsed;
      }
    }
  } finally {
    try {
      await reader.cancel();
    } catch {
      /* reader already closed — ignore */
    }
  }
}

/** Parse one SSE frame (the text between two \\n\\n separators) into
 * an SSEFrame, or null if the frame has no `data:` line. */
function parseFrame(frame: string): SSEFrame | null {
  let id: number | undefined;
  let event: string | undefined;
  const dataLines: string[] = [];
  for (const line of frame.split('\n')) {
    if (line.startsWith('id: ')) {
      const n = Number(line.slice(4));
      if (Number.isFinite(n)) id = n;
    } else if (line.startsWith('event: ')) {
      event = line.slice(7).trim();
    } else if (line.startsWith('data: ')) {
      dataLines.push(line.slice(6));
    }
  }
  if (dataLines.length === 0) return null;
  // Per W3C SSE: multiple data lines join with newline. Try JSON first;
  // fall back to raw string if the payload isn't JSON-encoded.
  const raw = dataLines.join('\n');
  let data: unknown;
  try {
    data = JSON.parse(raw);
  } catch {
    data = raw;
  }
  return { id, event: event ?? 'message', data };
}
