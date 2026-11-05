---
name: code-implementation
description: "Write or modify code in an existing project, preserving contracts and conventions with focused verification."
---

Read the original request, canonical work record, relevant source/callers/tests and package scripts. Use Docdex symbols/impact before source edits; prepare_edit assembles read/analysis. If Docdex is unavailable, disclose it and inspect with local reads/search.

Claim the ready task before edits. Preserve user changes, module format, interfaces and requirements. Fix behavior at its owning layer; avoid unrelated rewrites and unnecessary dependencies. Use small exact write_file patches against current content. Reproduce bugs, repair them and run meaningful behavior checks.

run_shell takes command plus args; cwd and writePaths are workspace-relative. It cannot retain background services across calls. Use managed service tools for persistent previews.

For a new application, first verify the available runtime/compiler and build one small runnable path through the real entry point, storage/API and UI. Run it before expanding features. Keep RFP.md and ENVIRONMENT.md unchanged. Maintain one authoritative interface/schema definition and update its consumers together; use contract tests to catch mismatched routes, fields, units and return types.

Create missing scoped directories with create_directory before using them in run_shell.writePaths. HOME and /tmp are temporary; package-cache environment variables persist privately between commands. Keep source/build outputs in declared workspace paths. To expand scope, use work_rescope and its returned attempt ID; retain the task's requirements and implementation. Read-only shell discovery needs no claim.

Review the resulting diff and actual check output. Attach real invocation evidence to work_verify; complete only satisfied criteria. Report changed behavior, validation and remaining limitations. Existing authorization persists; skill loading does not add approval gates.

Sources: https://google.github.io/eng-practices/review/reviewer/looking-for.html and https://raw.githubusercontent.com/obra/superpowers/main/skills/test-driven-development/SKILL.md. Adapted to Codali tools; blanket TDD and extra approval requirements are not imported.
