---
name: system-services
description: "Inspect, configure or recover managed services using available host connectors; distinguish host services from sandbox processes."
---

Identify the target host, service manager, exact service/project identity and intended scope. Discover the advertised management tools and their schemas before issuing host operations. Codali's default run_shell is isolated: it cannot reliably access the host service manager or keep background processes alive. Full permission does not remove that boundary.

For noVNC/static previews use browser_session and its matching skill. For a general backend or system service, use an available authorized host connector. If none exists, state that limitation once; continue useful workspace inspection or preparation, but do not claim a service was started. Do not invent a service tool or try sandbox escapes, nohup, cron or repeated launch variants.

With actual host access, inspect status, bounded recent logs, config location, dependencies and health evidence before changing anything. Preserve the existing service owner and deployment method. Keep operations within the user's authorized scope; avoid unrelated restarts and retain a rollback for configuration changes. Read only the matching reference via skill_read:
- references/linux.md for systemd.
- references/macos.md for launchd.
- references/docker.md for Docker/Compose.

After an authorized change, verify service state, application readiness and continued availability in a separate call. Running is not the same as ready; a localhost response does not prove access from another machine. Report the endpoint, access method and limits truthfully.

References link upstream OS/container documentation. Instructions do not grant host access or execute automatically.
