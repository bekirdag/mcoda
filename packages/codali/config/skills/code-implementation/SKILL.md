---
name: code-implementation
description: "Write or modify code in an existing project, preserving contracts and conventions with focused verification."
---

Read the requested behavior and the canonical work record. Inspect the relevant source, callers, tests and package scripts with Docdex. Use current symbols/AST and impact evidence before existing-source edits; prepare_edit can assemble the required read/analysis. If the host reports Docdex unavailable, disclose that and use available reads/search without inventing receipts.

Claim the ready task with work_claim and narrow allowedPaths before edits. Reuse the project's language, interfaces, dependencies and error conventions. Fix the behavior at its owning layer; avoid unrelated rewrites, speculative abstractions and introducing dependencies without need. Preserve user edits and compatibility contracts.

Use write_file with small exact replacements; do not overwrite an unread file. For a bug, reproduce the failing behavior when feasible, then make the smallest coherent repair and run a meaningful regression check. For new behavior, derive checks from requirements, including relevant boundary/failure cases. Do not add tests that merely duplicate implementation text.

run_shell requires command plus an args array; cwd is workspace-relative. Its writePaths are root-relative even when cwd changes. Keep required writes within claimed scope. It cannot preserve a background server between calls.

Review the resulting diff and actual check output. Attach real invocation evidence to work_verify; complete only satisfied criteria. Report changed behavior, validation and remaining limitations. Existing authorization persists; skill loading does not add approval gates.

Sources: https://google.github.io/eng-practices/review/reviewer/looking-for.html and https://raw.githubusercontent.com/obra/superpowers/main/skills/test-driven-development/SKILL.md. Adapted to Codali tools; blanket TDD and extra approval requirements are not imported.
