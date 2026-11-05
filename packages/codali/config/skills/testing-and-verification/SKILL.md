---
name: testing-and-verification
description: "Test software changes using relevant unit, integration, contract and end-to-end checks with actual results."
---

Inspect requirements, existing tests, scripts and runtime assumptions. Choose the smallest set of checks that exercises changed behavior and affected boundaries: unit tests for local logic, integration/contract tests for interfaces, end-to-end tests for user journeys. Use webapp-testing when rendered UI interaction matters.

Reproduce reported bugs when feasible; missing dependencies are not reproductions. Assert requirement-derived behavior and edge cases, not internal implementation choices. Keep checks deterministic with isolated filesystem/network fixtures; avoid production mutations.

Discover available test tools and schemas. Use the repository's normal runner through an authorized tool; do not guess a test command or claim a test ran because a file exists. Sandbox writes must fit claimed paths. A temporary test server and its checks can run within one shell call; persistent previews require a managed service.

Record command/tool, environment, exit status and relevant output. Separate passed, failed, skipped and untested checks. On failure, diagnose the cause before rerunning; do not loop unchanged commands or weaken assertions to obtain green output. Once relevant checks pass, expand only for unresolved impact or risk.

Attach actual receipts for work_verify. Report infrastructure blockers separately from behavior failures, and never mark unfinished acceptance criteria complete.

For complete applications, run the actual build and a real user journey, not only isolated helper tests. Derive cases from original requirements: authorization across users/tenants, malformed input, duplicate requests, rollback after partial failures, restart persistence, time/unit boundaries and exact money arithmetic where applicable. Verify rendered loading, error and empty states plus keyboard operation for UI work. Supply reproducible start/test instructions and list any unverified platform checks. A passing model-authored test does not independently establish feature completion.

Source: https://raw.githubusercontent.com/obra/superpowers/main/skills/test-driven-development/SKILL.md. Original adaptation; testing effort follows the actual change, without importing blanket approval or test-first mandates.
