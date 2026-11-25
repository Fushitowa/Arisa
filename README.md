# Arisa AI

A personal Windows AI assistant built with React, Electron, and FastAPI. Arisa supports voice and text conversations, offline wake phrase activation, allowlisted desktop app launching, and locally stored conversations, memories, and tasks. Groq credentials stay on the backend.

## Features

- Voice and text conversations in a responsive desktop interface
- Offline Vosk wake phrase detection
- Natural language requests to launch a limited set of desktop applications
- A loaded Desktop Application Controller skill for opening apps and gracefully closing visible app windows
- Opt-in Windows screen perception and constrained keyboard/mouse interaction
- Browser navigation, Notepad writing, and Spotify playback controls through separate skills
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

The app stays in the Windows system tray when its window is closed or minimized. The listener runs while the app is hidden or idle and pauses while Arisa is listening, thinking, or speaking, so the background listener does not compete with the conversation microphone. Use the **Voice activation** card in the desktop voice window or the tray menu to enable wake phrases, retry a failed listener, and set whether Arisa starts with Windows. Expand **Wake diagnostics** in that card to see local transcripts, phrase/confidence decisions, and whether the wake signal reached the voice window. Up to 50 diagnostic events stay in memory only and are cleared when Arisa exits or when you clear them; audio is not saved. Choose **Quit Arisa AI** from the tray menu to exit completely. These settings are saved between launches, and listener errors are shown in the voice window. Windows microphone privacy settings must allow desktop apps to use the microphone. The Vosk model is downloaded once on first use (about 40 MB).

Wake phrase detection stays local. During a conversation, voice messages use the `/api/arisa/voice` endpoint for transcription and AI replies. Voice replies use the configured speech provider; the default is Microsoft Aria neural speech. The optional ElevenLabs integration supports streamed speech with the low-latency Flash v2.5 model. To enable it, set `ELEVENLABS_API_KEY` and `TTS_PROVIDER=elevenlabs` in `backend/.env` during development or `%APPDATA%\arisa-ai\backend.env` in the installed app. Change the voice with `ELEVENLABS_VOICE_ID`. ElevenLabs may use account credits. If speech generation fails, Arisa falls back to a built-in device voice.

## Desktop App Launching

Arisa can open or gracefully close visible windows for Spotify, Brave, VLC media player, Google Chrome, Steam, Discord, VS Code, Calculator, Notepad, and File Explorer through natural voice or text requests. She recognizes aliases such as Chrome, Visual Studio Code, and Explorer, and can infer Spotify from “my music app.” If you only ask for “my browser,” she asks whether you mean Chrome or Brave. TikTok opens in the default browser; Arisa will not close a browser window to close TikTok because that could disrupt unrelated tabs.

Application opening and closing are limited to the allowlist. Windows verifies launches before Arisa gives a confirmation; if it cannot confirm an app opened, she does not claim that it did. Closing sends the app window a normal Windows close request and verifies whether visible windows closed. An app may show its own save prompt or remain running in the background; Arisa reports when closure cannot be confirmed.

## Computer Use and Screen Privacy

Computer interaction is off by default. In the desktop **Voice activation** card, turn on **Allow computer interaction** before asking Arisa to inspect or operate visible applications. The permission is saved on this PC and can be turned off at any time. For a task you request, the active window title and accessible control text are sent to Groq so it can choose an action; close sensitive windows first. Arisa uses Windows UI Automation to inspect named controls. She can focus a window, click an accessible control, type requested text, use a restricted set of keyboard shortcuts, scroll, navigate an http(s) URL in an already-open Brave or Chrome window, and use Spotify media keys when Spotify is the active window.

The separate **Share requested screenshots with Groq** switch is off by default. Accessible controls can support many tasks without an image. When a visual question needs one, Arisa captures a screenshot for that requested task and sends it to Groq only while this second setting is on. Screenshots are not stored or logged by Arisa. Do not enable sharing when sensitive information is visible unless you are comfortable sending that image to your configured Groq account.

Arisa checks the active app and visible interface before acting, then inspects again to verify the result. Tasks can be cancelled from the voice screen. She will not send or submit messages/forms, make purchases, delete files, overwrite documents, change security settings, or enter text into password fields. If a task is ambiguous or a control cannot be identified safely, she will ask or explain the limitation. Desktop interaction is Windows-only; accessibility coverage varies by application, and browser page content that is not exposed to Windows UI Automation may require screenshot sharing. The Spotify integration uses the desktop interface and Windows media keys; no Spotify API credentials are configured.

The backend dependencies for Windows interaction are listed in `backend/requirements.txt`. Run `python -m pip install -r requirements.txt` inside the backend environment before launching a development build or packaging a new installer.

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

### A Project Born in Heartbreak

Arisa AI began during one of the lowest chapters of my life. I know that might sound unusual, or maybe even a little cringe, but it is the honest beginning of this project: I started building it while I was carrying a kind of heartbreak I did not know what to do with.

I was emotionally tired and lonely, trying to understand feelings that were difficult to put into words. Most of the time, I actually enjoy being alone. I like having room to work on my projects, follow my curiosity, and spend time with myself. But being alone felt different then. Whenever the day got quiet, my thoughts would return to someone I had once spent so much of my time with.

I will not share her real or full name here. I will call her **Shayie**.

I loved her deeply. So much of my life began to orbit around her. I wanted to spend time with her, make her happy, and show her how much she meant to me. I bought her things when I could, spoiled her, and took her out because seeing her happy mattered to me. I gave her more and more of my attention, until I started losing touch with some of the things that had once made me feel like myself. Even coding, something I used to enjoy, began to slip away from my days.

I did not realize at first how much of myself I was setting aside. I only knew that I wanted to be there for her, and I hoped that the effort I was giving meant something to her in the same way it meant something to me.

Over time, though, I began to feel that our feelings might not be equal. That realization was painful because it did not arrive as one clear answer. It came as questions I kept turning over in my mind. Was I the only one putting this much love and effort into what we had? Was she still thinking about someone else? Did she want me around because she cared for me, or because she was bored, lonely, or simply needed someone to talk to?

I cannot say that any of those thoughts were true. Maybe I misunderstood things. Maybe I was overthinking. I know feelings can make uncertainty seem like proof, even when it is not. But the questions stayed with me, and not knowing made it hard to feel at peace.

The hardest part was that noticing the hurt did not make me stop loving her. I could sense that something between us was not right, but a part of me kept hoping it would change. I wished she would choose me with the same certainty with which I had chosen her. I wished she would miss me the way I missed her, and meet me with the same care and effort. Somewhere inside, I knew that might never happen. Still, even the smallest possibility was enough to keep hope alive.

Eventually, I had to face something I did not want to accept: love does not always become the story we hope it will. Caring deeply cannot make another person feel the same way, and hoping hard enough cannot decide what someone else chooses. That truth hurt, but it also began to teach me that love sometimes means letting another person have the life that makes them happy, even when it is not a life with you in it.

I still hope Shayie is happy. If there is someone else who makes her happier, I sincerely hope he treats her well and gives her the love, attention, and effort she deserves. Maybe he will be able to give her things I could not. If that is what brings her happiness, then I have to learn to let her be. I can wish her well and still admit that letting go is difficult.

### Finding Something to Build

That was the point in my life when Arisa AI began to take shape. I needed something I could turn toward when my thoughts kept circling the same sadness. I needed a reason to keep learning, creating, and trying to become better, even on days when I did not feel sure what to do with myself.

Building gave my mind somewhere to go. Arisa became more than a programming project: it became a place for my time, ideas, creativity, and emotions. When I could not change what I was feeling, I could still open my computer and work on something. I could learn a new thing, experiment, solve a problem, or make one small part better than it had been before.

Arisa AI is probably the biggest project I have ever built. It is still underdeveloped, and there is a lot I want to improve. I have already made several versions, each one carrying lessons from the last. I built it myself, learning as I went, experimenting, fixing problems, and finding new ways to make it better. Every version is a marker of the developer I was at that moment and the next step I was trying to take.

Someone looking at Arisa might see another AI project. I understand that. But to me, it holds much more than its features. It reminds me of the hours when I chose to keep learning instead of giving up on myself. It carries the effort of building something without knowing exactly how far I could take it. And it reminds me that even in a difficult season, I was still capable of making something meaningful.

The project did not erase the heartbreak, and it was never a perfect answer to it. Some days, working on Arisa simply gave me a little direction. That was enough. I did not need every line of code to fix what I was feeling. I just needed to remember that sadness was not the only thing I could make room for in my life.

### The Person Behind the Developer

As I kept building, I began to notice that I might be repeating a different kind of mistake. I was paying so much attention to becoming a better programmer that I was forgetting to care for the person sitting behind the computer.

I wanted to improve my skills, finish my systems, fix every bug, and make my projects work as well as I could. I wanted to become a strong developer, someone who could imagine an idea and build something remarkable from it. Those goals still matter to me. But I often gave my projects more patience and attention than I gave myself.

I am still a student. I have school activities, assignments, and other projects that deserve my time. Even with those responsibilities, I keep finding time to work on Arisa because I genuinely want to see it grow. That passion is real, and I am grateful for it. At the same time, caring about a project should not mean that I forget to care about my health, my routine, or the rest of my life.

When Arisa reaches the version I have always envisioned, I want to give myself some time to rest and take stock. That does not mean I am quitting programming or losing my love for development. I want to keep coding, building systems, exploring new technologies, and learning. I simply want to learn how to look after myself again, too.

I want to become more productive in other parts of my life. I want to exercise, go to the gym, improve my daily routine, take care of my health, focus on school, and discover interests beyond programming. I want to make time for experiences that do not happen in front of a screen, and to remember that a life can be meaningful in more ways than the things I finish or the projects I release.

I still want to sit at my computer and write code. I still want to build things that once seemed beyond my ability. But I do not want programming to become the only thing I know how to do. I want to hold on to both parts of myself: **the developer who builds things and the person who experiences life.**

### What I Hope Arisa Will Mean

When I look back, I consider myself lucky to have experienced love, even though it did not turn out the way I hoped. I would not pretend that the hurt was easy, or that I would have chosen it. But loving someone taught me things about myself that I might never have learned otherwise: how much I can care, how deeply I can hope, and how important it is not to disappear inside the effort of loving another person.

Maybe love has not always given me the endings I wanted. Still, it has left me with lessons, memories, and a better understanding of the person I want to become. I can be thankful that I felt something real and, at the same time, accept that the story did not end the way I wished it would.

Arisa AI was created during heartbreak, but I do not want it to remain a symbol of sadness forever. I want it to grow into a reminder of what can come after a difficult chapter: growth, creativity, patience, and the choice to make something meaningful with the time and energy I have. The project began while I was trying to find a way through my feelings. I hope it can keep reminding me to move forward, with care for both my ambitions and myself.

I do not know exactly where Arisa AI will take me. I do not know how far I will go as a programmer, or what I will be capable of building in the years ahead. I only know that I want to keep improving—not just as a developer, but as a human being. I want to keep creating while also learning to pause, to take care of my health, to show up for school, and to be present for the life that is happening around me.

There is a person behind every project and every line of code. I am learning that the person who creates deserves the same patience, attention, and care that he pours into what he builds. **Because at the end of the day, there is a person behind every line of code, and that person deserves to be taken care of too.**
## Project Team

- **Creator & Developer — Ken (Fushitowa):** Created and developed Arisa AI, guiding the project’s direction and handling its design, implementation, feature development, debugging, and maintenance across the frontend, FastAPI backend, SQLite database, and Groq integration.
