"""Offline Windows wake-word listener. Audio is processed locally with Vosk."""

from __future__ import annotations

import json
import os
import re
import sys
import time
import urllib.request
import zipfile
from pathlib import Path

MODEL_NAME = "vosk-model-small-en-us-0.15"
MODEL_URL = f"https://alphacephei.com/vosk/models/{MODEL_NAME}.zip"
MODEL_DIR = Path(os.getenv("ARISA_WAKE_MODEL_DIR", str(Path.home() / ".arisa-ai" / "wake-model")))
AUTHORIZED_WAKE_PHRASES = frozenset({
    "wake up arisa",
    "arisa open",
    "i need you arisa",
})
WAKE_TRANSCRIPT_ALIASES = {
    # The bundled English model lacks "Arisa" in its lexicon. These are the
    # exact word sequences it produced when tested with locally synthesized speech.
    "wake up or issa": "wake up arisa",
    "a recent open": "arisa open",
    "i need you or risa": "i need you arisa",
}
WAKE_GRAMMAR = sorted(AUTHORIZED_WAKE_PHRASES | WAKE_TRANSCRIPT_ALIASES.keys())
MIN_WORD_CONFIDENCE = 0.55


def normalize_wake_text(text: str) -> str:
    """Normalize punctuation and capitalization without accepting extra words."""
    words = re.findall(r"[a-z]+", str(text).lower())
    # Small English models occasionally spell the proper name phonetically.
    words = ["arisa" if word == "arissa" else word for word in words]
    normalized = " ".join(words)
    return WAKE_TRANSCRIPT_ALIASES.get(normalized, normalized)


def is_authorized_wake_result(result: dict, min_confidence: float = MIN_WORD_CONFIDENCE) -> bool:
    """Require an exact authorized phrase and confident word-level recognition."""
    if normalize_wake_text(result.get("text", "")) not in AUTHORIZED_WAKE_PHRASES:
        return False
    words = result.get("result")
    if not isinstance(words, list) or not words:
        return False
    try:
        return all(float(word["conf"]) >= min_confidence for word in words)
    except (KeyError, TypeError, ValueError):
        return False


def ensure_model() -> Path:
    model_path = MODEL_DIR / MODEL_NAME
    if (model_path / "am").is_dir():
        return model_path

    MODEL_DIR.mkdir(parents=True, exist_ok=True)
    archive = MODEL_DIR / f"{MODEL_NAME}.zip"

    def is_complete_zip(candidate: Path) -> bool:
        try:
            with zipfile.ZipFile(candidate) as bundle:
                has_model_files = any(name.startswith(f"{MODEL_NAME}/am/") for name in bundle.namelist())
                return has_model_files and bundle.testzip() is None
        except (OSError, zipfile.BadZipFile):
            return False

    # Downloads are staged and validated before replacing the final archive so
    # a cancelled/interrupted download cannot poison every later launch.
    if archive.exists() and not is_complete_zip(archive):
        archive.unlink()
    if not archive.exists():
        temporary = archive.with_suffix(".zip.part")
        temporary.unlink(missing_ok=True)
        print("Downloading the offline English wake-word model…", flush=True)
        try:
            urllib.request.urlretrieve(MODEL_URL, temporary)
            if not is_complete_zip(temporary):
                raise zipfile.BadZipFile("The downloaded wake-word model archive is incomplete")
            temporary.replace(archive)
        finally:
            temporary.unlink(missing_ok=True)

    with zipfile.ZipFile(archive) as bundle:
        root = MODEL_DIR.resolve()
        for member in bundle.infolist():
            target = (MODEL_DIR / member.filename).resolve()
            if root not in target.parents and target != root:
                raise ValueError("Unexpected path in the wake-word model archive")
        bundle.extractall(MODEL_DIR)
    return model_path


def main() -> None:
    try:
        import sounddevice as sd
        from vosk import KaldiRecognizer, Model
    except ImportError as exc:
        print(f"Wake listener dependencies are missing: {exc}", file=sys.stderr)
        raise SystemExit(2)

    model = Model(str(ensure_model()))
    recognizer = KaldiRecognizer(model, 16000, json.dumps([*WAKE_GRAMMAR, "[unk]"]))
    recognizer.SetWords(True)
    print("Waiting locally for an authorized Arisa wake phrase.", flush=True)
    last_wake = 0.0
    with sd.RawInputStream(samplerate=16000, blocksize=8000, dtype="int16", channels=1) as stream:
        while True:
            audio, overflowed = stream.read(4000)
            if overflowed:
                continue
            if recognizer.AcceptWaveform(audio):
                result = json.loads(recognizer.Result())
                if is_authorized_wake_result(result) and time.monotonic() - last_wake > 4:
                    last_wake = time.monotonic()
                    request = urllib.request.Request("http://127.0.0.1:8765/wake", data=b"{}", method="POST")
                    try:
                        urllib.request.urlopen(request, timeout=2).close()
                    except OSError as exc:
                        print(f"Could not notify the desktop app: {exc}", file=sys.stderr, flush=True)


if __name__ == "__main__":
    main()
