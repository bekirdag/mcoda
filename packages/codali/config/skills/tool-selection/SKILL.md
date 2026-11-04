---
name: tool-selection
description: "Choose and invoke available tools for repository, web, calculation, browser and operating-system tasks efficiently."
---

Start with the operation and required evidence. Inspect advertised capabilities; use tools_discover/tools_enable or tools_describe only when exposed by the current runtime. Read the actual input schema before an unfamiliar call. If only tool names are known, describe the intended operation and request/discover its schema; omit argument objects rather than inventing parameter names. A tool mentioned in a skill may not be connected on this machine.

Use Docdex for repository search, structure, impact and memory; use its web research for external facts and verify primary pages when needed. Use calculate or an advertised deterministic math/data/validation tool for exact operations, and server_time for current server time. Choose a specialist media tool for media generation. The LLM interprets and explains results; it should not simulate a tool result.

Use browser_open/browser_read for read-only page evidence, browser_session for persistent noVNC/static previews, and browser_interact for authorized actions in that desktop. Use a discovered host-management connector for host services. run_shell is workspace-scoped and temporary, not a substitute for host access or persistent service management.

Pass minimal sufficient context and narrow arguments. Follow result pagination instead of repeatedly fetching the same content. Batch independent reads when supported. On an error, distinguish invalid arguments, unavailable capability, permission denial and transient failure. Correct a demonstrated cause before retrying; a denial is not permission to bypass it.

Check the returned evidence against the requested outcome. Preserve URLs, units, timestamps and uncertainty; explain relevant results in plain language. Load only the matching skill and references, not the whole catalog.

Reference: Codali README.md, ORCHESTRATION.md and advertised runtime tool schemas. These runtime schemas are authoritative over examples.
