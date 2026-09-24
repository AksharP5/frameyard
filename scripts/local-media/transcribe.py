#!/usr/bin/env python3
"""Offline CPU transcription. stdout is the dapi word-timestamp JSON contract."""

import argparse
import hashlib
import importlib.metadata
import json
import math
import os
from pathlib import Path
import sys
import tempfile
from urllib.parse import quote


def model_directory(model: str) -> Path:
    path = Path(model).expanduser()
    if path.is_dir():
        return path.resolve()
    data = Path(os.environ.get("XDG_DATA_HOME", Path.home() / ".local/share"))
    return data / "diffusion-studio/models" / quote(model, safe="")


def cache_key(path: Path, model: Path, language: str, engine_version: str) -> str:
    digest = hashlib.sha256()
    # Version the decoding settings as well as the model and engine. A model
    # replaced in place must not reuse words from its previous weights.
    weights = model / "model.bin"
    stat = weights.stat()
    digest.update(json.dumps([
        "cpu-int8-vad-words-v1", str(model), stat.st_size, stat.st_mtime_ns,
        language, engine_version,
    ]).encode())
    with path.open("rb") as audio:
        for chunk in iter(lambda: audio.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def validate_transcript(value: object) -> dict:
    if not isinstance(value, dict) or not isinstance(value.get("segments"), list):
        raise ValueError("Invalid transcript: expected segments")
    for segment in value["segments"]:
        if not isinstance(segment, dict) or not isinstance(segment.get("text"), str) or not isinstance(segment.get("words"), list):
            raise ValueError("Invalid transcript segment")
        for word in segment["words"]:
            if not isinstance(word, dict) or not isinstance(word.get("text"), str):
                raise ValueError("Invalid transcript word")
            start, end = word.get("start"), word.get("end")
            if any(type(time) not in (int, float) or not math.isfinite(time) for time in (start, end)) or not 0 <= start <= end:
                raise ValueError("Invalid transcript word timestamps")
    return value


def transcribe(path: Path, model: Path, language: str, threads: int) -> dict:
    engine_version = importlib.metadata.version("faster-whisper")
    cache_root = Path(os.environ.get("XDG_CACHE_HOME", Path.home() / ".cache"))
    cache = cache_root / "diffusion-studio/transcripts" / (cache_key(path, model, language, engine_version) + ".json")
    cache.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
    cache.parent.chmod(0o700)
    if cache.exists():
        try:
            return validate_transcript(json.loads(cache.read_text()))
        except (ValueError, TypeError) as error:
            print(f"Ignoring invalid transcript cache {cache}: {error}", file=sys.stderr)

    # No network access during transcription, including tokenizer/model fetches.
    # Setup downloads weights once, without ever receiving the user's media.
    os.environ["HF_HUB_OFFLINE"] = "1"
    os.environ["HF_HUB_DISABLE_TELEMETRY"] = "1"
    from faster_whisper import WhisperModel

    engine = WhisperModel(str(model), device="cpu", compute_type="int8", cpu_threads=threads, local_files_only=True)
    segments, _ = engine.transcribe(
        str(path), language=None if language == "auto" else language,
        word_timestamps=True, vad_filter=True, beam_size=5,
        condition_on_previous_text=False,
    )
    result = validate_transcript({"segments": [
        {"text": segment.text.strip(), "words": [
            {"text": word.word.strip(), "start": round(float(word.start), 3), "end": round(float(word.end), 3)}
            for word in segment.words or [] if word.word.strip()
        ]}
        for segment in segments
    ]})
    with tempfile.NamedTemporaryFile(mode="w", dir=cache.parent, delete=False) as output:
        temporary = Path(output.name)
        json.dump(result, output, ensure_ascii=False, allow_nan=False)
    try:
        temporary.replace(cache)
    finally:
        temporary.unlink(missing_ok=True)
    return result


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("path", type=Path, nargs="?")
    parser.add_argument("--download-model", action="store_true")
    parser.add_argument("--model", default=os.environ.get("DIFFUSION_WHISPER_MODEL", "base"))
    parser.add_argument("--language", default=os.environ.get("DIFFUSION_WHISPER_LANGUAGE", "auto"))
    parser.add_argument("--threads", type=int, default=4)
    args = parser.parse_args()
    model = model_directory(args.model)

    if args.download_model:
        from faster_whisper.utils import download_model
        if not (model / "model.bin").is_file():
            download_model(args.model, output_dir=str(model))
        print(f"Whisper model ready: {model}")
        return

    if args.path is None or not args.path.is_file():
        parser.error("Provide a local audio or video file")
    if args.threads < 1:
        parser.error("--threads must be positive")
    if not (model / "model.bin").is_file():
        raise RuntimeError(f"Whisper model '{args.model}' is not installed. Run bash {Path(__file__).with_name('setup.sh')} to download it.")

    result = transcribe(args.path.resolve(), model, args.language, args.threads)
    print(json.dumps(result, ensure_ascii=False, allow_nan=False))


if __name__ == "__main__":
    try:
        main()
    except ImportError as error:
        sys.exit(f"Local transcription dependency is missing ({error}). Run bash {Path(__file__).with_name('setup.sh')}.")
    except Exception as error:
        sys.exit(f"Local transcription failed: {error}")
