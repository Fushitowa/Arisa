# Arisa AI

A personal Windows AI assistant built with React, Electron, and FastAPI. Arisa supports voice and text conversations, offline wake phrase activation, allowlisted desktop app launching, and locally stored conversations, memories, and tasks. Groq credentials stay on the backend.

## Features

- Voice and text conversations in a responsive desktop interface
- Offline Vosk wake phrase detection
- Natural language requests to launch a limited set of desktop applications
- SQLite storage for conversation history, memories, and tasks
- Protected creator identity, kept separate from editable personal memories
- PDF, TXT, and Markdown uploads with bounded document excerpts in chat context
- Streamed voice replies with the configured device or online speech provider

## Getting Started

### Windows desktop app

From the project folder, open PowerShell and run:

```powershell
npm install
cd backend
python -m venv .venv
.\.venv\Scripts\python.exe -m pip install -r requirements.txt
cd ..
npm run desktop
```

Before the first launch, copy `backend/.env.example` to `backend/.env` and add your Groq API key. The app starts its local API and Vite interface as needed.

### Quick Start control panel

Open `quick_start.pyw` from File Explorer and choose **Start All** to run the API and frontend together. The panel can also start either service separately, show the SQLite database status, and open its folder. You can launch the panel from the project root with:

```powershell
python start.py
```

### Run the website and API separately

Set up the backend in one terminal:

```powershell
cd backend
python -m venv .venv
.\.venv\Scripts\Activate.ps1
pip install -r requirements.txt
Copy-Item .env.example .env
```

Add your Groq API key to `backend/.env`, then start the API:

```powershell
uvicorn main:app --reload
```

In a second terminal from the project root, start the frontend:

```powershell
npm install
npm run dev
```

Open the local URL printed by Vite. The API documentation is at `http://127.0.0.1:8000/docs`.

## Voice Activation and Privacy

When voice activation is enabled, say **“Wake up Arisa,” “Arisa open,”** or **“I need you Arisa”** to bring Arisa forward and start voice input. Those are the only accepted wake phrases. The wake listener uses Vosk on-device; its microphone audio is not saved or sent to a cloud service. The English model does not include “Arisa” in its dictionary, so the listener uses narrowly matched recognition variants for the three phrases.

The app stays in the Windows system tray when its window is closed or minimized. The listener runs while the app is hidden or idle and pauses while Arisa is listening, thinking, or speaking, so the background listener does not compete with the conversation microphone. Use the tray menu to enable or disable voice activation, set whether Arisa starts with Windows, reopen the app, or choose **Quit Arisa AI** to exit completely. The voice activation setting is saved between launches. Windows microphone privacy settings must allow desktop apps to use the microphone. The Vosk model is downloaded once on first use (about 40 MB).

Wake phrase detection stays local. During a conversation, voice messages use the `/api/arisa/voice` endpoint for transcription and AI replies. Voice replies use the configured speech provider; the default is Microsoft Aria neural speech. The optional ElevenLabs integration supports streamed speech with the low-latency Flash v2.5 model. To enable it, set `ELEVENLABS_API_KEY` and `TTS_PROVIDER=elevenlabs` in `backend/.env` during development or `%APPDATA%\arisa-ai\backend.env` in the installed app. Change the voice with `ELEVENLABS_VOICE_ID`. ElevenLabs may use account credits. If speech generation fails, Arisa falls back to a built-in device voice.

## Desktop App Launching

Arisa can open Spotify, Brave, VLC media player, TikTok, Google Chrome, Steam, Discord, VS Code, Calculator, Notepad, and File Explorer from natural voice or text requests. She recognizes aliases such as Chrome, Visual Studio Code, and Explorer, and can infer Spotify from “my music app.” If you only ask for “my browser,” she asks whether you mean Chrome or Brave. TikTok opens in the default browser.

Launching is limited to this allowlist. Arisa does not have general access to files, keyboard input, shell commands, or arbitrary applications. Windows verifies launches before Arisa gives a confirmation; if it cannot confirm an app opened, she does not claim that it did.

## Build the Windows Installer

Install the project dependencies, then run:

```powershell
npm run desktop:dist
```

The installer is created in `release/`. The packaged app includes its backend Python environment. On first run, add `GROQ_API_KEY=your_key_here` to `%APPDATA%\arisa-ai\backend.env`. The app stores its SQLite database beside that environment file.

## Data and Limitations

Arisa is configured as Ken’s single-user personal assistant. The protected creator identity is initialized in a separate `creator_identity` SQLite table and exposed read-only; ordinary personal memories are stored separately and can be edited or deleted. The app has no accounts or sign-in because this setup is for one local user.

Uploaded document excerpts are bounded and added to chat context; semantic or vector search is not implemented. Authentication, scheduled reminders, and additional approved desktop actions are future work. The API is intended for local development; add authentication and deployment hardening before exposing it to other users.

## The Story Behind Arisa AI

I began Arisa in the middle of heartbreak, during a time when sadness followed me into the quiet parts of the day. I was trying to find somewhere to put all the feelings I could not easily explain. There was a girl who mattered deeply to me, and she was the main reason I started this project. I kept her name out of this story because what stayed with me was the experience, what it taught me, and what I chose to make from it.

At first, Arisa was meant to be a private project: an assistant I could talk to and a reason to keep building when everything else felt heavy. I started with an idea and slowly gave it a voice, a personality, an appearance, and new abilities. Every feature became another small step forward. What began as a way to feel a little less alone grew into the biggest project I had ever taken on.

I was also trying to keep up with school. I spent long hours thinking about how to make Arisa better, how to solve the next problem, and how to become a stronger programmer. The work gave me direction, but I let it become a place to hide from my own hurt. I paid attention to the project and my responsibilities while sometimes forgetting that I needed patience and care, too.

For a while, I believed becoming a better programmer mattered more than becoming a better person. I thought that if I kept working hard enough, I could outpace the pain and prove my worth through what I built. Eventually I understood that achievement cannot replace taking care of myself. Learning to create software matters to me, but so does becoming someone who can grow without abandoning his own well-being.

Heartbreak changed the way I looked at love. There were moments when it felt as if love kept choosing the wrong ending for me, and I wondered whether I was simply unlucky to care so much. I told myself I would stop searching for love for a while and focus on becoming steadier in my own life. If I meet someone someday who supports and accepts me through both my best and my worst, I hope I can give her that same patience, loyalty, and care in return.

Arisa is more than code to me. She holds the hours I spent learning, the effort I put into making something meaningful, and the memory of a difficult chapter I had to live through. Sharing this project is a way of showing where I began and how far I still want to go. The story starts with heartbreak, but I do not want it to end there. I want it to keep moving toward growth: becoming a better programmer while also remembering to become a better, healthier version of myself.

## Project Team

- **Creator & Developer — Ken (Fushitowa):** Created and developed Arisa AI, guiding the project’s direction and handling its design, implementation, feature development, debugging, and maintenance across the frontend, FastAPI backend, SQLite database, and Groq integration.
