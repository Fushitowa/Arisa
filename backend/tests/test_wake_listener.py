import unittest
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from wake_listener import AUTHORIZED_WAKE_PHRASES, audio_frame_bytes, is_authorized_wake_result, normalize_wake_text


def result(text, confidence=0.9):
    words = normalize_wake_text(text).split()
    return {
        "text": text,
        "result": [{"word": word, "conf": confidence} for word in words],
    }


class WakePhraseTests(unittest.TestCase):
    def test_audio_frames_are_converted_to_vosk_compatible_bytes(self):
        self.assertEqual(audio_frame_bytes(bytearray(b"pcm")), b"pcm")
        self.assertEqual(audio_frame_bytes(memoryview(b"pcm")), b"pcm")

    def test_only_three_authorized_phrases_are_configured(self):
        self.assertEqual(AUTHORIZED_WAKE_PHRASES, {
            "wake up arisa",
            "arisa open",
            "i need you arisa",
        })

    def test_authorized_phrases_match_case_and_punctuation_variations(self):
        phrases = [
            "Wake up Arisa!",
            "ARISA, OPEN.",
            "I need you, Arisa.",
        ]
        for phrase in phrases:
            with self.subTest(phrase=phrase):
                self.assertTrue(is_authorized_wake_result(result(phrase)))

    def test_phonetic_spelling_of_arisa_is_normalized(self):
        self.assertTrue(is_authorized_wake_result(result("Wake up Arissa")))
        for recognized in ("Wake up or issa", "A recent open", "I need you or risa"):
            with self.subTest(recognized=recognized):
                self.assertTrue(is_authorized_wake_result(result(recognized)))

    def test_unrelated_or_extra_words_do_not_activate(self):
        phrases = [
            "Hello Arisa",
            "Hey",
            "Arisa",
            "Please wake up Arisa",
            "I think I need you Arisa",
            "Wake up Arisa please",
            "A recent movie opened",
        ]
        for phrase in phrases:
            with self.subTest(phrase=phrase):
                self.assertFalse(is_authorized_wake_result(result(phrase)))

    def test_uncertain_or_missing_word_confidence_does_not_activate(self):
        self.assertFalse(is_authorized_wake_result(result("Wake up Arisa", 0.54)))
        self.assertFalse(is_authorized_wake_result({"text": "Wake up Arisa"}))
        self.assertFalse(is_authorized_wake_result({
            "text": "Wake up Arisa",
            "result": [{"word": "wake", "conf": 0.9}, {"word": "up"}, {"word": "arisa", "conf": 0.9}],
        }))


if __name__ == "__main__":
    unittest.main()
