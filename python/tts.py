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

# ─── FFmpeg library path setup (required by torchaudio ≥ 2.6 / torchcodec) ───
# torchaudio >= 2.6 uses torchcodec as its default audio I/O backend.
# torchcodec needs FFmpeg shared libraries (.dylib) loadable via dlopen().
# Homebrew installs FFmpeg to /usr/local (Intel) or /opt/homebrew (arm64),
# neither of which is on the default dyld search path inside an Electron process.
# Setting os.environ here works because all f5_tts/torchaudio imports are lazy —
# torchcodec's ctypes.CDLL() hasn't run yet at module load time, so the updated
# DYLD_LIBRARY_PATH is visible when dlopen() is eventually called.
def _setup_dyld_ffmpeg_path() -> None:
    if sys.platform != 'darwin':
        return
    try:
        result = subprocess.run(
            ['brew', '--prefix', 'ffmpeg'],
            capture_output=True, text=True, timeout=5
        )
        if result.returncode != 0:
            return
        lib_path = os.path.join(result.stdout.strip(), 'lib')
        if not os.path.isdir(lib_path):
            return
        existing = os.environ.get('DYLD_LIBRARY_PATH', '')
        parts = [p for p in existing.split(':') if p]
        if lib_path not in parts:
            os.environ['DYLD_LIBRARY_PATH'] = ':'.join([lib_path] + parts)
            print(f"[tts] Added {lib_path} to DYLD_LIBRARY_PATH for torchcodec",
                  file=sys.stderr, flush=True)
    except Exception as exc:
        print(f"[tts] Warning: could not detect Homebrew FFmpeg prefix: {exc}",
              file=sys.stderr, flush=True)

_setup_dyld_ffmpeg_path()

# ─── Model configuration ──────────────────────────────────────────────────────

# F5-TTS v1 Base — flow-matching voice cloning with Vocos vocoder
F5TTS_REPO = "SWivid/F5-TTS"
F5TTS_MODEL_NAME = "F5TTS_v1_Base"
F5TTS_CKPT_FILE = "model_1250000.safetensors"

_model = None          # loaded F5TTS instance
_model_loaded = False  # True once weights are in memory
_model_lock = threading.Lock()

_fw_model = None       # faster-whisper model for reference audio auto-transcription
_fw_model_lock = threading.Lock()
_torchaudio_patched = False  # True once we've applied the soundfile shim

# ─── torchaudio / torchcodec compatibility shim ───────────────────────────────
# torchaudio >= 2.6 defaults to torchcodec for audio I/O, which requires arm64
# FFmpeg shared libraries (needs Homebrew at /opt/homebrew on Apple Silicon).
# If those libs are unavailable, we patch torchaudio.load with soundfile before
# f5_tts is imported, so utils_infer.py's torchaudio.load(ref_audio) call works.
# soundfile handles WAV/FLAC/OGG natively and is already installed in the venv.
def _patch_torchaudio_if_needed() -> None:
    global _torchaudio_patched
    if _torchaudio_patched:
        return

    import torchaudio  # ensure the module is cached in sys.modules before f5_tts imports it

    # Probe whether torchcodec's C extension can load (it needs system FFmpeg)
    _ok = False
    try:
        from torchcodec._core import ops as _tc_ops  # noqa
        _ok = True
    except Exception:
        # Remove partial torchcodec submodules so they don't interfere later
        for _k in list(sys.modules.keys()):
            if 'torchcodec' in _k:
                del sys.modules[_k]

    if _ok:
        return  # all good, torchcodec works

    try:
        import soundfile as _sf
        import torch as _th

        def _sf_load(uri, frame_offset: int = 0, num_frames: int = -1,
                     normalize: bool = True, channels_first: bool = True, **_kw):
            _data, _sr = _sf.read(str(uri), dtype='float32', always_2d=True)
            _t = _th.from_numpy(_data.T.copy())  # (channels, samples)
            if frame_offset > 0:
                _t = _t[:, frame_offset:]
            if num_frames > 0:
                _t = _t[:, :num_frames]
            if not channels_first:
                _t = _t.T
            return _t, _sr

        torchaudio.load = _sf_load
        _torchaudio_patched = True
        print("[tts] torchcodec C libs not loadable (need arm64 FFmpeg); "
              "patched torchaudio.load → soundfile backend",
              file=sys.stderr, flush=True)
    except ImportError as _exc:
        print(f"[tts] Warning: both torchcodec and soundfile unavailable: {_exc}",
              file=sys.stderr, flush=True)

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


# ─── Lazy faster-whisper loader (reference audio transcription) ─────────────

def _get_fw_model():
    """Lazy-load faster-whisper-base for transcribing reference audio clips.

    Uses the same cached model as transcribe.py (Systran/faster-whisper-base),
    avoiding the 1.5 GB whisper-large-v3-turbo that F5-TTS would load instead.
    """
    global _fw_model
    with _fw_model_lock:
        if _fw_model is None:
            from faster_whisper import WhisperModel  # type: ignore
            print("[tts] Loading faster-whisper-base for ref-audio transcription...",
                  file=sys.stderr, flush=True)
            _fw_model = WhisperModel("base", device="cpu", compute_type="int8")
        return _fw_model


def _transcribe_ref_audio(audio_path: str) -> str:
    """Return a transcript for `audio_path` using faster-whisper-base."""
    fw = _get_fw_model()
    segments, _ = fw.transcribe(audio_path, beam_size=5)
    text = " ".join(seg.text.strip() for seg in segments).strip()
    return text if text else "."


# ─── Lazy F5-TTS model loader ─────────────────────────────────────────────────

def _get_model():
    global _model, _model_loaded
    with _model_lock:
        if _model_loaded:
            return _model

        try:
            _patch_torchaudio_if_needed()   # MUST run before f5_tts is imported
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
    reference_transcript: str = payload.get("reference_transcript", "").strip()
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

    # When no transcript is stored, transcribe the reference clip ourselves using
    # faster-whisper-base (already cached).  This prevents F5-TTS from loading its
    # own whisper-large-v3-turbo (1.5 GB) which causes multi-minute hangs.
    if not reference_transcript:
        print("[tts] ref_text is empty — transcribing via faster-whisper-base...",
              file=sys.stderr, flush=True)
        reference_transcript = _transcribe_ref_audio(reference_audio)
        print(f"[tts] auto-transcript: {reference_transcript!r}", file=sys.stderr, flush=True)

    model = _get_model()

    # Redirect stdout -> stderr to prevent F5-TTS's unconditional print() calls
    # from corrupting the JSON IPC channel.
    # nfe_step=16 halves the default 32 ODE steps — cuts inference ~50% with
    # minimal quality loss for voice-cloning use cases.
    with _stdout_to_stderr():
        model.infer(
            ref_file=reference_audio,
            ref_text=reference_transcript,
            gen_text=text,
            show_info=lambda *a, **kw: None,
            file_wave=output_path,
            nfe_step=16,
        )

    return {"audio_path": os.path.abspath(output_path)}


# ─── Sentence splitter ──────────────────────────────────────────────────────

import re as _re

_SENTENCE_END = _re.compile(r'(?<=[.!?])(?:\s+|$)')


def _split_sentences(text: str, min_chars: int = 20) -> list:
    """Split text into sentences, merging very short fragments into the next."""
    parts = [s.strip() for s in _SENTENCE_END.split(text) if s.strip()]
    merged: list = []
    buf = ""
    for p in parts:
        buf = (buf + " " + p).strip() if buf else p
        if len(buf) >= min_chars:
            merged.append(buf)
            buf = ""
    if buf:
        if merged:
            merged[-1] = (merged[-1] + " " + buf).strip()
        else:
            merged.append(buf)
    return merged if merged else [text]


# ─── Handle: synthesize_stream ───────────────────────────────────────────────
# Unlike synthesize, this handler DOES NOT return a single response dict.
# Instead it writes multiple JSON lines directly to stdout, each tagged with
# the same request id and containing one sentence's WAV path, before emitting
# a final {"done": true} line.  The main loop detects streaming=True in the
# handler and uses this special path.

def handle_synthesize_stream(req_id: str, payload: dict) -> None:
    """Generate speech sentence-by-sentence, flushing each chunk immediately."""
    text: str = payload.get("text", "").strip()
    reference_audio: str = payload.get("reference_audio", "")
    reference_transcript: str = payload.get("reference_transcript", "").strip()
    output_dir: str = payload.get("output_dir", "")

    def _emit(obj: dict) -> None:
        sys.stdout.write(json.dumps(obj) + "\n")
        sys.stdout.flush()

    def _err(msg: str) -> None:
        _emit({"id": req_id, "success": False, "error": msg})

    if not text:
        _err("'text' is required."); return
    if not reference_audio:
        _err("'reference_audio' is required."); return
    if not os.path.exists(reference_audio):
        _err(f"reference_audio not found: {reference_audio!r}"); return
    if not output_dir:
        _err("'output_dir' is required."); return

    os.makedirs(output_dir, exist_ok=True)

    # Ensure reference transcript
    ref_transcript = reference_transcript
    if not ref_transcript:
        print("[tts] ref_text empty — transcribing via faster-whisper-base...",
              file=sys.stderr, flush=True)
        ref_transcript = _transcribe_ref_audio(reference_audio)

    model = _get_model()
    sentences = _split_sentences(text)
    print(f"[tts] synthesize_stream: {len(sentences)} sentence(s)",
          file=sys.stderr, flush=True)

    import uuid as _uuid
    for i, sentence in enumerate(sentences):
        out_path = os.path.join(output_dir, f"{_uuid.uuid4()}.wav")
        try:
            with _stdout_to_stderr():
                model.infer(
                    ref_file=reference_audio,
                    ref_text=ref_transcript,
                    gen_text=sentence,
                    show_info=lambda *a, **kw: None,
                    file_wave=out_path,
                    nfe_step=16,
                )
            _emit({
                "id": req_id,
                "success": True,
                "streaming": True,
                "done": False,
                "data": {
                    "audio_path": os.path.abspath(out_path),
                    "sentence_index": i,
                    "sentence_count": len(sentences),
                }
            })
        except Exception as exc:
            _err(str(exc)); return

    _emit({"id": req_id, "success": True, "streaming": True, "done": True, "data": {}})


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
    "check_model":       handle_check_model,
    "download_model":    handle_download_model,
    "warmup":            handle_warmup,
    "synthesize":        handle_synthesize,
    "synthesize_stream": handle_synthesize_stream,  # streaming variant
    "clip_audio":        handle_clip_audio,
    "probe_duration":    handle_probe_duration,
}

# Handlers that manage their own stdout output (streaming)
STREAMING_HANDLERS = {"synthesize_stream"}


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
            sys.stdout.write(json.dumps(resp) + "\n")
            sys.stdout.flush()
        elif req_type in STREAMING_HANDLERS:
            # Streaming handlers write their own JSON lines; pass req_id explicitly
            try:
                handler(req_id, payload)
            except Exception as exc:
                resp = {
                    "id": req_id,
                    "success": False,
                    "error": str(exc),
                    "traceback": traceback.format_exc(),
                }
                sys.stdout.write(json.dumps(resp) + "\n")
                sys.stdout.flush()
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
