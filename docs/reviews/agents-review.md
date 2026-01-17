# Agents Review

## Scope
- **Commands** `mcoda agent list|details|add|update|delete|auth|auth-status|set-default|ratings`, `mcoda test-agent`, `mcoda agent-run`, `mcoda gateway-agent`.
- **Primary code** `packages/cli/src/commands/agents/AgentsCommands.ts`, `packages/cli/src/commands/agents/AgentRunCommand.ts`, `packages/cli/src/commands/agents/TestAgentCommand.ts`, `packages/cli/src/commands/agents/GatewayAgentCommand.ts`, `packages/core/src/api/AgentsApi.ts`, `packages/db/src/repositories/global/GlobalRepository.ts`.

## Findings
- **Low** `mcoda agent --help` (or `mcoda agent <sub> --help`) throws an error instead of printing usage and exiting 0, which can surface a stack trace in the CLI. `packages/cli/src/commands/agents/AgentsCommands.ts`.
- **Low** `mcoda agent-run` ignores piped stdin when any `--prompt`/`--prompt-file`/`--task-file` is supplied; users cannot combine stdin + explicit prompts. `packages/cli/src/commands/agents/AgentRunCommand.ts`.
- **Low** `--prompt` with no value is accepted as a boolean and later fails with a generic “No prompts provided” error, rather than a targeted “missing value” error. `packages/cli/src/commands/agents/AgentRunCommand.ts`, `packages/cli/src/commands/agents/TestAgentCommand.ts`.

## Suggestions
- Add explicit `--help` handling in `AgentsCommands.run` to print `USAGE` and exit 0 without throwing. `packages/cli/src/commands/agents/AgentsCommands.ts`.
- Validate that `--prompt`, `--prompt-file`, and `--task-file` are followed by values and throw targeted errors when missing. `packages/cli/src/commands/agents/AgentRunCommand.ts`, `packages/cli/src/commands/agents/TestAgentCommand.ts`.

## Enhancements
- Allow stdin content to append to prompts (or add `--stdin` to opt in) so piped content can be combined with explicit prompt flags. `packages/cli/src/commands/agents/AgentRunCommand.ts`.
- Include `prompts.commandPrompts` in the non‑JSON details view for easier inspection. `packages/cli/src/commands/agents/AgentsCommands.ts`.

## Test gaps
- No CLI tests cover `mcoda agent --help` / `mcoda agent list --help` success paths. `packages/cli/src/__tests__/AgentsCommands.test.ts`.
- No tests validate `mcoda agent-run --json` output structure. `packages/cli/src/__tests__/AgentRunCommand.test.ts`.
- No tests validate `mcoda test-agent --json` output structure. `packages/cli/src/__tests__/TestAgentCommand.test.ts`.

## Notes
- Review focused on CLI behavior, argument parsing, and Agent API usage. No issues found in `AgentsApi.runAgent` token usage recording.
