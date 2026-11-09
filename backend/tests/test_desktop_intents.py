"""Coverage for safe desktop-app intent tool dispatch."""

from __future__ import annotations

import json
import os
import tempfile
import types
import unittest
from pathlib import Path
from unittest.mock import patch
from dotenv import dotenv_values

# Import the API with an isolated database so these tests never touch user data.
_bootstrap_dir = tempfile.TemporaryDirectory(prefix="arisa-desktop-bootstrap-")
_live_api_key = os.getenv("GROQ_API_KEY") or dotenv_values(Path(__file__).resolve().parents[1] / ".env").get("GROQ_API_KEY")
os.environ["DATABASE_PATH"] = str(Path(_bootstrap_dir.name) / "bootstrap.sqlite3")
os.environ["GROQ_API_KEY"] = _live_api_key or "test-key-only"
import main as backend  # noqa: E402


class FakeCompletionClient:
    def __init__(self, *, app_id: str | None = None, content: str = ""):
        if app_id is None:
            tool_calls = None
        else:
            tool_calls = [
                types.SimpleNamespace(
                    function=types.SimpleNamespace(
                        name="launch_desktop_application",
                        arguments=json.dumps({"app_id": app_id}),
                    )
                )
            ]
        self.message = types.SimpleNamespace(content=content, tool_calls=tool_calls)
        self.request = None
        self.chat = types.SimpleNamespace(
            completions=types.SimpleNamespace(create=self.create_completion)
        )

    def create_completion(self, **kwargs):
        self.request = kwargs
        return types.SimpleNamespace(
            choices=[types.SimpleNamespace(message=self.message)]
        )


class DesktopIntentTests(unittest.TestCase):
    def setUp(self):
        with backend._desktop_launch_lock:
            backend._desktop_launch_times.clear()

    def test_direct_short_commands_keep_working(self):
        cases = {
            "Open Spotify": "spotify",
            "Arisa, open Google Chrome.": "google_chrome",
            "Open Visual Studio Code": "vs_code",
            "Open File Explorer": "file_explorer",
        }
        for utterance, expected_app in cases.items():
            with self.subTest(utterance=utterance), patch.object(
                backend, "launch_desktop_app", return_value="opened"
            ) as launch:
                self.assertEqual(backend.run_desktop_command(utterance), "opened")
                launch.assert_called_once_with(expected_app)

    def test_natural_language_tool_calls_execute_only_the_selected_app(self):
        cases = [
            ("Can you open my Spotify right now, Arisa?", "spotify"),
            ("Arisa, I want to listen to music. Open Spotify for me.", "spotify"),
            ("I need to browse something. Launch Chrome.", "google_chrome"),
            ("I need to work on my project. Launch VS Code.", "vs_code"),
            ("Could you start Discord for me?", "discord"),
            ("Please open my File Explorer.", "file_explorer"),
            ("I need to check something in Notepad. Can you launch it?", "notepad"),
            ("Can you start my music application?", "spotify"),
        ]
        for utterance, expected_app in cases:
            with self.subTest(utterance=utterance):
                client = FakeCompletionClient(app_id=expected_app)
                with patch.object(
                    backend, "launch_desktop_app", return_value="App opened successfully."
                ) as launch:
                    reply, did_launch = backend.create_assistant_reply(
                        client,
                        model="openai/gpt-oss-20b",
                        messages=[{"role": "user", "content": utterance}],
                        temperature=0.2,
                        max_tokens=80,
                        allow_desktop_actions=True,
                    )
                self.assertEqual(reply, "App opened successfully.")
                self.assertTrue(did_launch)
                launch.assert_called_once_with(expected_app)
                self.assertEqual(client.request["tool_choice"], "auto")
                self.assertEqual(
                    client.request["tools"][0]["function"]["name"],
                    "launch_desktop_application",
                )

    def test_app_mentions_without_a_launch_intent_do_not_execute(self):
        utterance = "Can you tell me whether Spotify has podcasts?"
        client = FakeCompletionClient(content="Yes, Spotify includes podcasts.")
        with patch.object(backend, "launch_desktop_app") as launch:
            reply, did_launch = backend.create_assistant_reply(
                client,
                model="openai/gpt-oss-20b",
                messages=[{"role": "user", "content": utterance}],
                temperature=0.2,
                max_tokens=80,
                allow_desktop_actions=True,
            )
        self.assertEqual(reply, "Yes, Spotify includes podcasts.")
        self.assertFalse(did_launch)
        launch.assert_not_called()

    def test_ambiguous_browser_request_can_be_clarified_without_launching(self):
        # Even a mistaken model choice must not pick between the two browsers.
        client = FakeCompletionClient(app_id="google_chrome")
        with patch.object(backend, "launch_desktop_app") as launch:
            reply, did_launch = backend.create_assistant_reply(
                client,
                model="openai/gpt-oss-20b",
                messages=[{"role": "user", "content": "Could you start my browser?"}],
                temperature=0.2,
                max_tokens=80,
                allow_desktop_actions=True,
            )
        self.assertEqual(reply, "Which browser do you mean, Chrome or Brave?")
        self.assertFalse(did_launch)
        launch.assert_not_called()

    def test_unapproved_tool_arguments_never_reach_the_launcher(self):
        client = FakeCompletionClient(app_id="powershell")
        with patch.object(backend, "launch_desktop_app") as launch:
            reply, did_launch = backend.create_assistant_reply(
                client,
                model="openai/gpt-oss-20b",
                messages=[{"role": "user", "content": "Open PowerShell."}],
                temperature=0.2,
                max_tokens=80,
                allow_desktop_actions=True,
            )
        self.assertIn("Which supported application", reply)
        self.assertFalse(did_launch)
        launch.assert_not_called()

    @unittest.skipUnless(os.name == "nt", "The desktop launcher is Windows-only.")
    def test_repeated_recognition_is_throttled(self):
        with patch.object(backend.webbrowser, "open", return_value=True) as open_browser:
            first = backend.run_desktop_command("Open TikTok")
            second = backend.run_desktop_command("Open TikTok")
        self.assertIn("TikTok is open", first)
        self.assertIn("already opening", second)
        open_browser.assert_called_once()


@unittest.skipUnless(
    os.getenv("ARISA_LIVE_INTENT_TESTS") == "1" and _live_api_key,
    "Set ARISA_LIVE_INTENT_TESTS=1 and configure GROQ_API_KEY to run model integration cases.",
)
class LiveGroqDesktopIntentTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        from groq import Groq
        cls.client = Groq(api_key=_live_api_key)

    def test_real_model_understands_requests_and_rejects_non_requests(self):
        cases = [
            ("Arisa, can you please open my Spotify right now?", "spotify"),
            ("I want to listen to music. Could you start my music app?", "spotify"),
            ("I need to browse something. Bring up Chrome for me.", "google_chrome"),
            ("I need to work on my project. Launch Visual Studio Code.", "vs_code"),
            ("Could you start Discord? I'm joining a call.", "discord"),
            ("Please open my File Explorer.", "file_explorer"),
            ("I need to check something in Notepad. Can you launch it?", "notepad"),
            ("Could you start my browser?", None),
            ("Can you tell me whether Spotify has podcasts?", None),
            ("Don't open Chrome yet; I'm still deciding.", None),
            ("How do I open TikTok on the desktop?", None),
            ("Open Photoshop.", None),
        ]
        for utterance, expected_app in cases:
            with self.subTest(utterance=utterance):
                launched = []

                def simulated_launch(app_id):
                    launched.append(app_id)
                    return f"Simulated launch of {backend.DESKTOP_APPS[app_id]['label']}."

                messages = [
                    {"role": "system", "content": backend.DESKTOP_ACTION_RULE},
                    {"role": "user", "content": utterance},
                ]
                with patch.object(backend, "launch_desktop_app", side_effect=simulated_launch):
                    reply, did_launch = backend.create_assistant_reply(
                        self.client,
                        model="openai/gpt-oss-20b",
                        messages=messages,
                        temperature=0,
                        max_tokens=100,
                        allow_desktop_actions=True,
                    )
                if expected_app is None:
                    self.assertEqual(launched, [], msg=reply)
                    self.assertFalse(did_launch)
                else:
                    self.assertEqual(launched, [expected_app], msg=reply)
                    self.assertTrue(did_launch)


if __name__ == "__main__":
    unittest.main()
