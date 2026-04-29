"""
SoulX-FlashTalk Web App Configuration
"""

import os
from dotenv import load_dotenv

load_dotenv()

# Project root
PROJECT_ROOT = os.path.dirname(os.path.abspath(__file__))

# Directories
UPLOADS_DIR = os.path.join(PROJECT_ROOT, "uploads")
OUTPUTS_DIR = os.path.join(PROJECT_ROOT, "outputs")
TEMP_DIR = os.path.join(PROJECT_ROOT, "temp")
EXAMPLES_DIR = os.path.join(PROJECT_ROOT, "examples")
HOSTS_DIR = os.path.join(OUTPUTS_DIR, "hosts", "saved")
# Per-task result manifests (one JSON per completed video), used by
# /api/results/{task_id} and the frontend /result/:taskId page. Queue entries
# get truncated to last 20; manifests are permanent.
RESULTS_DIR = os.path.join(OUTPUTS_DIR, "results")

# Whitelisted roots for path-traversal-safe file access (CSO audit).
# Used by _safe_upload_path() helper; no PROJECT_ROOT fallback.
SAFE_ROOTS = (UPLOADS_DIR, OUTPUTS_DIR, EXAMPLES_DIR)

# Upload limits
MAX_UPLOAD_BYTES = 20 * 1024 * 1024  # 20 MB

# ========================================
# SoulX-FlashTalk Model Settings
# ========================================
FLASHTALK_CKPT_DIR = os.path.join(PROJECT_ROOT, "models", "SoulX-FlashTalk-14B")
FLASHTALK_WAV2VEC_DIR = os.environ.get(
    "FLASHTALK_WAV2VEC_DIR",
    os.path.join(PROJECT_ROOT, "models", "chinese-wav2vec2-base"),
)

FLASHTALK_OPTIONS = {
    # Prompt conditions the T5 text encoder → diffusion model. Emphasize
    # restraint on both lip and body motion: the unguarded "characters are
    # moving" hint tended to produce jerky hand swings and exaggerated mouth
    # openings.
    "default_prompt": (
        "A close-up of a person calmly speaking. Each consonant and vowel "
        "is articulated with precise, restrained lip movement that exactly "
        "matches the audio. Lips fully close for /m/, /b/, /p/ sounds. "
        "Mouth opens cleanly but remains naturally proportioned — no "
        "horizontal stretching, no wide lateral mouth opening, no "
        "smile-like distortion. Jaw stays restrained. Subtle natural hand "
        "gestures, stable body posture. Static background."
    ),
    "audio_encode_mode": "stream",  # "stream" or "once"
    "base_seed": 9999,
    "cpu_offload": True,  # Enable CPU offload for lower VRAM usage (40GB instead of 64GB)
    # When true, generate via `torchrun --nproc_per_node=2` subprocess on
    # GPUs 1,3 with USP (sequence parallelism) + Parallel VAE +
    # torch.compile. Falls back to in-process world_size=1 path on rollback.
    # Set FLASHTALK_USE_TORCHRUN_SUBPROCESS=0 to disable.
    "use_torchrun_subprocess": os.environ.get("FLASHTALK_USE_TORCHRUN_SUBPROCESS", "0") == "1",
    "torchrun_gpu_set": os.environ.get("FLASHTALK_TORCHRUN_GPUS", "1,3"),
    "torchrun_timeout_s": int(os.environ.get("FLASHTALK_TORCHRUN_TIMEOUT_S", "7200")),
}

# Audio preprocessing — trim leading/trailing silence to stabilise chunk
# boundaries (lip closes awkwardly when long silence drives the first chunk).
# Conservative defaults: 40dB threshold rarely cuts speech; 200ms padding
# preserves natural breath. Disable per-job by setting AUDIO_TRIM_ENABLED=0.
AUDIO_TRIM_ENABLED = os.environ.get("AUDIO_TRIM_ENABLED", "1") == "1"
AUDIO_TRIM_TOP_DB = float(os.environ.get("AUDIO_TRIM_TOP_DB", "40"))
AUDIO_TRIM_PAD_MS = int(os.environ.get("AUDIO_TRIM_PAD_MS", "0"))

# Lip-sync audio offset for the final ffmpeg merge. Negative value =
# pull audio earlier than video (use when lips trail the voice — set to
# the observed lag in ms). Positive = push audio later. 0 = no shift.
# Applied via `ffmpeg -itsoffset {sec} -i audio` in save_video.
LIPSYNC_AUDIO_OFFSET_MS = int(os.environ.get("LIPSYNC_AUDIO_OFFSET_MS", "0"))

# ========================================
# MultiTalk Model Settings (multi-person)
# ========================================
MULTITALK_CKPT_DIR = os.path.join(PROJECT_ROOT, "models", "MultiTalk-14B-480P")

MULTITALK_OPTIONS = {
    "default_prompt": (
        "Two people are talking with subtle, natural hand gestures and "
        "minimal, stable body movement. Their lips move softly and naturally "
        "in sync with speech, not exaggerated. Only the foreground characters "
        "move; the background remains static."
    ),
    "base_seed": 9999,
    "cpu_offload": True,
    "sample_steps": 40,  # Non-distilled model needs more steps
    "sample_shift": 5,
}

# ========================================
# ElevenLabs TTS Settings
# ========================================
ELEVENLABS_API_KEY = os.environ.get("ELEVENLABS_API_KEY", "")
ELEVENLABS_OPTIONS = {
    "default_voice_id": "",  # Will be populated from API
    "model_id": "eleven_v3",  # v3: [breath] native, 5000 char limit (Phase 0 T-EL0)
    "output_format": "pcm_16000",  # 16kHz PCM for FlashTalk compatibility
    "stability": 0.4,
    "similarity_boost": 0.8,
    "style": 0.0,
    "speed": 0.95,
    "use_speaker_boost": True,  # T-EL1
    "language_code": "ko",  # T-EL2
}
ELEVENLABS_MAX_CHARS = 5000  # v3 limit; HostStudio UI enforces same

# ========================================
# Feature flags (Phase 0)
# ========================================
FEATURE_HOSTSTUDIO = os.environ.get("FEATURE_HOSTSTUDIO", "1") == "1"

# Auth baseline (Phase 0 D13, §4.0.6)
REQUIRE_API_KEY = os.environ.get("REQUIRE_API_KEY", "0") == "1"
API_KEY = os.environ.get("API_KEY", "")

# ========================================
# DB integration (PR1+) — see docs/db-integration-plan.md
# ========================================
MONGO_URL = os.environ.get("MONGO_URL", "mongodb://localhost:27017")
DB_NAME = os.environ.get("DB_NAME", "ai_showhost")
STUDIO_JWT_SECRET = os.environ.get("STUDIO_JWT_SECRET", "")
STUDIO_JWT_TTL_DAYS = int(os.environ.get("STUDIO_JWT_TTL_DAYS", "7"))

# CORS (Phase 0 D12, §4.0.5)
CORS_ORIGINS = [
    o.strip() for o in os.environ.get(
        "CORS_ORIGINS",
        "http://localhost:5173,http://localhost:8001",
    ).split(",") if o.strip()
]

# Audit log (Phase 0 §4.0.7)
AUDIT_LOG_PATH = os.environ.get(
    "AUDIT_LOG_PATH",
    os.path.join(PROJECT_ROOT, "logs", "audit.log"),
)

# ========================================
# Default Input Files
# ========================================
DEFAULT_HOST_IMAGE_MALE = os.path.join(PROJECT_ROOT, "examples", "man_default.png")
DEFAULT_HOST_IMAGE_FEMALE = os.path.join(PROJECT_ROOT, "examples", "woman.png")
DEFAULT_HOST_IMAGE = DEFAULT_HOST_IMAGE_FEMALE  # Single Host 기본: 호스트 A (여성)
DEFAULT_AUDIO = os.path.join(PROJECT_ROOT, "examples", "cantonese_16k.wav")

# Default ElevenLabs voice names per gender
DEFAULT_VOICE_FEMALE = "JiYoung - professional"
DEFAULT_VOICE_MALE = "JoonPark - professional"

# ========================================
# MultiTalk Settings (multi-person video generation)
# ========================================
MULTITALK_ENABLED = True

# Composite mode for 2-person split layout
# "alpha" = FlashTalk + rembg alpha composite (recommended, best quality)
# "multitalk" = MultiTalk model (lower quality, 480P)
# "hstack" = FlashTalk hstack + blur strip (fastest, visible seam)
COMPOSITE_MODE = "alpha"  # Use MultiTalk for split layout with 2 agents

# ========================================
# S3 Storage (PR S3+) — see specs/s3-migration/plan.md
# ========================================
# Bucket layout: <S3_BUCKET>/<S3_ENV_PREFIX>/<S3_PROJECT_NAME>/<storage_key>
# storage_key shape: outputs/..., uploads/..., examples/...
S3_BUCKET = os.environ.get("S3_BUCKET", "ailab-demo")
S3_REGION = os.environ.get("S3_REGION", "ap-northeast-2")
S3_ACCESS_KEY = os.environ.get("S3_ACCESS_KEY", "")
S3_SECRET_KEY = os.environ.get("S3_SECRET_KEY", "")
S3_ENV_PREFIX = os.environ.get("S3_ENV_PREFIX", "dev")
S3_PROJECT_NAME = os.environ.get("S3_PROJECT_NAME", "soulx-flashtalk")

# Presigned URL TTL (seconds). Video TTL = 6h to cover long byte-range seek
# sessions; image/audio = 1h is enough for wizard preview.
S3_PRESIGN_TTL_IMAGE = int(os.environ.get("S3_PRESIGN_TTL_IMAGE", "3600"))
S3_PRESIGN_TTL_VIDEO = int(os.environ.get("S3_PRESIGN_TTL_VIDEO", "21600"))

# boto3 client tuning. Pool size 50 covers concurrent uploads + GPU
# inference downloads; retries=5 + standard mode handles throttling.
S3_MAX_POOL_CONNECTIONS = int(os.environ.get("S3_MAX_POOL_CONNECTIONS", "50"))
S3_MULTIPART_THRESHOLD = int(os.environ.get("S3_MULTIPART_THRESHOLD", str(8 * 1024 * 1024)))
# Total attempts (not retries — boto3 'standard' mode counts the first
# call). Plan §1 #6: caller adds an outer retry loop on top of this for
# the S3 upload step specifically (so a bad ffmpeg result mp4 doesn't
# get re-uploaded 15 times). 3 keeps us well under that budget.
S3_MAX_RETRY_ATTEMPTS = int(os.environ.get("S3_MAX_RETRY_ATTEMPTS", "3"))
S3_CONNECT_TIMEOUT = int(os.environ.get("S3_CONNECT_TIMEOUT", "10"))
S3_READ_TIMEOUT = int(os.environ.get("S3_READ_TIMEOUT", "300"))

# ========================================
# Logging
# ========================================
LOG_LEVEL = "INFO"
