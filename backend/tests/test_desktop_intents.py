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
    def __init__(self, *, app_id: str | None = None, action: str = "open", content: str = ""):
        if app_id is None:
            tool_calls = None
        else:
            tool_calls = [
                types.SimpleNamespace(
                    function=types.SimpleNamespace(
                        name="manage_desktop_application",
                        arguments=json.dumps({"action": action, "app_id": app_id}),
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
        with backend._desktop_response_lock:
            backend._desktop_last_responses.clear()

    def test_direct_short_commands_keep_working(self):
        cases = {
            "Open Spotify": "spotify",
            "Arisa, open Google Chrome.": "google_chrome",
            "Open Visual Studio Code": "vs_code",
            "Open File Explorer": "file_explorer",
        }
        for utterance, expected_app in cases.items():
            with self.subTest(utterance=utterance), patch.object(
                backend, "manage_desktop_app", return_value="opened"
            ) as launch:
                self.assertEqual(backend.run_desktop_command(utterance), "opened")
                launch.assert_called_once_with("open", expected_app)

    def test_direct_open_and_close_commands_use_same_registered_aliases(self):
        cases = [
            ("Open Spotify", "open", "spotify"),
            ("Open my music app", "open", "spotify"),
            ("Please launch Google Chrome for me.", "open", "google_chrome"),
            ("Arisa, close VS Code.", "close", "vs_code"),
            ("Could you exit my browser", "close", None),
            ("Shut down Steam", "close", "steam"),
        ]
        for utterance, expected_action, expected_app in cases:
            with self.subTest(utterance=utterance):
                if expected_app is None:
                    self.assertIsNone(backend.run_desktop_command(utterance))
                    continue
                with patch.object(backend, "manage_desktop_app", return_value="handled") as manage:
                    self.assertEqual(backend.run_desktop_command(utterance), "handled")
                manage.assert_called_once_with(expected_action, expected_app)

    def test_app_mentions_and_information_questions_are_not_action_intents(self):
        for utterance in (
            "I like Spotify.",
            "What can you open?",
            "How do I close Chrome?",
            "Don't open Steam.",
            "I closed Spotify yesterday.",
        ):
            with self.subTest(utterance=utterance):
                self.assertIsNone(backend.run_desktop_command(utterance))
        self.assertFalse(backend.desktop_action_is_requested("I like Spotify.", "open"))
        self.assertFalse(backend.desktop_action_is_requested("What apps can you open?", "open"))
        self.assertFalse(backend.desktop_action_is_requested("Don't open Steam.", "open"))
        self.assertFalse(backend.desktop_action_is_requested("I can open Spotify, but I am only discussing it.", "open"))
        self.assertFalse(backend.desktop_action_is_requested("How do I close Chrome?", "close"))
        self.assertTrue(backend.desktop_action_is_requested("Please close Spotify.", "close"))
        self.assertTrue(backend.desktop_action_is_requested("Would you mind closing Spotify?", "close"))
        self.assertTrue(backend.desktop_action_is_requested("I don't need Spotify anymore. Close it.", "close"))

    def test_skill_file_is_loaded_into_desktop_system_context(self):
        self.assertTrue(backend.DESKTOP_SKILL_INSTRUCTIONS)
        self.assertIn("Desktop Application Controller", backend.DESKTOP_SKILL_INSTRUCTIONS)
        self.assertIn("Desktop Application Controller", backend.desktop_skill_context())

    def test_close_sends_graceful_close_messages_and_verifies_windows(self):
        with patch.object(backend.os, "name", "nt"), \
             patch.object(backend, "_desktop_app_windows", side_effect=[[123, 456], []]), \
             patch.object(backend, "_request_window_close", return_value=True) as request_close, \
             patch.object(backend.time, "sleep"):
            reply = backend.close_desktop_app("spotify")
        self.assertIn("Spotify", reply)
        self.assertIn("closed", reply)
        self.assertEqual(request_close.call_args_list, [unittest.mock.call(123), unittest.mock.call(456)])

    def test_close_reports_not_running_without_sending_close_message(self):
        with patch.object(backend.os, "name", "nt"), \
             patch.object(backend, "_desktop_app_windows", return_value=[]), \
             patch.object(backend, "_wait_for_desktop_process", return_value=False), \
             patch.object(backend, "_request_window_close") as request_close:
            reply = backend.close_desktop_app("discord")
        self.assertIn("Discord", reply)
        self.assertTrue("isn’t running" in reply or "already closed" in reply or "don’t see" in reply)
        request_close.assert_not_called()

    def test_close_never_touches_browser_for_tiktok(self):
        with patch.object(backend, "_desktop_app_windows") as inspect_windows:
            reply = backend.close_desktop_app("tiktok")
        self.assertIn("TikTok", reply)
        self.assertIn("safely", reply)
        self.assertIn("browser page", reply)
        inspect_windows.assert_not_called()

    def test_untrusted_tool_arguments_are_type_checked(self):
        self.assertIn("supported desktop app list", backend.manage_desktop_app("close", []))
        self.assertIn("open or close", backend.manage_desktop_app({}, "spotify"))

    def test_close_failure_is_reported_without_force_termination(self):
        with patch.object(backend.os, "name", "nt"), \
             patch.object(backend, "_desktop_app_windows", side_effect=[[789], [789]]), \
             patch.object(backend, "_request_window_close", return_value=True), \
             patch.object(backend.time, "monotonic", side_effect=[0.0, 4.0]):
            reply = backend.close_desktop_app("notepad")
        self.assertIn("unsaved-changes prompt", reply)

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
                    backend, "manage_desktop_app", return_value="App opened successfully."
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
                launch.assert_called_once_with("open", expected_app)
                self.assertEqual(client.request["tool_choice"], "auto")
                self.assertEqual(
                    client.request["tools"][0]["function"]["name"],
                    "manage_desktop_application",
                )

    def test_natural_language_close_requests_call_graceful_close_tool(self):
        cases = [
            ("Arisa, close Spotify for me.", "spotify"),
            ("Could you exit Google Chrome?", "google_chrome"),
            ("I don't need Discord anymore. Please close it.", "discord"),
            ("I want Visual Studio Code closed.", "vs_code"),
        ]
        for utterance, expected_app in cases:
            with self.subTest(utterance=utterance):
                client = FakeCompletionClient(app_id=expected_app, action="close")
                with patch.object(backend, "manage_desktop_app", return_value=f"Closed {expected_app}.") as manage:
                    reply, did_action = backend.create_assistant_reply(
                        client,
                        model="openai/gpt-oss-20b",
                        messages=[{"role": "user", "content": utterance}],
                        temperature=0,
                        max_tokens=80,
                        allow_desktop_actions=True,
                    )
                self.assertEqual(reply, f"Closed {expected_app}.")
                self.assertTrue(did_action)
                manage.assert_called_once_with("close", expected_app)

    def test_streamed_voice_tool_supports_close_requests(self):
        calls = {
            0: {
                "function": {
                    "name": "manage_desktop_application",
                    "arguments": json.dumps({"action": "close", "app_id": "discord"}),
                }
            }
        }
        with patch.object(backend, "manage_desktop_app", return_value="The visible Discord window(s) are closed.") as manage:
            reply, did_action = backend._execute_streamed_desktop_tools(calls, "Arisa, close Discord.")
        self.assertEqual(reply, "The visible Discord window(s) are closed.")
        self.assertTrue(did_action)
        manage.assert_called_once_with("close", "discord")

    def test_close_browser_request_is_clarified_before_tool_execution(self):
        client = FakeCompletionClient(app_id="google_chrome", action="close")
        with patch.object(backend, "manage_desktop_app") as manage:
            reply, did_action = backend.create_assistant_reply(
                client,
                model="openai/gpt-oss-20b",
                messages=[{"role": "user", "content": "Could you close my browser?"}],
                temperature=0,
                max_tokens=80,
                allow_desktop_actions=True,
            )
        self.assertEqual(reply, "Which browser do you mean, Chrome or Brave?")
        self.assertFalse(did_action)
        manage.assert_not_called()

    def test_model_tool_call_without_clear_open_or_close_intent_is_rejected(self):
        client = FakeCompletionClient(app_id="spotify", action="close")
        with patch.object(backend, "manage_desktop_app") as manage:
            reply, did_action = backend.create_assistant_reply(
                client,
                model="openai/gpt-oss-20b",
                messages=[{"role": "user", "content": "I listen to Spotify every day."}],
                temperature=0,
                max_tokens=80,
                allow_desktop_actions=True,
            )
        self.assertIn("haven't changed anything", reply)
        self.assertFalse(did_action)
        manage.assert_not_called()

    def test_app_mentions_without_a_launch_intent_do_not_execute(self):
        utterance = "Can you tell me whether Spotify has podcasts?"
        client = FakeCompletionClient(content="Yes, Spotify includes podcasts.")
        with patch.object(backend, "manage_desktop_app") as launch:
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
        with patch.object(backend, "manage_desktop_app") as launch:
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
        with patch.object(backend, "manage_desktop_app") as launch:
            reply, did_launch = backend.create_assistant_reply(
                client,
                model="openai/gpt-oss-20b",
                messages=[{"role": "user", "content": "Open PowerShell."}],
                temperature=0.2,
                max_tokens=80,
                allow_desktop_actions=True,
            )
        self.assertIn("supported desktop app list", reply)
        self.assertFalse(did_launch)
        launch.assert_not_called()

    @unittest.skipUnless(os.name == "nt", "The desktop launcher is Windows-only.")
    def test_repeated_recognition_is_throttled(self):
        with patch.object(backend.webbrowser, "open", return_value=True) as open_browser:
            first = backend.run_desktop_command("Open TikTok")
            second = backend.run_desktop_command("Open TikTok")
        self.assertIn("TikTok", first)
        self.assertIn("browser", first)
        self.assertTrue("opening" in second or "bringing" in second)
        open_browser.assert_called_once()

    def test_action_response_variants_do_not_repeat_consecutively(self):
        for outcome, label, detail in (
            ("opened", "Spotify", ""),
            ("opened_browser", "TikTok", ""),
            ("closed", "Spotify", ""),
            ("already_open", "Chrome", ""),
            ("already_closed", "Discord", ""),
            ("open_failed", "Steam", "I couldn’t find it installed."),
            ("close_failed", "Notepad", "It may still be open."),
            ("close_unavailable", "TikTok", "It’s a browser page."),
        ):
            with self.subTest(outcome=outcome):
                replies = [backend.desktop_action_response(outcome, label, detail) for _ in range(8)]
                self.assertTrue(all(reply and label in reply for reply in replies))
                self.assertTrue(all(left != right for left, right in zip(replies, replies[1:])))

    @unittest.skipUnless(os.name == "nt", "The desktop launcher is Windows-only.")
    def test_opening_an_already_running_app_does_not_launch_another_instance(self):
        with patch.object(backend, "_desktop_process_is_running", return_value=True), \
             patch.object(backend, "_spawn_desktop_app") as spawn_app:
            reply = backend.launch_desktop_app("spotify")
        self.assertIn("Spotify", reply)
        self.assertIn("already", reply)
        spawn_app.assert_not_called()


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

                def simulated_launch(action, app_id):
                    if action != "open":
                        return f"Simulated close of {backend.DESKTOP_APPS[app_id]['label']}."
                    launched.append(app_id)
                    return f"Simulated launch of {backend.DESKTOP_APPS[app_id]['label']}."

                messages = [
                    {"role": "system", "content": backend.desktop_skill_context()},
                    {"role": "user", "content": utterance},
                ]
                with patch.object(backend, "manage_desktop_app", side_effect=simulated_launch):
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
