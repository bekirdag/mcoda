# SDS implementation report (v0.3)

This report compares `docs/sds/sds.md` against the current mcoda codebase and notes what is implemented vs missing or partial.

## Implemented
- Repository layout and module boundaries are in place (`packages/shared`, `packages/db`, `packages/agents`, `packages/integrations`, `packages/core`, `packages/generators`, `packages/cli`, `packages/testing`).
- CLI command surface in the SDS is implemented, including create/refine/work-on-tasks, code-review, qa-tasks, backlog, estimate, routing, task detail/order, update, jobs, docs (PDR/SDS), openapi-from-docs, gateway-agent, and test-agent (`packages/cli/src/bin/McodaEntrypoint.ts`).
- OpenAPI spec exists and drives shared types and OpenAPI-driven workflows (`openapi/mcoda.yaml`, `packages/shared/src/openapi/OpenApiTypes.ts`, `packages/core/src/services/openapi/OpenApiService.ts`).
- Global and workspace DB schemas plus migrations exist and align to the SDS tables (`packages/db/src/migrations/global/GlobalMigrations.ts`, `packages/db/src/migrations/workspace/WorkspaceMigrations.ts`).
- Agent registry, encrypted auth, capabilities, and health checks are implemented (`packages/agents/src/AgentService/AgentService.ts`, `packages/shared/src/crypto/CryptoHelper.ts`, `packages/core/src/api/AgentsApi.ts`, `packages/cli/src/commands/agents/AgentsCommands.ts`).
- Routing defaults and capability validation are implemented (`packages/core/src/services/agents/RoutingService.ts`, `packages/core/src/services/agents/generated/RoutingApiClient.ts`, `packages/cli/src/commands/routing/RoutingCommands.ts`).
- Doc generation and docdex integration are implemented for PDR/SDS/OpenAPI flows (`packages/core/src/services/docs/DocsService.ts`, `packages/core/src/services/openapi/OpenApiService.ts`, `packages/integrations/src/docdex/DocdexClient.ts`).
- Task lifecycle workflows (create/refine/work-on-tasks, backlog ordering, task detail/comments, dependency ordering) are implemented (`packages/core/src/services/planning`, `packages/core/src/services/execution`, `packages/core/src/services/backlog`, `packages/core/src/services/tasks`).
- Code review and QA pipelines exist, including QA adapters (CLI/Chromium/Maestro) and prompt flows (`packages/core/src/services/review/CodeReviewService.ts`, `packages/core/src/services/execution/QaTasksService.ts`, `packages/integrations/src/qa`).
- Job engine, checkpoints, logs, and resumability are implemented (`packages/core/src/services/jobs/JobService.ts`, `packages/cli/src/commands/jobs`).
- Token usage and telemetry aggregation are implemented (`packages/core/src/services/telemetry/TelemetryService.ts`, `packages/cli/src/commands/telemetry/TelemetryCommands.ts`).
- Update flow is implemented via the system client and update service (`packages/integrations/src/system/SystemClient.ts`, `packages/core/src/services/system/SystemUpdateService.ts`, `packages/cli/src/commands/update/UpdateCommands.ts`).

## Partially implemented or missing
- Config service and full config layering are not implemented as described in the SDS. Workspace config is read for a few fields, but there is no dedicated config service or CLI to print/manage config, and global config support is limited to specific uses (e.g., velocity defaults).
  - Evidence: `packages/core/src/config/ConfigService.ts` (empty), `packages/core/src/workspace/WorkspaceManager.ts`, `packages/core/src/services/estimate/VelocityService.ts`, `packages/cli/src/commands/workspace/SetWorkspaceCommand.ts`.
- Issue tracker integration is missing. The Issues client is a stub and is not wired into core flows.
  - Evidence: `packages/integrations/src/issues/IssuesClient.ts`.
- VCS configurability is partial. The SDS calls for configurable base branch and task branch pattern; current implementation forces `mcoda-dev` and `mcoda/task/<key>` and warns when config differs.
  - Evidence: `packages/core/src/services/execution/WorkOnTasksService.ts`.
- Shared prompt loader and shared logging/error utilities are placeholders, while the SDS calls for centralized prompt assembly, logging, and redaction.
  - Evidence: `packages/core/src/prompts/PromptLoader.ts`, `packages/shared/src/errors/ErrorFactory.ts`, `packages/shared/src/logging/Logger.ts`, `packages/shared/src/utils/UtilityService.ts`.
- The OpenAPI spec includes `/system/ping` and `/config` endpoints but there is no server implementation or CLI exposure for them. Only the update system client is wired.
  - Evidence: `openapi/mcoda.yaml`, `packages/integrations/src/system/SystemClient.ts`.
- Docdex “remote-only” policy is not enforced. The client falls back to a local JSON store if the remote service is unavailable.
  - Evidence: `packages/integrations/src/docdex/DocdexClient.ts`.

## Notes
- This report only reflects what is implemented in this repo; it does not validate external services (routing/jobs/telemetry APIs).
- Some SDS items may be intentionally deferred or scoped to external services; those are marked as partial/missing only when there is no implementation in this codebase.
