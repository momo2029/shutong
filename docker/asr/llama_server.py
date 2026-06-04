#!/usr/bin/env python3
"""
llama.cpp HTTP server wrapper for Qwen3-ASR-0.6B INT8 (GGUF).
Exposes a simple REST API: POST /asr  ->  {"text": "..."}
"""
import os
import sys
import json
import tempfile
import subprocess
from http.server import HTTPServer, BaseHTTPRequestHandler
from pathlib import Path

MODEL_PATH = os.environ.get("ASR_MODEL_PATH", "/models/qwen3-asr-0.6b-int8.gguf")
LLAMA_CPP_DIR = os.environ.get("LLAMA_CPP_DIR", "/llama.cpp")
LLAMA_CLI = os.path.join(LLAMA_CPP_DIR, "llama-cli")
LLAMA_SERVER = os.path.join(LLAMA_CPP_DIR, "llama-server")
PORT = int(os.environ.get("ASR_PORT", "8888"))

# Use llama-server if available, otherwise fall back to llama-cli
USE_SERVER = os.path.isfile(LLAMA_SERVER)

ASR_PROMPT = "请将以下音频转写为中文文本。"


class ASRHandler(BaseHTTPRequestHandler):
    def do_POST(self):
        if self.path != "/asr":
            self.send_error(404, "Not Found")
            return

        content_length = int(self.headers.get("Content-Length", 0))
        if content_length == 0:
            self.send_error(400, "Empty body")
            return

        body = self.rfile.read(content_length)

        # Write WAV to temp file
        with tempfile.NamedTemporaryFile(suffix=".wav", delete=False) as tmp:
            tmp.write(body)
            tmp_path = tmp.name

        try:
            text = self.transcribe(tmp_path)
            resp = json.dumps({"text": text}, ensure_ascii=False).encode("utf-8")
            self.send_response(200)
            self.send_header("Content-Type", "application/json; charset=utf-8")
            self.send_header("Content-Length", str(len(resp)))
            self.end_headers()
            self.wfile.write(resp)
        except Exception as e:
            self.send_error(500, str(e))
        finally:
            os.unlink(tmp_path)

    def transcribe(self, wav_path: str) -> str:
        """Run llama.cpp inference on the WAV file."""
        if USE_SERVER:
            return self._transcribe_server(wav_path)
        return self._transcribe_cli(wav_path)

    def _transcribe_cli(self, wav_path: str) -> str:
        """One-shot inference via llama-cli."""
        # Build prompt for Qwen3-ASR
        prompt = f"<|audio|>{wav_path}\n{ASR_PROMPT}"
        cmd = [
            LLAMA_CLI,
            "-m", MODEL_PATH,
            "-p", prompt,
            "--print-progress",
            "-n", "512",       # max tokens
            "--temp", "0.0",    # greedy decoding
            "--repeat-penalty", "1.0",
            "-t", "4",          # threads (adjust based on CPU cores)
            "--no-display-prompt",
        ]
        result = subprocess.run(cmd, capture_output=True, text=True, timeout=300)
        output = result.stdout.strip()
        # Remove prompt echo if present
        if output.startswith(prompt):
            output = output[len(prompt):].strip()
        return output

    def _transcribe_server(self, wav_path: str) -> str:
        """Use llama-server mode with audio embedding (if supported)."""
        # For now, fall back to CLI mode
        # TODO: implement server mode with /embedding endpoint
        return self._transcribe_cli(wav_path)

    def log_message(self, format, *args):
        """Custom log format."""
        print(f"[ASR] {self.address_string()} - {format % args}", flush=True)


def main():
    # Check model exists
    if not os.path.isfile(MODEL_PATH):
        print(f"[ASR] WARNING: Model not found at {MODEL_PATH}")
        print("[ASR] The server will start but inference will fail.")
        print("[ASR] Download the model and mount it to the container.")

    server = HTTPServer(("0.0.0.0", PORT), ASRHandler)
    print(f"[ASR] Server listening on 0.0.0.0:{PORT}", flush=True)
    print(f"[ASR] Model: {MODEL_PATH}", flush=True)
    print(f"[ASR] Using {'llama-server' if USE_SERVER else 'llama-cli'} backend", flush=True)
    server.serve_forever()


if __name__ == "__main__":
    main()
