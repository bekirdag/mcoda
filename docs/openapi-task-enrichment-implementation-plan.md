# OpenAPI Generation Alignment Plan (SDS-First Task Enrichment)

## Objective

Align `openapi-from-docs` with the workflow:

1. RFP -> PDR -> SDS -> OpenAPI
2. SDS is the single source of truth
3. OpenAPI output enriches downstream `create-tasks`, `refine-tasks`, and `order-tasks`

## Scope

- Command surface:
  - `packages/cli/src/commands/openapi/OpenapiCommands.ts`
  - `packages/cli/src/__tests__/OpenapiCommands.test.ts`
- OpenAPI generation:
  - `packages/core/src/services/openapi/OpenApiService.ts`
  - `packages/core/src/services/openapi/__tests__/OpenApiService.test.ts`
- Downstream enrichment path:
  - `packages/core/src/services/planning/CreateTasksService.ts`
  - `packages/core/src/services/planning/RefineTasksService.ts`

## Design Principles

1. SDS-first by default:
   - OpenAPI generation must fail if SDS context cannot be resolved.
2. No speculative API:
   - Remove prompt instructions that invent APIs not grounded in SDS.
3. Structured enrichment:
   - Require operation-level extension metadata in generated OpenAPI.
4. Backward-safe rollout:
   - Add validations and tests before expanding downstream consumers.

## Implementation Phases

### Phase 1: CLI and OpenAPI strictness

1. Add `--project <KEY>` support to `openapi-from-docs` CLI parser and command invocation.
2. Enforce SDS presence in `OpenapiContextAssembler.build()`:
   - If SDS docdex+local resolution fails, throw an explicit error.
3. Tighten prompt:
   - Remove permissive fallback guidance that fabricates endpoints.
   - Require SDS-traceable operations only.

### Phase 2: OpenAPI task-hints contract

1. Define `x-mcoda-task-hints` prompt contract per operation:
   - `service`
   - `capability`
   - `stage`
   - `complexity`
   - `depends_on_operations`
   - `test_requirements` (`unit|component|integration|api`)
2. Add validator checks:
   - `x-mcoda-task-hints` must be object when present.
   - `test_requirements` fields must be arrays of strings.

### Phase 3: Downstream enrichment integration

1. `CreateTasksService`:
   - Parse OpenAPI operation hints from docs.
   - Inject concise hint summaries into task-generation prompts.
2. `RefineTasksService`:
   - Expand doc query to include OpenAPI-specific terms.
   - Include extracted operation hint summary in refinement context.

### Phase 4: Test coverage and validation

1. CLI tests:
   - Ensure `--project` is parsed and forwarded.
2. OpenAPI service tests:
   - Ensure missing SDS fails job with explicit error.
   - Ensure prompt no longer allows context-free minimal spec fallback.
3. Planning path tests:
   - Validate OpenAPI hint extraction and prompt-injection behavior.

## Risks and Mitigations

1. Risk: strict SDS gate breaks existing loose workflows.
   - Mitigation: explicit error text with remediation path to SDS docs.
2. Risk: over-constrained task hints reduce model flexibility.
   - Mitigation: hints required only where operation exists; empty arrays allowed.
3. Risk: parser fragility for OpenAPI docs.
   - Mitigation: fail-soft parse with warnings; preserve existing behavior without crash.

## Definition of Done

1. `openapi-from-docs` fails without SDS context.
2. CLI supports `--project`.
3. Prompt instructions are SDS-grounded and non-speculative.
4. OpenAPI hint contract is validated.
5. Create/refine prompts receive OpenAPI hint context.
6. New/updated tests pass for touched modules.
