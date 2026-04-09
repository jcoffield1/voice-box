#!/usr/bin/env python3
"""
Voice embedding server using Resemblyzer.
Extracts d-vector embeddings from audio segments for speaker recognition.

Request (embed):
  {"id": "uuid", "type": "embed", "payload": {"audio_path": "/path/to.wav", "speaker_id": "SPEAKER_00"}}

Request (compare):
  {"id": "uuid", "type": "compare", "payload": {"embedding_a": [...], "embedding_b": [...]}}

Response:
  {"id": "uuid", "success": true, "data": {"embedding": [...256 floats...], "speaker_id": "SPEAKER_00"}}
"""

import sys
import json
import traceback
import os
import numpy as np

_encoder = None


def get_encoder():
    global _encoder
    if _encoder is None:
        from resemblyzer import VoiceEncoder, preprocess_wav
        _encoder = VoiceEncoder()
    return _encoder


def embed(payload: dict) -> dict:
    audio_path = payload.get("audio_path")
    speaker_id = payload.get("speaker_id", "unknown")

    if not audio_path or not os.path.exists(audio_path):
        raise ValueError(f"Audio file not found: {audio_path}")

    from resemblyzer import preprocess_wav
    encoder = get_encoder()

    wav = preprocess_wav(audio_path)
    embedding = encoder.embed_utterance(wav)

    return {
        "embedding": embedding.tolist(),
        "speaker_id": speaker_id,
        "dim": len(embedding),
    }


def compare(payload: dict) -> dict:
    """Cosine similarity between two embeddings."""
    a = np.array(payload["embedding_a"], dtype=np.float32)
    b = np.array(payload["embedding_b"], dtype=np.float32)

    norm_a = np.linalg.norm(a)
    norm_b = np.linalg.norm(b)

    if norm_a == 0 or norm_b == 0:
        return {"similarity": 0.0}

    similarity = float(np.dot(a, b) / (norm_a * norm_b))
    return {"similarity": similarity}


def handle_request(request: dict) -> dict:
    req_type = request.get("type")
    payload = request.get("payload", {})

    if req_type == "embed":
        data = embed(payload)
        return {"id": request["id"], "success": True, "data": data}
    elif req_type == "compare":
        data = compare(payload)
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
