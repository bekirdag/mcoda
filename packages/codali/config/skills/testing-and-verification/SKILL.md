---
name: testing-and-verification
description: "Verify software with real unit, integration, contract and UI checks."
---

Inspect requirements, exports, tests, scripts and runtime before writing tests; never invent API names. Derive expected results independently from requirements, not from implementation. Cover boundaries, empties, ties/order, duplicates, cancellation/rejections, units and rounding. For stateful rules, test invalid-to-valid sequences; a rejected step must not corrupt later valid behavior unless specified. Resolve contradictory model-written expectations from the original requirement.

Reproduce bugs with isolated fixtures and the repository runner. Missing dependencies are not reproductions. Discover tool schemas. Node --test uses default discovery or explicit test files; a directory argument is not portable test discovery. For supplied Python answers, verify_tests runner python supports standard-library unittest.TestCase, not pytest.

For apps, exercise the actual setup, build, entrypoint and a real user journey, not just helper tests. Verify persisted seed state, restart persistence, authorization, invalid input, duplicate requests, rollback and concurrency. Before a negative authorization test, prove authentication, fixture existence and a permitted operation succeed. A missing route returning 404 proves nothing about tenant isolation. Zero tests, syntax-only checks, no-op scripts and placeholder UI do not prove domain functionality.

Use webapp-testing for rendered interaction: loading/error/empty states, keyboard operation and responsive layout. Temporary servers and checks can share one shell call; persistent previews need managed services. Sandbox writes must fit claimed paths.

Record commands, environment, exit status and output. Distinguish passed, failed, skipped and untested. Diagnose before rerunning; never loop unchanged checks or weaken requirements. Expand checks only for unresolved impact/risk. Attach actual receipts to work_verify. Provide reproducible start/test instructions and disclose infrastructure or platform blockers. Model-authored passing tests are limited evidence, not independent proof of completion.

Source: https://raw.githubusercontent.com/obra/superpowers/main/skills/test-driven-development/SKILL.md. Adaptation without blanket approval or test-first mandates.
