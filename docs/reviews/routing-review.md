# Routing Review

## Scope
- **Commands** `mcoda routing defaults`, `mcoda routing preview`, `mcoda routing explain`.
- **Primary code** `packages/cli/src/commands/routing/RoutingCommands.ts`, `packages/core/src/services/agents/RoutingService.ts`, `packages/core/src/services/agents/AgentRatingService.ts`.

## Findings
- **Medium** `routing defaults --set-command` accepts any command name without validation, so typos silently create defaults that are never used, while `routing preview/explain` rejects unknown commands. `packages/cli/src/commands/routing/RoutingCommands.ts`, `packages/core/src/services/agents/RoutingService.ts`.
- **Low** `routing defaults --list` resolves agent slugs by awaiting `getAgentSummary` per command, which can be slow for large default sets (serial I/O). `packages/cli/src/commands/routing/RoutingCommands.ts`.

## Suggestions
- Validate command names on `--set-command` using the same command allowlist as `routing preview/explain` (or warn when unknown). `packages/cli/src/commands/routing/RoutingCommands.ts`.
- Batch agent lookups when listing defaults to reduce serial calls. `packages/cli/src/commands/routing/RoutingCommands.ts`, `packages/core/src/services/agents/RoutingService.ts`.

## Enhancements
- Add a `--show-ids` toggle for `routing defaults --list` to display both slug and agent id when using the API-backed routing service. `packages/cli/src/commands/routing/RoutingCommands.ts`.
- Include required capabilities in `routing preview` output for the non‑explain path. `packages/cli/src/commands/routing/RoutingCommands.ts`.

## Test gaps
- No CLI-level tests cover `routing defaults/preview/explain` output or JSON flags. `packages/cli/src/commands/routing/RoutingCommands.ts`.
- No tests cover the “unknown command” error path for `routing preview/explain`. `packages/core/src/services/agents/__tests__/RoutingService.test.ts`.

## Notes
- Review covered CLI parsing and RoutingService validation. Routing API client behavior was not inspected.
