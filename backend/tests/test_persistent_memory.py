"""Isolated regression coverage for Arisa's persistent memory context."""

from __future__ import annotations

import importlib
import os
import sys
import tempfile
import types
import unittest
from pathlib import Path
from unittest.mock import patch

# Avoid loading or changing the developer's real SQLite database at import time.
_bootstrap_dir = tempfile.TemporaryDirectory(prefix="arisa-memory-bootstrap-")
os.environ["DATABASE_PATH"] = str(Path(_bootstrap_dir.name) / "bootstrap.sqlite3")
os.environ["GROQ_API_KEY"] = "test-key-only"
import main as backend  # noqa: E402


captured_system_prompts: list[str] = []


class FakeGroq:
    def __init__(self, api_key: str):
        self.audio = types.SimpleNamespace(
            transcriptions=types.SimpleNamespace(create=self.transcribe)
        )
        self.chat = types.SimpleNamespace(
            completions=types.SimpleNamespace(create=self.create_completion)
        )

    def create_completion(self, **kwargs):
        captured_system_prompts.append(kwargs["messages"][0]["content"])
        question = kwargs["messages"][-1]["content"].lower()
        answer = "I was created by Ken." if "who created" in question else "I’ll remember that."
        return types.SimpleNamespace(
            choices=[types.SimpleNamespace(message=types.SimpleNamespace(content=answer))]
        )

    def transcribe(self, **kwargs):
        return "Who created you?"


class PersistentMemoryTests(unittest.TestCase):
    def setUp(self):
        self.temp_dir = tempfile.TemporaryDirectory(prefix="arisa-memory-test-")
        os.environ["DATABASE_PATH"] = str(Path(self.temp_dir.name) / "arisa.sqlite3")
        backend = importlib.reload(sys.modules["main"])
        self.backend = backend
        captured_system_prompts.clear()
        self.groq_patch = patch.dict(sys.modules, {"groq": types.SimpleNamespace(Groq=FakeGroq)})
        self.groq_patch.start()

    def tearDown(self):
        self.groq_patch.stop()
        self.temp_dir.cleanup()

    def test_creator_and_saved_memory_survive_backend_reload(self):
        creator = self.backend.get_creator_identity()
        self.assertEqual(creator["name"], "Ken")
        self.assertEqual(creator["role"], "Creator and lead developer")

        response = self.backend.chat(self.backend.ChatRequest(message="Who created you?"))
        self.assertEqual(response["reply"], "I was created by Ken.")
        self.assertIn("Ken", captured_system_prompts[-1])

        self.backend.chat(
            self.backend.ChatRequest(message="Remember that my favorite color is blue.")
        )
        memory = next(
            item for item in self.backend.list_memories() if "favorite color" in item["content"].lower()
        )
        self.backend.update_memory(
            memory["id"], self.backend.MemoryRequest(content="My favorite color is deep blue.")
        )

        # Simulate application restart: initialize the same SQLite file again.
        self.backend = importlib.reload(self.backend)
        self.assertEqual(self.backend.get_creator_identity()["name"], "Ken")
        self.assertIn("used only by Ken", self.backend.get_creator_identity()["details"])
        self.assertTrue(
            any(item["content"] == "My favorite color is deep blue." for item in self.backend.list_memories())
        )

        new_conversation = self.backend.chat(
            self.backend.ChatRequest(message="Who created you?")
        )
        self.assertEqual(new_conversation["reply"], "I was created by Ken.")
        self.assertIn("creator", captured_system_prompts[-1].lower())
        self.assertIn("current user", captured_system_prompts[-1].lower())
        self.assertIn("only user", captured_system_prompts[-1].lower())

        self.backend.chat(self.backend.ChatRequest(message="What is my favorite color?"))
        self.assertIn("deep blue", captured_system_prompts[-1])

    def test_voice_prompt_uses_persistent_creator_identity(self):
        with self.backend.db() as conn:
            context = self.backend.voice_system_context(conn, "Who created you?")
        self.assertIn("Ken", context)
        self.assertIn("creator", context.lower())
        self.assertIn("current user", context.lower())
        self.assertIn(self.backend.MEMORY_TRUTH_RULE, context)

    def test_personal_memory_can_be_updated_and_deleted(self):
        item = self.backend.create_memory(self.backend.MemoryRequest(content="Ken prefers concise replies."))
        changed = self.backend.update_memory(
            item["id"], self.backend.MemoryRequest(content="Ken prefers concise, clear replies.")
        )
        self.assertEqual(changed["content"], "Ken prefers concise, clear replies.")
        self.assertTrue(self.backend.delete_memory(item["id"])["deleted"])
        self.assertFalse(any(memory["id"] == item["id"] for memory in self.backend.list_memories()))
        self.assertEqual(self.backend.get_creator_identity()["name"], "Ken")


if __name__ == "__main__":
    unittest.main()
