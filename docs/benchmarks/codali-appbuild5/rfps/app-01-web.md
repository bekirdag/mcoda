# RFP: HarborOps

Platform: web

A multi-user team service desk for two independent organizations. React+TypeScript frontend, Node backend and SQLite persistence. Run locally without paid services.

## Delivery contract
Build the application end to end in this workspace. Do not just describe a plan or return code snippets. Read this RFP and ENVIRONMENT.md, then implement, build and test as far as the provided environment permits. Use tools to create actual project files. You may discover available file,shell,Docdex,planning and testing tools. You may install public dependencies inside this workspace. No production deployment,external account creation,paid services or host administration is authorized. Keep secrets and personal host data out of the project.

One initial request is supplied; no further feature clarifications or evaluator fixes will be provided. Make reasonable product decisions and document them. Internal tool calls and self-corrections are allowed. Do not lower requirements to make tests pass. The common maximum is60minutes,100model calls,200tool calls,1million aggregate model tokens and8192output tokens per call, subject to64K context. Finish early only if the application is actually complete or you have accurately documented a blocker. Do not claim tests/builds you did not run.

Deliver source,dependency manifests and lockfiles,build configuration,tests,demo fixtures,and README. Include DELIVERY.md with implemented features,exact executed commands and results,known bugs,unverified checks,and missing requirements. Provide a machine-readable delivery.json with keys app,platform,buildCommand,runCommand,testCommand,artifactPaths,knownLimitations. Never include production secrets. Do not remove or rewrite RFP.md or ENVIRONMENT.md. No human will repair submitted code before scoring. Generated dependencies/build caches are excluded from source review but source and produced artifacts are preserved.

## Quality rubric (100points)
Features35: each of the35 numbered feature checks is worth1point. Build/delivery15,reliability/tests15,UI/UX15,code quality10,security10. Evaluation uses actual build/test/runtime evidence plus code review. An absent feature fails. An implemented but untestable native-platform behavior is marked unverified,not passed. Scores include verification coverage; environment gaps are disclosed separately. A screenshot/mockup alone does not prove behavior.

## Platform and data constraints
Use local-only demo data. Seed Harbor with owner@harbor.test,agent@harbor.test,requester@harbor.test and Cedar with owner@cedar.test. Document demo passwords; hash them in storage. Backend must bind127.0.0.1 by default with configurable PORT. Do not require Docker or external DB. Provide a health endpoint and API documentation. Use integer milliseconds for timestamps. API authorization must not trust organizationId or role supplied by a client.

## Required features

### Identity and tenancy
- F01: Seed two organizations Harbor and Cedar with separate users and tickets.
- F02: Implement password-hashed login and logout with server-validated sessions.
- F03: Enforce owner/agent/requester roles on server endpoints.
- F04: Reject cross-organization ticket reads and writes even with guessed IDs.
- F05: Requester can access own requests but cannot change administrative settings.

### Ticket lifecycle
- F06: Create tickets with title,description,priority,category and assignee.
- F07: Validate required fields and show field errors without losing input.
- F08: Support open,in_progress,resolved and closed with a documented transition policy.
- F09: Persist comments and chronological status history per ticket.
- F10: Archive or soft-delete with confirmation and recoverability.

### Work queue
- F11: Search title and description case-insensitively.
- F12: Filter by status,priority and assignee and combine filters.
- F13: Sort by created time and priority with deterministic tie-breaking.
- F14: Paginate a seeded list of at least30tickets.
- F15: Provide accessible table and board views of the same persisted records.

### SLA and analytics
- F16: Use priority targets P1=60,P2=240,P3=1440minutes from creation to resolution.
- F17: Display remaining or breached time using stored timestamps.
- F18: Show counts by status and priority filtered to current organization.
- F19: Show resolution-duration summary from actual ticket history.
- F20: Offer CSV export of currently filtered tickets with safe cell escaping.

### Knowledge and attachments
- F21: Create and edit searchable knowledge articles scoped to organization.
- F22: Render article Markdown without executable HTML.
- F23: Attach a local PNG/JPEG/text file up to2MiB to a ticket.
- F24: Reject oversized or unsupported uploads server-side.
- F25: Authorize every attachment download and prevent path traversal.

### Administration and audit
- F26: Owner can invite/create local users and set roles.
- F27: Prevent the last owner from removing their own owner role.
- F28: Record actor,time,entity and action for sensitive changes.
- F29: Provide owner-only audit log with filtering.
- F30: Use transactional updates so failed changes do not leave partial audit/data state.

### Product delivery
- F31: Dashboard,queue,detail,knowledge and settings screens are navigable.
- F32: Provide useful empty/loading/error states and toast or inline feedback.
- F33: Persist all edits after server restart.
- F34: Seed deterministic demo data and document demo credentials clearly.
- F35: Provide README with install,dev,build,start,test and reset commands.

## Security requirements
- S1: Server-enforced tenancy and roles, with negative integration tests.
- S2: Parameterized SQL and strict input validation on every mutation.
- S3: Safe authentication cookies/session expiry, no embedded production secret.
- S4: Sanitized Markdown and uploads; no arbitrary path access.
- S5: CSV formula neutralization and no sensitive data leakage in errors.

## Evaluation contract
Every visible control must perform its claimed action. Demo data must be fictional and deterministic. Tests must validate behavior,not merely assert that files exist. Native signing/store publication is not required. Describe all environment blockers accurately.
