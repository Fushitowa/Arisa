"""Tests for permission gates and bounded computer-use tool orchestration."""

from __future__ import annotations

import json
import os
import tempfile
import types
import unittest
from pathlib import Path
from unittest.mock import patch

from dotenv import dotenv_values

_bootstrap_dir = tempfile.TemporaryDirectory(prefix="arisa-computer-bootstrap-")
_live_api_key = os.getenv("GROQ_API_KEY") or dotenv_values(Path(__file__).resolve().parents[1] / ".env").get("GROQ_API_KEY")
os.environ["DATABASE_PATH"] = str(Path(_bootstrap_dir.name) / "bootstrap.sqlite3")
os.environ["GROQ_API_KEY"] = _live_api_key or "test-key-only"
import main as backend  # noqa: E402
import computer_use  # noqa: E402


def tool_call(name: str, arguments: dict, call_id: str = "call-1"):
    return types.SimpleNamespace(
        id=call_id,
        function=types.SimpleNamespace(name=name, arguments=json.dumps(arguments)),
    )


def completion(content="", calls=None):
    return types.SimpleNamespace(choices=[types.SimpleNamespace(
        message=types.SimpleNamespace(content=content, tool_calls=calls),
    )])


class FakeClient:
    def __init__(self, responses):
        self.responses = list(responses)
        self.requests = []
        self.chat = types.SimpleNamespace(completions=types.SimpleNamespace(create=self.create))

    def create(self, **request):
        self.requests.append(request)
        return self.responses.pop(0)


class ComputerUseTests(unittest.TestCase):
    def test_computer_capability_requires_the_app_session_token(self):
        with tempfile.TemporaryDirectory(prefix="arisa-computer-settings-") as directory:
            settings_path = Path(directory) / "settings.json"
            settings_path.write_text(json.dumps({"computerUseEnabled": True, "screenVisionEnabled": False}), encoding="utf-8")
            with patch.dict(os.environ, {"ARISA_COMPUTER_SESSION_TOKEN": "secret", "ARISA_SETTINGS_FILE": str(settings_path)}):
                self.assertFalse(backend._computer_permissions_valid(None, True, False))
                self.assertFalse(backend._computer_permissions_valid("wrong", True, False))
                self.assertTrue(backend._computer_permissions_valid("secret", True, False))
                self.assertFalse(backend._computer_permissions_valid("secret", False, False))
                self.assertFalse(backend._computer_permissions_valid("secret", True, True))
                settings_path.write_text(json.dumps({"computerUseEnabled": True, "screenVisionEnabled": True}), encoding="utf-8")
                self.assertTrue(backend._computer_permissions_valid("secret", True, True))
                settings_path.write_text(json.dumps({"computerUseEnabled": False, "screenVisionEnabled": True}), encoding="utf-8")
                self.assertFalse(backend._computer_permissions_valid("secret", True, True))

    def test_skill_documents_are_loaded_for_the_skill_architecture(self):
        for skill in ("computer-use", "screen-perception", "web-browser", "text-editor", "spotify-controller"):
            with self.subTest(skill=skill):
                self.assertIn(f"# {skill.replace('-', ' ').title()}", backend.COMPUTER_SKILL_INSTRUCTIONS)
        browser_skills = backend.computer_skill_context("Search Google in Chrome")
        self.assertIn("# Web Browser", browser_skills)
        self.assertNotIn("# Spotify Controller", browser_skills)

    def test_computer_action_gate_requires_a_current_request(self):
        allowed = ["Look at my screen", "What is on my display?", "Type a note in Notepad", "Search Google in Chrome"]
        rejected = ["I opened Chrome yesterday", "How do I open Notepad?", "I use Spotify every day", "Don't click anything"]
        for text in allowed:
            with self.subTest(text=text):
                self.assertTrue(backend.computer_action_is_requested(text))
        for text in rejected:
            with self.subTest(text=text):
                self.assertFalse(backend.computer_action_is_requested(text))

    def test_screen_screenshot_is_rejected_without_explicit_vision_permission(self):
        result, image = backend._execute_computer_tool(
            "observe_screen", json.dumps({"include_screenshot": True}), allow_screenshot=False,
        )
        self.assertIsNone(image)
        self.assertIn("not enabled", json.loads(result)["error"])

    def test_coordinate_click_requires_a_fresh_screenshot(self):
        with patch("computer_use._require_fresh_observation", return_value=object()), patch.dict(
            computer_use._last_observation, {"has_screenshot": False}, clear=False
        ):
            with self.assertRaisesRegex(RuntimeError, "require a screenshot"):
                computer_use.computer_action("click_coordinates", target="100,200")

    def test_opted_in_screenshot_is_sent_to_the_vision_model_only_after_observation(self):
        client = FakeClient([
            completion(calls=[tool_call("observe_screen", {"include_screenshot": True})]),
            completion("The screen shows a Notepad window."),
        ])
        screenshot = "data:image/jpeg;base64,c2NyZWVu"
        with patch("computer_use.observe_screen", return_value={"active_window": "Notepad", "controls": [], "screenshot_data_url": screenshot}):
            reply, _did_act = backend.create_computer_assisted_reply(
                client, model="test-model", messages=[{"role": "user", "content": "Look at my screen."}],
                temperature=0, max_tokens=100, allow_desktop_actions=True,
                allow_computer_use=True, allow_screen_vision=True,
            )
        self.assertEqual(reply, "The screen shows a Notepad window.")
        self.assertEqual(client.requests[1]["model"], "qwen/qwen3.8-27b")
        image_message = next(m for m in client.requests[1]["messages"] if isinstance(m.get("content"), list))
        self.assertEqual(image_message["content"][1]["image_url"]["url"], screenshot)

    def test_tool_loop_observes_before_acting_and_returns_final_model_reply(self):
        client = FakeClient([
            completion(calls=[tool_call("observe_screen", {"include_screenshot": False})]),
            completion(calls=[tool_call("computer_action", {"action": "type_text", "text": "hello"}, "call-2")]),
            completion("I entered the requested text and checked the editor."),
        ])
        with patch("computer_use.observe_screen", return_value={"active_window": "Notepad", "controls": [{"name": "Text Editor"}]}), \
                patch("computer_use.computer_action", return_value={"success": True, "action": "type_text"}) as action:
            reply, did_act = backend.create_computer_assisted_reply(
                client, model="test-model", messages=[{"role": "user", "content": "Type hello into Notepad."}],
                temperature=0, max_tokens=100, allow_desktop_actions=True,
                allow_computer_use=True, allow_screen_vision=False,
            )
        self.assertEqual(reply, "I entered the requested text and checked the editor.")
        self.assertTrue(did_act)
        action.assert_called_once()
        self.assertEqual(len(client.requests), 3)

    def test_same_mutating_action_is_not_repeated_within_a_task(self):
        click = tool_call("computer_action", {"action": "click_control", "target": "Play"})
        client = FakeClient([
            completion(calls=[tool_call("observe_screen", {})]),
            completion(calls=[click]),
            completion(calls=[tool_call("computer_action", {"action": "click_control", "target": "Play"}, "call-3")]),
            completion("I tried that control once and will not click it again."),
        ])
        with patch("computer_use.observe_screen", return_value={"active_window": "Spotify", "controls": []}), \
                patch("computer_use.computer_action", return_value={"success": True}) as action:
            reply, did_act = backend.create_computer_assisted_reply(
                client, model="test-model", messages=[{"role": "user", "content": "Click Play in Spotify."}],
                temperature=0, max_tokens=100, allow_desktop_actions=True,
                allow_computer_use=True, allow_screen_vision=False,
            )
        self.assertTrue(did_act)
        self.assertIn("will not click it again", reply)
        action.assert_called_once()

    def test_cancelled_task_stops_before_another_model_or_desktop_action(self):
        client = FakeClient([])
        with backend._computer_cancel_lock:
            backend._computer_cancelled_tasks.add("cancel-me")
        reply, did_act = backend.create_computer_assisted_reply(
            client, model="test-model", messages=[{"role": "user", "content": "Search the web for Python."}],
            temperature=0, max_tokens=100, allow_desktop_actions=True,
            allow_computer_use=True, allow_screen_vision=False, task_id="cancel-me",
        )
        self.assertIn("stopped", reply)
        self.assertFalse(did_act)
        self.assertEqual(client.requests, [])


if __name__ == "__main__":
    unittest.main()
