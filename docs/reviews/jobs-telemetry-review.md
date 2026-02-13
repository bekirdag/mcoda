# Jobs and Telemetry Review

## Scope
- Commands: `mcoda job list`, `mcoda job status`, `mcoda job watch`, `mcoda job logs`, `mcoda job inspect`, `mcoda job resume`, `mcoda job cancel`, `mcoda job tokens`, `mcoda jobs`, `mcoda telemetry`, `mcoda tokens`.
- Primary code: `packages/cli/src/commands/jobs/JobsCommands.ts`, `packages/cli/src/commands/telemetry/TelemetryCommands.ts`, `packages/core/src/services/jobs/JobService.ts`, `packages/core/src/services/telemetry/TelemetryService.ts`.
- Tests: `packages/cli/src/__tests__/JobsCommands.test.ts`, `packages/cli/src/__tests__/TelemetryCommands.test.ts`, `packages/core/src/services/telemetry/__tests__/TelemetryService.test.ts`.

## Findings
- None noted during this review.

## Suggestions
- None.

## Enhancements
- None.

## Test gaps
- None noted.

## Notes
- Reviewed job state handling, telemetry aggregation, and CLI rendering surfaces.
