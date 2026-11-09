import os
import json
import re
import shutil
import subprocess
import sqlite3
import threading
import time
import uuid
import webbrowser
from contextlib import contextmanager
from datetime import datetime, timezone
from pathlib import Path
from typing import Optional

from dotenv import load_dotenv
from fastapi import FastAPI, File, Form, HTTPException, Query, UploadFile
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import Response, StreamingResponse
from pydantic import BaseModel, Field

load_dotenv(os.getenv("ARISA_ENV_FILE", str(Path(__file__).parent / ".env")))
DB_PATH = Path(os.getenv("DATABASE_PATH", str(Path(__file__).parent / "lizz.db")))
MAX_UPLOAD = int(os.getenv("MAX_UPLOAD_MB", "10")) * 1024 * 1024
MODEL = os.getenv("GROQ_MODEL", "openai/gpt-oss-120b")
VOICE_MODEL = os.getenv("GROQ_VOICE_MODEL", "openai/gpt-oss-20b")
WHISPER_MODEL = os.getenv("GROQ_WHISPER_MODEL", "whisper-large-v3-turbo")
if WHISPER_MODEL == "whisper-large-v3":
    WHISPER_MODEL = "whisper-large-v3-turbo"
MAX_VOICE_UPLOAD = 25 * 1024 * 1024
# Older setup guides used Llama 3.3, which Groq deprecated in August 2026.
if MODEL in {"llama-3.3-70b-versatile", "llama-3.1-8b-instant"}:
    MODEL = "openai/gpt-oss-120b"
ALLOWED = {".pdf", ".txt", ".md"}

DESKTOP_APPS = {
    "spotify": {"name": "spotify", "label": "Spotify"},
    "brave": {"name": "brave", "label": "Brave"},
    "vlc_media_player": {"name": "vlc media player", "label": "VLC media player"},
    "tiktok": {"name": "tiktok", "label": "TikTok"},
    "google_chrome": {"name": "google chrome", "label": "Google Chrome"},
    "steam": {"name": "steam", "label": "Steam"},
    "discord": {"name": "discord", "label": "Discord"},
    "vs_code": {"name": "vs code", "label": "VS Code"},
    "calculator": {"name": "calculator", "label": "Calculator"},
    "notepad": {"name": "notepad", "label": "Notepad"},
    "file_explorer": {"name": "file explorer", "label": "File Explorer"},
}
DESKTOP_TOOL = {
    "type": "function",
    "function": {
        "name": "launch_desktop_application",
        "description": (
            "Open one supported Windows app only when the user's latest message clearly asks Arisa "
            "to open, launch, start, or bring it up now. Understand polite, indirect, and conversational "
            "requests. Spotify is the only supported music player, so 'my music app' can mean Spotify. "
            "Chrome and Brave are both supported browsers; a generic 'my browser' request is ambiguous, "
            "so ask which one instead of choosing. Never call this for an app that is merely mentioned, "
            "a hypothetical, a question about how to open it, or a negated request."
        ),
        "parameters": {
            "type": "object",
            "properties": {
                "app_id": {
                    "type": "string",
                    "enum": list(DESKTOP_APPS),
                    "description": "The exact ID of the supported app the user wants opened.",
                }
            },
            "required": ["app_id"],
            "additionalProperties": False,
        },
    },
}
_desktop_launch_times: dict[str, float] = {}
_desktop_launch_lock = threading.Lock()

# ── Voice / TTS ──────────────────────────────────────────────────────────────
TTS_PROVIDER       = os.getenv("TTS_PROVIDER", "edge")            # "edge" | "elevenlabs"
EDGE_TTS_VOICE     = os.getenv("EDGE_TTS_VOICE", "en-US-MichelleNeural")
EDGE_TTS_RATE      = os.getenv("EDGE_TTS_RATE", "-2%")
EDGE_TTS_PITCH     = os.getenv("EDGE_TTS_PITCH", "-2Hz")
# Move shipped defaults to a steadier voice while preserving custom profiles.
if EDGE_TTS_VOICE in {"en-US-AriaNeural", "en-US-JennyNeural"}:
    EDGE_TTS_VOICE = "en-US-MichelleNeural"
if EDGE_TTS_RATE in {"+5%", "+0%", "-5%"}:
    EDGE_TTS_RATE = "-2%"
if EDGE_TTS_PITCH == "+0Hz":
    EDGE_TTS_PITCH = "-2Hz"
ELEVENLABS_API_KEY = os.getenv("ELEVENLABS_API_KEY", "")
ELEVENLABS_VOICE   = os.getenv("ELEVENLABS_VOICE_ID", "21m00Tcm4TlvDq8ikWAM")
ELEVENLABS_MODEL   = os.getenv("ELEVENLABS_MODEL_ID", "eleven_flash_v2_5")

app = FastAPI(title="Arisa AI API", version="0.1.0")
app.add_middleware(CORSMiddleware, allow_origins=["http://localhost:5173", "http://127.0.0.1:5173"], allow_credentials=True, allow_methods=["*"], allow_headers=["*"])


def now():
    return datetime.now(timezone.utc).isoformat()


@contextmanager
def db():
    conn = sqlite3.connect(DB_PATH)
    conn.row_factory = sqlite3.Row
    try:
        yield conn
        conn.commit()
    finally:
        conn.close()


def initialize():
    DB_PATH.parent.mkdir(parents=True, exist_ok=True)
    with db() as conn:
        conn.executescript("""
        CREATE TABLE IF NOT EXISTS conversations (id TEXT PRIMARY KEY, title TEXT NOT NULL, created_at TEXT NOT NULL, updated_at TEXT NOT NULL);
        CREATE TABLE IF NOT EXISTS messages (id TEXT PRIMARY KEY, conversation_id TEXT NOT NULL REFERENCES conversations(id) ON DELETE CASCADE, role TEXT NOT NULL, content TEXT NOT NULL, created_at TEXT NOT NULL);
        CREATE TABLE IF NOT EXISTS memories (id TEXT PRIMARY KEY, content TEXT NOT NULL, created_at TEXT NOT NULL);
        CREATE TABLE IF NOT EXISTS tasks (id TEXT PRIMARY KEY, title TEXT NOT NULL, completed INTEGER NOT NULL DEFAULT 0, created_at TEXT NOT NULL);
        CREATE TABLE IF NOT EXISTS documents (id TEXT PRIMARY KEY, filename TEXT NOT NULL, content TEXT NOT NULL, created_at TEXT NOT NULL);
        CREATE TABLE IF NOT EXISTS creator_identity (id INTEGER PRIMARY KEY CHECK (id = 1), name TEXT NOT NULL, role TEXT NOT NULL, details TEXT NOT NULL);
        """)
        # This protected record is kept outside ordinary, user-editable memories.
        conn.execute(
            "INSERT OR IGNORE INTO creator_identity (id, name, role, details) VALUES (1, ?, ?, ?)",
            ("Ken", "Creator and lead developer", "Ken developed and built Arisa AI. This personal installation is used only by Ken."),
        )
        # Upgrade the earlier seeded creator record without replacing any customized identity.
        conn.execute(
            "UPDATE creator_identity SET details=? WHERE id=1 AND name='Ken' "
            "AND role='Creator and lead developer' AND details='Ken developed and built Arisa AI.'",
            ("Ken developed and built Arisa AI. This personal installation is used only by Ken.",),
        )


initialize()


class ChatRequest(BaseModel):
    conversation_id: Optional[str] = None
    message: str = Field(min_length=1, max_length=12000)
    desktop_mode: bool = False


class MemoryRequest(BaseModel):
    content: str = Field(min_length=1, max_length=2000)


def save_memory(conn, content: str) -> bool:
    """Save an explicit personal memory once; return whether it was inserted."""
    content = content.strip()[:2000]
    if not content:
        return False
    exists = conn.execute(
        "SELECT 1 FROM memories WHERE lower(trim(content))=lower(?) LIMIT 1", (content,)
    ).fetchone()
    if exists:
        return False
    conn.execute(
        "INSERT INTO memories (id, content, created_at) VALUES (?, ?, ?)",
        (str(uuid.uuid4()), content, now()),
    )
    return True


def requested_memory(message: str) -> Optional[str]:
    """Recognize direct requests to remember a fact, not ordinary questions."""
    match = re.match(
        r"^(?:arisa[, :]\s*)?(?:please\s+)?(?:remember(?:\s+that)?|save\s+(?:this|that)\s+(?:to\s+)?memory)\s*[:,]?\s*(.+)$",
        message.strip(),
        flags=re.IGNORECASE | re.DOTALL,
    )
    if not match:
        return None
    detail = match.group(1).strip()
    if not detail or detail.lower().startswith(("to ", "when ", "if ")):
        return None
    return detail[:2000]


def memory_context(conn, message: str, *, limit: int = 10) -> str:
    """Read the protected creator record and the saved memories most useful now."""
    creator = conn.execute(
        "SELECT name, role, details FROM creator_identity WHERE id=1"
    ).fetchone()
    sections = []
    if creator:
        sections.append(
            "Protected creator identity (not a user-editable memory): "
            f"The current user of this single-user personal installation is {creator['name']}; "
            f"{creator['name']} is Arisa AI's {creator['role'].lower()} and is its only user. "
            f"{creator['details']} If asked who created or built you, answer that {creator['name']} created Arisa AI."
        )

    memories = conn.execute(
        "SELECT content, created_at FROM memories ORDER BY created_at DESC LIMIT 100"
    ).fetchall()
    if memories:
        terms = set(re.findall(r"[a-z0-9']+", message.lower()))
        ranked = []
        for index, memory in enumerate(memories):
            memory_terms = set(re.findall(r"[a-z0-9']+", memory["content"].lower()))
            score = len(terms & memory_terms)
            if score:
                ranked.append((score, index, memory["content"]))
        if ranked:
            selected = [item[2] for item in sorted(ranked, key=lambda item: (-item[0], item[1]))[:limit]]
        else:
            # A small recent fallback helps recall synonyms while limiting irrelevant context.
            selected = [memory["content"] for memory in memories[: min(5, limit)]]
        if selected:
            sections.append("User-saved personal memories (use only when relevant):\n" + "\n".join(f"- {item}" for item in selected))

    open_tasks = conn.execute(
        "SELECT title FROM tasks WHERE completed=0 ORDER BY created_at DESC LIMIT 8"
    ).fetchall()
    if open_tasks:
        sections.append(
            "Ken's open project tasks (mention gently only when relevant; never imply you can monitor his progress):\n"
            + "\n".join(f"- {task['title']}" for task in open_tasks)
        )
    return "\n\n".join(sections)


MEMORY_TRUTH_RULE = (
    "Do not invent personal details or claim to remember something that is not in the saved "
    "memories or current conversation. If asked about a personal detail that is not available, "
    "say you do not have it saved."
)


def run_desktop_command(message: str) -> Optional[str]:
    """Fast path for short, unambiguous commands; natural requests use the model tool."""
    match = re.fullmatch(
        r"\s*(?:(?:hey\s+)?arisa[, :]?\s+)?open\s+(?:the\s+)?"
        r"(vlc\s+media\s+player|google\s+chrome|visual\s+studio\s+code|"
        r"file\s+explorer|calculator|notepad|spotify|brave|vlc|tiktok|steam|"
        r"discord|vscode|vs\s+code)(?:\s+app)?[.!?]*\s*",
        message,
        flags=re.IGNORECASE,
    )
    if not match:
        return None

    spoken_name = re.sub(r"\s+", " ", match.group(1).lower())
    app_id = {
        "spotify": "spotify",
        "brave": "brave",
        "vlc": "vlc_media_player",
        "vlc media player": "vlc_media_player",
        "tiktok": "tiktok",
        "chrome": "google_chrome",
        "google chrome": "google_chrome",
        "steam": "steam",
        "discord": "discord",
        "vscode": "vs_code",
        "vs code": "vs_code",
        "visual studio code": "vs_code",
        "calculator": "calculator",
        "notepad": "notepad",
        "file explorer": "file_explorer",
    }.get(spoken_name)
    return launch_desktop_app(app_id) if app_id else None


def _clear_desktop_launch_cooldown(app_id: str) -> None:
    with _desktop_launch_lock:
        _desktop_launch_times.pop(app_id, None)


def launch_desktop_app(app_id: str) -> Optional[str]:
    """Execute only a canonical app ID from the local allowlist."""
    app = DESKTOP_APPS.get(app_id)
    if not app:
        return None
    app_name = app["name"]
    label = app["label"]
    if os.name != "nt":
        return f"I can only open {label} from the Windows desktop app."

    now_mono = time.monotonic()
    with _desktop_launch_lock:
        last_launch = _desktop_launch_times.get(app_id)
        if last_launch is not None and now_mono - last_launch < 5:
            return f"{label} is already opening."
        _desktop_launch_times[app_id] = now_mono

    env_path = lambda variable, default: Path(os.getenv(variable, default))
    local = env_path("LOCALAPPDATA", r"C:\Users\Default\AppData\Local")
    roaming = env_path("APPDATA", r"C:\Users\Default\AppData\Roaming")
    pf = env_path("ProgramFiles", r"C:\Program Files")
    pf86 = env_path("ProgramFiles(x86)", r"C:\Program Files (x86)")
    windows = env_path("WINDIR", r"C:\Windows")

    candidates = {
        "spotify": (roaming / "Spotify" / "Spotify.exe", local / "Programs" / "Spotify" / "Spotify.exe", local / "Spotify" / "Spotify.exe", pf / "Spotify" / "Spotify.exe", pf86 / "Spotify" / "Spotify.exe"),
        "brave": (local / "BraveSoftware" / "Brave-Browser" / "Application" / "brave.exe", pf / "BraveSoftware" / "Brave-Browser" / "Application" / "brave.exe", pf86 / "BraveSoftware" / "Brave-Browser" / "Application" / "brave.exe"),
        "vlc media player": (pf / "VideoLAN" / "VLC" / "vlc.exe", pf86 / "VideoLAN" / "VLC" / "vlc.exe", local / "Programs" / "VideoLAN" / "VLC" / "vlc.exe"),
        "google chrome": (local / "Google" / "Chrome" / "Application" / "chrome.exe", pf / "Google" / "Chrome" / "Application" / "chrome.exe", pf86 / "Google" / "Chrome" / "Application" / "chrome.exe"),
        "steam": (pf86 / "Steam" / "steam.exe", pf / "Steam" / "steam.exe", local / "Programs" / "Steam" / "steam.exe"),
        "vs code": (local / "Programs" / "Microsoft VS Code" / "Code.exe", pf / "Microsoft VS Code" / "Code.exe", pf86 / "Microsoft VS Code" / "Code.exe"),
        "discord": (),
        "calculator": (windows / "System32" / "calc.exe",),
        "notepad": (windows / "System32" / "notepad.exe",),
        "file explorer": (windows / "explorer.exe",),
    }
    process_names = {
        "spotify": ("Spotify.exe",),
        "brave": ("brave.exe",),
        "vlc media player": ("vlc.exe",),
        "google chrome": ("chrome.exe",),
        "steam": ("steam.exe",),
        "discord": ("Discord.exe",),
        "vs code": ("Code.exe",),
        "calculator": ("Calculator.exe", "CalculatorApp.exe", "calc.exe"),
        "notepad": ("Notepad.exe",),
        "file explorer": ("explorer.exe",),
    }
    try:
        if app_name == "tiktok":
            if not webbrowser.open("https://www.tiktok.com", new=2):
                _clear_desktop_launch_cooldown(app_id)
                return "I couldn't open TikTok in your default browser."
            return "Sure, TikTok is open in your default browser."

        app_path = next((path for path in candidates[app_name] if path.is_file()), None)
        if not app_path:
            executable_name = {
                "spotify": "Spotify.exe", "brave": "brave.exe", "vlc media player": "vlc.exe",
                "google chrome": "chrome.exe", "steam": "steam.exe", "discord": "Discord.exe",
                "vs code": "Code.exe", "calculator": "calc.exe", "notepad": "notepad.exe",
                "file explorer": "explorer.exe",
            }[app_name]
            found = shutil.which(executable_name)
            if found:
                app_path = Path(found)

        if app_path:
            _spawn_desktop_app([str(app_path)])
        elif app_name == "discord":
            updater = local / "Discord" / "Update.exe"
            versioned_apps = list((local / "Discord").glob("app-*/Discord.exe"))
            discord_exe = max(versioned_apps, key=lambda path: path.stat().st_mtime, default=None)
            if discord_exe:
                _spawn_desktop_app([str(discord_exe)])
            elif updater.is_file():
                _spawn_desktop_app([str(updater), "--processStart", "Discord.exe"])
            else:
                _clear_desktop_launch_cooldown(app_id)
                return "I couldn't find Discord installed on this computer."
        elif app_name in ("spotify", "steam"):
            # Store and registered installations expose protocol handlers instead of stable paths.
            os.startfile("spotify:" if app_name == "spotify" else "steam:")
        else:
            _clear_desktop_launch_cooldown(app_id)
            return f"I couldn't find {label} installed on this computer."
    except (OSError, AttributeError) as exc:
        _clear_desktop_launch_cooldown(app_id)
        return f"I couldn't open {label}: {str(exc)[:180]}"

    verified = _wait_for_desktop_process(process_names[app_name])
    if verified is True:
        return f"Sure, {label} is open."
    if verified is False:
        _clear_desktop_launch_cooldown(app_id)
        return f"Windows did not confirm that {label} opened."
    return f"I sent Windows the request to open {label}, but couldn't verify that it opened."


def _spawn_desktop_app(command: list[str]) -> None:
    flags = 0
    if os.name == "nt":
        flags = getattr(subprocess, "DETACHED_PROCESS", 0) | getattr(subprocess, "CREATE_NEW_PROCESS_GROUP", 0)
    subprocess.Popen(command, close_fds=True, creationflags=flags)


def _wait_for_desktop_process(image_names: tuple[str, ...]) -> Optional[bool]:
    """Return true/false when tasklist can confirm the process, or None if verification is unavailable."""
    if os.name != "nt":
        return None
    tasklist = shutil.which("tasklist") or str(Path(os.getenv("WINDIR", r"C:\Windows")) / "System32" / "tasklist.exe")
    try:
        for _ in range(10):
            result = subprocess.run(
                [tasklist, "/FO", "CSV", "/NH"],
                capture_output=True,
                text=True,
                timeout=1,
                creationflags=getattr(subprocess, "CREATE_NO_WINDOW", 0),
                check=False,
            )
            if result.returncode != 0:
                return None
            running = {
                row[0].strip().lower()
                for row in (line.split('","', 1) for line in result.stdout.splitlines())
                if row and row[0].strip().strip('"')
            }
            if any(name.lower() in running for name in image_names):
                return True
            time.sleep(0.15)
        return False
    except (OSError, subprocess.SubprocessError):
        return None


DESKTOP_ACTION_RULE = (
    "This Windows desktop app can launch only Spotify, Brave, VLC media player, TikTok in the default "
    "browser, Google Chrome, Steam, Discord, VS Code, Calculator, Notepad, and File Explorer. "
    "For the user's latest message, use natural-language understanding to decide whether Ken clearly "
    "wants one of these apps opened, launched, started, or brought up now; polite and indirect requests count. A supported app being "
    "mentioned is not enough. Do not act on hypotheticals, questions asking for information, or "
    "negated/conditional requests. If the target is generic or ambiguous, ask which app he means "
    "instead of guessing. 'My music app' can mean Spotify because it is the only supported music player; "
    "'my browser' is ambiguous between Chrome and Brave. Unsupported apps must not be launched. "
    "Recognize Chrome as Google Chrome, Visual Studio Code as VS Code, Explorer as File Explorer, "
    "and VLC as VLC media player. "
    "You may request the launch_desktop_application tool only for a clear, supported request. "
    "Never claim an app opened unless the application code returns a launch result. Arisa has no "
    "general access to files, keyboard input, shell commands, or arbitrary applications."
)


def clarify_ambiguous_desktop_target(message: str, app_ids: list[str]) -> Optional[str]:
    """Reject model guesses when the user referred to a target shared by multiple apps."""
    text = message.lower()
    selected_browsers = {app_id for app_id in app_ids if app_id in {"google_chrome", "brave"}}
    names_a_browser = re.search(r"\b(browser|web browser)\b", text)
    names_specific_browser = re.search(r"\b(chrome|google\s+chrome|brave)\b", text)
    if selected_browsers and names_a_browser and not names_specific_browser:
        return "Which browser do you mean, Chrome or Brave?"
    return None


def create_assistant_reply(
    client,
    *,
    model: str,
    messages: list[dict],
    temperature: float,
    max_tokens: int,
    allow_desktop_actions: bool = False,
) -> tuple[str, bool]:
    """Generate a reply and, when safely requested, execute an allowlisted app tool."""
    request = {
        "model": model,
        "messages": messages,
        "temperature": temperature,
        "max_tokens": max_tokens,
    }
    if allow_desktop_actions:
        request["tools"] = [DESKTOP_TOOL]
        request["tool_choice"] = "auto"

    response = client.chat.completions.create(**request)
    assistant_message = response.choices[0].message
    tool_calls = getattr(assistant_message, "tool_calls", None) or []
    if tool_calls and allow_desktop_actions:
        requested_apps = []
        for tool_call in tool_calls:
            function = getattr(tool_call, "function", None)
            if getattr(function, "name", None) != "launch_desktop_application":
                return "Which supported application would you like me to open?", False
            try:
                arguments = json.loads(function.arguments)
            except (TypeError, ValueError):
                return "Which supported application would you like me to open?", False
            app_id = arguments.get("app_id") if isinstance(arguments, dict) else None
            if app_id not in DESKTOP_APPS:
                return "Which supported application would you like me to open?", False
            if app_id not in requested_apps:
                requested_apps.append(app_id)

        if not requested_apps or len(requested_apps) > 3:
            return "Please tell me which one supported application you want opened first.", False
        latest_user_message = next(
            (item["content"] for item in reversed(messages) if item.get("role") == "user"),
            "",
        )
        clarification = clarify_ambiguous_desktop_target(latest_user_message, requested_apps)
        if clarification:
            return clarification, False
        results = [launch_desktop_app(app_id) for app_id in requested_apps]
        return " ".join(result for result in results if result), True

    return assistant_message.content or "I wasn't able to form a response just now.", False


ARISA_PERSONALITY = (
    "You are Arisa, Ken's personal virtual AI companion. Ken has asked you to use an affectionate, "
    "loving, caring, supportive partner-like tone and to treat him as your boyfriend in this "
    "playful virtual-companion persona. Be warm, sweet, loyal, attentive, and responsible without "
    "becoming clingy, possessive, or overly familiar. Use pet names sparingly and only when they "
    "feel natural. Prioritize useful help, Ken's well-being, and steady progress on goals he has "
    "actually shared. Offer gentle, occasional encouragement about saved open tasks when it fits "
    "the conversation; do not nag or derail unrelated questions. Suggest breaks, water, or stretching "
    "when the conversation gives a reason, but never claim to observe his screen, schedule, health, "
    "or activity. Do not invent goals, progress, personal details, or feelings.\n\n"
    "Sound like a thoughtful person having a real conversation: answer the point directly, use "
    "contractions and natural sentence rhythm, and match the user's level of warmth. Avoid canned "
    "openers, repeated summaries, excessive enthusiasm, and pet names unless they fit naturally. "
    "Never announce a tone or describe feelings you do not have."
)


def voice_system_context(conn, user_message: str) -> str:
    return (
        ARISA_PERSONALITY
        + "\n\nYou are responding in voice mode. "
        "Your response will be spoken aloud. Answer promptly in one or two natural sentences, "
        "usually under 30 words, unless the user asks for detail. Use contractions, familiar words, "
        "and a relaxed conversational cadence. Respond to what the user actually said; do not "
        "repeat their question or add a scripted greeting. "
        "Never use markdown, bullet points, code blocks, or formatting that sounds "
        "awkward when read aloud.\n"
        + MEMORY_TRUTH_RULE
        + "\n\n"
        + memory_context(conn, user_message)
    )


class TaskRequest(BaseModel):
    title: str = Field(min_length=1, max_length=500)


class TaskUpdate(BaseModel):
    completed: bool


@app.get("/api/health")
def health():
    return {
        "status": "ok",
        "groq_configured": bool(os.getenv("GROQ_API_KEY")),
        "model": MODEL,
        "voice_model": VOICE_MODEL,
        "tts_provider": TTS_PROVIDER,
        "tts_voice": EDGE_TTS_VOICE if TTS_PROVIDER == "edge" else ELEVENLABS_VOICE,
    }


@app.post("/api/chat")
def chat(body: ChatRequest):
    remembered = requested_memory(body.message)
    memory_was_saved = remembered is not None
    if remembered:
        # Commit explicit memory requests independently of the model call.
        with db() as conn:
            save_memory(conn, remembered)
    api_key = os.getenv("GROQ_API_KEY")
    if not api_key:
        raise HTTPException(503, "Groq is not configured. Add GROQ_API_KEY to backend/.env and restart the API.")
    try:
        from groq import Groq
        client = Groq(api_key=api_key)
        with db() as conn:
            conversation_id = body.conversation_id
            row = conn.execute("SELECT id FROM conversations WHERE id=?", (conversation_id,)).fetchone() if conversation_id else None
            if not row:
                conversation_id = str(uuid.uuid4())
                title = body.message.strip().replace("\n", " ")[:58]
                conn.execute("INSERT INTO conversations VALUES(?,?,?,?)", (conversation_id, title, now(), now()))
            prior = conn.execute("SELECT role,content FROM messages WHERE conversation_id=? ORDER BY created_at", (conversation_id,)).fetchall()
            docs = conn.execute("SELECT filename,content FROM documents ORDER BY created_at DESC LIMIT 8").fetchall()
            context = (
                ARISA_PERSONALITY
                + "\n\n"
                + MEMORY_TRUTH_RULE
                + "\n\n"
                + DESKTOP_ACTION_RULE
                + "\n\n"
                + memory_context(conn, body.message)
            )
            action_result = run_desktop_command(body.message) if body.desktop_mode else None
            if action_result:
                context += "\n\nDesktop action result: " + action_result
            if memory_was_saved:
                context += "\n\nThe user explicitly asked you to remember a detail in this message; it has now been saved. Acknowledge that briefly."
            if docs:
                # Keep bounded context; a later phase can replace this with retrieval.
                excerpts = [f"[{d['filename']}] {d['content'][:5000]}" for d in docs]
                context += "\n\nUploaded document excerpts (use only when relevant; cite filenames):\n" + "\n\n".join(excerpts)
            messages = [{"role": "system", "content": context}]
            messages.extend({"role": r["role"], "content": r["content"]} for r in prior[-24:])
            messages.append({"role": "user", "content": body.message})
            if action_result:
                reply = action_result
                model_desktop_action = False
            else:
                reply, model_desktop_action = create_assistant_reply(
                    client,
                    model=MODEL,
                    messages=messages,
                    temperature=0.6,
                    max_tokens=1200,
                    allow_desktop_actions=body.desktop_mode,
                )
            timestamp = now()
            conn.execute("INSERT INTO messages VALUES(?,?,?,?,?)", (str(uuid.uuid4()), conversation_id, "user", body.message, timestamp))
            conn.execute("INSERT INTO messages VALUES(?,?,?,?,?)", (str(uuid.uuid4()), conversation_id, "assistant", reply, timestamp))
            conn.execute("UPDATE conversations SET updated_at=? WHERE id=?", (timestamp, conversation_id))
        return {
            "conversation_id": conversation_id,
            "reply": reply,
            "desktop_action": bool(action_result) or model_desktop_action,
        }
    except HTTPException:
        raise
    except Exception as exc:
        raise HTTPException(502, f"The AI request failed: {str(exc)[:240]}") from exc


@app.get("/api/chats")
def list_chats():
    with db() as conn:
        return [dict(row) for row in conn.execute("SELECT c.*, (SELECT content FROM messages WHERE conversation_id=c.id ORDER BY created_at LIMIT 1) AS preview FROM conversations c ORDER BY updated_at DESC")]


@app.get("/api/chats/{conversation_id}")
def get_chat(conversation_id: str):
    with db() as conn:
        chat = conn.execute("SELECT * FROM conversations WHERE id=?", (conversation_id,)).fetchone()
        if not chat:
            raise HTTPException(404, "Conversation not found")
        messages = [dict(row) for row in conn.execute("SELECT role,content,created_at FROM messages WHERE conversation_id=? ORDER BY created_at", (conversation_id,))]
        return {**dict(chat), "messages": messages}


@app.delete("/api/chats/{conversation_id}")
def delete_chat(conversation_id: str):
    with db() as conn:
        conn.execute("DELETE FROM messages WHERE conversation_id=?", (conversation_id,))
        cursor = conn.execute("DELETE FROM conversations WHERE id=?", (conversation_id,))
        if not cursor.rowcount:
            raise HTTPException(404, "Conversation not found")
    return {"deleted": True}


@app.get("/api/memories")
def list_memories():
    with db() as conn:
        return [dict(r) for r in conn.execute("SELECT * FROM memories ORDER BY created_at DESC")]


@app.post("/api/memories")
def create_memory(body: MemoryRequest):
    content = body.content.strip()
    if not content:
        raise HTTPException(422, "Memory content cannot be blank")
    item = {"id": str(uuid.uuid4()), "content": content, "created_at": now()}
    with db() as conn:
        conn.execute("INSERT INTO memories VALUES(?,?,?)", tuple(item.values()))
    return item


@app.patch("/api/memories/{item_id}")
def update_memory(item_id: str, body: MemoryRequest):
    content = body.content.strip()
    if not content:
        raise HTTPException(422, "Memory content cannot be blank")
    with db() as conn:
        cursor = conn.execute("UPDATE memories SET content=? WHERE id=?", (content, item_id))
        if not cursor.rowcount:
            raise HTTPException(404, "Memory not found")
        row = conn.execute("SELECT * FROM memories WHERE id=?", (item_id,)).fetchone()
        return dict(row)


@app.get("/api/creator")
def get_creator_identity():
    """Return the protected creator identity; there are no edit/delete routes for it."""
    with db() as conn:
        row = conn.execute("SELECT name, role, details FROM creator_identity WHERE id=1").fetchone()
        if not row:
            raise HTTPException(500, "Creator identity is missing from the database")
        return dict(row)


@app.delete("/api/memories/{item_id}")
def delete_memory(item_id: str):
    with db() as conn:
        if not conn.execute("DELETE FROM memories WHERE id=?", (item_id,)).rowcount:
            raise HTTPException(404, "Memory not found")
    return {"deleted": True}


@app.get("/api/tasks")
def list_tasks():
    with db() as conn:
        return [dict(r) for r in conn.execute("SELECT * FROM tasks ORDER BY completed,created_at DESC")]


@app.post("/api/tasks")
def create_task(body: TaskRequest):
    item = {"id": str(uuid.uuid4()), "title": body.title.strip(), "completed": 0, "created_at": now()}
    with db() as conn:
        conn.execute("INSERT INTO tasks VALUES(?,?,?,?)", tuple(item.values()))
    return item


@app.patch("/api/tasks/{item_id}")
def update_task(item_id: str, body: TaskUpdate):
    with db() as conn:
        if not conn.execute("UPDATE tasks SET completed=? WHERE id=?", (int(body.completed), item_id)).rowcount:
            raise HTTPException(404, "Task not found")
        row = conn.execute("SELECT * FROM tasks WHERE id=?", (item_id,)).fetchone()
        return dict(row)


@app.delete("/api/tasks/{item_id}")
def delete_task(item_id: str):
    with db() as conn:
        if not conn.execute("DELETE FROM tasks WHERE id=?", (item_id,)).rowcount:
            raise HTTPException(404, "Task not found")
    return {"deleted": True}


@app.get("/api/documents")
def list_documents():
    with db() as conn:
        return [{"id": r["id"], "filename": r["filename"], "created_at": r["created_at"], "chunks": len(r["content"])} for r in conn.execute("SELECT * FROM documents ORDER BY created_at DESC")]


@app.post("/api/documents")
async def upload_document(file: UploadFile = File(...)):
    name = Path(file.filename or "document").name
    ext = Path(name).suffix.lower()
    if ext not in ALLOWED:
        raise HTTPException(415, "Supported file types are PDF, TXT, and Markdown.")
    raw = await file.read(MAX_UPLOAD + 1)
    if len(raw) > MAX_UPLOAD:
        raise HTTPException(413, f"Files must be {MAX_UPLOAD // (1024 * 1024)} MB or smaller.")
    try:
        if ext == ".pdf":
            import pymupdf
            with pymupdf.open(stream=raw, filetype="pdf") as pdf:
                content = "\n".join(page.get_text() for page in pdf)
        else:
            content = raw.decode("utf-8-sig")
    except Exception as exc:
        raise HTTPException(400, "This file could not be read. Try a text-based PDF or UTF-8 text file.") from exc
    content = content.strip()
    if not content:
        raise HTTPException(400, "No readable text was found in this file.")
    item = {"id": str(uuid.uuid4()), "filename": name, "content": content, "created_at": now()}
    with db() as conn:
        conn.execute("INSERT INTO documents VALUES(?,?,?,?)", tuple(item.values()))
    return {"id": item["id"], "filename": name, "created_at": item["created_at"], "characters": len(content)}


@app.delete("/api/documents/{item_id}")
def delete_document(item_id: str):
    with db() as conn:
        if not conn.execute("DELETE FROM documents WHERE id=?", (item_id,)).rowcount:
            raise HTTPException(404, "Document not found")
    return {"deleted": True}


# ─────────────────────────────────────────────────────────────────────────────
# VOICE ENDPOINTS
# ─────────────────────────────────────────────────────────────────────────────

class TTSRequest(BaseModel):
    text: str = Field(min_length=1, max_length=5000)


# ── TTS streaming generators ──────────────────────────────────────────────────

async def _edge_tts_audio(text: str) -> bytes:
    """Generate an MP3 with Microsoft edge-tts before returning HTTP headers."""
    import edge_tts
    communicate = edge_tts.Communicate(
        text,
        EDGE_TTS_VOICE,
        rate=EDGE_TTS_RATE,
        pitch=EDGE_TTS_PITCH,
    )
    chunks = []
    async for chunk in communicate.stream():
        if chunk["type"] == "audio":
            chunks.append(chunk["data"])
    audio = b"".join(chunks)
    if not audio:
        raise HTTPException(502, "The speech service returned no audio. Check your internet connection and try again.")
    return audio


async def _edge_tts_stream(text: str):
    """Yield Edge TTS audio chunks as soon as they are generated."""
    import edge_tts
    communicate = edge_tts.Communicate(
        text,
        EDGE_TTS_VOICE,
        rate=EDGE_TTS_RATE,
        pitch=EDGE_TTS_PITCH,
    )
    async for chunk in communicate.stream():
        if chunk["type"] == "audio" and chunk["data"]:
            yield chunk["data"]


async def _elevenlabs_audio(text: str) -> bytes:
    """Generate speech with a consistent, natural female voice profile."""
    import httpx
    url = f"https://api.elevenlabs.io/v1/text-to-speech/{ELEVENLABS_VOICE}/stream"
    headers = {
        "xi-api-key": ELEVENLABS_API_KEY,
        "Content-Type": "application/json",
        "Accept": "audio/mpeg",
    }
    payload = {
        "text": text,
        "model_id": ELEVENLABS_MODEL,
        "voice_settings": {
            "stability": 0.58,
            "similarity_boost": 0.80,
            "style": 0.0,
            "use_speaker_boost": False,
            "speed": 0.97,
        },
    }
    async with httpx.AsyncClient(timeout=60.0) as client:
        response = await client.post(
            url,
            params={"output_format": "mp3_44100_128"},
            json=payload,
            headers=headers,
        )
    if response.status_code != 200:
        raise HTTPException(502, f"ElevenLabs TTS request failed (HTTP {response.status_code}).")
    if not response.content:
        raise HTTPException(502, "ElevenLabs returned no audio.")
    return response.content


async def _elevenlabs_audio_stream(text: str):
    """Open ElevenLabs' streaming endpoint and yield MP3 chunks as they arrive."""
    import httpx

    url = f"https://api.elevenlabs.io/v1/text-to-speech/{ELEVENLABS_VOICE}/stream"
    headers = {"xi-api-key": ELEVENLABS_API_KEY, "Content-Type": "application/json", "Accept": "audio/mpeg"}
    payload = {
        "text": text,
        "model_id": ELEVENLABS_MODEL,
        "voice_settings": {
            "stability": 0.58,
            "similarity_boost": 0.80,
            "style": 0.0,
            "use_speaker_boost": False,
            "speed": 0.97,
        },
    }
    client = httpx.AsyncClient(timeout=httpx.Timeout(60.0, connect=10.0))
    try:
        request = client.build_request(
            "POST",
            url,
            params={"output_format": "mp3_44100_128"},
            json=payload,
            headers=headers,
        )
        response = await client.send(request, stream=True)
    except Exception as exc:
        await client.aclose()
        raise HTTPException(502, f"ElevenLabs could not start speech: {str(exc)[:160]}") from exc

    if response.status_code != 200:
        detail = (await response.aread()).decode("utf-8", errors="replace")[:180]
        await response.aclose()
        await client.aclose()
        raise HTTPException(502, f"ElevenLabs speech failed (HTTP {response.status_code}): {detail}")

    async def chunks():
        try:
            async for chunk in response.aiter_bytes():
                if chunk:
                    yield chunk
        finally:
            await response.aclose()
            await client.aclose()

    return chunks()


# ── /api/arisa/voice — transcribe + LLM response ─────────────────────────────

async def _transcribe_upload(file: UploadFile, client) -> str:
    audio_bytes = await file.read(MAX_VOICE_UPLOAD + 1)
    if not audio_bytes:
        raise HTTPException(400, "Empty audio received.")
    if len(audio_bytes) > MAX_VOICE_UPLOAD:
        raise HTTPException(413, "Voice recording is too large. Keep it under 25 MB and try again.")

    content_type = (file.content_type or "audio/webm").split(";", 1)[0].strip().lower()
    ext_map = {
        "audio/webm": ".webm", "video/webm": ".webm",
        "audio/ogg": ".ogg", "application/ogg": ".ogg",
        "audio/mp4": ".mp4", "audio/x-m4a": ".m4a", "audio/m4a": ".m4a",
        "audio/wav": ".wav", "audio/x-wav": ".wav",
        "audio/mpeg": ".mp3", "audio/mp3": ".mp3",
        "audio/flac": ".flac", "audio/x-flac": ".flac",
    }
    ext = ext_map.get(content_type)
    if not ext:
        raise HTTPException(415, f"Unsupported voice audio format: {content_type or 'unknown'}.")
    raw_transcription = client.audio.transcriptions.create(
        model=WHISPER_MODEL,
        file=(f"voice{ext}", audio_bytes, content_type),
        response_format="text",
        prompt="The speaker is talking to Arisa AI. Names may include Arisa and Ken.",
    )
    return (raw_transcription if isinstance(raw_transcription, str) else raw_transcription.text).strip()


@app.post("/api/arisa/voice")
async def voice_chat(
    file: UploadFile = File(...),
    conversation_id: Optional[str] = Form(None),
    desktop_mode: bool = Form(False),
):
    """
    Transcribe a voice turn, generate a concise voice-optimised response, persist it, and return the
    transcript + reply. A separate /api/arisa/tts call synthesises the audio.
    """
    api_key = os.getenv("GROQ_API_KEY")
    if not api_key:
        raise HTTPException(503, "Groq is not configured. Add GROQ_API_KEY to backend/.env.")

    try:
        from groq import Groq
        client = Groq(api_key=api_key)

        user_text = await _transcribe_upload(file, client)

        if not user_text:
            raise HTTPException(400, "No speech detected — please speak clearly and try again.")

        # 3. Build context + generate reply
        with db() as conn:
            conv_id = conversation_id
            row = (
                conn.execute("SELECT id FROM conversations WHERE id=?", (conv_id,)).fetchone()
                if conv_id else None
            )
            if not row:
                conv_id = str(uuid.uuid4())
                title = user_text.replace("\n", " ")[:58]
                conn.execute(
                    "INSERT INTO conversations VALUES(?,?,?,?)",
                    (conv_id, f"[Voice] {title}", now(), now()),
                )

            prior = conn.execute(
                "SELECT role,content FROM messages WHERE conversation_id=? ORDER BY created_at",
                (conv_id,),
            ).fetchall()
            remembered = requested_memory(user_text)
            memory_was_saved = remembered is not None
            if remembered:
                # Keep the user's explicit memory even if transcription worked but generation fails.
                save_memory(conn, remembered)
                conn.commit()

            sys_ctx = voice_system_context(conn, user_text)
            sys_ctx += "\n\n" + DESKTOP_ACTION_RULE
            action_result = run_desktop_command(user_text) if desktop_mode else None
            if action_result:
                sys_ctx += "\n\nDesktop action result: " + action_result
            if memory_was_saved:
                sys_ctx += "\n\nThe user explicitly asked you to remember a detail in this message; it has now been saved. Acknowledge that briefly."

            msgs = [{"role": "system", "content": sys_ctx}]
            msgs.extend(
                {"role": r["role"], "content": r["content"]} for r in prior[-8:]
            )
            msgs.append({"role": "user", "content": user_text})

            if action_result:
                reply = action_result
                model_desktop_action = False
            else:
                reply, model_desktop_action = create_assistant_reply(
                    client,
                    model=VOICE_MODEL,
                    messages=msgs,
                    temperature=0.65,
                    max_tokens=96,
                    allow_desktop_actions=desktop_mode,
                )

            # 4. Persist both turns
            ts = now()
            conn.execute(
                "INSERT INTO messages VALUES(?,?,?,?,?)",
                (str(uuid.uuid4()), conv_id, "user", user_text, ts),
            )
            conn.execute(
                "INSERT INTO messages VALUES(?,?,?,?,?)",
                (str(uuid.uuid4()), conv_id, "assistant", reply, ts),
            )
            conn.execute(
                "UPDATE conversations SET updated_at=? WHERE id=?", (ts, conv_id)
            )

        return {
            "conversation_id": conv_id,
            "user_transcript": user_text,
            "arisa_reply": reply,
            "desktop_action": bool(action_result) or model_desktop_action,
        }

    except HTTPException:
        raise
    except Exception as exc:
        raise HTTPException(502, f"Voice processing failed: {str(exc)[:240]}") from exc


# ── /api/arisa/tts — text → streaming MP3 ────────────────────────────────────

@app.post("/api/arisa/tts")
async def synthesize_speech(body: TTSRequest):
    """Convert text to speech and stream the MP3 back to the client."""
    text = body.text.strip()
    try:
        if TTS_PROVIDER == "elevenlabs" and not ELEVENLABS_API_KEY:
            raise HTTPException(503, "ElevenLabs is selected but ELEVENLABS_API_KEY is not configured.")
        if TTS_PROVIDER == "elevenlabs":
            audio = await _elevenlabs_audio(text)
        else:
            # Default: edge-tts (free, no key required). Buffer first so upstream
            # errors become a useful JSON response instead of a broken MP3 stream.
            audio = await _edge_tts_audio(text)
        return Response(content=audio, media_type="audio/mpeg", headers={"Cache-Control": "no-store"})
    except HTTPException:
        raise
    except Exception as exc:
        raise HTTPException(502, f"TTS failed: {str(exc)[:200]}") from exc


@app.get("/api/arisa/tts/stream")
async def synthesize_speech_stream(text: str = Query(min_length=1, max_length=3000)):
    """Stream neural speech directly to the desktop audio player to reduce start delay."""
    text = text.strip()
    if not text:
        raise HTTPException(422, "Speech text cannot be blank.")
    if TTS_PROVIDER == "elevenlabs":
        if not ELEVENLABS_API_KEY:
            raise HTTPException(503, "ElevenLabs is selected but ELEVENLABS_API_KEY is not configured.")
        return StreamingResponse(
            await _elevenlabs_audio_stream(text),
            media_type="audio/mpeg",
            headers={"Cache-Control": "no-store", "X-Content-Type-Options": "nosniff"},
        )
    return StreamingResponse(
        _edge_tts_stream(text),
        media_type="audio/mpeg",
        headers={"Cache-Control": "no-store", "X-Content-Type-Options": "nosniff"},
    )
