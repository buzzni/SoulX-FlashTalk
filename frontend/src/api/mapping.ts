/**
 * Pure mapping helpers — UI state ↔ backend string conventions.
 *
 * No network, no side effects, heavily unit-tested. Split from the async
 * API modules so tests don't need to mock `fetch` just to exercise string
 * manipulation.
 */

// ────────────────────────────────────────────────────────────────────
// Host prompt builder (§5.1 — ko→en suffix for text-mode host prompts)
// ────────────────────────────────────────────────────────────────────

const BUILDER_KO_EN = {
  성별: { female: 'female', male: 'male' },
  연령대: {
    '20s': 'in her/his 20s',
    '30s': 'in her/his 30s',
    '40s': 'in her/his 40s',
    '50plus': 'age 50+',
  },
  분위기: {
    bright: 'bright and energetic',
    calm: 'calm and trustworthy',
    friendly: 'friendly and approachable',
    pro: 'professional and refined',
  },
  옷차림: {
    formal: 'formal attire',
    casual: 'casual outfit',
    chic: 'chic modern style',
    cozy: 'cozy homewear',
  },
} as const;

type BuilderKey = keyof typeof BUILDER_KO_EN;

export function builderToPromptSuffix(builder?: Record<string, string> | null): string {
  if (!builder) return '';
  const parts: string[] = [];
  for (const key of ['성별', '연령대', '분위기', '옷차림'] as BuilderKey[]) {
    const v = builder[key];
    if (!v) continue;
    const table = BUILDER_KO_EN[key] as Record<string, string>;
    const mapped = table[v];
    if (mapped) parts.push(mapped);
  }
  return parts.length ? ', ' + parts.join(', ') : '';
}

// §5.1.1 — free-form negative prompt → system_instruction suffix (no
// translation; backend embeds verbatim with a lead-in phrase).
export function negativeToSystemSuffix(negativePrompt?: string | null): string {
  const trimmed = (negativePrompt || '').trim();
  if (!trimmed) return '';
  return `\n\nAvoid the following in the output: ${trimmed}`;
}

// §5.1.2 — face/outfit reference strength → natural-language clause.
// Ranges: [0, 0.3), [0.3, 0.6), [0.6, 0.85), [0.85, 1.0]
export function strengthToClause(
  strength: number | null | undefined,
  kind: 'face' | 'outfit',
): string {
  if (strength == null) return '';
  const noun = kind === 'outfit' ? 'outfit' : 'face';
  if (strength < 0.3) {
    return `Take only loose inspiration from the reference ${noun}; prioritize the text description.`;
  }
  if (strength < 0.6) {
    return `Use the reference ${noun} as a general style guide.`;
  }
  if (strength < 0.85) {
    return `Preserve the key features of the reference ${noun} closely.`;
  }
  return `Match the reference ${noun} as exactly as possible.`;
}

// ────────────────────────────────────────────────────────────────────
// Resolution
// ────────────────────────────────────────────────────────────────────

// §5.3 — backend expects portrait-encoded "height x width". The UI
// carries raw `{width, height}` objects; this is the single canonical
// stringifier so different callers can't drift.
export function stringifyResolution(r: { width?: number; height?: number } | null | undefined): string {
  if (!r?.width || !r?.height) throw new Error('resolution requires width and height');
  return `${r.height}x${r.width}`;
}

export function parseResolution(str: string | null | undefined): { width: number; height: number } {
  const m = /^(\d+)\s*x\s*(\d+)$/.exec(str || '');
  if (!m) throw new Error(`Cannot parse resolution: ${str}`);
  const h = parseInt(m[1]!, 10);
  const w = parseInt(m[2]!, 10);
  return { width: w, height: h };
}

// ────────────────────────────────────────────────────────────────────
// Script (voice) text
// ────────────────────────────────────────────────────────────────────

// §5.3 + §5.4 — paragraphs → ElevenLabs v3 script_text.
// TTS path uses " [breath] " separators (v3 supports the tag); upload
// path uses plain newlines (the user's own audio already has the pauses).
export interface ParagraphsToScriptOptions {
  source?: 'tts' | 'upload';
  maxChars?: number;
}

export function paragraphsToScript(
  paragraphs: (string | null | undefined)[],
  { source = 'tts', maxChars = 5000 }: ParagraphsToScriptOptions = {},
): string {
  if (!Array.isArray(paragraphs)) throw new Error('paragraphs must be an array');
  const cleaned = paragraphs.map((p) => (p ?? '').toString().trim()).filter(Boolean);
  const script = source === 'upload' ? cleaned.join('\n\n') : cleaned.join(' [breath] ');
  if (script.length > maxChars) {
    throw new Error(`대본이 너무 길어요 (${script.length}자 / 최대 ${maxChars}자)`);
  }
  return script;
}

// ────────────────────────────────────────────────────────────────────
// Seeds — "다시 만들기" uses fresh random seeds so retry doesn't
// re-run the backend's deterministic default set.
// ────────────────────────────────────────────────────────────────────

export function makeRandomSeeds(n = 4): number[] {
  return Array.from({ length: n }, () => Math.floor(Math.random() * 2_147_483_647));
}
