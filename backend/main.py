import os
import sqlite3
import uuid
from contextlib import contextmanager
from datetime import datetime, timezone
from pathlib import Path
from typing import Optional

import pymupdf
from dotenv import load_dotenv
from fastapi import FastAPI, File, HTTPException, UploadFile
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel, Field

load_dotenv()
DB_PATH = Path(os.getenv("DATABASE_PATH", str(Path(__file__).parent / "lizz.db")))
MAX_UPLOAD = int(os.getenv("MAX_UPLOAD_MB", "10")) * 1024 * 1024
MODEL = os.getenv("GROQ_MODEL", "openai/gpt-oss-120b")
# Older setup guides used Llama 3.3, which Groq deprecated in August 2026.
if MODEL in {"llama-3.3-70b-versatile", "llama-3.1-8b-instant"}:
    MODEL = "openai/gpt-oss-120b"
ALLOWED = {".pdf", ".txt", ".md"}

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
        """)


initialize()


class ChatRequest(BaseModel):
    conversation_id: Optional[str] = None
    message: str = Field(min_length=1, max_length=12000)


class MemoryRequest(BaseModel):
    content: str = Field(min_length=1, max_length=2000)


class TaskRequest(BaseModel):
    title: str = Field(min_length=1, max_length=500)


class TaskUpdate(BaseModel):
    completed: bool


@app.get("/api/health")
def health():
    return {"status": "ok", "groq_configured": bool(os.getenv("GROQ_API_KEY")), "model": MODEL}


@app.post("/api/chat")
def chat(body: ChatRequest):
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
            memories = conn.execute("SELECT content FROM memories ORDER BY created_at DESC LIMIT 20").fetchall()
            docs = conn.execute("SELECT filename,content FROM documents ORDER BY created_at DESC LIMIT 8").fetchall()
            context = "You are Arisa, a thoughtful and practical personal AI assistant. Be warm, clear, and concise.\n"
            if memories:
                context += "\nUser-saved memories (use only when relevant):\n" + "\n".join(f"- {m['content']}" for m in memories)
            if docs:
                # Keep bounded context; a later phase can replace this with retrieval.
                excerpts = [f"[{d['filename']}] {d['content'][:5000]}" for d in docs]
                context += "\n\nUploaded document excerpts (use only when relevant; cite filenames):\n" + "\n\n".join(excerpts)
            messages = [{"role": "system", "content": context}]
            messages.extend({"role": r["role"], "content": r["content"]} for r in prior[-24:])
            messages.append({"role": "user", "content": body.message})
            result = client.chat.completions.create(model=MODEL, messages=messages, temperature=0.6, max_tokens=1200)
            reply = result.choices[0].message.content or "I wasn't able to form a response just now."
            timestamp = now()
            conn.execute("INSERT INTO messages VALUES(?,?,?,?,?)", (str(uuid.uuid4()), conversation_id, "user", body.message, timestamp))
            conn.execute("INSERT INTO messages VALUES(?,?,?,?,?)", (str(uuid.uuid4()), conversation_id, "assistant", reply, timestamp))
            conn.execute("UPDATE conversations SET updated_at=? WHERE id=?", (timestamp, conversation_id))
        return {"conversation_id": conversation_id, "reply": reply}
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
    item = {"id": str(uuid.uuid4()), "content": body.content.strip(), "created_at": now()}
    with db() as conn:
        conn.execute("INSERT INTO memories VALUES(?,?,?)", tuple(item.values()))
    return item


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
