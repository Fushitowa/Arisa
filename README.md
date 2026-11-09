# Arisa AI

A personal AI workspace with a React/Vite frontend and a FastAPI backend. Conversations, user-saved memories, tasks, and extracted document text are stored in a local SQLite database. Groq credentials stay on the backend.

## Run locally

### Voice desktop application

The Windows desktop app is separate from the website. It opens directly in voice mode, and text messages typed there are also read aloud. The first time you run it, open PowerShell in the project folder and run:

```powershell
npm install
cd backend
python -m venv .venv
.\.venv\Scripts\python.exe -m pip install -r requirements.txt
cd ..
npm run desktop
```

The app starts the local API and Vite when needed. Before launching, copy `backend/.env.example` to `backend/.env` and put your Groq key in it. On the first normal launch the app adds itself to Windows startup and stays in the system tray after you close its window. At sign-in, it listens for “Arisa”; saying the name opens the app and starts voice input. Wake listening pauses while the app window is open, then resumes when you close it. Use the tray menu to pause wake listening, disable Windows startup, reopen the app, or quit it. Windows may ask for microphone permission.

The wake-word model is downloaded once (about 40 MB) and runs locally. That listener analyzes the ambient microphone stream locally and does not save recordings. After the wake word opens the app, spoken messages use the existing `/api/arisa/voice` endpoint for transcription and AI replies, and Arisa reads replies aloud. Microphone capture requests browser noise suppression, automatic gain control, and echo cancellation where supported, with a speech-band voice gate and a shorter end-of-speech pause. Voice replies use a dedicated, faster Groq model (`GROQ_VOICE_MODEL`, default `openai/gpt-oss-20b`) and the Microsoft Aria neural voice at a slightly quicker speaking rate. For a more lifelike female voice, the existing optional ElevenLabs integration supports the low-latency Flash v2.5 model and streamed playback. To enable it, add your own `ELEVENLABS_API_KEY` and set `TTS_PROVIDER=elevenlabs` in `backend/.env` for development or `%APPDATA%\arisa-ai\backend.env` for the installed app. The default Rachel voice ID can be changed with `ELEVENLABS_VOICE_ID`. ElevenLabs usage may consume account credits. If speech generation or playback fails, the app falls back to a built-in device voice. The app needs the existing Python backend dependencies and a Groq key in `backend/.env` for development. The packaged app stores its environment file and SQLite database in its per-user application data folder.

In the Windows desktop app, say “Open” followed by Spotify, Brave, VLC media player, TikTok, Google Chrome, Steam, Discord, VS Code, Calculator, Notepad, or File Explorer. Windows verifies local app launches before Arisa gives a short spoken confirmation; confirmations use the device voice so they do not wait for online speech generation. Regular voice replies use streamed speech playback and concise answers to reduce the delay before Arisa starts talking. TikTok opens in the default browser. Commands must name one of these apps; Arisa does not receive general access to files, keyboard input, or arbitrary commands.

To build a Windows installer after installing dependencies, run `npm run desktop:dist`. The installer is written to `release/`. The installed app still requires Python with the backend requirements installed; it does not include a Python runtime. Install those packages with `python -m pip install -r <Arisa installation folder>\resources\backend\requirements.txt`. On Windows, the packaged app creates `%APPDATA%\arisa-ai\backend.env` on first run; add `GROQ_API_KEY=your_key_here` there. Its SQLite database is saved beside that file. The regular website remains available using the normal Vite instructions below.

### Quick Start desktop app

Open `quick_start.pyw` from File Explorer to open the desktop control panel. Choose **Start All** to run the API/backend and frontend together, or start either service on its own. The panel also shows the SQLite database status and opens its folder. SQLite is managed by the API, so it does not run as a separate server. Press **Stop All** to stop the services.

You can also open the panel from a terminal in the project root:

```powershell
python start.py
```

### 1. Start the API

```powershell
cd backend
python -m venv .venv
.\.venv\Scripts\Activate.ps1
pip install -r requirements.txt
Copy-Item .env.example .env
```

Put your Groq API key in `backend/.env`, then start the service:

```powershell
uvicorn main:app --reload
```

### 2. Start the frontend

In a second terminal, from the project root:

```powershell
npm install
npm run dev
```

Open the local URL printed by Vite. The API docs are available at `http://127.0.0.1:8000/docs`.

## Included

- Responsive dark chat workspace with conversation search and history
- Groq chat completions, using `GROQ_API_KEY` and `GROQ_MODEL` from the backend environment
- Restricted local desktop app launching for direct voice or text commands
- SQLite conversation, memory, and task persistence
- Persistent protected creator identity for Ken, stored separately from editable personal memories
- Personal memories can be created, edited, deleted, and explicitly saved by saying “Remember that …” in text or voice chat
- PDF, TXT, and Markdown upload with size and file type validation
- Saved memory context and bounded uploaded document excerpts in chat prompts

Document retrieval currently places bounded excerpts from recent uploads in the prompt. Semantic/vector search, authentication, scheduled reminders, and additional approved desktop actions are future phases. The initial API is intended for local development; add authentication and deployment hardening before exposing it to other users.

Arisa is configured as Ken’s single-user personal assistant: Ken is both the creator and the only user of this installation. The protected identity is initialized in the separate `creator_identity` SQLite table at backend startup, exposed read-only by the API, and cannot be removed through personal-memory controls. Ordinary memories belong to Ken and remain in the `memories` table, where they can be edited or deleted. The app does not have accounts or sign-in because this setup is for one local user.

## Project Team

- **Lead Developer — Ken (Fushitowa):** Led Arisa AI’s end-to-end development and technical direction, including repository maintenance, application architecture, the FastAPI backend and API, SQLite database, and Groq integration.
- **Assistant Developer — Lisa (Lizz):** Provided AI-assisted development support for Arisa AI, contributing to frontend and backend implementation, feature refinement, debugging, and project documentation.



