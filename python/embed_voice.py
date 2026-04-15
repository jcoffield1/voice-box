#!/usr/bin/env python3
"""
Voice embedding server using Resemblyzer.
Extracts d-vector embeddings from audio segments for speaker recognition.

Optimisations vs v1:
  - Encoder is loaded eagerly on startup (warmup) — no cold-load delay on first request.
  - embed_segments / embed_segments_batch use seek-based partial reads (soundfile) so
    only the requested time-range chunks are loaded — not the entire audio file.  This
    is critical for long recordings where a full preprocess_wav() call could take minutes.
  - embed_segments_batch accepts multiple segment groups in one request, avoiding N
    round-trips for cross-cluster matching.
  - compare has been kept for back-compat but should not be called in a loop —
    the TypeScript side performs bulk cosine similarity against stored embeddings.
  - Cosine similarity (compare / compare_all) uses vectorised NumPy ops.
"""

import sys
import json
import traceback
import os
from math import gcd
import numpy as np
import soundfile as sf
from scipy.signal import resample_poly

# ── Encoder singleton ─────────────────────────────────────────────────────────

_encoder = None


def get_encoder():
    global _encoder
    if _encoder is None:
        from resemblyzer import VoiceEncoder
        _encoder = VoiceEncoder()
    return _encoder


# ── Wav cache (path → float32 numpy array at 16 kHz) ─────────────────────────

_wav_cache: dict = {}
_WAV_CACHE_MAX = 8  # keep at most 8 files in memory


def get_wav(audio_path: str):
    if audio_path in _wav_cache:
        return _wav_cache[audio_path]

    from resemblyzer import preprocess_wav
    wav = preprocess_wav(audio_path)

    # Evict oldest entry if cache is full
    if len(_wav_cache) >= _WAV_CACHE_MAX:
        oldest = next(iter(_wav_cache))
        del _wav_cache[oldest]

    _wav_cache[audio_path] = wav
    return wav


# ── Helpers ───────────────────────────────────────────────────────────────────

SR = 16000  # Resemblyzer always works at 16 kHz


def _load_segment(audio_path: str, start_sec: float, end_sec: float) -> np.ndarray:
    """Read only a specific time range from a file and return float32 mono @ SR.

    Uses soundfile's seek-based partial read so we never load the full file into
    memory — critical for long recordings where loading the whole thing could
    take minutes.
    """
    info = sf.info(audio_path)
    native_sr    = info.samplerate
    start_frame  = max(0, int(start_sec * native_sr))
    end_frame    = min(info.frames, int(end_sec * native_sr))
    if end_frame <= start_frame:
        return np.zeros(0, dtype=np.float32)

    audio, _ = sf.read(
        audio_path, start=start_frame, stop=end_frame,
        dtype='float32', always_2d=False
    )

    # Mix down to mono
    if audio.ndim > 1:
        audio = audio.mean(axis=1)

    # Resample to 16 kHz if needed
    if native_sr != SR:
        g     = gcd(native_sr, SR)
        audio = resample_poly(audio, SR // g, native_sr // g).astype(np.float32)

    # Resemblyzer expects values in [-1, 1]; normalise if needed
    peak = np.abs(audio).max()
    if peak > 1.0:
        audio = audio / peak

    return audio


def _extract_combined(audio_path: str, segments: list) -> np.ndarray:
    """Load and concatenate specific time-range segments (seek-based, no full-file load)."""
    chunks = []
    for seg in segments:
        chunk = _load_segment(audio_path, float(seg["start"]), float(seg["end"]))
        if len(chunk) > 0:
            chunks.append(chunk)
    if not chunks:
        raise ValueError("No audio data found in the specified segments")
    return np.concatenate(chunks)


# ── Request handlers ──────────────────────────────────────────────────────────

def warmup(_payload: dict) -> dict:
    """Eagerly load the VoiceEncoder so the first real request is fast."""
    get_encoder()
    return {"ready": True}


def embed(payload: dict) -> dict:
    audio_path = payload.get("audio_path")
    speaker_id = payload.get("speaker_id", "unknown")

    if not audio_path or not os.path.exists(audio_path):
        raise ValueError(f"Audio file not found: {audio_path}")

    encoder  = get_encoder()
    wav      = get_wav(audio_path)
    embedding = encoder.embed_utterance(wav)

    return {
        "embedding": embedding.tolist(),
        "speaker_id": speaker_id,
        "dim": len(embedding),
    }


def embed_segments(payload: dict) -> dict:
    """Embed the concatenated audio of specific time-range segments."""
    audio_path = payload.get("audio_path")
    segments   = payload.get("segments", [])

    if not audio_path or not os.path.exists(audio_path):
        # File missing (e.g. snapshot deleted before Python read it) — return empty gracefully
        return {"embedding": [], "dim": 0}
    if not segments:
        raise ValueError("No segments provided")

    encoder  = get_encoder()
    try:
        combined = _extract_combined(audio_path, segments)
    except ValueError:
        # All requested segments fall outside the audio file duration — return
        # an empty embedding so the caller can handle it without an exception.
        return {"embedding": [], "dim": 0}
    embedding = encoder.embed_utterance(combined)

    return {
        "embedding": embedding.tolist(),
        "dim": len(embedding),
    }


def embed_segments_batch(payload: dict) -> dict:
    """Embed multiple groups of segments from the same audio file in one call.

    Payload:
      {
        "audio_path": "/path/to/recording.wav",
        "groups": [
          {"id": "SPEAKER_00", "segments": [{"start": 0.5, "end": 3.2}, ...]},
          {"id": "SPEAKER_01", "segments": [{"start": 5.0, "end": 8.1}]}
        ]
      }

    Response:
      {
        "results": [
          {"id": "SPEAKER_00", "embedding": [...], "dim": 256},
          {"id": "SPEAKER_01", "embedding": [...], "dim": 256}
        ]
      }
    """
    audio_path = payload.get("audio_path")
    groups     = payload.get("groups", [])

    if not audio_path or not os.path.exists(audio_path):
        raise ValueError(f"Audio file not found: {audio_path}")
    if not groups:
        raise ValueError("No groups provided")

    encoder = get_encoder()
    # Wav is cached — loaded once for all groups
    results = []
    for group in groups:
        try:
            combined  = _extract_combined(audio_path, group.get("segments", []))
            embedding = encoder.embed_utterance(combined)
            results.append({
                "id":        group.get("id", ""),
                "embedding": embedding.tolist(),
                "dim":       len(embedding),
            })
        except Exception as e:
            # Don't abort the whole batch for one bad group
            results.append({"id": group.get("id", ""), "error": str(e)})

    return {"results": results}


def compare(payload: dict) -> dict:
    """Cosine similarity between two embeddings (kept for back-compat)."""
    a = np.array(payload["embedding_a"], dtype=np.float32)
    b = np.array(payload["embedding_b"], dtype=np.float32)

    norm_a = np.linalg.norm(a)
    norm_b = np.linalg.norm(b)

    if norm_a == 0 or norm_b == 0:
        return {"similarity": 0.0}

    return {"similarity": float(np.dot(a, b) / (norm_a * norm_b))}


def handle_request(request: dict) -> dict:
    req_type = request.get("type")
    payload  = request.get("payload", {})

    handlers = {
        "warmup":               warmup,
        "embed":                embed,
        "embed_segments":       embed_segments,
        "embed_segments_batch": embed_segments_batch,
        "compare":              compare,
        "ping":                 lambda _: {"pong": True},
    }

    if req_type not in handlers:
        return {"id": request["id"], "success": False, "error": f"Unknown type: {req_type}"}

    data = handlers[req_type](payload)
    return {"id": request["id"], "success": True, "data": data}


def main():
    # Eagerly warm up the encoder so the first user-facing request is instant.
    # Errors here are printed to stderr but don't crash the server loop.
    try:
        get_encoder()
        print(json.dumps({"startup": "ready"}), flush=True)
    except Exception as e:
        print(json.dumps({"startup": "error", "detail": str(e)}), file=sys.stderr, flush=True)

    for line in sys.stdin:
        line = line.strip()
        if not line:
            continue
        try:
            request  = json.loads(line)
            response = handle_request(request)
        except Exception as e:
            response = {
                "id":      (json.loads(line) if line else {}).get("id", "unknown"),
                "success": False,
                "error":   traceback.format_exc(),
            }
        print(json.dumps(response), flush=True)


if __name__ == "__main__":
    main()
