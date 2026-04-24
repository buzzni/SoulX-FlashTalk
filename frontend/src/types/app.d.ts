/**
 * Hand-written UI-only types. These compose the generated API types from
 * `src/types/generated/api.d.ts` (produced by `npm run gen:types` once the
 * backend has Pydantic `response_model`s — Phase 0b).
 *
 * Until Phase 0b ships, the generated file is a placeholder and the types
 * below use their own local definitions. When the real generated types
 * arrive, swap the local definitions out for imports:
 *
 *   import type { paths, components } from './generated/api';
 *   export type QueueSnapshot = components['schemas']['QueueSnapshot'];
 *
 * Keep this file thin — per-component prop types live alongside their
 * components (`.tsx` files, once Phase 4 renames `.jsx → .tsx`).
 */

// ---------- Task lifecycle ----------

export type TaskStage =
  | 'queued'
  | 'loading'
  | 'preparing'
  | 'compositing_bg'
  | 'generating'
  | 'saving'
  | 'compositing'
  | 'complete'
  | 'error';

export type TaskStatus = 'pending' | 'running' | 'completed' | 'error' | 'cancelled';

export type TaskType = 'generate' | 'conversation';

export interface TaskState {
  task_id: string;
  stage: TaskStage;
  progress: number; // 0..1
  message?: string;
  error?: string | null;
  output_path?: string | null;
}

export interface QueueEntry {
  task_id: string;
  type: TaskType;
  label?: string;
  status: TaskStatus;
  created_at: string;
  started_at?: string | null;
  completed_at?: string | null;
  error?: string | null;
  params?: Record<string, unknown>;
}

export interface QueueSnapshot {
  running: QueueEntry[];
  pending: QueueEntry[];
  recent: QueueEntry[];
  total_running: number;
  total_pending: number;
}

// ---------- Result manifest ----------

export interface ResultManifest {
  task_id: string;
  type: TaskType;
  status: 'completed' | 'error' | 'cancelled';
  completed_at?: string;
  generation_time_sec?: number | null;
  video_url: string;
  video_path?: string | null;
  video_bytes: number;
  video_filename?: string | null;
  params: ResultParams;
  meta?: Record<string, unknown> | null;
  synthesized?: boolean;
  error?: string | null;
}

export interface ResultParams {
  host_image?: string | null;
  audio_path?: string | null;
  audio_source_label?: string | null;
  prompt?: string | null;
  seed?: number | null;
  cpu_offload?: boolean | null;
  script_text?: string;
  resolution_requested?: string | null;
  resolution_actual?: string | null;
  scene_prompt?: string;
  reference_image_paths?: string[];
}

// ---------- Video history ----------

export interface VideoHistoryItem {
  task_id: string;
  timestamp: string;
  script_text?: string;
  host_image?: string;
  audio_source?: string;
  output_path?: string;
  file_size?: number;
  video_url: string;
  generation_time?: number | null;
  type?: TaskType;
}

// ---------- Wizard state (UI-owned; never sent to server) ----------

export type WizardStep = 1 | 2 | 3;

export interface WizardHost {
  mode?: 'text' | 'image' | null;
  textPrompt?: string;
  referenceImagePath?: string | null;
  referenceImageUrl?: string | null;
  faceRefPath?: string | null;
  outfitRefPath?: string | null;
  outfitText?: string;
  temperature?: number;
  imageSize?: '1K' | '2K' | '4K';
  variants?: HostVariant[];
  selectedSeed?: number | null;
  imageUrl?: string | null;
}

export interface HostVariant {
  seed: number;
  imageUrl: string;
  imagePath?: string;
}

export interface WizardProduct {
  id: string;
  name?: string;
  path?: string | null;
  url?: string | null;
  // Transient — present only while a File is staged for upload, dropped
  // by `partialize` before localStorage persist.
  _file?: File;
}

export interface WizardBackground {
  source?: 'preset' | 'prompt' | 'upload' | 'url' | null;
  preset?: { id: string; label: string } | null;
  presetId?: string;
  presetLabel?: string;
  prompt?: string;
  uploadPath?: string | null;
  uploadUrl?: string | null;
}

export interface WizardComposition {
  shot?: 'closeup' | 'bust' | 'medium' | 'full';
  temperature?: number;
  variants?: CompositionVariant[];
  selectedUrl?: string | null;
  selectedPath?: string | null;
}

export interface CompositionVariant {
  seed: number;
  url: string;
  path?: string;
}

export interface WizardVoice {
  source?: 'tts' | 'clone' | 'upload' | null;
  voiceId?: string | null;
  voiceName?: string | null;
  script?: string;
  audioUrl?: string | null;
  audioPath?: string | null;
}

export interface WizardState {
  host: WizardHost;
  products: WizardProduct[];
  background: WizardBackground;
  composition: WizardComposition;
  voice: WizardVoice;
  script?: string;
  resolution?: string;
  imageQuality?: '1K' | '2K' | '4K';
}
