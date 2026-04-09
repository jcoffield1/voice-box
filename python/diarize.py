#!/usr/bin/env python3
"""
Speaker diarization server using Pyannote.audio.
Communicates via newline-delimited JSON on stdin/stdout.

Request:
  {"id": "uuid", "type": "diarize", "payload": {"audio_path": "/path/to.wav", "num_speakers": null}}

Response:
  {"id": "uuid", "success": true, "data": {"segments": [{"speaker_id": "SPEAKER_00", "start": 0.0, "end": 2.5}]}}
"""

import sys
import json
import traceback
import os

_pipeline = None


def get_pipeline():
    global _pipeline
    if _pipeline is None:
        from pyannote.audio import Pipeline
        # Uses local model cache — user must have accepted pyannote license
        hf_token = os.environ.get("HF_TOKEN")
        _pipeline = Pipeline.from_pretrained(
            "pyannote/speaker-diarization-3.1",
            use_auth_token=hf_token,
        )
    return _pipeline


def diarize(payload: dict) -> dict:
    audio_path = payload.get("audio_path")
    num_speakers = payload.get("num_speakers")  # optional hint

    if not audio_path or not os.path.exists(audio_path):
        raise ValueError(f"Audio file not found: {audio_path}")

    pipeline = get_pipeline()

    kwargs = {}
    if num_speakers:
        kwargs["num_speakers"] = num_speakers

    diarization = pipeline(audio_path, **kwargs)

    segments = []
    for turn, _, speaker in diarization.itertracks(yield_label=True):
        segments.append({
            "speaker_id": speaker,
            "start": float(turn.start),
            "end": float(turn.end),
        })

    return {"segments": segments}


def handle_request(request: dict) -> dict:
    req_type = request.get("type")
    payload = request.get("payload", {})

    if req_type == "diarize":
        data = diarize(payload)
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
