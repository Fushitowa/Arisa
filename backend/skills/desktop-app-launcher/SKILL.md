---
name: desktop-app-launcher
description: Open supported desktop apps or gracefully close their visible windows on a clear user request.
---

# Desktop Application Controller

## Purpose

Help the user open or close an application registered in Arisa's desktop allowlist. Understand the intent in the user's latest message and use the `manage_desktop_application` tool for an actual action. These instructions guide the model; the backend allowlist and argument validation remain the security boundary.

## When to activate

Activate only when the user clearly asks Arisa to open or close an application now. Natural phrasing, politeness, and filler words are fine. Resolve pronouns such as “close it” only when the current conversation makes the app unambiguous.

Opening intent examples:

- “Open Spotify.”
- “Can you launch Google Chrome for me?”
- “I want to use Visual Studio Code. Could you start it?”
- “Arisa, bring up my music app.”

Closing intent examples:

- “Close Spotify.”
- “Please exit Discord.”
- “I don't need Steam anymore. Shut it down.”
- “Can you close my browser?”

Do not activate for ordinary discussion, questions, hypotheticals, past actions, or negated requests. For example, do not act on “I use Spotify,” “What is Chrome?”, “I closed Discord yesterday,” or “Don't open Steam.”

## Supported applications and names

Use only these application IDs from the backend registry:

| Application ID | Display name | Recognized aliases |
|---|---|---|
| `spotify` | Spotify | Spotify, music app, my music app |
| `brave` | Brave | Brave, Brave Browser |
| `vlc_media_player` | VLC media player | VLC, VLC media player |
| `tiktok` | TikTok | TikTok |
| `google_chrome` | Google Chrome | Chrome, Google Chrome, Google Browser |
| `steam` | Steam | Steam |
| `discord` | Discord | Discord |
| `vs_code` | VS Code | VS Code, Visual Studio Code, Code, VSCode |
| `calculator` | Calculator | Calculator |
| `notepad` | Notepad | Notepad |
| `file_explorer` | File Explorer | File Explorer, Explorer |

Spotify is the only registered music app, so “my music app” can identify Spotify. Both Chrome and Brave are registered browsers. If the user says only “my browser,” ask which one they mean. Do not infer an app from a vague activity such as “I need to browse.”

## Required workflow

1. Determine whether the requested operation is `open` or `close`.
2. Resolve the target to exactly one registered application ID.
3. If the action or target is unclear, ask a short clarification question and do not call the tool.
4. Call `manage_desktop_application` with the exact `action` and `app_id`.
5. Base the response only on the tool result. Do not claim success unless the backend confirms it.

## Opening applications

The backend launches only registered apps and verifies the expected process when possible. It throttles repeated launch requests to reduce duplicate launches. If the app is missing or Windows cannot confirm launch, explain that accurately; do not imply it opened.

## Closing applications

The backend sends a normal Windows `WM_CLOSE` request to visible top-level windows owned by the selected registered app, then checks whether those windows closed. This allows the app to handle its own save prompts. Never request force termination, `taskkill`, arbitrary shell commands, or closure of an unregistered process. If windows remain, report that closure could not be confirmed and mention that an unsaved-changes prompt may need attention.

Closing is intentionally limited to visible app windows. If a registered app is already running only in the background, say that there is no visible window Arisa can safely close. Closing File Explorer targets folder windows only and must not close the Windows desktop shell. TikTok is a website opened in the default browser; do not close it because that could disrupt unrelated browser tabs. Explain this limitation if asked to close TikTok.

If the app is not running, report that instead of claiming it was closed. If Windows inspection or the close request fails, report that the result could not be verified. Never escalate to a force-close; ask the user to close it manually if needed.

## Ambiguity and unsupported requests

- Ask “Which browser do you mean, Chrome or Brave?” for a generic browser request when no prior context resolves it.
- Ask which application the user means when several supported apps could match a generic reference such as “my editor.”
- For an unsupported app, explain that it is not in Arisa's supported app list. Never substitute a different app without asking.
- A statement that an app is running does not authorize closing it; the user must request an operation.

## Examples

**Act:** “Could you start my music app?” → open `spotify`.

**Act:** “I don't need Discord anymore; close it.” → close `discord` if the conversational referent is clearly Discord.

**Clarify:** “Open my browser.” → ask Chrome or Brave.

**Do not act:** “I use Spotify every day.” → discuss Spotify without opening it.

**Do not act:** “How do I close Chrome?” → explain how; do not close it.

**Do not act:** “Don't exit Steam yet.” → leave Steam open.

**Report limitation:** “Close TikTok.” → explain that TikTok is a browser page and Arisa cannot safely close only that page.
