"""Regression coverage for complete streamed voice replies and speech chunk boundaries."""

from __future__ import annotations

import asyncio
import json
import os
import tempfile
import types
import unittest
from contextlib import contextmanager
from pathlib import Path
from unittest.mock import AsyncMock, patch

from dotenv import dotenv_values

_bootstrap_dir = tempfile.TemporaryDirectory(prefix="arisa-voice-bootstrap-")
_live_api_key = os.getenv("GROQ_API_KEY") or dotenv_values(Path(__file__).resolve().parents[1] / ".env").get("GROQ_API_KEY")
os.environ["DATABASE_PATH"] = str(Path(_bootstrap_dir.name) / "bootstrap.sqlite3")
os.environ["GROQ_API_KEY"] = _live_api_key or "test-key-only"
import main as backend  # noqa: E402


def model_chunk(text: str = "", finish_reason: str | None = None):
    return types.SimpleNamespace(
        choices=[
            types.SimpleNamespace(
                delta=types.SimpleNamespace(content=text, tool_calls=None),
                finish_reason=finish_reason,
            )
        ]
    )


class AsyncStream:
    def __init__(self, chunks, error: Exception | None = None):
        self.chunks = chunks
        self.error = error

    def __aiter__(self):
        self.index = 0
        return self

    async def __anext__(self):
        if self.index < len(self.chunks):
            chunk = self.chunks[self.index]
            self.index += 1
            return chunk
        if self.error:
            error, self.error = self.error, None
            raise error
        raise StopAsyncIteration


class FakeAsyncClient:
    def __init__(self, streams):
        self.streams = list(streams)
        self.requests = []
        self.closed = False
        self.chat = types.SimpleNamespace(
            completions=types.SimpleNamespace(create=self.create_completion)
        )

    async def create_completion(self, **request):
        self.requests.append(request)
        item = self.streams.pop(0)
        if isinstance(item, Exception):
            raise item
        return item

    async def close(self):
        self.closed = True


@contextmanager
def fake_db():
    class Connection:
        def execute(self, *_args):
            return None

    yield Connection()


def collect_events(client, *, user_text="Explain this clearly."):
    async def collect():
        return [
            frame async for frame in backend._stream_voice_reply(
                client,
                model="fake-model",
                messages=[{"role": "user", "content": user_text}],
                user_text=user_text,
                conversation_id="test-conversation",
                action_result=None,
                desktop_mode=False,
                max_tokens=64,
            )
        ]

    with patch.object(backend, "db", fake_db), patch.object(backend, "now", return_value="2026-01-01T00:00:00"):
        frames = asyncio.run(collect())
    events = []
    for frame in frames:
        event_name, payload = frame.split("\n", 1)
        events.append((event_name.removeprefix("event: "), json.loads(payload.removeprefix("data: ").strip())))
    return events


class FakeSyncClient:
    def __init__(self, choices):
        self.choices = list(choices)
        self.requests = []
        self.chat = types.SimpleNamespace(
            completions=types.SimpleNamespace(create=self.create_completion)
        )

    def create_completion(self, **request):
        self.requests.append(request)
        content, finish_reason = self.choices.pop(0)
        return types.SimpleNamespace(
            choices=[
                types.SimpleNamespace(
                    message=types.SimpleNamespace(content=content, tool_calls=None),
                    finish_reason=finish_reason,
                )
            ]
        )


class VoiceGenerationTests(unittest.TestCase):
    def test_only_standalone_authorized_interruption_words_pass_the_gate(self):
        authorized = {
            "STOP": "stop",
            "Stop.": "stop",
            "enough!": "enough",
            "WAIT?": "wait",
            "Stop stop": "stop",
            "WAIT, enough.": "wait",
        }
        rejected = [
            "Hello", "Okay", "Yes", "No", "Really?", "What?", "I understand",
            "Please stop", "Wait a moment", "I said enough", "stoplight", "unclear speech",
        ]
        for phrase, expected in authorized.items():
            with self.subTest(phrase=phrase):
                self.assertEqual(backend.authorized_interruption_keyword(phrase), expected)
        for phrase in rejected:
            with self.subTest(phrase=phrase):
                self.assertIsNone(backend.authorized_interruption_keyword(phrase))

    def test_keyword_requires_confident_speech_recognition_metadata(self):
        confident = types.SimpleNamespace(
            text="STOP.",
            segments=[types.SimpleNamespace(avg_logprob=-0.12, no_speech_prob=0.01)],
        )
        uncertain = types.SimpleNamespace(
            text="wait",
            segments=[types.SimpleNamespace(avg_logprob=-0.72, no_speech_prob=0.03)],
        )
        likely_noise = types.SimpleNamespace(
            text="enough",
            segments=[types.SimpleNamespace(avg_logprob=-0.1, no_speech_prob=0.65)],
        )
        missing_metadata = types.SimpleNamespace(text="wait", segments=[])
        longer_phrase = types.SimpleNamespace(
            text="Wait a minute",
            segments=[types.SimpleNamespace(avg_logprob=-0.1, no_speech_prob=0.02)],
        )
        self.assertEqual(backend.confident_interruption_keyword(confident), "stop")
        for result in (uncertain, likely_noise, missing_metadata, longer_phrase):
            with self.subTest(result=result):
                self.assertIsNone(backend.confident_interruption_keyword(result))

    def test_keyword_endpoint_uses_verbose_recognition_and_returns_only_the_gate_result(self):
        client_instances = []

        class FakeAsyncGroq:
            def __init__(self, **_options):
                self.closed = False
                client_instances.append(self)

            async def close(self):
                self.closed = True

        transcript = types.SimpleNamespace(
            text="Enough!",
            segments=[types.SimpleNamespace(avg_logprob=-0.1, no_speech_prob=0.01)],
        )
        transcribe = AsyncMock(return_value=transcript)
        with (
            patch.dict(os.environ, {"GROQ_API_KEY": "test-key-only"}),
            patch.dict("sys.modules", {"groq": types.SimpleNamespace(AsyncGroq=FakeAsyncGroq)}),
            patch.object(backend, "_transcribe_upload", transcribe),
        ):
            result = asyncio.run(backend.transcribe_interruption_keyword(types.SimpleNamespace()))
        self.assertEqual(result, {"keyword": "enough"})
        self.assertEqual(transcribe.await_args.kwargs["response_format"], "verbose_json")
        self.assertEqual(transcribe.await_args.kwargs["language"], "en")
        self.assertIn("Do not infer", transcribe.await_args.kwargs["prompt"])
        self.assertTrue(client_instances[0].closed)

    def test_short_reply_finishes_and_emits_a_done_event(self):
        reply = "Sure, I can help with that."
        events = collect_events(FakeAsyncClient([AsyncStream([model_chunk(reply, "stop")])]))
        self.assertEqual(events[-1][0], "done")
        self.assertEqual(events[-1][1]["reply"], reply)
        self.assertTrue(any(name == "sentence" for name, _payload in events))

    def test_long_multi_paragraph_reply_is_preserved_and_sent_in_fewer_speech_chunks(self):
        reply = (
            "First, define the goal. Then gather the relevant information. "
            "Next, compare the options and explain their tradeoffs.\n\n"
            "Finally, choose the approach that best fits the constraints. Check the result and revise it if needed."
        )
        events = collect_events(FakeAsyncClient([AsyncStream([model_chunk(reply, "stop")])]))
        sentence_events = [payload["text"] for name, payload in events if name == "sentence"]
        self.assertEqual(events[-1][1]["reply"], reply)
        self.assertLess(len(sentence_events), 5)
        self.assertIn("\n\n", events[-1][1]["reply"])

    def test_length_finish_continues_before_marking_the_reply_done(self):
        client = FakeAsyncClient(
            [
                AsyncStream([model_chunk("The explanation begins clearly. ", "length")]),
                AsyncStream([model_chunk("It now reaches a complete conclusion.", "stop")]),
            ]
        )
        events = collect_events(client)
        self.assertEqual(len(client.requests), 2)
        self.assertIn("Continue the answer", client.requests[1]["messages"][-1]["content"])
        self.assertEqual(events[-1][0], "done")
        self.assertEqual(
            events[-1][1]["reply"],
            "The explanation begins clearly. It now reaches a complete conclusion.",
        )

    def test_nonstream_chat_generation_also_continues_after_a_length_finish(self):
        client = FakeSyncClient(
            [
                ("The answer starts here. ", "length"),
                ("It finishes the thought.", "stop"),
            ]
        )
        reply, action = backend.create_assistant_reply(
            client,
            model="fake-model",
            messages=[{"role": "user", "content": "Explain this."}],
            temperature=0.2,
            max_tokens=8,
        )
        self.assertFalse(action)
        self.assertEqual(reply, "The answer starts here. It finishes the thought.")
        self.assertEqual(len(client.requests), 2)

    def test_nonstream_length_exhaustion_is_explicit_instead_of_silent(self):
        client = FakeSyncClient(
            [("A useful answer starts here.", "length")]
            * (backend.MAX_RESPONSE_CONTINUATIONS + 1)
        )
        reply, _action = backend.create_assistant_reply(
            client,
            model="fake-model",
            messages=[{"role": "user", "content": "Explain this."}],
            temperature=0.2,
            max_tokens=8,
        )
        self.assertTrue(reply.endswith("Please ask me to continue."))

    def test_stream_length_exhaustion_never_speaks_the_cut_off_tail(self):
        streams = [
            AsyncStream([model_chunk("A complete sentence. unfinished thought", "length")]),
            AsyncStream([model_chunk(" unfinished thought", "length")]),
            AsyncStream([model_chunk(" unfinished thought", "length")]),
            AsyncStream([model_chunk(" unfinished thought", "length")]),
        ]
        events = collect_events(FakeAsyncClient(streams))
        self.assertEqual(events[-1][0], "done")
        self.assertNotIn("unfinished thought", events[-1][1]["reply"])
        self.assertIn("Please ask me to continue.", events[-1][1]["reply"])

    def test_interrupted_stream_resumes_instead_of_silently_ending(self):
        client = FakeAsyncClient(
            [
                AsyncStream(
                    [model_chunk("The first part is complete. ")],
                    error=ConnectionError("temporary network interruption"),
                ),
                AsyncStream([model_chunk("The next part completes the answer.", "stop")]),
            ]
        )
        events = collect_events(client)
        self.assertEqual(len(client.requests), 2)
        self.assertEqual(events[-1][0], "done")
        self.assertEqual(
            events[-1][1]["reply"],
            "The first part is complete. The next part completes the answer.",
        )

    def test_periods_do_not_split_abbreviations_and_later_sentences_are_grouped(self):
        text = "Dr. Arisa works in the U.S. She speaks calmly. One sentence. Another sentence. Finished."
        first_boundary = backend._find_voice_sentence_boundary(text)
        self.assertEqual(text[:first_boundary], "Dr. Arisa works in the U.S. She speaks calmly. ")
        second_part = text[first_boundary:]
        grouped_boundary = backend._next_voice_speech_boundary(second_part, has_spoken=True)
        self.assertEqual(second_part[:grouped_boundary], "One sentence. Another sentence. ")

    def test_commas_and_question_marks_are_kept_in_natural_speech_chunks(self):
        reply = "Wait, really? Yes, absolutely. You can do this!"
        events = collect_events(
            FakeAsyncClient([AsyncStream([model_chunk(reply, "stop")])]),
            user_text="Can you help?",
        )
        chunks = [payload["text"] for name, payload in events if name == "sentence"]
        self.assertIn("Wait, really?", chunks[0])
        self.assertIn(",", chunks[1])
        self.assertIn("!", events[-1][1]["reply"])

    def test_repeated_api_failure_is_reported_without_a_false_done_event(self):
        client = FakeAsyncClient([ConnectionError("offline") for _ in range(backend.MAX_RESPONSE_CONTINUATIONS + 1)])
        events = collect_events(client)
        self.assertEqual(events[-1][0], "error")
        self.assertFalse(any(name == "done" for name, _payload in events))
        self.assertTrue(client.closed)


if __name__ == "__main__":
    unittest.main()
