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
    recognizer = KaldiRecognizer(model, 16000, json.dumps(["arisa", "[unk]"]))
    recognizer.SetWords(False)
    print("Waiting locally for the wake word Arisa.", flush=True)
    last_wake = 0.0
    with sd.RawInputStream(samplerate=16000, blocksize=8000, dtype="int16", channels=1) as stream:
        while True:
            audio, overflowed = stream.read(4000)
            if overflowed:
                continue
            if recognizer.AcceptWaveform(audio):
                text = json.loads(recognizer.Result()).get("text", "")
                normalized = re.sub(r"[^a-z\s]", " ", text.lower())
                if re.search(r"\bari(?:sa|ssa)\b", normalized) and time.monotonic() - last_wake > 4:
                    last_wake = time.monotonic()
                    request = urllib.request.Request("http://127.0.0.1:8765/wake", data=b"{}", method="POST")
                    try:
                        urllib.request.urlopen(request, timeout=2).close()
                    except OSError:
                        pass


if __name__ == "__main__":
    main()
