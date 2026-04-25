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
FLASHTALK_WAV2VEC_DIR = os.path.join(PROJECT_ROOT, "models", "chinese-wav2vec2-base")

FLASHTALK_OPTIONS = {
    # Prompt conditions the T5 text encoder → diffusion model. Emphasize
    # restraint on both lip and body motion: the unguarded "characters are
    # moving" hint tended to produce jerky hand swings and exaggerated mouth
    # openings.
    "default_prompt": (
        "A person is talking with subtle, natural hand gestures and minimal, "
        "stable body movement. The lips move softly and naturally in sync "
        "with speech, not exaggerated. Only the foreground character moves; "
        "the background remains static."
    ),
    "audio_encode_mode": "stream",  # "stream" or "once"
    "base_seed": 9999,
    "cpu_offload": True,  # Enable CPU offload for lower VRAM usage (40GB instead of 64GB)
}

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
    "stability": 0.5,
    "similarity_boost": 0.75,
    "style": 0.0,
    "speed": 1.0,
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
# Logging
# ========================================
LOG_LEVEL = "INFO"
