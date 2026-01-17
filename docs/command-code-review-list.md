# Command Code Review List

This list breaks down mcoda features into command-level review items. Each section calls out the commands, primary code locations, tests to validate, and the key review focus for that area.

## Agent management
- **Commands** `mcoda agent list|details|add|update|delete|auth|auth-status|set-default|ratings`, `mcoda test-agent`, `mcoda agent-run`, `mcoda gateway-agent`.
- **Review focus** JSON output parity, secret handling (no key leakage), capability/model config validation, health + rating fields, and table truncation/readability.
- **Primary code** `packages/cli/src/commands/agents/AgentsCommands.ts`, `packages/cli/src/commands/agents/AgentRunCommand.ts`, `packages/cli/src/commands/agents/TestAgentCommand.ts`, `packages/cli/src/commands/agents/GatewayAgentCommand.ts`, `packages/core/src/api/AgentsApi.ts`, `packages/db/src/repositories/global/GlobalRepository.ts`.
- **Tests** `packages/cli/src/__tests__/AgentsCommands.test.ts`, `packages/cli/src/__tests__/AgentRunCommand.test.ts`, `packages/cli/src/__tests__/TestAgentCommand.test.ts`, `packages/core/src/api/__tests__/AgentsApi.test.ts`.

## Routing
- **Commands** `mcoda routing defaults`, `mcoda routing set-default`, `mcoda routing preview`, `mcoda routing explain`.
- **Review focus** precedence order (override → workspace → global), JSON output shape, error messaging when defaults are missing, and capability filtering.
- **Primary code** `packages/cli/src/commands/routing/RoutingCommands.ts`, `packages/core/src/services/agents/RoutingService.ts`, `packages/core/src/services/agents/AgentRatingService.ts`.
- **Tests** `packages/core/src/services/agents/__tests__/RoutingService.test.ts`.

## Task planning
- **Commands** `mcoda create-tasks`, `mcoda refine-tasks`, `mcoda migrate-tasks`, `mcoda order-tasks`, `mcoda tasks order-by-deps`, `mcoda task`, `mcoda task-detail`.
- **Review focus** argument parsing consistency, dry-run vs apply behavior, dependency ordering, JSON output where supported, and plan-in/plan-out file handling.
- **Primary code** `packages/cli/src/commands/planning/CreateTasksCommand.ts`, `packages/cli/src/commands/planning/RefineTasksCommand.ts`, `packages/cli/src/commands/planning/MigrateTasksCommand.ts`, `packages/cli/src/commands/backlog/OrderTasksCommand.ts`, `packages/cli/src/commands/backlog/TaskShowCommands.ts`, `packages/core/src/services/planning/CreateTasksService.ts`, `packages/core/src/services/planning/RefineTasksService.ts`.
- **Tests** `packages/core/src/services/planning/__tests__/CreateTasksService.test.ts`, `packages/core/src/services/planning/__tests__/RefineTasksService.test.ts`, `packages/cli/src/__tests__/TaskShowCommands.test.ts`.

## Backlog
- **Commands** `mcoda backlog`.
- **Review focus** default status filters, ordering by dependencies, JSON output completeness, and verbose warning output behavior.
- **Primary code** `packages/cli/src/commands/backlog/BacklogCommands.ts`, `packages/core/src/services/backlog/BacklogService.ts`, `packages/core/src/services/backlog/TaskOrderingService.ts`.
- **Tests** `packages/cli/src/__tests__/BacklogCommands.test.ts`, `packages/core/src/services/backlog/__tests__/TaskOrderingService.test.ts`.

## Estimation
- **Commands** `mcoda estimate`.
- **Review focus** velocity source selection, status-based time accounting, ETA formatting, JSON output shape, and telemetry opt-out handling.
- **Primary code** `packages/cli/src/commands/estimate/EstimateCommands.ts`, `packages/core/src/services/estimate/EstimateService.ts`, `packages/core/src/services/estimate/VelocityService.ts`.
- **Tests** `packages/cli/src/__tests__/EstimateCommands.test.ts`, `packages/core/src/services/estimate/__tests__/VelocityAndEstimate.test.ts`.

## Execution workflows
- **Commands** `mcoda work-on-tasks`, `mcoda gateway-trio`, `mcoda code-review`, `mcoda qa-tasks`.
- **Review focus** task status transitions, retries and failure modes, JSON output when enabled, agent routing hooks, and test runner integration.
- **Primary code** `packages/cli/src/commands/work/WorkOnTasksCommand.ts`, `packages/cli/src/commands/work/GatewayTrioCommand.ts`, `packages/cli/src/commands/review/CodeReviewCommand.ts`, `packages/cli/src/commands/planning/QaTasksCommand.ts`, `packages/core/src/services/execution/WorkOnTasksService.ts`, `packages/core/src/services/execution/GatewayTrioService.ts`, `packages/core/src/services/review/CodeReviewService.ts`, `packages/core/src/services/execution/QaTasksService.ts`.
- **Tests** `packages/core/src/services/execution/__tests__/WorkOnTasksService.test.ts`, `packages/core/src/services/execution/__tests__/GatewayTrioService.test.ts`, `packages/core/src/services/review/__tests__/CodeReviewService.test.ts`, `packages/core/src/services/execution/__tests__/QaTasksService.test.ts`, `packages/cli/src/__tests__/GatewayTrioCommand.test.ts`.

## Jobs and telemetry
- **Commands** `mcoda job list|status|watch|logs|inspect|resume|cancel|tokens`, `mcoda jobs`, `mcoda telemetry`, `mcoda tokens`.
- **Review focus** JSON output for list/status/inspect, job state transitions, token usage aggregation fields, and CLI output formatting for streaming logs.
- **Primary code** `packages/cli/src/commands/jobs/JobsCommands.ts`, `packages/cli/src/commands/telemetry/TelemetryCommands.ts`, `packages/core/src/services/jobs/JobService.ts`, `packages/core/src/services/telemetry/TelemetryService.ts`.
- **Tests** `packages/cli/src/__tests__/JobsCommands.test.ts`, `packages/cli/src/__tests__/TelemetryCommands.test.ts`, `packages/core/src/services/telemetry/__tests__/TelemetryService.test.ts`.

## Docs and OpenAPI
- **Commands** `mcoda docs pdr generate`, `mcoda docs sds generate`, `mcoda openapi`.
- **Review focus** input validation, file output paths, JSON output mode, and routing fallback when agents are unavailable.
- **Primary code** `packages/cli/src/commands/docs/DocsCommands.ts`, `packages/cli/src/commands/openapi/OpenapiCommands.ts`, `packages/core/src/services/docs/DocsService.ts`, `packages/core/src/services/openapi/OpenApiService.ts`, `openapi/gen-openapi.ts`.
- **Tests** `packages/core/src/services/docs/__tests__/DocsService.test.ts`, `packages/core/src/services/openapi/__tests__/OpenApiService.test.ts`.

## Updates and workspace setup
- **Commands** `mcoda update`, `mcoda set-workspace`, `mcoda --version`.
- **Review focus** channel preference persistence, JSON output shape for update status, workspace resolution behavior, and error handling when config is missing.
- **Primary code** `packages/cli/src/commands/update/UpdateCommands.ts`, `packages/cli/src/commands/workspace/SetWorkspaceCommand.ts`, `packages/core/src/services/system/SystemUpdateService.ts`, `packages/core/src/workspace/WorkspaceResolver.ts`.
- **Tests** `packages/core/src/services/system/__tests__/SystemUpdateService.test.ts`, `packages/core/src/workspace/__tests__/WorkspaceResolver.test.ts`.
