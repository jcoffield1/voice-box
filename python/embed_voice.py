#!/usr/bin/env python3
"""
Voice embedding server.

Primary backend: pyannote/embedding (ECAPA-TDNN, 512-dim) — used when HF_TOKEN is set
and the model is available.  This is significantly more accurate than Resemblyzer for
speaker identification, especially for short or overlapping speech segments.

Fallback backend: Resemblyzer (d-vector, 256-dim) — used when no HF_TOKEN is configured
or the pyannote model fails to load.

The backend is selected once at startup (warmup) and stays fixed for the process lifetime.
All public request handlers are backend-agnostic — the TypeScript side sees the same API
regardless of which backend is active.

Dimension note: pyannote produces 512-dim embeddings; Resemblyzer produces 256-dim.
The TypeScript side guards cosine similarity against dimension mismatches, so old
Resemblyzer embeddings stored in the database are safely ignored (score 0) and get
replaced the next time a speaker is confirmed.

Optimisations:
  - Backend is loaded eagerly at warmup — no cold-load delay on first request.
  - All audio loading uses seek-based partial reads (soundfile) — never loads the
    full file for large recordings.
  - embed_segments_batch embeds multiple speaker clusters in one IPC round-trip.
"""

import sys
import json
import traceback
import os
from math import gcd
import numpy as np
import av as _av
from scipy.signal import resample_poly

SR = 16000  # All audio is resampled to 16 kHz before embedding

# ── Backend singletons ────────────────────────────────────────────────────────

_backend: str | None = None   # "pyannote" or "resemblyzer"
_inference = None              # pyannote.audio Inference instance
_encoder = None                # Resemblyzer VoiceEncoder instance


def _init_backend() -> None:
    global _backend, _inference, _encoder
    if _backend is not None:
        return

    hf_token = os.environ.get("HF_TOKEN")

    if hf_token:
        try:
            from pyannote.audio import Inference
            _inference = Inference(
                "pyannote/embedding",
                token=hf_token,
                window="whole",
            )
            _backend = "pyannote"
            return
        except Exception as e:
            # Model not accepted / not downloaded yet — fall through to resemblyzer.
            print(
                f"[embed_voice] pyannote/embedding unavailable ({e}); "
                "falling back to Resemblyzer",
                file=sys.stderr,
                flush=True,
            )

    from resemblyzer import VoiceEncoder
    _encoder = VoiceEncoder()
    _backend = "resemblyzer"


# ── Core embedding ────────────────────────────────────────────────────────────

def _embed_audio(audio: np.ndarray) -> np.ndarray:
    """Return a speaker embedding for a float32 16 kHz mono numpy array."""
    min_samples = SR // 4  # 250 ms minimum — anything shorter is unreliable
    if len(audio) < min_samples:
        raise ValueError(
            f"Audio segment too short ({len(audio) / SR:.3f}s); minimum is 0.25s"
        )

    if _backend == "pyannote":
        import torch
        waveform = torch.from_numpy(audio).float().unsqueeze(0)  # [1, T]
        embedding = _inference({"waveform": waveform, "sample_rate": SR})
        return np.squeeze(np.array(embedding)).astype(np.float32)
    else:
        return _encoder.embed_utterance(audio)


# ── Audio loading ─────────────────────────────────────────────────────────────

def _load_segment(audio_path: str, start_sec: float, end_sec: float) -> np.ndarray:
    """Seek-based partial read using PyAV — supports .m4a, .wav, .mp4, etc."""
    container = _av.open(str(audio_path))
    try:
        stream = container.streams.audio[0]
        native_sr = stream.codec_context.sample_rate

        # Seek slightly before start to handle AAC codec lookahead
        if start_sec > 0.1:
            container.seek(int((start_sec - 0.1) * 1e6), any_frame=True)

        chunks = []
        for frame in container.decode(stream):
            if frame.pts is None:
                continue
            frame_t = float(frame.pts) * float(stream.time_base)
            frame_end_t = frame_t + frame.samples / frame.sample_rate

            if frame_end_t <= start_sec:
                continue
            if frame_t >= end_sec:
                break

            # float planar: (channels, samples) — M4A frames arrive as fltp already
            audio_arr = frame.to_ndarray()

            sr = frame.sample_rate
            clip_start = max(0, int((start_sec - frame_t) * sr))
            clip_end = min(frame.samples, int((end_sec - frame_t) * sr) + 1)
            audio_arr = audio_arr[:, clip_start:clip_end]

            if audio_arr.shape[1] > 0:
                chunks.append(audio_arr.mean(axis=0).astype(np.float32))
    finally:
        container.close()

    if not chunks:
        return np.zeros(0, dtype=np.float32)

    audio = np.concatenate(chunks)

    if native_sr != SR:
        g = gcd(native_sr, SR)
        audio = resample_poly(audio, SR // g, native_sr // g).astype(np.float32)

    peak = np.abs(audio).max()
    if peak > 1.0:
        audio = audio / peak

    return audio


def _extract_combined(audio_path: str, segments: list) -> np.ndarray:
    """Load and concatenate specific time-range segments (seek-based, no full-file load)."""
    chunks = [
        _load_segment(audio_path, float(s["start"]), float(s["end"]))
        for s in segments
    ]
    chunks = [c for c in chunks if len(c) > 0]
    if not chunks:
        raise ValueError("No audio data found in the specified segments")
    return np.concatenate(chunks)


# ── Request handlers ──────────────────────────────────────────────────────────

def warmup(_payload: dict) -> dict:
    """Eagerly load the embedding backend — eliminates cold-load delay on first request."""
    _init_backend()
    return {"ready": True, "backend": _backend}


def embed(payload: dict) -> dict:
    """Embed an entire audio file (legacy — prefer embed_segments for time-range extraction)."""
    audio_path = payload.get("audio_path")
    speaker_id = payload.get("speaker_id", "unknown")

    if not audio_path or not os.path.exists(audio_path):
        raise ValueError(f"Audio file not found: {audio_path}")

    _init_backend()
    audio = _load_segment(audio_path, 0.0, float('inf'))
    embedding = _embed_audio(audio)

    return {"embedding": embedding.tolist(), "speaker_id": speaker_id, "dim": len(embedding)}


def embed_segments(payload: dict) -> dict:
    """Embed the concatenated audio of specific time-range segments."""
    audio_path = payload.get("audio_path")
    segments   = payload.get("segments", [])

    if not audio_path or not os.path.exists(audio_path):
        return {"embedding": [], "dim": 0}
    if not segments:
        raise ValueError("No segments provided")

    _init_backend()
    try:
        combined  = _extract_combined(audio_path, segments)
        embedding = _embed_audio(combined)
    except ValueError:
        return {"embedding": [], "dim": 0}

    return {"embedding": embedding.tolist(), "dim": len(embedding)}


def embed_segments_batch(payload: dict) -> dict:
    """Embed multiple speaker clusters from the same audio file in one call.

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
          {"id": "SPEAKER_00", "embedding": [...], "dim": 512},
          {"id": "SPEAKER_01", "embedding": [...], "dim": 512}
        ]
      }
    """
    audio_path = payload.get("audio_path")
    groups     = payload.get("groups", [])

    if not audio_path or not os.path.exists(audio_path):
        raise ValueError(f"Audio file not found: {audio_path}")
    if not groups:
        raise ValueError("No groups provided")

    _init_backend()
    results = []
    for group in groups:
        try:
            combined  = _extract_combined(audio_path, group.get("segments", []))
            embedding = _embed_audio(combined)
            results.append({
                "id":        group.get("id", ""),
                "embedding": embedding.tolist(),
                "dim":       len(embedding),
            })
        except Exception as e:
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
    try:
        _init_backend()
        print(json.dumps({"startup": "ready", "backend": _backend}), flush=True)
    except Exception as e:
        print(
            json.dumps({"startup": "error", "detail": str(e)}),
            file=sys.stderr,
            flush=True,
        )

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
