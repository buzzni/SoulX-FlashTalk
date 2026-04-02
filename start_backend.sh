#!/bin/bash
# Start SoulX-FlashTalk FastAPI backend
cd "$(dirname "$0")"

# Set ELEVENLABS_API_KEY if needed
# export ELEVENLABS_API_KEY="your-api-key-here"

# GPU selection
export CUDA_VISIBLE_DEVICES=${CUDA_VISIBLE_DEVICES:-1}

.venv/bin/python app.py --port 8001
