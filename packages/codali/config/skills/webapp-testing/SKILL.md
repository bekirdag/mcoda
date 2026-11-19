---
name: webapp-testing
description: "Verify a local web UI with observed page state and browser interactions; distinguish static previews from backend services."
---

Read the application entry point and package scripts before choosing a launch method. For a static site, browser_session provides a persistent read-only preview. In its browser the workspace is served at http://127.0.0.1:8000/. The returned previewUrl is the host URL for SSH forwarding; it uses a different port.

For a backend, use its existing managed service or an authorized host service workflow. A temporary run_shell server can support checks within that single call, but cannot provide a persistent demo URL.

Inspect rendered page state before selecting controls. Exercise the requested user journey, verify visible outcomes, and run the project's real tests separately. A successful HTTP fetch does not prove interactivity. Record the tested URL and observed results; identify untested behavior.

Source: https://github.com/anthropics/skills/blob/main/skills/webapp-testing/SKILL.md. Original Codali adaptation of its inspect-before-action workflow; no upstream scripts bundled.
