"""Arisa AI desktop quick-start panel."""

from __future__ import annotations

import os
import queue
import shutil
import subprocess
import sys
import threading
import webbrowser
import tkinter as tk
from pathlib import Path
from tkinter import messagebox, ttk


ROOT = Path(__file__).resolve().parent
BACKEND = ROOT / "backend"
DATABASE = BACKEND / "lizz.db"
FRONTEND_URL = "http://localhost:5173"
API_URL = "http://127.0.0.1:8000/docs"
BG = "#10111a"
PANEL = "#191b28"
TEXT = "#f1f2f8"
MUTED = "#a4a8bd"
ACCENT = "#8b6cff"
GREEN = "#45d483"
RED = "#ff6b75"


def backend_python() -> str:
    """Prefer the backend virtual environment when it exists."""
    if os.name == "nt":
        candidate = BACKEND / ".venv" / "Scripts" / "python.exe"
    else:
        candidate = BACKEND / ".venv" / "bin" / "python"
    return str(candidate) if candidate.is_file() else (shutil.which("python") or sys.executable)


class QuickStart:
    def __init__(self, root: tk.Tk) -> None:
        self.root = root
        self.root.title("Arisa AI | Quick Start")
        self.root.geometry("760x650")
        self.root.minsize(650, 560)
        self.root.configure(bg=BG)
        self.processes: dict[str, subprocess.Popen[str]] = {}
        self.output_queue: queue.Queue[tuple[str, str]] = queue.Queue()
        self.python = backend_python()

        self._configure_styles()
        self._build_ui()
        self.root.protocol("WM_DELETE_WINDOW", self.close)
        self.root.after(150, self._poll)
        self._log("Ready. Start both services or choose one below.")
        self._refresh_database_status()

    def _configure_styles(self) -> None:
        style = ttk.Style()
        style.theme_use("clam")
        style.configure("TFrame", background=BG)
        style.configure("Panel.TFrame", background=PANEL)
        style.configure("TLabel", background=BG, foreground=TEXT, font=("Segoe UI", 10))
        style.configure("Muted.TLabel", background=BG, foreground=MUTED, font=("Segoe UI", 9))
        style.configure("Panel.TLabel", background=PANEL, foreground=TEXT, font=("Segoe UI", 10))
        style.configure("Title.TLabel", background=BG, foreground=TEXT, font=("Segoe UI Semibold", 22))
        style.configure("Section.TLabel", background=BG, foreground=TEXT, font=("Segoe UI Semibold", 12))
        style.configure("TButton", font=("Segoe UI Semibold", 10), padding=(12, 9))
        style.configure("Accent.TButton", background=ACCENT, foreground="white")
        style.map("Accent.TButton", background=[("active", "#7658e8"), ("disabled", "#4a465c")])
        style.configure("Secondary.TButton", background="#292c3d", foreground=TEXT)
        style.map("Secondary.TButton", background=[("active", "#373a50")])

    def _build_ui(self) -> None:
        outer = ttk.Frame(self.root, padding=24)
        outer.pack(fill="both", expand=True)

        ttk.Label(outer, text="Arisa AI", style="Title.TLabel").pack(anchor="w")
        ttk.Label(outer, text="Quick Start · Local services", style="Muted.TLabel").pack(anchor="w", pady=(2, 18))

        services = ttk.Frame(outer, style="Panel.TFrame", padding=16)
        services.pack(fill="x")
        ttk.Label(services, text="Services", style="Panel.TLabel", font=("Segoe UI Semibold", 12)).pack(anchor="w", pady=(0, 12))

        self.backend_status = self._service_row(services, "API / Backend", "FastAPI · 127.0.0.1:8000")
        self.frontend_status = self._service_row(services, "Web app", "Vite · localhost:5173")

        db_row = ttk.Frame(services, style="Panel.TFrame")
        db_row.pack(fill="x", pady=(4, 0))
        ttk.Label(db_row, text="Database", style="Panel.TLabel", width=18).pack(side="left")
        self.database_status = ttk.Label(db_row, text="SQLite · starts with the API", style="Panel.TLabel", foreground=MUTED)
        self.database_status.pack(side="left", fill="x", expand=True)
        ttk.Button(db_row, text="Open folder", style="Secondary.TButton", command=self.open_database_folder).pack(side="right")

        actions = ttk.Frame(outer)
        actions.pack(fill="x", pady=16)
        ttk.Button(actions, text="Start All", style="Accent.TButton", command=self.start_all).pack(side="left")
        ttk.Button(actions, text="Start API", style="Secondary.TButton", command=self.start_backend).pack(side="left", padx=(8, 0))
        ttk.Button(actions, text="Start Web App", style="Secondary.TButton", command=self.start_frontend).pack(side="left", padx=(8, 0))
        ttk.Button(actions, text="Stop All", style="Secondary.TButton", command=self.stop_all).pack(side="right")

        links = ttk.Frame(outer)
        links.pack(fill="x", pady=(0, 14))
        ttk.Button(links, text="Open Arisa AI", style="Secondary.TButton", command=lambda: webbrowser.open(FRONTEND_URL)).pack(side="left")
        ttk.Button(links, text="Open API Docs", style="Secondary.TButton", command=lambda: webbrowser.open(API_URL)).pack(side="left", padx=(8, 0))

        ttk.Label(outer, text="Activity", style="Section.TLabel").pack(anchor="w", pady=(0, 7))
        log_wrap = ttk.Frame(outer)
        log_wrap.pack(fill="both", expand=True)
        self.log = tk.Text(
            log_wrap,
            bg="#0b0c12",
            fg="#d9dcef",
            insertbackground=TEXT,
            relief="flat",
            wrap="word",
            font=("Consolas", 9),
            padx=12,
            pady=10,
            state="disabled",
        )
        scrollbar = ttk.Scrollbar(log_wrap, orient="vertical", command=self.log.yview)
        self.log.configure(yscrollcommand=scrollbar.set)
        self.log.pack(side="left", fill="both", expand=True)
        scrollbar.pack(side="right", fill="y")

        ttk.Label(
            outer,
            text="SQLite is a local database file managed by the API; it does not run as a separate server.",
            style="Muted.TLabel",
            wraplength=700,
        ).pack(anchor="w", pady=(10, 0))

    def _service_row(self, parent: ttk.Frame, name: str, detail: str) -> ttk.Label:
        row = ttk.Frame(parent, style="Panel.TFrame")
        row.pack(fill="x", pady=4)
        ttk.Label(row, text=name, style="Panel.TLabel", width=18).pack(side="left")
        ttk.Label(row, text=detail, style="Panel.TLabel", foreground=MUTED).pack(side="left", fill="x", expand=True)
        status = ttk.Label(row, text="Stopped", style="Panel.TLabel", foreground=MUTED)
        status.pack(side="right")
        return status

    def _log(self, message: str) -> None:
        self.log.configure(state="normal")
        self.log.insert("end", message.rstrip() + "\n")
        self.log.see("end")
        self.log.configure(state="disabled")

    def _set_status(self, service: str, label: str, running: bool) -> None:
        widget = self.backend_status if service == "backend" else self.frontend_status
        widget.configure(text=label, foreground=GREEN if running else MUTED)

    def _refresh_database_status(self) -> None:
        if DATABASE.exists():
            self.database_status.configure(text=f"SQLite · ready · {DATABASE.name}", foreground=GREEN)
        elif "backend" in self.processes and self.processes["backend"].poll() is None:
            self.database_status.configure(text="SQLite · initializing…", foreground=ACCENT)
        else:
            self.database_status.configure(text="SQLite · created when API starts", foreground=MUTED)

    def _start(self, service: str, command: list[str] | str, cwd: Path, *, shell: bool = False) -> None:
        current = self.processes.get(service)
        if current and current.poll() is None:
            self._log(f"{service.title()} is already running.")
            return
        try:
            process = subprocess.Popen(
                command,
                cwd=cwd,
                shell=shell,
                stdout=subprocess.PIPE,
                stderr=subprocess.STDOUT,
                text=True,
                encoding="utf-8",
                errors="replace",
                bufsize=1,
            )
        except OSError as exc:
            self._log(f"Could not start {service}: {exc}")
            messagebox.showerror("Could not start service", str(exc), parent=self.root)
            return

        self.processes[service] = process
        self._set_status(service, "Starting…", True)
        threading.Thread(target=self._read_output, args=(service, process), daemon=True).start()
        self._log(f"Starting {service}…")
        self._refresh_database_status()

    def _read_output(self, service: str, process: subprocess.Popen[str]) -> None:
        if process.stdout:
            for line in process.stdout:
                self.output_queue.put((service, line.rstrip()))
        process.wait()
        self.output_queue.put((service, f"[process exited with code {process.returncode}]"))

    def start_backend(self) -> None:
        if not (BACKEND / "main.py").is_file():
            messagebox.showerror("Backend not found", f"Could not find {BACKEND / 'main.py'}", parent=self.root)
            return
        check = subprocess.run(
            [self.python, "-c", "import fastapi, uvicorn"],
            cwd=BACKEND,
            stdout=subprocess.DEVNULL,
            stderr=subprocess.DEVNULL,
            check=False,
        )
        if check.returncode:
            messagebox.showerror(
                "Backend dependencies missing",
                "FastAPI and Uvicorn are not installed in the selected Python environment.\n\n"
                "Open a terminal in the project folder and run:\n"
                "  cd backend\n  python -m venv .venv\n"
                "  .venv\\Scripts\\python -m pip install -r requirements.txt",
                parent=self.root,
            )
            return
        if not (BACKEND / ".env").is_file():
            self._log("backend/.env is missing. AI chat needs a Groq API key in that file.")
        self._start(
            "backend",
            [self.python, "-m", "uvicorn", "main:app", "--reload", "--host", "127.0.0.1", "--port", "8000"],
            BACKEND,
        )

    def start_frontend(self) -> None:
        npm = shutil.which("npm")
        if not npm:
            messagebox.showerror("Node.js not found", "Install Node.js (which includes npm), then open this panel again.", parent=self.root)
            return
        if not (ROOT / "node_modules").is_dir():
            messagebox.showerror("Frontend packages missing", "Open a terminal in the project folder and run:\n\n  npm install", parent=self.root)
            return
        if os.name == "nt":
            self._start("frontend", "npm run dev", ROOT, shell=True)
        else:
            self._start("frontend", [npm, "run", "dev"], ROOT)

    def start_all(self) -> None:
        self.start_backend()
        self.start_frontend()

    def _stop(self, service: str) -> None:
        process = self.processes.get(service)
        if not process or process.poll() is not None:
            self._set_status(service, "Stopped", False)
            return
        self._log(f"Stopping {service}…")
        if os.name == "nt":
            subprocess.run(
                ["taskkill", "/PID", str(process.pid), "/T", "/F"],
                stdout=subprocess.DEVNULL,
                stderr=subprocess.DEVNULL,
                check=False,
            )
        else:
            process.terminate()
        try:
            process.wait(timeout=5)
        except subprocess.TimeoutExpired:
            process.kill()
        self._set_status(service, "Stopped", False)
        self.processes.pop(service, None)
        self._refresh_database_status()

    def stop_all(self) -> None:
        self._stop("frontend")
        self._stop("backend")
        self._log("All services stopped.")

    def open_database_folder(self) -> None:
        try:
            if os.name == "nt":
                os.startfile(str(BACKEND))
            elif sys.platform == "darwin":
                subprocess.Popen(["open", str(BACKEND)])
            else:
                subprocess.Popen(["xdg-open", str(BACKEND)])
        except OSError as exc:
            messagebox.showerror("Could not open folder", str(exc), parent=self.root)

    def _poll(self) -> None:
        while True:
            try:
                service, line = self.output_queue.get_nowait()
            except queue.Empty:
                break
            if line:
                self._log(f"[{service}] {line}")
        for service in ("backend", "frontend"):
            process = self.processes.get(service)
            if process:
                if process.poll() is None:
                    label = "Running" if process.pid else "Starting…"
                    self._set_status(service, label, True)
                else:
                    self._set_status(service, "Stopped", False)
        self._refresh_database_status()
        self.root.after(150, self._poll)

    def close(self) -> None:
        self.stop_all()
        self.root.destroy()


def main() -> None:
    root = tk.Tk()
    QuickStart(root)
    root.mainloop()


if __name__ == "__main__":
    main()
