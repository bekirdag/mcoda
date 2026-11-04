---
name: testing-and-verification
description: "Test software changes using relevant unit, integration, contract and end-to-end checks with observed results."
---

Inspect requirements, existing tests, scripts and runtime assumptions. Choose the smallest set of checks that exercises changed behavior and affected boundaries: unit tests for local logic, integration/contract tests for interfaces, end-to-end tests for user journeys. Use webapp-testing when rendered UI interaction matters.

For a reported bug, reproduce it before the repair when feasible. A failure must exercise the intended defect, not a missing dependency or test typo. Include meaningful boundaries and error paths. Assert observable contract invariants, not a preferred implementation. Distinguish attempted calls from committed effects; do not require invented state names or exact internal call counts unless the contract requires them. Keep tests deterministic; isolate filesystem/network effects, use fixtures for external services, and clean up only resources owned by the test. Avoid production mutations.

Discover the actual available test tools and schemas. Use the repository's normal runner through an authorized tool; do not guess a test command or claim a test ran because a file exists. Sandbox writes must fit claimed paths. A temporary test server and its checks can run within one shell call; persistent previews require a managed service.

Record command/tool, environment, exit status and relevant output. Separate passed, failed, skipped and untested checks. On failure, diagnose the cause before rerunning; do not loop unchanged commands or weaken assertions to obtain green output. Once relevant checks pass, expand only for unresolved impact or risk.

Attach actual receipts for work_verify. Report infrastructure blockers separately from behavior failures, and never mark unfinished acceptance criteria complete.

Source: https://raw.githubusercontent.com/obra/superpowers/main/skills/test-driven-development/SKILL.md. Original adaptation; testing effort follows the actual change, without importing blanket approval or test-first mandates.
