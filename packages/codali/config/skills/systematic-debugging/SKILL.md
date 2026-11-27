---
name: systematic-debugging
description: "Diagnose repeated tool, build or service failures using concrete evidence and bounded experiments before changing strategy."
---

Capture the exact failing command/tool, error and relevant logs. Separate model transport failures from application errors and host capability limits. Find the earliest failure rather than treating later symptoms as the cause.

State a hypothesis and perform one small test that can disprove it. Change one relevant factor; compare the new result with the original evidence. After the same failure recurs, inspect the responsible layer or load its skill instead of repeating equivalent commands.

A missing capability needs a capability fix: per-call shell processes cannot become persistent through different backgrounding syntax. Use managed lifecycle tools. Preserve checkpoints on model-service errors; do not replay side effects whose completion is uncertain.

Fix the root cause, add a meaningful regression check, then test the actual user path. Report successful checks separately from remaining blockers.

Source: https://github.com/obra/superpowers/blob/main/skills/systematic-debugging/SKILL.md. Original condensed adaptation for Codali.
