"""
ElevenLabs TTS Module for SoulX-FlashTalk
Generates speech audio from text using ElevenLabs API.
Supports voice cloning from reference audio.
"""

import os
import io
import wave
import struct
import logging
from typing import Optional

import httpx

logger = logging.getLogger(__name__)

ELEVENLABS_BASE_URL = "https://api.elevenlabs.io/v1"


class ElevenLabsQuotaExceeded(RuntimeError):
    """Raised when ElevenLabs returns 401 with status='quota_exceeded'.

    ElevenLabs returns 401 (not 402/429) when the account has 0 credits — surface
    that as a distinct exception so the API layer can show the user "크레딧 부족"
    instead of the misleading raw "Client error '401 Unauthorized'" httpx string.
    """


class ElevenLabsAPIError(RuntimeError):
    """Raised when ElevenLabs returns a non-2xx with a parsed detail message."""


def _raise_friendly(exc: "httpx.HTTPStatusError") -> None:
    """Translate an httpx error from ElevenLabs into a typed exception with a
    user-readable message. Falls back to the raw exception text if the response
    body is not JSON."""
    try:
        data = exc.response.json()
    except ValueError:
        raise ElevenLabsAPIError(str(exc)) from exc

    detail = data.get("detail") if isinstance(data, dict) else None
    status = detail.get("status") if isinstance(detail, dict) else None
    message = detail.get("message") if isinstance(detail, dict) else None

    # Don't add a Korean prefix here — the FastAPI layer adds its own user-facing
    # prefix (e.g. "ElevenLabs 크레딧이 부족합니다."). Doubling it produces
    # "...부족합니다. ...부족합니다. 계정 크레딧을 충전해주세요." in the rare
    # path where ElevenLabs omits `detail.message`.
    if status == "quota_exceeded":
        raise ElevenLabsQuotaExceeded(message or "0 credits remaining") from exc
    raise ElevenLabsAPIError(message or str(exc)) from exc


class ElevenLabsTTS:
    def __init__(self, api_key: str, model_id: str = "eleven_v3"):
        """v3 default: native [breath], 5000-char limit.

        Phase 0 T-EL0: global v3 upgrade (see specs/hoststudio-migration/plan.md).
        """
        if not api_key:
            raise ValueError("ElevenLabs API key is required. Set ELEVENLABS_API_KEY environment variable.")
        self.api_key = api_key
        self.model_id = model_id
        self.headers = {
            "xi-api-key": api_key,
        }

    def list_voices(self) -> list[dict]:
        """List available voices from ElevenLabs API"""
        with httpx.Client(timeout=30) as client:
            resp = client.get(f"{ELEVENLABS_BASE_URL}/voices", headers=self.headers)
            resp.raise_for_status()
            data = resp.json()
            voices = []
            for v in data.get("voices", []):
                voices.append({
                    "voice_id": v["voice_id"],
                    "name": v["name"],
                    "category": v.get("category", ""),
                    "labels": v.get("labels", {}),
                    "preview_url": v.get("preview_url", ""),
                    "description": v.get("description", "") or "",
                })
            return voices

    def get_voice(self, voice_id: str) -> dict:
        """Fetch a single voice's metadata. Used post-clone to populate the
        DB row with name/labels/preview_url without a list scan."""
        with httpx.Client(timeout=30) as client:
            resp = client.get(
                f"{ELEVENLABS_BASE_URL}/voices/{voice_id}",
                headers=self.headers,
            )
            resp.raise_for_status()
            v = resp.json()
            return {
                "voice_id": v["voice_id"],
                "name": v.get("name", ""),
                "category": v.get("category", "cloned"),
                "labels": v.get("labels", {}),
                "preview_url": v.get("preview_url", ""),
                "description": v.get("description", "") or "",
            }

    def generate_speech(
        self,
        text: str,
        voice_id: str,
        output_path: str,
        stability: float = 0.5,
        similarity_boost: float = 0.75,
        style: float = 0.0,
        speed: float = 1.0,
        use_speaker_boost: bool = True,
        language_code: str = "ko",
    ) -> str:
        """Generate speech audio from text using a specific voice.

        Args:
            text: Text to synthesize (v3: max 5000 chars, includes [breath] tokens)
            voice_id: ElevenLabs voice ID
            output_path: Path to save the WAV file (16kHz mono)
            stability: Voice stability (0.0-1.0)
            similarity_boost: Similarity boost (0.0-1.0)
            style: Style exaggeration (0.0-1.0)
            speed: Playback speed multiplier (0.5-1.8). Phase 0 T-EL3.
            use_speaker_boost: Enhance voice presence. Phase 0 T-EL1 (default: True).
            language_code: Language hint. Phase 0 T-EL2 (default: "ko" for Korean).

        Returns:
            Path to the generated WAV file
        """
        logger.info(f"Generating speech: text={text[:50]}..., voice={voice_id}, model={self.model_id}")

        # v3: 5000 char limit (includes [breath] tokens)
        if len(text) > 5000:
            raise ValueError(
                f"Script too long ({len(text)} chars). v3 limit is 5000 including [breath] tokens."
            )

        payload = {
            "text": text,
            "model_id": self.model_id,
            "language_code": language_code,
            # v3 supports auto normalization of numbers ("12,000원"), emoji, and
            # abbreviations before TTS. "on" forces it; Korean commerce scripts
            # lean heavily on numerics so this is the right default. Users never
            # touch this — it's a quality default, not a creative knob.
            "apply_text_normalization": "on",
            "voice_settings": {
                "stability": stability,
                "similarity_boost": similarity_boost,
                "style": style,
                "speed": speed,
                "use_speaker_boost": use_speaker_boost,
            },
        }

        # Request 16kHz PCM directly via the `output_format` query param — no
        # MP3 → ffmpeg conversion. FlashTalk needs 16kHz mono WAV, which is
        # exactly what pcm_16000 gives us (just missing the WAV header,
        # which we add below). This saves ~1-3s of subprocess latency and
        # drops the ffmpeg runtime dep from this code path.
        with httpx.Client(timeout=120) as client:
            resp = client.post(
                f"{ELEVENLABS_BASE_URL}/text-to-speech/{voice_id}",
                headers={**self.headers, "Content-Type": "application/json", "Accept": "audio/wav"},
                params={"output_format": "pcm_16000"},
                json=payload,
            )
            try:
                resp.raise_for_status()
            except httpx.HTTPStatusError as exc:
                _raise_friendly(exc)
            pcm_bytes = resp.content

        # pcm_16000 is raw 16-bit little-endian mono PCM at 16 kHz — wrap it
        # in a WAV header so the output_path stays a valid .wav that any
        # downstream tool (FlashTalk, browser <audio>) can play.
        sample_rate = 16000
        with wave.open(output_path, "wb") as wf:
            wf.setnchannels(1)
            wf.setsampwidth(2)  # 16-bit
            wf.setframerate(sample_rate)
            wf.writeframes(pcm_bytes)

        logger.info(f"Speech generated: {output_path}")
        return output_path

    def clone_voice(
        self,
        name: str,
        reference_audio_path: str,
        description: str = "",
    ) -> str:
        """Clone a voice from reference audio.

        Args:
            name: Name for the cloned voice
            reference_audio_path: Path to reference audio file
            description: Optional description

        Returns:
            voice_id of the cloned voice
        """
        logger.info(f"Cloning voice from: {reference_audio_path}")

        with httpx.Client(timeout=120) as client:
            with open(reference_audio_path, "rb") as audio_file:
                files = {"files": (os.path.basename(reference_audio_path), audio_file)}
                data = {
                    "name": name,
                    "description": description or f"Cloned voice from {os.path.basename(reference_audio_path)}",
                }
                resp = client.post(
                    f"{ELEVENLABS_BASE_URL}/voices/add",
                    headers=self.headers,
                    data=data,
                    files=files,
                )
                resp.raise_for_status()
                result = resp.json()
                voice_id = result["voice_id"]
                logger.info(f"Voice cloned successfully: {voice_id}")
                return voice_id

    def delete_voice(self, voice_id: str) -> bool:
        """Delete a cloned voice. Treats 404 as success — if the voice is
        already gone upstream (manual ElevenLabs UI delete, or a prior
        partial delete from us), the desired end state is already reached
        and our DB cleanup should proceed. Without this, an orphan DB row
        produces a permanent 502 loop with no UI path to recover."""
        with httpx.Client(timeout=30) as client:
            resp = client.delete(
                f"{ELEVENLABS_BASE_URL}/voices/{voice_id}",
                headers=self.headers,
            )
            return resp.status_code in (200, 404)
