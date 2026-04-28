#!/bin/bash
# Start SoulX-FlashTalk FastAPI backend
cd "$(dirname "$0")"

# Set ELEVENLABS_API_KEY if needed
# export ELEVENLABS_API_KEY="your-api-key-here"

# GPU selection
export CUDA_VISIBLE_DEVICES=${CUDA_VISIBLE_DEVICES:-1}

# WARNING: WEB_CONCURRENCY=1 is required for the GenerationJob pubsub.
# Multi-worker breaks SSE — each worker has its own asyncio.Queue, so an
# event published by the POST-handling worker never reaches the worker
# serving the SSE GET. v2.1 will introduce Redis-backed pubsub for
# multi-worker scaling. Until then, the assertion in app.py startup
# (assert_single_process_or_raise) refuses to boot under WEB_CONCURRENCY>1.
export WEB_CONCURRENCY=1

.venv/bin/python app.py --port 8001
