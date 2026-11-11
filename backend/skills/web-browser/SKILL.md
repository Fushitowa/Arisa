---
name: web-browser
description: Handle user-requested searches and navigation in supported Windows browsers.
---

# Web Browser

Supported browser applications are the existing registered Brave and Google Chrome entries. Use the application launcher when a named browser is not open; “my browser” is ambiguous when both are supported. Inspect the active window before interaction. Navigate only to a complete http(s) address using `open_url`, or use visible controls and safe keyboard shortcuts such as Ctrl+L, Ctrl+T, Ctrl+W, and Enter for a user-requested search. Inspect the page after navigation and base summaries on visible/accessibly exposed page content. If the page has inaccessible content, ask for screenshot sharing or state the limitation. Never submit forms or credentials.
