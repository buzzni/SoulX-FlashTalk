/**
 * Phase 3-4 — src/studio/api.js mapping layer unit tests.
 *
 * TDD skeleton. All `it.skip` until Phase 3 (mapping infra) and Phase 4
 * (full wiring) unskip.
 */
import { describe, it } from 'vitest'

describe('api.js — Step 1 host mapping', () => {
  it.skip('maps host.mode=text → {mode:"text", prompt, extraPrompt}', () => {})
  it.skip('maps host.mode=image + faceRef + outfitRef → "face-outfit"', () => {})
  it.skip('maps host.mode=image + faceRef only → "style-ref"', () => {})
  it.skip('applies negativePrompt §5.1.1 rule to system_instruction suffix', () => {})
  it.skip('applies faceStrength §5.1.2 threshold (0.29 → "loose inspiration")', () => {})
  it.skip('applies faceStrength §5.1.2 threshold (0.30 → "general style guide")', () => {})
  it.skip('applies faceStrength §5.1.2 threshold (0.60 → "preserve key features")', () => {})
  it.skip('applies faceStrength §5.1.2 threshold (0.85 → "match as exactly as possible")', () => {})
  it.skip('maps host.builder (성별,연령대,분위기,옷차림) via ko→en table', () => {})
})

describe('api.js — Step 2 composite mapping', () => {
  it.skip('maps products[].url (blob) → productImagePaths after upload', () => {})
  it.skip('maps background.source=preset → backgroundType + backgroundPresetId', () => {})
  it.skip('maps background.source=prompt → backgroundType=prompt + backgroundPrompt', () => {})
  it.skip('passes composition.direction Korean verbatim', () => {})
  it.skip('passes shot + angle enums 1:1', () => {})
})

describe('api.js — Step 3 voice mapping', () => {
  it.skip('maps voice.source=tts → audio_source=elevenlabs', () => {})
  it.skip('maps voice.source=clone → clone-voice first, then elevenlabs', () => {})
  it.skip('maps voice.source=upload → audio_source=upload + audio_path', () => {})
  it.skip('joins paragraphs with " [breath] " for v3', () => {})
  it.skip('skips [breath] join in upload mode', () => {})
  it.skip('enforces 5000-char limit including [breath] tokens', () => {})
  it.skip('1-paragraph script has no breath inserted', () => {})
  it.skip('passes stability/style/similarity/speed 1:1', () => {})
  it.skip('does NOT strip voice.pitch (backend post-processes)', () => {})
})

describe('api.js — resolution mapping', () => {
  it.skip('resolution portrait {width:448,height:768} → "768x448" (H-first)', () => {})
  it.skip('resolution landscape {width:1280,height:720} → "720x1280"', () => {})
  it.skip('parse_resolution helper is symmetric with stringify', () => {})
})

describe('api.js — upload choreography', () => {
  it.skip('uploads File to /api/upload/* and returns server path', () => {})
  it.skip('rejects files > 20MB client-side (UI pre-check)', () => {})
  it.skip('retries upload once on network error', () => {})
})

describe('api.js — error handling', () => {
  it.skip('Gemini 429 maps to user copy "지금은 많이 붐벼요"', () => {})
  it.skip('ElevenLabs 401 maps to admin-contact copy', () => {})
  it.skip('network timeout triggers retry UI state', () => {})
})
