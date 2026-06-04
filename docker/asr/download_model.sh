#!/bin/bash
# Download Qwen3-ASR-0.6B INT8 GGUF model
# Usage: ./download_model.sh <url>
set -e

MODEL_DIR="/models"
MODEL_FILE="qwen3-asr-0.6b-int8.gguf"

if [ -z "$1" ]; then
    echo "Usage: $0 <model_url>"
    echo "Example: $0 https://huggingface.co/Qwen/Qwen3-ASR-0.6B-GGUF/resolve/main/qwen3-asr-0.6b-int8.gguf"
    exit 1
fi

MODEL_URL="$1"

if [ -f "${MODEL_DIR}/${MODEL_FILE}" ]; then
    echo "Model already exists: ${MODEL_DIR}/${MODEL_FILE}"
    exit 0
fi

echo "Downloading model from: ${MODEL_URL}"
curl -L -o "${MODEL_DIR}/${MODEL_FILE}" "${MODEL_URL}" --progress-bar

echo "Model downloaded: ${MODEL_DIR}/${MODEL_FILE}"
ls -lh "${MODEL_DIR}/${MODEL_FILE}"
