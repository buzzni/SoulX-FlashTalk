/**
 * api/voice.deleteVoice — wire contract.
 *
 * Pins the URL shape, method, and error surfacing so the VoicePicker
 * trash button can rely on the call without integration testing the
 * whole RTL component tree (covered in step3_audio.test.tsx).
 *
 * @vitest-environment jsdom
 */
import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest';
import { deleteVoice } from '../voice';

describe('deleteVoice', () => {
  let originalFetch: typeof globalThis.fetch;

  beforeEach(() => {
    originalFetch = globalThis.fetch;
  });
  afterEach(() => {
    globalThis.fetch = originalFetch;
    vi.restoreAllMocks();
  });

  it('hits DELETE /api/elevenlabs/voices/{id} with the voice id encoded', async () => {
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({ ok: true }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    }));
    globalThis.fetch = fetchMock as unknown as typeof globalThis.fetch;

    await deleteVoice('voice abc/xyz');

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toMatch(/\/api\/elevenlabs\/voices\/voice%20abc%2Fxyz$/);
    expect(init).toMatchObject({ method: 'DELETE' });
  });

  it('rejects with humanized message on 404 (foreign / unknown voice)', async () => {
    const fetchMock = vi.fn(async () => new Response(
      JSON.stringify({ detail: 'Voice not found' }),
      { status: 404, headers: { 'content-type': 'application/json' } },
    ));
    globalThis.fetch = fetchMock as unknown as typeof globalThis.fetch;

    await expect(deleteVoice('ghost')).rejects.toThrow();
  });

  it('rejects on 403 (stock voice — server refuses)', async () => {
    const fetchMock = vi.fn(async () => new Response(
      JSON.stringify({ detail: 'Stock voice cannot be deleted' }),
      { status: 403, headers: { 'content-type': 'application/json' } },
    ));
    globalThis.fetch = fetchMock as unknown as typeof globalThis.fetch;

    await expect(deleteVoice('stock-1')).rejects.toThrow();
  });
});
