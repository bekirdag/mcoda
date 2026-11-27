---
name: browser-session
description: "Start persistent noVNC browser desktops, local static previews and SSH tunnels; recover sessions that disappear after shell calls."
---

Use `browser_session` with action `start`, then `status`. This host-managed desktop survives tool calls and TUI exit; it expires after eight hours. It returns an owned noVNC URL, static preview URL and an SSH forwarding template. Substitute the actual SSH user and server; never claim the Mac can connect until the tunnel exists. Keep the endpoints loopback-bound.

For browser_interact use browserPreviewUrl (port 8000 inside the container). The returned previewUrl is for the host/Mac through SSH; never guess other ports or host.docker.internal. One successful browser page check and browser_session status are sufficient before reporting the URL.

Do not launch background servers with run_shell: its isolated PID namespace is destroyed on return. nohup, setsid, tmux and cron cannot repair that lifecycle. Do not disable the sandbox or search for escape mechanisms.

Docker is required. First startup builds the bundled local image. If prerequisites are unavailable, report that specific blocker once; do not repeatedly probe unrelated launch methods. A static preview does not run backend application code.

Use browser_session stop only for the owned session when finished; leave it running when the user needs to inspect it. Inspect status before restarting. Distinguish HTTP readiness from a verified VNC connection.

Sources: https://github.com/novnc/noVNC and https://github.com/novnc/websockify. Codali-specific adaptation; no upstream scripts execute automatically.
