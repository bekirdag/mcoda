# RFP: FieldCheck

Platform: android

A native Android offline field-inspection application for maintenance teams. Kotlin,Jetpack Compose and Room or equivalent durable local storage. MinimumSDK26,target/compileSDK35.

## Delivery contract
Build the application end to end in this workspace. Do not just describe a plan or return code snippets. Read this RFP and ENVIRONMENT.md, then implement, build and test as far as the provided environment permits. Use tools to create actual project files. You may discover available file,shell,Docdex,planning and testing tools. You may install public dependencies inside this workspace. No production deployment,external account creation,paid services or host administration is authorized. Keep secrets and personal host data out of the project.

One initial request is supplied; no further feature clarifications or evaluator fixes will be provided. Make reasonable product decisions and document them. Internal tool calls and self-corrections are allowed. Do not lower requirements to make tests pass. The common maximum is60minutes,100model calls,200tool calls,1million aggregate model tokens and8192output tokens per call, subject to64K context. Finish early only if the application is actually complete or you have accurately documented a blocker. Do not claim tests/builds you did not run.

Deliver source,dependency manifests and lockfiles,build configuration,tests,demo fixtures,and README. Include DELIVERY.md with implemented features,exact executed commands and results,known bugs,unverified checks,and missing requirements. Provide a machine-readable delivery.json with keys app,platform,buildCommand,runCommand,testCommand,artifactPaths,knownLimitations. Never include production secrets. Do not remove or rewrite RFP.md or ENVIRONMENT.md. No human will repair submitted code before scoring. Generated dependencies/build caches are excluded from source review but source and produced artifacts are preserved.

## Quality rubric (100points)
Features35: each of the35 numbered feature checks is worth1point. Build/delivery15,reliability/tests15,UI/UX15,code quality10,security10. Evaluation uses actual build/test/runtime evidence plus code review. An absent feature fails. An implemented but untestable native-platform behavior is marked unverified,not passed. Scores include verification coverage; environment gaps are disclosed separately. A screenshot/mockup alone does not prove behavior.

## Platform and data constraints
Use Kotlin/Compose native screens, not a browser wrapper. Pin a mutually compatible Gradle/AGP/Kotlin/Compose set. A provided host toolchain may containJDK17,AndroidSDK35 and build-tools34/35; use ENVIRONMENT.md paths. The sync transport must be a local deterministic fake, not a real external service. No real credentials or user accounts. Standard debug signing is sufficient. A complete APK, source and tests are expected if the provided Android toolchain is available.

## Required features

### Assignments and assets
- F01: Seed12assets across3sites and6inspection assignments.
- F02: Search and filter assets by site,type and inspection status.
- F03: Show asset details,history and pending assignments.
- F04: Start an inspection from an assignment or asset.
- F05: Persist all assignments and inspections across process restart.

### Dynamic checklist forms
- F06: Provide templates with yes/no,text,numeric and photo fields.
- F07: Render required markers and type-specific validation.
- F08: Save drafts automatically and resume them.
- F09: Reject completion while required answers are missing or invalid.
- F10: Record inspector name,timestamps and template version with submission.

### Evidence and findings
- F11: Attach photo evidence using system picker or camera with permission handling.
- F12: Create findings with severity,description and linked checklist item.
- F13: Mark findings open,in_progress or resolved with history.
- F14: Filter findings and show unresolved high-severity summary.
- F15: Delete or replace evidence without orphaning or exposing external files.

### Offline sync simulation
- F16: Maintain a durable outbox of completed inspections.
- F17: Provide explicit local mock sync transport with success,timeout and server-rejection modes.
- F18: Retry transient failures with bounded exponential backoff.
- F19: Use stable operation IDs to prevent duplicate remote acceptance.
- F20: Show pending,synced and failed state with user-readable retry controls.

### Reports and transfer
- F21: Show inspection completion and findings summary per site.
- F22: Export inspection as shareable JSON and CSV.
- F23: Import versioned template JSON with strict validation.
- F24: Handle malformed imports without losing existing data.
- F25: Provide safe reset/demo reload with confirmation.

### Android UX
- F26: Dashboard,asset list,inspection form,findings,outbox and settings screens are navigable.
- F27: Support dark mode,font scaling and TalkBack content descriptions.
- F28: Handle rotation and background/resume without losing draft input.
- F29: Provide loading,empty,validation and offline indicators.
- F30: Use touch-friendly controls and avoid blocking UI thread during file/DB operations.

### Product delivery
- F31: Produce a debug APK with Gradle and documented installation command.
- F32: Include unit tests for required validation,outbox retry/idempotency and persistence mapping.
- F33: Include at least one instrumentation/UI smoke test.
- F34: Document demo workflow including failed sync recovery.
- F35: Provide Gradle wrapper or deterministic bootstrap and all app resources/manifests.

## Security requirements
- S1: No unnecessary exported components,cleartext network access or broad storage permissions.
- S2: Validate imported templates and bound text/file/collection sizes.
- S3: Store evidence in app-owned storage and use safe content URIs.
- S4: Outbox operations enforce stable IDs and do not leak sensitive inspection data.
- S5: No secrets in source/logs and no destructive unconfirmed reset.

## Evaluation contract
Every visible control must perform its claimed action. Demo data must be fictional and deterministic. Tests must validate behavior,not merely assert that files exist. Native signing/store publication is not required. Describe all environment blockers accurately.
