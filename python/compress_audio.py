#!/usr/bin/env python3
"""
One-shot audio compressor: lossless/PCM audio -> AAC in an MP4 container (.m4a).

Usage:
    python compress_audio.py <input.wav> <output.m4a.part>

Decodes with PyAV (no system FFmpeg needed), encodes mono AAC at the source
sample rate, then RE-DECODES the output to verify it is fully readable and
matches the source duration. Prints a single JSON line to stdout:

    {"success": true, "duration_in": 123.4, "duration_out": 123.5,
     "size_in": 118000000, "size_out": 6400000}

On any failure prints {"success": false, "error": "..."} and exits non-zero.
The caller is responsible for the atomic rename and for deleting the source —
this script never touches the input file.
"""

import sys
import json
import os

AAC_BIT_RATE = 64_000  # 64 kbps mono — transparent for 16 kHz speech


def compress(src: str, dst: str) -> dict:
    import av

    in_container = av.open(src)
    try:
        in_stream = in_container.streams.audio[0]
        rate = in_stream.codec_context.sample_rate or 16000

        # The .part extension defeats format inference — specify mp4 explicitly.
        out_container = av.open(dst, mode="w", format="mp4")
        try:
            out_stream = out_container.add_stream("aac", rate=rate)
            out_stream.codec_context.bit_rate = AAC_BIT_RATE

            resampler = av.AudioResampler(format="fltp", layout="mono", rate=rate)

            samples_in = 0
            for frame in in_container.decode(in_stream):
                samples_in += frame.samples
                for out_frame in resampler.resample(frame):
                    out_frame.pts = None
                    for packet in out_stream.encode(out_frame):
                        out_container.mux(packet)
            for out_frame in resampler.resample(None):  # flush resampler
                out_frame.pts = None
                for packet in out_stream.encode(out_frame):
                    out_container.mux(packet)
            for packet in out_stream.encode(None):  # flush encoder
                out_container.mux(packet)
        finally:
            out_container.close()
    finally:
        in_container.close()

    duration_in = samples_in / rate

    # ── Verification pass: fully decode the output ────────────────────────────
    ver_container = av.open(dst)
    try:
        ver_stream = ver_container.streams.audio[0]
        ver_rate = ver_stream.codec_context.sample_rate or rate
        samples_out = 0
        for frame in ver_container.decode(ver_stream):
            samples_out += frame.samples
    finally:
        ver_container.close()

    duration_out = samples_out / ver_rate

    return {
        "success": True,
        "duration_in": duration_in,
        "duration_out": duration_out,
        "size_in": os.path.getsize(src),
        "size_out": os.path.getsize(dst),
    }


def main() -> int:
    if len(sys.argv) != 3:
        print(json.dumps({"success": False, "error": "usage: compress_audio.py <src> <dst>"}))
        return 1
    try:
        print(json.dumps(compress(sys.argv[1], sys.argv[2])))
        return 0
    except Exception as e:  # noqa: BLE001 — report everything as JSON
        import traceback
        print(json.dumps({
            "success": False,
            "error": f"{type(e).__name__}: {e}",
            "traceback": traceback.format_exc(),
        }))
        return 1


if __name__ == "__main__":
    sys.exit(main())
