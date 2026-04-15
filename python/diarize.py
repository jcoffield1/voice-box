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


def _patch_compat():
    """
    Patch incompatibilities between pyannote 3.x and newer library versions.

    1. torchaudio 2.x removed AudioMetaData, info(), and list_audio_backends()
       which pyannote 3.x references at import time.

    2. huggingface_hub 1.x removed the `use_auth_token` kwarg from hf_hub_download
       and related functions. pyannote 3.x still passes it. We wrap the hub
       functions to remap `use_auth_token` -> `token` transparently.

    3. PyTorch raises a UserWarning when pyannote's SpeakerEmbedding pooling
       computes std() on segments that are too short (single frame → ddof==0).
       This is harmless — pyannote falls back to zero variance — so suppress it.
    """
    import warnings
    warnings.filterwarnings(
        'ignore',
        message=r'std\(\): degrees of freedom is <= 0',
        category=UserWarning,
    )

    import torchaudio
    import soundfile as sf
    import torch
    import numpy as np

    # torchaudio 2.11 replaced all audio I/O with torchcodec (requires FFmpeg).
    # Replace torchaudio.load with a soundfile-based implementation that returns
    # the same (waveform_tensor, sample_rate) tuple pyannote expects.
    if not getattr(torchaudio.load, '_sf_patched', False):
        def _sf_load(path, frame_offset=0, num_frames=-1, normalize=True, channels_first=True, format=None, backend=None):
            data, sr = sf.read(str(path), dtype='float32', always_2d=True)
            # soundfile returns (frames, channels); pyannote expects (channels, frames)
            waveform = torch.from_numpy(data.T if channels_first else data)
            if frame_offset > 0 or num_frames != -1:
                end = None if num_frames == -1 else frame_offset + num_frames
                waveform = waveform[:, frame_offset:end]
            return waveform, sr
        _sf_load._sf_patched = True
        torchaudio.load = _sf_load

    if not hasattr(torchaudio, 'AudioMetaData'):
        from dataclasses import dataclass

        @dataclass
        class _AudioMetaData:
            sample_rate: int
            num_frames: int
            num_channels: int
            bits_per_sample: int
            encoding: str

        torchaudio.AudioMetaData = _AudioMetaData

    if not hasattr(torchaudio, 'info'):
        def _info(path, backend=None):
            info = sf.info(str(path))
            return torchaudio.AudioMetaData(
                sample_rate=info.samplerate,
                num_frames=info.frames,
                num_channels=info.channels,
                bits_per_sample=16,
                encoding='PCM_S',
            )
        torchaudio.info = _info

    if not hasattr(torchaudio, 'list_audio_backends'):
        torchaudio.list_audio_backends = lambda: ['soundfile']

    # PyTorch 2.6+ defaults weights_only=True in torch.load, which blocks
    # pyannote checkpoints that embed custom classes (TorchVersion,
    # Specifications, Problem, etc.). Rather than allowlisting each class
    # individually, patch torch.load to default weights_only=False.
    # These are trusted HuggingFace model files cached locally.
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

    # Remap use_auth_token -> token for all huggingface_hub download functions.
    import huggingface_hub
    import functools

    def _remap_auth_token(fn):
        @functools.wraps(fn)
        def wrapper(*args, **kwargs):
            if 'use_auth_token' in kwargs:
                token = kwargs.pop('use_auth_token')
                kwargs.setdefault('token', token)
            return fn(*args, **kwargs)
        return wrapper

    for _fn_name in ('hf_hub_download', 'snapshot_download', 'model_info'):
        _fn = getattr(huggingface_hub, _fn_name, None)
        if _fn and not getattr(_fn, '_auth_patched', False):
            _wrapped = _remap_auth_token(_fn)
            _wrapped._auth_patched = True
            setattr(huggingface_hub, _fn_name, _wrapped)


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

    # Pre-load audio with torchaudio so pyannote never calls torchcodec
    import torchaudio
    waveform, sample_rate = torchaudio.load(audio_path)
    audio_input = {"waveform": waveform, "sample_rate": sample_rate}

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
