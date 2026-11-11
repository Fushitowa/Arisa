"""Offline Windows wake-word listener. Audio is processed locally with Vosk."""

from __future__ import annotations

import json
import math
import os
import re
import sys
import time
import urllib.request
import uuid
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
DIAGNOSTIC_PREFIX = "ARISA_WAKE_DIAGNOSTIC "


def emit_wake_diagnostic(stage: str, **details) -> None:
    """Write a structured, local-only diagnostic event to the listener's stdout."""
    print(DIAGNOSTIC_PREFIX + json.dumps({"stage": stage, **details}, ensure_ascii=False), flush=True)


def normalize_wake_text(text: str) -> str:
    """Normalize punctuation and capitalization without accepting extra words."""
    words = re.findall(r"[a-z]+", str(text).lower())
    # Small English models occasionally spell the proper name phonetically.
    words = ["arisa" if word == "arissa" else word for word in words]
    normalized = " ".join(words)
    return WAKE_TRANSCRIPT_ALIASES.get(normalized, normalized)


def is_authorized_wake_result(result: dict, min_confidence: float = MIN_WORD_CONFIDENCE) -> bool:
    """Require an exact authorized phrase and confident word-level recognition."""
    return diagnose_wake_result(result, min_confidence)["accepted"]


def diagnose_wake_result(result: dict, min_confidence: float = MIN_WORD_CONFIDENCE) -> dict:
    """Explain why a Vosk final result passed or failed the wake phrase gate."""
    transcript = str(result.get("text", "")).strip()[:180]
    normalized = normalize_wake_text(transcript)
    diagnostic = {
        "transcript": transcript,
        "normalized": normalized,
        "accepted": False,
        "reason": "phrase_not_authorized",
        "required_confidence": min_confidence,
    }
    if not transcript:
        diagnostic["reason"] = "no_speech_recognized"
        return diagnostic
    if normalized not in AUTHORIZED_WAKE_PHRASES:
        return diagnostic

    words = result.get("result")
    if not isinstance(words, list) or not words:
        diagnostic["reason"] = "word_confidence_unavailable"
        return diagnostic
    try:
        confidences = [float(word["conf"]) for word in words]
    except (KeyError, TypeError, ValueError):
        diagnostic["reason"] = "word_confidence_unavailable"
        return diagnostic
    if any(not math.isfinite(confidence) or confidence < 0 or confidence > 1 for confidence in confidences):
        diagnostic["reason"] = "word_confidence_unavailable"
        return diagnostic
    observed_minimum = min(confidences)
    diagnostic["observed_min_confidence"] = round(observed_minimum, 3)
    if observed_minimum < min_confidence:
        diagnostic["reason"] = "confidence_below_threshold"
        return diagnostic
    diagnostic["accepted"] = True
    diagnostic["reason"] = "authorized_phrase"
    return diagnostic


def audio_frame_bytes(audio: object) -> bytes:
    """Convert sounddevice's CFFI-backed raw frame into Vosk-compatible bytes."""
    return bytes(audio)


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


def run_listener(sd, KaldiRecognizer, Model) -> None:
    model = Model(str(ensure_model()))
    recognizer = KaldiRecognizer(model, 16000, json.dumps([*WAKE_GRAMMAR, "[unk]"]))
    recognizer.SetWords(True)
    last_wake = 0.0
    with sd.RawInputStream(samplerate=16000, blocksize=8000, dtype="int16", channels=1) as stream:
        device_name = "Default input device"
        try:
            device_id = stream.device[0] if isinstance(stream.device, (tuple, list)) else stream.device
            device_name = sd.query_devices(device_id, "input")["name"]
        except Exception:
            pass
        emit_wake_diagnostic(
            "listener_ready",
            device_name=str(device_name)[:120],
            sample_rate=16000,
            channels=1,
        )
        print("Wake listener active; listening locally for authorized phrases.", flush=True)
        last_partial = ""
        while True:
            audio, overflowed = stream.read(4000)
            if overflowed:
                emit_wake_diagnostic("audio_overflow", message="The microphone input buffer overflowed; skipped one audio block.")
                continue
            if recognizer.AcceptWaveform(audio_frame_bytes(audio)):
                result = json.loads(recognizer.Result())
                decision = diagnose_wake_result(result)
                if decision["transcript"]:
                    emit_wake_diagnostic("phrase_result", **decision)
                last_partial = ""
                if decision["accepted"] and time.monotonic() - last_wake > 4:
                    last_wake = time.monotonic()
                    request_id = uuid.uuid4().hex
                    emit_wake_diagnostic(
                        "wake_request_sending",
                        request_id=request_id,
                        transcript=decision["transcript"],
                    )
                    request = urllib.request.Request(
                        "http://127.0.0.1:8765/wake",
                        data=json.dumps({"request_id": request_id, "transcript": decision["transcript"]}).encode("utf-8"),
                        headers={"Content-Type": "application/json"},
                        method="POST",
                    )
                    try:
                        with urllib.request.urlopen(request, timeout=2) as response:
                            emit_wake_diagnostic(
                                "wake_request_response",
                                request_id=request_id,
                                status_code=response.status,
                            )
                    except OSError as exc:
                        emit_wake_diagnostic(
                            "wake_request_failed",
                            request_id=request_id,
                            error=f"{type(exc).__name__}: {str(exc)[:180]}",
                        )
                        print(f"Could not notify the desktop app: {exc}", file=sys.stderr, flush=True)
            else:
                try:
                    partial = json.loads(recognizer.PartialResult()).get("partial", "").strip()
                except (AttributeError, TypeError, ValueError):
                    partial = ""
                if partial and partial != last_partial:
                    last_partial = partial
                    emit_wake_diagnostic("partial_transcript", transcript=partial[:180])


def main() -> None:
    try:
        import sounddevice as sd
        from vosk import KaldiRecognizer, Model
    except ImportError as exc:
        print(f"Wake listener dependencies are missing: {exc}", file=sys.stderr, flush=True)
        raise SystemExit(2)

    try:
        run_listener(sd, KaldiRecognizer, Model)
    except Exception as exc:
        print(f"Wake listener failed: {type(exc).__name__}: {exc}", file=sys.stderr, flush=True)
        raise SystemExit(1) from exc


if __name__ == "__main__":
    main()
