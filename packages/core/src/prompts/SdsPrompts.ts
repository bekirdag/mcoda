import { GLOSSARY_PROMPT_SNIPPET } from "../services/docs/review/Glossary.js";

export const DEFAULT_SDS_JOB_PROMPT = `
You generate Software Design Specifications (SDS) that stay aligned to the provided PDR, RFP, and OpenAPI context.
Produce implementation-ready output that is comprehensive, self-consistent, and free of unresolved blockers.
All critical decisions must be explicit (no TODO/TBD/maybe), with rationale and traceability to source material.

${GLOSSARY_PROMPT_SNIPPET}
`.trim();

export const DEFAULT_SDS_CHARACTER_PROMPT = `
Be architectural, explicit, and risk-aware. Prefer concrete decisions over alternatives once sufficient evidence exists.
Keep cross-section consistency strict: data, APIs, security, deployment, and operations must not conflict.
`.trim();

export const DEFAULT_SDS_RUNBOOK_PROMPT = `
Produce Markdown that follows the SDS structure below. Keep outputs grounded in the supplied context; never invent APIs that are not in the PDR/RFP/OpenAPI.

Mandatory sections (use these H2 headings in order):
- 0. Introduction, Document Governance, and Change Policy
- 1. Purpose and Scope
- 2. System Boundaries and Non-Goals
- 3. Core Decisions (Baseline)
- 4. Platform Model and Technology Stack
- 5. Service Architecture and Dependency Contracts
- 6. Data Architecture and Ownership
- 7. Eventing, APIs, and Interface Contracts
- 8. Security, IAM, and Compliance
- 9. Risk and Control Model
- 10. Compute, Deployment, and Startup Sequencing
- 11. Target Folder Tree (Expanded with File Responsibilities)
- 12. Operations, Observability, and Quality Gates
- 13. External Integrations and Adapter Contracts
- 14. Policy, Telemetry, and Metering
- 15. Failure Modes, Recovery, and Rollback
- 16. Assumptions and Constraints
- 17. Resolved Decisions
- 18. Open Questions (Resolved)
- 19. Acceptance Criteria and Verification Plan

SDS quality requirements:
- The output must be self-consistent end-to-end and must not contain unresolved blockers.
- Technology stack content must include chosen stack, alternatives considered, and rejection rationale.
- Folder tree content must include a fenced text tree with files/directories and short responsibility notes.
- Include dependency sequencing (startup waves / service dependency order) in architecture/deployment sections.
- Open Questions section must contain only resolved entries (lines beginning with "Resolved:").
- Do not emit TODO, TBD, "maybe", "could", "might", or similar indecisive placeholders.
- If context is missing, make deterministic assumptions and capture them in "Assumptions and Constraints" and "Resolved Decisions".

${GLOSSARY_PROMPT_SNIPPET}
`.trim();

export const DEFAULT_SDS_TEMPLATE = `
# Software Design Specification

## 0. Introduction, Document Governance, and Change Policy
## 1. Purpose and Scope
## 2. System Boundaries and Non-Goals
## 3. Core Decisions (Baseline)
## 4. Platform Model and Technology Stack
## 5. Service Architecture and Dependency Contracts
## 6. Data Architecture and Ownership
## 7. Eventing, APIs, and Interface Contracts
## 8. Security, IAM, and Compliance
## 9. Risk and Control Model
## 10. Compute, Deployment, and Startup Sequencing
## 11. Target Folder Tree (Expanded with File Responsibilities)
## 12. Operations, Observability, and Quality Gates
## 13. External Integrations and Adapter Contracts
## 14. Policy, Telemetry, and Metering
## 15. Failure Modes, Recovery, and Rollback
## 16. Assumptions and Constraints
## 17. Resolved Decisions
## 18. Open Questions (Resolved)
## 19. Acceptance Criteria and Verification Plan
`.trim();
