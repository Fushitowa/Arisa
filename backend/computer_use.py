"""Permission-gated Windows screen inspection and desktop interaction.

All automation is scoped to visible windows and UI Automation controls. This module
does not expose process execution or arbitrary shell commands to the language model.
"""

from __future__ import annotations

import base64
import io
import os
import re
import time
from typing import Any

MAX_CONTROLS = 140
MAX_TEXT = 240
_last_observation: dict[str, Any] = {"at": 0.0, "handle": None, "controls": [], "has_screenshot": False}


def _windows():
    if os.name != "nt":
        raise RuntimeError("Computer interaction is currently supported on Windows only.")
    try:
        from pywinauto import Desktop
    except ImportError as exc:
        raise RuntimeError("Windows UI Automation is not installed. Reinstall Arisa with its current dependencies.") from exc
    return Desktop(backend="uia")


def _safe_control_text(control) -> str:
    try:
        if control.element_info.control_type == "Edit" and control.is_password():
            return "[password field]"
    except Exception:
        pass
    try:
        text = str(control.window_text() or "").replace("\n", " ").strip()
        return text[:MAX_TEXT]
    except Exception:
        return ""


def _control_records(window):
    records = []
    try:
        controls = window.descendants()
    except Exception:
        return records
    for index, control in enumerate(controls[:MAX_CONTROLS]):
        try:
            info = control.element_info
            rect = control.rectangle()
            name = _safe_control_text(control)
            record = {
                "index": index,
                "name": name,
                "type": str(info.control_type or "Unknown")[:40],
                "automation_id": str(info.automation_id or "")[:100],
                "bounds": [int(rect.left), int(rect.top), int(rect.right), int(rect.bottom)],
                "enabled": bool(control.is_enabled()),
                "visible": bool(control.is_visible()),
            }
            records.append(record)
        except Exception:
            continue
    return records


def _foreground_window():
    windows = _windows()
    try:
        window = windows.get_active()
        if not window or not window.is_visible():
            return None
        return window
    except Exception:
        return None


def _screenshot_data_url() -> str:
    try:
        import mss
        from PIL import Image
    except ImportError as exc:
        raise RuntimeError("Screen capture dependencies are missing. Reinstall Arisa with its current dependencies.") from exc
    with mss.mss() as capture:
        monitor = capture.monitors[0]
        shot = capture.grab(monitor)
        image = Image.frombytes("RGB", shot.size, shot.rgb)
        image.thumbnail((1600, 1000))
        buffer = io.BytesIO()
        image.save(buffer, format="JPEG", quality=78, optimize=True)
    return "data:image/jpeg;base64," + base64.b64encode(buffer.getvalue()).decode("ascii")


def _send_unicode_text(value: str) -> None:
    """Type literal Unicode characters without interpreting shortcut syntax."""
    import ctypes
    from ctypes import wintypes

    ulong_ptr = ctypes.c_ulonglong if ctypes.sizeof(ctypes.c_void_p) == 8 else ctypes.c_ulong

    class KEYBDINPUT(ctypes.Structure):
        _fields_ = [("wVk", wintypes.WORD), ("wScan", wintypes.WORD), ("dwFlags", wintypes.DWORD),
                    ("time", wintypes.DWORD), ("dwExtraInfo", ulong_ptr)]

    class MOUSEINPUT(ctypes.Structure):
        _fields_ = [("dx", wintypes.LONG), ("dy", wintypes.LONG), ("mouseData", wintypes.DWORD),
                    ("dwFlags", wintypes.DWORD), ("time", wintypes.DWORD), ("dwExtraInfo", ulong_ptr)]

    class HARDWAREINPUT(ctypes.Structure):
        _fields_ = [("uMsg", wintypes.DWORD), ("wParamL", wintypes.WORD), ("wParamH", wintypes.WORD)]

    class INPUTUNION(ctypes.Union):
        _fields_ = [("mi", MOUSEINPUT), ("ki", KEYBDINPUT), ("hi", HARDWAREINPUT)]

    class INPUT(ctypes.Structure):
        _fields_ = [("type", wintypes.DWORD), ("union", INPUTUNION)]

    KEYEVENTF_KEYUP = 0x0002
    KEYEVENTF_UNICODE = 0x0004
    events = []
    for character in value:
        encoded = character.encode("utf-16-le", errors="surrogatepass")
        for offset in range(0, len(encoded), 2):
            code_unit = int.from_bytes(encoded[offset:offset + 2], "little")
            events.append(INPUT(type=1, union=INPUTUNION(ki=KEYBDINPUT(0, code_unit, KEYEVENTF_UNICODE, 0, 0))))
            events.append(INPUT(type=1, union=INPUTUNION(ki=KEYBDINPUT(0, code_unit, KEYEVENTF_UNICODE | KEYEVENTF_KEYUP, 0, 0))))
    if not events:
        return
    event_array = (INPUT * len(events))(*events)
    send_input = ctypes.WinDLL("user32", use_last_error=True).SendInput
    send_input.argtypes = (wintypes.UINT, ctypes.POINTER(INPUT), ctypes.c_int)
    send_input.restype = wintypes.UINT
    sent = send_input(len(event_array), event_array, ctypes.sizeof(INPUT))
    if sent != len(event_array):
        raise RuntimeError("Windows did not accept all typed characters.")


def observe_screen(include_screenshot: bool = False) -> dict[str, Any]:
    """Inspect the foreground window and accessible controls, optionally returning a screenshot."""
    global _last_observation
    window = _foreground_window()
    if not window:
        raise RuntimeError("There is no active application window to inspect.")
    handle = int(window.handle)
    title = str(window.window_text() or "")[:200]
    controls = _control_records(window)
    _last_observation = {"at": time.monotonic(), "handle": handle, "controls": controls, "title": title, "has_screenshot": include_screenshot}
    result: dict[str, Any] = {
        "active_window": title or "Untitled window",
        "control_count": len(controls),
        "controls": [c for c in controls if c["visible"] and (c["name"] or c["type"] in {"Button", "Edit", "TabItem", "MenuItem", "ListItem"})][:80],
        "observed_at": time.strftime("%H:%M:%S"),
    }
    if include_screenshot:
        result["screenshot_data_url"] = _screenshot_data_url()
    return result


def list_windows() -> dict[str, Any]:
    """List visible application windows without reading hidden/background windows."""
    rows = []
    for window in _windows().windows(visible_only=True, enabled_only=False):
        try:
            title = str(window.window_text() or "").strip()
            if title:
                rows.append({"title": title[:180], "handle": int(window.handle), "active": bool(window.is_active())})
        except Exception:
            continue
    return {"windows": rows[:40]}


def _require_fresh_observation():
    if not _last_observation["handle"] or time.monotonic() - _last_observation["at"] > 90:
        raise RuntimeError("Inspect the active window immediately before interacting with it.")
    window = _windows().window(handle=_last_observation["handle"])
    if not window.exists() or not window.is_visible():
        raise RuntimeError("The previously inspected window is no longer available. Inspect the screen again.")
    try:
        window.set_focus()
    except Exception as exc:
        raise RuntimeError("Could not focus the inspected application window.") from exc
    return window


def computer_action(action: str, *, target: str = "", text: str = "", keys: str = "", direction: str = "down", amount: int = 3) -> dict[str, Any]:
    """Perform a bounded action against the currently observed foreground window."""
    if action == "wait":
        seconds = max(1, min(5, int(amount)))
        time.sleep(seconds)
        return {"success": True, "action": action, "seconds": seconds}
    if action == "focus_window":
        requested_title = target.strip().casefold()
        if not requested_title:
            raise RuntimeError("Name the visible window to focus.")
        matches = []
        for candidate in _windows().windows(visible_only=True, enabled_only=False):
            try:
                if candidate.window_text().strip().casefold() == requested_title:
                    matches.append(candidate)
            except Exception:
                continue
        if len(matches) != 1:
            raise RuntimeError("That exact window title is not visible or is ambiguous. List visible windows and choose an exact title.")
        matches[0].set_focus()
        time.sleep(0.1)
        observation = observe_screen(include_screenshot=False)
        return {"success": True, "action": action, "window": observation["active_window"]}

    if action == "open_url":
        url = text.strip()
        if not re.match(r"^https?://", url, re.IGNORECASE) or len(url) > 2048:
            raise RuntimeError("Use a complete http or https website address.")
        window = _require_fresh_observation()
        if not re.search(r"(chrome|brave)", _last_observation["title"], re.IGNORECASE):
            raise RuntimeError("Open or focus Brave or Chrome first, then inspect it before navigating.")
        from pywinauto.keyboard import send_keys
        address_fields = [c for c in _last_observation["controls"] if c["visible"] and c["type"] == "Edit" and re.search(r"(address|search|url|omnibox)", c["name"], re.I)]
        if len(address_fields) != 1:
            raise RuntimeError("I could not identify one accessible browser address bar. Use Ctrl+L and type the address yourself, or enable screenshot sharing for visual guidance.")
        address = window.descendants()[address_fields[0]["index"]]
        address.set_edit_text(url)
        send_keys("{ENTER}")
        return {"success": True, "action": "open_url", "url": url}

    window = _require_fresh_observation()
    if action in {"media_play_pause", "media_next", "media_previous", "volume_up", "volume_down"}:
        if "spotify" not in _last_observation["title"].casefold():
            raise RuntimeError("Focus Spotify and inspect it before using its media controls.")
        virtual_keys = {
            "media_play_pause": 0xB3, "media_next": 0xB0, "media_previous": 0xB1,
            "volume_up": 0xAF, "volume_down": 0xAE,
        }
        import ctypes
        user32 = ctypes.WinDLL("user32", use_last_error=True)
        key = virtual_keys[action]
        user32.keybd_event(key, 0, 0, 0)
        user32.keybd_event(key, 0, 0x0002, 0)
        return {"success": True, "action": action, "window": _last_observation["title"]}
    if action in {"click_control", "double_click_control", "right_click_control", "move_to_control"}:
        matches = [c for c in _last_observation["controls"] if (c["name"] or c["automation_id"]).casefold() == target.casefold()]
        if len(matches) != 1:
            raise RuntimeError("That control is missing or ambiguous. Inspect the screen and identify a unique visible control.")
        item = matches[0]
        if not item["visible"] or not item["enabled"]:
            raise RuntimeError("That control is not currently visible and enabled.")
        control = window.descendants()[item["index"]]
        if action == "double_click_control":
            control.click_input(button="left", double=True)
        elif action == "right_click_control":
            control.click_input(button="right")
        elif action == "move_to_control":
            control.move_mouse_input()
        else:
            control.click_input()
        return {"success": True, "action": action, "target": item["name"] or item["automation_id"]}

    if action == "click_coordinates":
        if not _last_observation.get("has_screenshot"):
            raise RuntimeError("Coordinate clicks require a screenshot from the latest screen inspection. Use a named accessible control if screenshot sharing is off.")
        # Coordinates are allowed only when grounded in a fresh screen observation.
        try:
            x, y = [int(part.strip()) for part in target.split(",", 1)]
        except Exception as exc:
            raise RuntimeError("Coordinates must be supplied as x,y from the latest screenshot.") from exc
        hit = [control for control in _last_observation["controls"] if control["visible"] and control["bounds"][0] <= x <= control["bounds"][2] and control["bounds"][1] <= y <= control["bounds"][3]]
        hit.sort(key=lambda control: max(0, control["bounds"][2] - control["bounds"][0]) * max(0, control["bounds"][3] - control["bounds"][1]))
        if not hit or not hit[0]["enabled"] or (len(hit) > 1 and hit[0]["bounds"] == hit[1]["bounds"]):
            raise RuntimeError("The point does not identify exactly one visible, enabled control. Inspect again and target a named control.")
        if re.search(r"\b(send|submit|purchase|buy|delete|remove|erase|clear|reset|replace|overwrite|security|payment|checkout)\b", hit[0]["name"], re.I):
            raise RuntimeError("This control can perform a sensitive or irreversible action and requires the user to do it directly.")
        window.descendants()[hit[0]["index"]].click_input()
        return {"success": True, "action": action, "target": hit[0]["name"] or hit[0]["type"]}

    if action == "type_text":
        value = text[:10000]
        try:
            focused = window.get_focus()
            if focused.is_password():
                raise RuntimeError("Typing into a password field is disabled to protect credentials.")
        except RuntimeError:
            raise
        except Exception:
            pass
        try:
            _send_unicode_text(value)
        except Exception as exc:
            raise RuntimeError("Text could not be entered into the active application.") from exc
        return {"success": True, "action": action, "characters": len(value)}

    if action == "press_keys":
        allowed = {"ENTER", "TAB", "ESC", "ESCAPE", "CTRL+Z", "CTRL+Y", "CTRL+S", "CTRL+N", "CTRL+L", "CTRL+T", "CTRL+W", "ALT+LEFT", "ALT+RIGHT", "SPACE", "HOME", "END", "PGUP", "PGDN"}
        normalized = keys.upper().replace(" ", "")
        if normalized not in {key.replace(" ", "") for key in allowed}:
            raise RuntimeError("That keyboard shortcut is not in Arisa's safe shortcut list.")
        if normalized == "ENTER" and any(re.search(r"\b(send|submit|purchase|buy|delete|remove|clear|reset|replace|overwrite|checkout)\b", c["name"], re.I) and c["visible"] for c in _last_observation["controls"]):
            raise RuntimeError("A visible form action could be triggered by Enter. Arisa will not submit forms automatically.")
        from pywinauto.keyboard import send_keys
        translated = normalized.replace("CTRL+", "^{").replace("ALT+", "%{")
        if "{" in translated:
            translated += "}"
        else:
            translated = "{" + normalized + "}"
        send_keys(translated)
        return {"success": True, "action": action, "keys": normalized}

    if action == "scroll":
        direction = direction.lower()
        if direction not in {"up", "down"}:
            raise RuntimeError("Scroll direction must be up or down.")
        from pywinauto.keyboard import send_keys
        page_key = "{PGUP}" if direction == "up" else "{PGDN}"
        for _ in range(max(1, min(10, int(amount)))):
            send_keys(page_key)
        return {"success": True, "action": action, "direction": direction}

    raise RuntimeError("Unsupported computer action.")

