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


class ElevenLabsTTS:
    def __init__(self, api_key: str, model_id: str = "eleven_multilingual_v2"):
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
                })
            return voices

    def generate_speech(
        self,
        text: str,
        voice_id: str,
        output_path: str,
        stability: float = 0.5,
        similarity_boost: float = 0.75,
        style: float = 0.0,
    ) -> str:
        """Generate speech audio from text using a specific voice.

        Args:
            text: Text to synthesize
            voice_id: ElevenLabs voice ID
            output_path: Path to save the WAV file (16kHz mono)
            stability: Voice stability (0.0-1.0)
            similarity_boost: Similarity boost (0.0-1.0)
            style: Style exaggeration (0.0-1.0)

        Returns:
            Path to the generated WAV file
        """
        logger.info(f"Generating speech: text={text[:50]}..., voice={voice_id}")

        payload = {
            "text": text,
            "model_id": self.model_id,
            "voice_settings": {
                "stability": stability,
                "similarity_boost": similarity_boost,
                "style": style,
            },
        }

        with httpx.Client(timeout=120) as client:
            resp = client.post(
                f"{ELEVENLABS_BASE_URL}/text-to-speech/{voice_id}",
                headers={**self.headers, "Content-Type": "application/json", "Accept": "audio/mpeg"},
                json=payload,
            )
            resp.raise_for_status()

            # Save as mp3 first, then convert to wav
            mp3_path = output_path.replace(".wav", ".mp3")
            with open(mp3_path, "wb") as f:
                f.write(resp.content)

        # Convert mp3 to 16kHz mono WAV using ffmpeg (required for FlashTalk)
        import subprocess
        cmd = [
            "ffmpeg", "-y", "-i", mp3_path,
            "-ar", "16000", "-ac", "1", "-f", "wav",
            output_path,
        ]
        subprocess.run(cmd, check=True, capture_output=True)

        # Cleanup mp3
        if os.path.exists(mp3_path):
            os.remove(mp3_path)

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
        """Delete a cloned voice"""
        with httpx.Client(timeout=30) as client:
            resp = client.delete(
                f"{ELEVENLABS_BASE_URL}/voices/{voice_id}",
                headers=self.headers,
            )
            return resp.status_code == 200
