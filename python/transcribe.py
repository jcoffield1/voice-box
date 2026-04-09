#!/usr/bin/env python3
"""
Whisper transcription server.
Communicates via newline-delimited JSON on stdin/stdout.
Never exits — stays alive for the app session.

Request format:
  {"id": "uuid", "type": "transcribe", "payload": {"audio_path": "/path/to/audio.wav", "language": "auto"}}

Response format:
  {"id": "uuid", "success": true, "data": {"segments": [...]}}
  {"id": "uuid", "success": false, "error": "..."}
"""

import sys
import json
import traceback
import os

# Use faster-whisper (CTranslate2) — significantly faster than openai-whisper on CPU/MPS.
# Falls back to openai-whisper if faster-whisper is not installed.
_whisper_model = None
_current_model_size = None
_use_faster_whisper = False

try:
    from faster_whisper import WhisperModel as FasterWhisperModel
    _use_faster_whisper = True
except ImportError:
    pass


def get_model(size: str = "base"):
    global _whisper_model, _current_model_size
    if _whisper_model is None or _current_model_size != size:
        if _use_faster_whisper:
            # int8 quantization is fast on Apple Silicon ARM CPU via CTranslate2
            _whisper_model = FasterWhisperModel(size, device="cpu", compute_type="int8")
        else:
            import whisper
            _whisper_model = whisper.load_model(size)
        _current_model_size = size
    return _whisper_model


def transcribe(payload: dict) -> dict:
    audio_path = payload.get("audio_path")
    model_size = payload.get("model_size", "base")
    language = payload.get("language", None)  # None = auto-detect

    if not audio_path or not os.path.exists(audio_path):
        raise ValueError(f"Audio file not found: {audio_path}")

    model = get_model(model_size)

    if _use_faster_whisper:
        lang_arg = None if (not language or language == "auto") else language
        fw_segments, info = model.transcribe(audio_path, language=lang_arg, task="transcribe")
        segments = []
        for seg in fw_segments:
            segments.append({
                "text": seg.text.strip(),
                "start": float(seg.start),
                "end": float(seg.end),
                "confidence": float(seg.avg_logprob) if hasattr(seg, "avg_logprob") else 0.0,
                "language": info.language,
            })
        return {"segments": segments, "language": info.language}

    else:
        options = {"task": "transcribe", "verbose": False, "fp16": False}
        if language and language != "auto":
            options["language"] = language
        result = model.transcribe(audio_path, **options)
        segments = []
        for seg in result.get("segments", []):
            segments.append({
                "text": seg["text"].strip(),
                "start": float(seg["start"]),
                "end": float(seg["end"]),
                "confidence": float(seg.get("avg_logprob", 0.0)),
                "language": result.get("language"),
            })
        return {"segments": segments, "language": result.get("language")}


def handle_request(request: dict) -> dict:
    req_type = request.get("type")
    payload = request.get("payload", {})

    if req_type == "transcribe":
        data = transcribe(payload)
        return {"id": request["id"], "success": True, "data": data}
    elif req_type == "ping":
        return {"id": request["id"], "success": True, "data": {"pong": True}}
    else:
        return {"id": request["id"], "success": False, "error": f"Unknown type: {req_type}"}


def main():
    for line in sys.stdin:
        line = line.strip()
        if not line:
            continue
        try:
            request = json.loads(line)
            response = handle_request(request)
        except json.JSONDecodeError as e:
            # Can't respond without an ID — write a generic error
            response = {"id": "unknown", "success": False, "error": f"JSON parse error: {e}"}
        except Exception as e:
            req_id = "unknown"
            try:
                req_id = json.loads(line).get("id", "unknown")
            except Exception:
                pass
            response = {
                "id": req_id,
                "success": False,
                "error": f"{type(e).__name__}: {e}",
                "traceback": traceback.format_exc(),
            }

        sys.stdout.write(json.dumps(response) + "\n")
        sys.stdout.flush()


if __name__ == "__main__":
    main()
