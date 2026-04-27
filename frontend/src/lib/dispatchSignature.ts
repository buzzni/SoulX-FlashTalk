/**
 * dispatchSignature — turns the live wizard state into a stable string
 * that identifies a dispatch's intent.
 *
 * Two dispatches with the same signature would land in the queue as
 * effectively-duplicate tasks (same audio, same host, same script,
 * same resolution, same seed). Used by the /render dispatch gate to
 * decide between fresh enqueue vs attach-to-existing.
 *
 * Field set mirrors what generateVideo() ships to /api/generate. Order
 * is fixed by the JSON.stringify shape.
 */

type Unknown = unknown;

export function computeDispatchSignature(state: Unknown): string {
  const s = (state ?? {}) as Record<string, Unknown>;
  return JSON.stringify({
    audio: extractAudioKey(s.voice),
    host: extractHostKey(s),
    script: extractScriptText(s.voice),
    resolution: typeof s.resolution === 'string' ? s.resolution : '',
    seed: typeof s.seed === 'number' ? s.seed : null,
  });
}

function extractAudioKey(voice: Unknown): string {
  if (!voice || typeof voice !== 'object') return '';
  const v = voice as Record<string, Unknown>;
  if (v.source === 'upload') {
    const a = v.audio as Record<string, Unknown> | null | undefined;
    return a && typeof a.path === 'string' ? a.path : '';
  }
  const gen = v.generation as Record<string, Unknown> | null | undefined;
  if (gen && gen.state === 'ready') {
    const audio = gen.audio as Record<string, Unknown> | null | undefined;
    if (audio && typeof audio.path === 'string') return audio.path;
  }
  return '';
}

function extractHostKey(state: Record<string, Unknown>): string {
  // Composition takes precedence — matches the dispatch path which
  // prefers the composed image over the raw host when present.
  const comp = state.composition as Record<string, Unknown> | null | undefined;
  const compPath = readReadyPath(comp);
  if (compPath) return `composite:${compPath}`;

  const host = state.host as Record<string, Unknown> | null | undefined;
  const hostPath = readReadyPath(host);
  if (hostPath) return `host:${hostPath}`;
  return '';
}

function readReadyPath(node: Record<string, Unknown> | null | undefined): string {
  if (!node) return '';
  const gen = node.generation as Record<string, Unknown> | null | undefined;
  if (!gen || gen.state !== 'ready') return '';
  const sel = gen.selected as Record<string, Unknown> | null | undefined;
  if (!sel) return '';
  if (typeof sel.path === 'string') return sel.path;
  if (typeof sel.url === 'string') return sel.url;
  return '';
}

function extractScriptText(voice: Unknown): string {
  if (!voice || typeof voice !== 'object') return '';
  const v = voice as Record<string, Unknown>;
  const script = v.script as Record<string, Unknown> | null | undefined;
  const para = script?.paragraphs;
  if (!Array.isArray(para)) return '';
  return para
    .map((p: Unknown) => {
      if (typeof p === 'string') return p;
      if (p && typeof p === 'object') {
        const text = (p as Record<string, Unknown>).text;
        if (typeof text === 'string') return text;
      }
      return '';
    })
    .join('\n');
}
