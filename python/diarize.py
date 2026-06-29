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
import numpy as np

_pipeline = None


def _patch_compat():
    """
    Suppress warnings from pyannote 4.x / torchaudio 2.x and patch torch.load
    to allow loading pyannote checkpoint files that embed custom classes.
    """
    import warnings
    warnings.filterwarnings(
        'ignore',
        message=r'std\(\): degrees of freedom is <= 0',
        category=UserWarning,
    )
    warnings.filterwarnings(
        'ignore',
        message=r'torchcodec is not installed',
        category=UserWarning,
    )

    # PyTorch 2.6+ defaults weights_only=True in torch.load, which blocks
    # pyannote checkpoints that embed custom classes (TorchVersion,
    # Specifications, Problem, etc.).  These are trusted local HF cache files.
    import torch
    import inspect
    if not getattr(torch.load, '_weights_patched', False):
        _orig_load = torch.load
        _load_params = set(inspect.signature(_orig_load).parameters)
        def _load_weights_false(*args, **kwargs):
            if 'weights_only' in _load_params and kwargs.get('weights_only') is not False:
                kwargs['weights_only'] = False
            return _orig_load(*args, **kwargs)
        _load_weights_false._weights_patched = True
        torch.load = _load_weights_false


def get_pipeline():
    global _pipeline
    if _pipeline is None:
        _patch_compat()
        from pyannote.audio import Pipeline
        # Uses local model cache — user must have accepted pyannote license
        hf_token = os.environ.get("HF_TOKEN")
        print(f"[diarize] HF_TOKEN present: {bool(hf_token)}", file=sys.stderr, flush=True)
        # huggingface_hub >= 1.x picks up HF_TOKEN from the environment automatically;
        # use_auth_token and token kwargs were removed in hub 1.x / pyannote 3.x.
        _pipeline = Pipeline.from_pretrained(
            "pyannote/speaker-diarization-3.1",
        )
    return _pipeline


def diarize(payload: dict) -> dict:
    audio_path = payload.get("audio_path")
    num_speakers = payload.get("num_speakers")  # optional hint

    if not audio_path or not os.path.exists(audio_path):
        raise ValueError(f"Audio file not found: {audio_path}")

    pipeline = get_pipeline()

    # Pre-load audio with PyAV (supports .m4a, .wav, etc.) and pass as a
    # waveform dict so pyannote never touches torchcodec / system FFmpeg.
    import av as _av
    import torch

    container = _av.open(audio_path)
    try:
        stream = container.streams.audio[0]
        native_sr = stream.codec_context.sample_rate
        resampler = _av.AudioResampler(format='fltp', layout='mono', rate=native_sr)
        chunks = []
        for frame in container.decode(stream):
            for out_frame in resampler.resample(frame):
                chunks.append(out_frame.to_ndarray())
        for out_frame in resampler.resample(None):  # flush codec buffer
            chunks.append(out_frame.to_ndarray())
    finally:
        container.close()

    audio_np = np.concatenate(chunks, axis=1).astype(np.float32)  # (1, samples)
    audio_input = {"waveform": torch.from_numpy(audio_np), "sample_rate": native_sr}

    kwargs = {}
    if num_speakers:
        kwargs["num_speakers"] = num_speakers

    diarization = pipeline(audio_input, **kwargs)

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
    print(json.dumps({"startup": "ready"}), flush=True)
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
