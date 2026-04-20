#!/usr/bin/env python3
"""
F5-TTS server — zero-shot voice cloning via F5-TTS (flow-matching).

Much faster than autoregressive LLM-based TTS on Apple Silicon — uses MPS
automatically, achieving sub-real-time inference on M-series Macs.

Communicates via newline-delimited JSON on stdin/stdout, identical to the
other VoiceBox Python bridges (transcribe.py, diarize.py, embed_voice.py).

Supported request types:
  check_model      — report whether model weights are on disk
  download_model   — download weights from HuggingFace (blocks until done)
  warmup           — pre-load model weights; no-op if already loaded
  synthesize       — generate speech with a reference audio clip
  clip_audio       — extract a time window from an audio file using ffmpeg
  probe_duration   — return the duration of an audio file in seconds

Request format:
  {"id": "uuid", "type": "<type>", "payload": {...}}

Response format:
  {"id": "uuid", "success": true,  "data": {...}}
  {"id": "uuid", "success": false, "error": "..."}

Startup signal (required by PythonBridge.ts):
  {"startup": "ready"}
"""

import sys
import json
import os
import traceback
import subprocess
import shutil
import threading
import contextlib
from pathlib import Path

# ─── Model configuration ──────────────────────────────────────────────────────

# F5-TTS v1 Base — flow-matching voice cloning with Vocos vocoder
F5TTS_REPO = "SWivid/F5-TTS"
F5TTS_MODEL_NAME = "F5TTS_v1_Base"
F5TTS_CKPT_FILE = "model_1250000.safetensors"

_model = None          # loaded F5TTS instance
_model_loaded = False  # True once weights are in memory
_model_lock = threading.Lock()

# ─── Suppress F5-TTS stdout noise ─────────────────────────────────────────────
# F5-TTS has unconditional print() calls that would corrupt the JSON stdout
# channel used by PythonBridge.ts.  We redirect stdout → stderr for the
# duration of any F5-TTS call so those prints are captured as log noise only.

@contextlib.contextmanager
def _stdout_to_stderr():
    old = sys.stdout
    sys.stdout = sys.stderr
    try:
        yield
    finally:
        sys.stdout = old

# ─── HF hub cache helpers ────────────────────────────────────────────────────

def _get_hf_hub_cache() -> Path:
    hf_home = os.environ.get("HF_HOME") or os.path.join(Path.home(), ".cache", "huggingface")
    hub_cache = os.environ.get("HF_HUB_CACHE") or os.path.join(hf_home, "hub")
    return Path(hub_cache)


def _model_is_downloaded() -> bool:
    """Return True if the F5-TTS model checkpoint is present in the HF hub cache."""
    model_cache = _get_hf_hub_cache() / "models--SWivid--F5-TTS"
    if not model_cache.exists():
        return False
    return any(
        p.is_file()
        for p in model_cache.glob(f"snapshots/*/{F5TTS_MODEL_NAME}/{F5TTS_CKPT_FILE}")
    )


# ─── Handle: check_model ─────────────────────────────────────────────────────

def handle_check_model(_payload: dict) -> dict:
    if _model_loaded:
        return {"status": "ready"}
    if _model_is_downloaded():
        return {"status": "ready"}
    return {"status": "not_downloaded"}


# ─── Handle: download_model ──────────────────────────────────────────────────

def handle_download_model(_payload: dict) -> dict:
    """Download F5-TTS weights.  F5TTS() downloads automatically on construction."""
    _get_model()
    return {"status": "ready"}


# ─── Lazy model loader ───────────────────────────────────────────────────────

def _get_model():
    global _model, _model_loaded
    with _model_lock:
        if _model_loaded:
            return _model

        try:
            from f5_tts.api import F5TTS  # type: ignore

            print("[tts] Loading F5-TTS (flow-matching voice cloning)...", file=sys.stderr, flush=True)
            # F5TTS auto-selects device: MPS > CPU.  No manual device_map needed.
            # Model + Vocos vocoder are downloaded automatically if not cached.
            with _stdout_to_stderr():
                _model = F5TTS()

            print(f"[tts] F5-TTS loaded on {_model.device} — ready", file=sys.stderr, flush=True)
            _model_loaded = True
            return _model

        except ImportError as exc:
            raise RuntimeError(
                "f5-tts package not installed. Run: pip install f5-tts"
            ) from exc
        except Exception as exc:
            tb = traceback.format_exc()
            print(f"[tts] FATAL: model load failed:\n{tb}", file=sys.stderr, flush=True)
            raise RuntimeError(f"Failed to load F5-TTS model: {exc}") from exc


# ─── Handle: warmup ──────────────────────────────────────────────────────────

def handle_warmup(_payload: dict) -> dict:
    """Pre-load model weights into memory.  No-op if already loaded or not downloaded."""
    if not _model_loaded:
        if _model_is_downloaded():
            _get_model()
    return {"status": "ready" if _model_loaded else "not_downloaded"}


# ─── Handle: synthesize ───────────────────────────────────────────────────────

def handle_synthesize(payload: dict) -> dict:
    text: str = payload.get("text", "").strip()
    reference_audio: str = payload.get("reference_audio", "")
    reference_transcript: str = payload.get("reference_transcript", "")
    output_path: str = payload.get("output_path", "")

    if not text:
        raise ValueError("'text' is required.")
    if not output_path:
        raise ValueError("'output_path' is required.")
    if not reference_audio:
        raise ValueError(
            "'reference_audio' is required. Add at least one audio sample to this voice."
        )
    if not os.path.exists(reference_audio):
        raise ValueError(f"reference_audio not found: {reference_audio!r}")

    os.makedirs(os.path.dirname(output_path) or ".", exist_ok=True)

    model = _get_model()

    # If ref_text is empty, F5-TTS auto-transcribes using Whisper (with caching).
    # Redirect stdout -> stderr to prevent F5-TTS's print() calls from corrupting
    # the JSON IPC channel.
    with _stdout_to_stderr():
        model.infer(
            ref_file=reference_audio,
            ref_text=reference_transcript,
            gen_text=text,
            show_info=lambda *a, **kw: None,
            file_wave=output_path,
        )

    return {"audio_path": os.path.abspath(output_path)}


# ─── Handle: clip_audio ───────────────────────────────────────────────────────

def handle_clip_audio(payload: dict) -> dict:
    source_path: str = payload.get("source_path", "")
    output_path: str = payload.get("output_path", "")
    start_sec: float = float(payload.get("start_sec", 0))
    end_sec: float = float(payload.get("end_sec", start_sec + 10))

    if not source_path or not os.path.exists(source_path):
        raise ValueError(f"source_path not found: {source_path!r}")
    if not output_path:
        raise ValueError("'output_path' is required.")

    os.makedirs(os.path.dirname(output_path) or ".", exist_ok=True)

    # Prefer the bundled binary injected by the Electron main process
    ffmpeg = os.environ.get("FFMPEG_PATH") or shutil.which("ffmpeg")
    if not ffmpeg:
        raise RuntimeError(
            "ffmpeg not found — install it via 'brew install ffmpeg' to clip recording audio."
        )

    duration = end_sec - start_sec
    result = subprocess.run(
        [
            ffmpeg, "-y",
            "-ss", str(start_sec),
            "-i", source_path,
            "-t", str(duration),
            "-ar", "16000",   # 16-kHz mono WAV for best TTS compatibility
            "-ac", "1",
            "-c:a", "pcm_s16le",
            output_path,
        ],
        capture_output=True,
        text=True,
        timeout=60,
    )
    if result.returncode != 0:
        raise RuntimeError(f"ffmpeg error: {result.stderr.strip()}")

    return {"output_path": os.path.abspath(output_path)}


# ─── Handle: probe_duration ───────────────────────────────────────────────────

def handle_probe_duration(payload: dict) -> dict:
    audio_path: str = payload.get("audio_path", "")
    if not audio_path or not os.path.exists(audio_path):
        return {"duration_sec": None}

    # Try soundfile first (fast, no subprocess)
    try:
        import soundfile as sf  # type: ignore
        info = sf.info(audio_path)
        return {"duration_sec": float(info.duration)}
    except Exception:
        pass

    # Fall back to ffprobe
    ffprobe = shutil.which("ffprobe")
    if not ffprobe:
        return {"duration_sec": None}

    try:
        result = subprocess.run(
            [
                ffprobe, "-v", "quiet",
                "-show_entries", "format=duration",
                "-of", "default=noprint_wrappers=1:nokey=1",
                audio_path,
            ],
            capture_output=True,
            text=True,
            timeout=10,
        )
        val = result.stdout.strip()
        if val:
            return {"duration_sec": float(val)}
    except Exception:
        pass

    return {"duration_sec": None}


# ─── Dispatch table ───────────────────────────────────────────────────────────

HANDLERS = {
    "check_model":    handle_check_model,
    "download_model": handle_download_model,
    "warmup":         handle_warmup,
    "synthesize":     handle_synthesize,
    "clip_audio":     handle_clip_audio,
    "probe_duration": handle_probe_duration,
}


# ─── Main loop ────────────────────────────────────────────────────────────────

def main() -> None:
    # Signal readiness to PythonBridge.ts
    sys.stdout.write(json.dumps({"startup": "ready"}) + "\n")
    sys.stdout.flush()

    # If the model is already downloaded, pre-load weights immediately so the
    # first synthesize call doesn't wait for a cold-start model load.
    if _model_is_downloaded():
        threading.Thread(target=_get_model, daemon=True).start()

    for raw_line in sys.stdin:
        raw_line = raw_line.strip()
        if not raw_line:
            continue

        try:
            req = json.loads(raw_line)
        except json.JSONDecodeError as exc:
            sys.stderr.write(f"[tts.py] JSON parse error: {exc}\n")
            sys.stderr.flush()
            continue

        req_id   = req.get("id", "")
        req_type = req.get("type", "")
        payload  = req.get("payload", {})

        handler = HANDLERS.get(req_type)
        if handler is None:
            resp = {"id": req_id, "success": False, "error": f"Unknown request type: {req_type!r}"}
        else:
            try:
                data = handler(payload)
                resp = {"id": req_id, "success": True, "data": data}
            except Exception as exc:
                resp = {
                    "id": req_id,
                    "success": False,
                    "error": str(exc),
                    "traceback": traceback.format_exc(),
                }

        sys.stdout.write(json.dumps(resp) + "\n")
        sys.stdout.flush()


if __name__ == "__main__":
    main()
