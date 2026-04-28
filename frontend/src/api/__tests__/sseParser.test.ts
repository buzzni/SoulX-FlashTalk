/**
 * @vitest-environment node
 *
 * Wire-format integration test for parseRichSSEStream.
 *
 * Feeds the EXACT byte format the backend's sse_format() helper emits
 * (modules/jobs_pubsub.py:170-184) and asserts the parser yields the
 * shape the cache+subscription expect. This is the regression net for
 * the class of bug /simplify caught at P1 — a wire-format mismatch
 * between backend and frontend that no individual unit test can detect.
 */
import { describe, it, expect } from 'vitest';
import { parseRichSSEStream } from '../sseParser';

/** Build a Response whose body streams the given chunks. Mirrors the
 * fetch() return shape that jobSubscription's _openConnection consumes. */
function makeResponse(chunks: string[]): Response {
  const encoder = new TextEncoder();
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      for (const c of chunks) controller.enqueue(encoder.encode(c));
      controller.close();
    },
  });
  return new Response(stream, { headers: { 'content-type': 'text/event-stream' } });
}

async function collect(res: Response, signal?: AbortSignal) {
  const out: { id?: number; event: string; data: unknown }[] = [];
  for await (const f of parseRichSSEStream(res, signal)) {
    out.push({ id: f.id, event: f.event, data: f.data });
  }
  return out;
}

describe('parseRichSSEStream — wire format', () => {
  // The backend emits exactly this layout (jobs_pubsub.py sse_format):
  //   id: <seq>\n
  //   event: <type>\n
  //   data: <json>\n
  //   \n
  //
  // Each test mirrors the byte string the backend would send.

  it('parses snapshot frame matching backend sse_format(event,data,id)', async () => {
    const wire =
      'id: 0\n' +
      'event: snapshot\n' +
      'data: {"id":"job-1","kind":"host","state":"streaming","variants":[]}\n' +
      '\n';
    const frames = await collect(makeResponse([wire]));
    expect(frames).toHaveLength(1);
    expect(frames[0]!.id).toBe(0);
    expect(frames[0]!.event).toBe('snapshot');
    expect(frames[0]!.data).toEqual({
      id: 'job-1',
      kind: 'host',
      state: 'streaming',
      variants: [],
    });
  });

  it('parses candidate frame as the runner publishes it', async () => {
    // job_runner.py _apply_event candidate: yields {"type":"candidate","variant":{...}}
    // jobs_pubsub.py sse_format_event wraps the JobEvent payload as data.
    const wire =
      'id: 7\n' +
      'event: candidate\n' +
      'data: {"type":"candidate","variant":{"image_id":"v1","path":"/p/v1.png","url":"/u/v1.png","seed":42}}\n' +
      '\n';
    const frames = await collect(makeResponse([wire]));
    expect(frames[0]!.id).toBe(7);
    expect(frames[0]!.event).toBe('candidate');
    const data = frames[0]!.data as { variant: { image_id: string; seed: number } };
    expect(data.variant.image_id).toBe('v1');
    expect(data.variant.seed).toBe(42);
  });

  it('parses done frame with batch_id + prev_selected_image_id', async () => {
    const wire =
      'id: 12\n' +
      'event: done\n' +
      'data: {"type":"done","batch_id":"b-1","prev_selected_image_id":"old-img"}\n' +
      '\n';
    const frames = await collect(makeResponse([wire]));
    const data = frames[0]!.data as { batch_id: string; prev_selected_image_id: string };
    expect(data.batch_id).toBe('b-1');
    expect(data.prev_selected_image_id).toBe('old-img');
  });

  it('parses fatal frame', async () => {
    const wire = 'id: 3\nevent: fatal\ndata: {"type":"fatal","error":"GPU OOM"}\n\n';
    const frames = await collect(makeResponse([wire]));
    const data = frames[0]!.data as { error: string };
    expect(frames[0]!.event).toBe('fatal');
    expect(data.error).toBe('GPU OOM');
  });

  it('parses cancelled frame (no payload body, just type)', async () => {
    // DELETE handler publishes {"type":"cancelled"} via jobs_pubsub.publish.
    const wire = 'id: 5\nevent: cancelled\ndata: {"type":"cancelled"}\n\n';
    const frames = await collect(makeResponse([wire]));
    expect(frames[0]!.event).toBe('cancelled');
  });

  it('parses multiple frames separated by blank lines (real streaming)', async () => {
    // The drain loop in app.py emits frames over time. Validate that a
    // single chunked body containing 3 frames yields 3 parsed events.
    const wire =
      'id: 1\nevent: snapshot\ndata: {"state":"streaming"}\n\n' +
      'id: 2\nevent: candidate\ndata: {"variant":{"image_id":"v1"}}\n\n' +
      'id: 3\nevent: done\ndata: {"batch_id":"b"}\n\n';
    const frames = await collect(makeResponse([wire]));
    expect(frames.map((f) => f.event)).toEqual(['snapshot', 'candidate', 'done']);
    expect(frames.map((f) => f.id)).toEqual([1, 2, 3]);
  });

  it('stitches frames split across chunk boundaries', async () => {
    // Mid-frame chunk boundary — the parser must use TextDecoder({stream:true})
    // and only yield once \n\n is seen.
    const part1 = 'id: 1\nevent: candidate\ndata: {"vari';
    const part2 = 'ant":{"image_id":"v1"}}\n\n';
    const frames = await collect(makeResponse([part1, part2]));
    expect(frames).toHaveLength(1);
    const data = frames[0]!.data as { variant: { image_id: string } };
    expect(data.variant.image_id).toBe('v1');
  });

  it('drops frames with no data: line', async () => {
    const wire = 'id: 1\nevent: heartbeat\n\n';
    const frames = await collect(makeResponse([wire]));
    expect(frames).toEqual([]);
  });

  it('falls back to raw string when data: is not JSON', async () => {
    const wire = 'event: log\ndata: hello world\n\n';
    const frames = await collect(makeResponse([wire]));
    expect(frames[0]!.data).toBe('hello world');
  });

  it('defaults missing event: line to "message" (W3C spec)', async () => {
    const wire = 'data: {"x":1}\n\n';
    const frames = await collect(makeResponse([wire]));
    expect(frames[0]!.event).toBe('message');
  });

  it('omits id when id: line is missing', async () => {
    const wire = 'event: candidate\ndata: {"x":1}\n\n';
    const frames = await collect(makeResponse([wire]));
    expect(frames[0]!.id).toBeUndefined();
  });

  it('aborts cleanly mid-stream when the signal fires', async () => {
    const ac = new AbortController();
    const encoder = new TextEncoder();
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(encoder.encode('id: 1\nevent: candidate\ndata: {"x":1}\n\n'));
        // Don't close. Caller will abort.
      },
    });
    const res = new Response(stream, {
      headers: { 'content-type': 'text/event-stream' },
    });
    const out: number[] = [];
    const iter = parseRichSSEStream(res, ac.signal);
    const first = await iter.next();
    if (!first.done) out.push(first.value.id ?? -1);
    ac.abort();
    // Next pull should exit the loop without yielding.
    const second = await iter.next();
    expect(second.done).toBe(true);
    expect(out).toEqual([1]);
  });
});
