# Agents + Routing Review Tasks

Tasks derived from:
- `docs/reviews/agents-review.md`
- `docs/reviews/routing-review.md`

Each task includes slug, title, detailed description, files to touch, tests, dependencies, and acceptance criteria.

---

## Task 01
- **Slug** `agent-help-handling`
- **Title** Handle `mcoda agent --help` and subcommand help without throwing
- **Detailed description**
  - Update `AgentsCommands.run` to detect `--help`/`-h` before throwing errors so help output is printed and exit code remains 0.
  - Ensure `mcoda agent --help` prints the top‑level usage block.
  - Ensure `mcoda agent <sub> --help` (e.g., `list --help`) also prints usage instead of throwing.
  - Preserve existing error behavior for unknown subcommands or missing required args when `--help` is not provided.
  - Add a focused CLI test that asserts `--help` prints usage and does not throw.
- **Files to touch**
  - `packages/cli/src/commands/agents/AgentsCommands.ts`
  - `packages/cli/src/__tests__/AgentsCommands.test.ts`
- **Tests**
  - **Unit** `packages/cli/src/__tests__/AgentsCommands.test.ts` (new help test case)
  - **Component** none
  - **Integration** none
  - **API** none
- **Dependencies** none
- **Acceptance criteria**
  - `mcoda agent --help` prints the usage block and exits successfully.
  - `mcoda agent list --help` prints the same usage block and exits successfully.
  - Tests confirm the behavior without throwing.

---

## Task 02
- **Slug** `agent-prompt-flag-validation`
- **Title** Validate missing `--prompt`/`--prompt-file`/`--task-file` values
- **Detailed description**
  - In `AgentRunCommand`, treat `--prompt`, `--prompt-file`, and `--task-file` with no following value as invalid and throw a targeted error message (e.g., “Missing value for --prompt”).
  - In `TestAgentCommand`, treat `--prompt` with no value as invalid and throw a targeted error message.
  - Keep the existing “No prompts provided” error for cases where all inputs are empty but values were correctly provided.
  - Add tests that exercise the missing‑value error for both commands.
- **Files to touch**
  - `packages/cli/src/commands/agents/AgentRunCommand.ts`
  - `packages/cli/src/commands/agents/TestAgentCommand.ts`
  - `packages/cli/src/__tests__/AgentRunCommand.test.ts`
  - `packages/cli/src/__tests__/TestAgentCommand.test.ts`
- **Tests**
  - **Unit** `packages/cli/src/__tests__/AgentRunCommand.test.ts` (new missing‑value test)
  - **Unit** `packages/cli/src/__tests__/TestAgentCommand.test.ts` (new missing‑value test)
  - **Component** none
  - **Integration** none
  - **API** none
- **Dependencies** none
- **Acceptance criteria**
  - Missing values for `--prompt`, `--prompt-file`, or `--task-file` in `agent-run` trigger a clear, specific error.
  - Missing value for `test-agent --prompt` triggers a clear, specific error.
  - Tests cover these error paths.

---

## Task 03
- **Slug** `agent-stdin-opt-in`
- **Title** Allow combining stdin with explicit prompts via `--stdin`
- **Detailed description**
  - Add a new `--stdin` flag to `mcoda agent-run` usage.
  - When `--stdin` is present:
    - Read stdin even if other prompt flags were provided.
    - Append stdin content as an additional prompt when non‑empty.
  - When `--stdin` is absent:
    - Preserve existing behavior (stdin is only read if no prompt flags were provided).
  - Update usage text and parsing logic to reflect the new flag.
  - Add a test that pipes stdin into `agent-run` with `--stdin` and verifies the prompt list includes the stdin content.
- **Files to touch**
  - `packages/cli/src/commands/agents/AgentRunCommand.ts`
  - `packages/cli/src/__tests__/AgentRunCommand.test.ts`
- **Tests**
  - **Unit** `packages/cli/src/__tests__/AgentRunCommand.test.ts` (stdin + `--stdin` coverage)
  - **Component** none
  - **Integration** none
  - **API** none
- **Dependencies**
  - `agent-prompt-flag-validation` (if parsing logic is refactored)
- **Acceptance criteria**
  - `mcoda agent-run <agent> --prompt "X" --stdin` accepts piped stdin and adds it to prompt list.
  - Without `--stdin`, piped stdin is ignored when other prompts are provided (current behavior preserved).
  - Tests confirm both behaviors.

---

## Task 04
- **Slug** `agent-details-command-prompts`
- **Title** Show command prompts in non‑JSON agent details
- **Detailed description**
  - Extend the non‑JSON output of `mcoda agent details` to include `prompts.commandPrompts`.
  - Render as a compact list (e.g., `command=prompt` pairs) or a multi‑line block with stable ordering.
  - Keep JSON output unchanged.
  - Add a CLI test that sets command prompts and asserts the details output contains them.
- **Files to touch**
  - `packages/cli/src/commands/agents/AgentsCommands.ts`
  - `packages/cli/src/__tests__/AgentsCommands.test.ts`
- **Tests**
  - **Unit** `packages/cli/src/__tests__/AgentsCommands.test.ts` (new details output test)
  - **Component** none
  - **Integration** none
  - **API** none
- **Dependencies** none
- **Acceptance criteria**
  - `mcoda agent details <name>` shows command prompt mappings when present.
  - Output order is deterministic.
  - Tests validate presence of the rendered mapping.

---

## Task 05
- **Slug** `agent-run-json-test`
- **Title** Add JSON output coverage for `mcoda agent-run`
- **Detailed description**
  - Add a test case that runs `mcoda agent-run <agent> --json` and parses the result.
  - Validate that `agent`, `responses`, and `responses[].prompt`/`output` fields exist.
  - Keep behavior unchanged; this task is only test coverage.
- **Files to touch**
  - `packages/cli/src/__tests__/AgentRunCommand.test.ts`
- **Tests**
  - **Unit** `packages/cli/src/__tests__/AgentRunCommand.test.ts` (JSON output test)
  - **Component** none
  - **Integration** none
  - **API** none
- **Dependencies** none
- **Acceptance criteria**
  - JSON output test validates structure for `agent-run`.

---

## Task 06
- **Slug** `test-agent-json-test`
- **Title** Add JSON output coverage for `mcoda test-agent`
- **Detailed description**
  - Add a test case that runs `mcoda test-agent <agent> --json` and parses the result.
  - Validate that `health`, `prompt`, and `response` fields exist.
  - Keep behavior unchanged; this task is only test coverage.
- **Files to touch**
  - `packages/cli/src/__tests__/TestAgentCommand.test.ts`
- **Tests**
  - **Unit** `packages/cli/src/__tests__/TestAgentCommand.test.ts` (JSON output test)
  - **Component** none
  - **Integration** none
  - **API** none
- **Dependencies** none
- **Acceptance criteria**
  - JSON output test validates structure for `test-agent`.

---

## Task 07
- **Slug** `routing-set-command-validation`
- **Title** Validate `routing defaults --set-command` command names
- **Detailed description**
  - Add command‑name validation for `routing defaults --set-command` using the same allowlist as `routing preview/explain`.
  - Reject unknown commands with a clear error that lists valid options.
  - Ensure validation occurs before DB writes.
  - Add a CLI test that confirms unknown commands are rejected.
- **Files to touch**
  - `packages/cli/src/commands/routing/RoutingCommands.ts`
  - `packages/cli/src/__tests__/RoutingCommands.test.ts` (new)
- **Tests**
  - **Unit** `packages/cli/src/__tests__/RoutingCommands.test.ts` (new test for unknown command)
  - **Component** none
  - **Integration** none
  - **API** none
- **Dependencies** none
- **Acceptance criteria**
  - Unknown commands in `--set-command` fail with a clear error.
  - Tests validate the error path.

---

## Task 08
- **Slug** `routing-defaults-list-cache`
- **Title** Cache agent summaries during `routing defaults --list`
- **Detailed description**
  - Reduce repeated calls to `routing.getAgentSummary` by caching agent lookups per agent id.
  - Use a map keyed by agent id to avoid duplicate fetches while assembling the table.
  - Maintain exact output format.
  - No behavior change beyond performance; ensure existing output tests still pass.
- **Files to touch**
  - `packages/cli/src/commands/routing/RoutingCommands.ts`
- **Tests**
  - **Unit** existing routing tests (if added) should continue to pass.
  - **Component** none
  - **Integration** none
  - **API** none
- **Dependencies**
  - `routing-set-command-validation` (optional if shared helpers are introduced)
- **Acceptance criteria**
  - `routing defaults --list` output is unchanged but lookups are cached.

---

## Task 09
- **Slug** `routing-defaults-show-ids`
- **Title** Add `--show-ids` to `routing defaults --list`
- **Detailed description**
  - Add a `--show-ids` flag to show both slug and id for workspace/global agents (e.g., `slug (id)`).
  - Update help text and usage documentation in `RoutingCommands`.
  - Keep JSON output unchanged.
  - Add a CLI test that asserts the `--show-ids` output format.
- **Files to touch**
  - `packages/cli/src/commands/routing/RoutingCommands.ts`
  - `packages/cli/src/__tests__/RoutingCommands.test.ts`
- **Tests**
  - **Unit** `packages/cli/src/__tests__/RoutingCommands.test.ts` (show‑ids test)
  - **Component** none
  - **Integration** none
  - **API** none
- **Dependencies**
  - `routing-defaults-list-cache` (if list rendering is refactored)
- **Acceptance criteria**
  - `routing defaults --list --show-ids` renders both slug and id in agent columns.
  - JSON output remains unchanged.

---

## Task 10
- **Slug** `routing-preview-required-capabilities`
- **Title** Include required capabilities in `routing preview` output
- **Detailed description**
  - Extend the non‑JSON, non‑explain `routing preview` output to show required capabilities (either a new column or a separate line).
  - Ensure the list is deterministic and reflects `RoutingService.requiredCapabilities`.
  - Add a CLI test that asserts required capabilities are visible in output.
- **Files to touch**
  - `packages/cli/src/commands/routing/RoutingCommands.ts`
  - `packages/cli/src/__tests__/RoutingCommands.test.ts`
- **Tests**
  - **Unit** `packages/cli/src/__tests__/RoutingCommands.test.ts` (required capabilities output test)
  - **Component** none
  - **Integration** none
  - **API** none
- **Dependencies**
  - `routing-set-command-validation` (shared validation helpers)
- **Acceptance criteria**
  - Non‑JSON `routing preview` output includes required capabilities.
  - Tests confirm presence and formatting.

---

## Task 11
- **Slug** `routing-cli-json-tests`
- **Title** Add CLI tests for routing JSON outputs
- **Detailed description**
  - Add tests that run `mcoda routing defaults --json`, `mcoda routing preview --json`, and `mcoda routing explain --json`.
  - Validate output is valid JSON and contains expected keys (workspace/global defaults for defaults; routingPreview DTO for preview/explain).
  - Keep command behavior unchanged.
- **Files to touch**
  - `packages/cli/src/__tests__/RoutingCommands.test.ts`
- **Tests**
  - **Unit** `packages/cli/src/__tests__/RoutingCommands.test.ts` (new JSON tests)
  - **Component** none
  - **Integration** none
  - **API** none
- **Dependencies**
  - `routing-set-command-validation` (shared test setup)
- **Acceptance criteria**
  - JSON outputs for defaults/preview/explain are validated by tests.

---

## Task 12
- **Slug** `routing-preview-unknown-command-test`
- **Title** Add error‑path coverage for unknown routing command
- **Detailed description**
  - Add a test that invokes `mcoda routing preview --command does-not-exist` and asserts a clear error message is returned.
  - Ensure the CLI sets a non‑zero exit code for this path.
- **Files to touch**
  - `packages/cli/src/__tests__/RoutingCommands.test.ts`
- **Tests**
  - **Unit** `packages/cli/src/__tests__/RoutingCommands.test.ts` (error path)
  - **Component** none
  - **Integration** none
  - **API** none
- **Dependencies**
  - `routing-set-command-validation`
- **Acceptance criteria**
  - Unknown command is rejected with a clear error.
  - Test captures the error path.

---

## Task 13
- **Slug** `routing-cli-tests-harness`
- **Title** Ensure routing CLI tests are executed in the test harness
- **Detailed description**
  - Verify the CLI package test script runs all tests in `packages/cli/dist/__tests__`.
  - If the harness does not execute the new routing test file, add it to `tests/all.js` under `extraWorkspaceTests`.
  - Document any changes made to test discovery.
- **Files to touch**
  - `tests/all.js` (only if the routing CLI tests are not picked up)
- **Tests**
  - **Unit** n/a (harness change)
  - **Component** n/a
  - **Integration** `node tests/all.js` (ensure routing tests run)
  - **API** none
- **Dependencies**
  - `routing-cli-json-tests`
  - `routing-preview-unknown-command-test`
- **Acceptance criteria**
  - Routing CLI tests are executed by the standard test runner.
  - `node tests/all.js` includes the new routing test file (directly or via workspace tests).
