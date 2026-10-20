# Arisa AI

A personal AI workspace with a React/Vite frontend and a FastAPI backend. Conversations, user-saved memories, tasks, and extracted document text are stored in a local SQLite database. Groq credentials stay on the backend.

## Run locally

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
- SQLite conversation, memory, and task persistence
- PDF, TXT, and Markdown upload with size and file type validation
- Saved memory context and bounded uploaded document excerpts in chat prompts

Document retrieval currently places bounded excerpts from recent uploads in the prompt. Semantic/vector search, authentication, scheduled reminders, and approved external tool execution are future phases. The initial API is intended for local development; add authentication and deployment hardening before exposing it to other users.



