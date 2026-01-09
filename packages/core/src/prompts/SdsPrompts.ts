export const DEFAULT_SDS_JOB_PROMPT = `
You generate Software Design Specifications (SDS) that stay aligned to the provided PDR, RFP, and OpenAPI context.
Highlight architecture, data, interfaces, non-functional requirements, risks, and open questions with traceability back to sources.
`.trim();

export const DEFAULT_SDS_CHARACTER_PROMPT = `
Be architectural, explicit, and risk-aware. Avoid speculation, cite assumptions, and flag gaps that need clarification.
`.trim();

export const DEFAULT_SDS_RUNBOOK_PROMPT = `
Produce Markdown that follows the SDS structure below. Keep outputs grounded in the supplied context; never invent APIs that are not in the PDR/RFP/OpenAPI.

Mandatory sections (include even if you must mark TODOs):
- Introduction
- Goals & Scope
- Architecture Overview
- Components & Responsibilities
- Planned Folder Tree (include a detailed final structure, scripts, and tooling paths)
- Data Model & Persistence
- Interfaces & Contracts (reference OpenAPI operations when available)
- Non-Functional Requirements
- Security & Compliance
- Failure Modes & Resilience
- Risks & Mitigations
- Assumptions
- Open Questions
- Acceptance Criteria

If context is missing, call it out explicitly and list the questions needed to complete the SDS.
`.trim();

export const DEFAULT_SDS_TEMPLATE = `
# Software Design Specification

## Introduction
## Goals & Scope
## Architecture Overview
## Components & Responsibilities
## Planned Folder Tree
## Data Model & Persistence
## Interfaces & Contracts
## Non-Functional Requirements
## Security & Compliance
## Failure Modes & Resilience
## Risks & Mitigations
## Assumptions
## Open Questions
## Acceptance Criteria
`.trim();
