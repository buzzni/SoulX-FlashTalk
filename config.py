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

# ========================================
# SoulX-FlashTalk Model Settings
# ========================================
FLASHTALK_CKPT_DIR = os.path.join(PROJECT_ROOT, "models", "SoulX-FlashTalk-14B")
FLASHTALK_WAV2VEC_DIR = os.path.join(PROJECT_ROOT, "models", "chinese-wav2vec2-base")

FLASHTALK_OPTIONS = {
    "default_prompt": "A person is talking. Only the foreground characters are moving, the background remains static.",
    "audio_encode_mode": "stream",  # "stream" or "once"
    "base_seed": 9999,
    "cpu_offload": True,  # Enable CPU offload for lower VRAM usage (40GB instead of 64GB)
}

# ========================================
# MultiTalk Model Settings (multi-person)
# ========================================
MULTITALK_CKPT_DIR = os.path.join(PROJECT_ROOT, "models", "MultiTalk-14B-480P")

MULTITALK_OPTIONS = {
    "default_prompt": "Two people are talking. Only the foreground characters are moving, the background remains static.",
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
    "model_id": "eleven_multilingual_v2",  # Best for Korean
    "output_format": "pcm_16000",  # 16kHz PCM for FlashTalk compatibility
    "stability": 0.5,
    "similarity_boost": 0.75,
    "style": 0.0,
}

# ========================================
# Default Input Files
# ========================================
DEFAULT_HOST_IMAGE_MALE = os.path.join(PROJECT_ROOT, "examples", "man_default.png")
DEFAULT_HOST_IMAGE_FEMALE = os.path.join(PROJECT_ROOT, "examples", "woman.png")
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
