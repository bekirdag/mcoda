# RFP: TrailLedger

Platform: ios

A native iOS17+ travel budget and shared-expense application using SwiftUI and local persistence. Offline by default; no account or paid API required.

## Delivery contract
Build the application end to end in this workspace. Do not just describe a plan or return code snippets. Read this RFP and ENVIRONMENT.md, then implement, build and test as far as the provided environment permits. Use tools to create actual project files. You may discover available file,shell,Docdex,planning and testing tools. You may install public dependencies inside this workspace. No production deployment,external account creation,paid services or host administration is authorized. Keep secrets and personal host data out of the project.

One initial request is supplied; no further feature clarifications or evaluator fixes will be provided. Make reasonable product decisions and document them. Internal tool calls and self-corrections are allowed. Do not lower requirements to make tests pass. The common maximum is60minutes,100model calls,200tool calls,1million aggregate model tokens and8192output tokens per call, subject to64K context. Finish early only if the application is actually complete or you have accurately documented a blocker. Do not claim tests/builds you did not run.

Deliver source,dependency manifests and lockfiles,build configuration,tests,demo fixtures,and README. Include DELIVERY.md with implemented features,exact executed commands and results,known bugs,unverified checks,and missing requirements. Provide a machine-readable delivery.json with keys app,platform,buildCommand,runCommand,testCommand,artifactPaths,knownLimitations. Never include production secrets. Do not remove or rewrite RFP.md or ENVIRONMENT.md. No human will repair submitted code before scoring. Generated dependencies/build caches are excluded from source review but source and produced artifacts are preserved.

## Quality rubric (100points)
Features35: each of the35 numbered feature checks is worth1point. Build/delivery15,reliability/tests15,UI/UX15,code quality10,security10. Evaluation uses actual build/test/runtime evidence plus code review. An absent feature fails. An implemented but untestable native-platform behavior is marked unverified,not passed. Scores include verification coverage; environment gaps are disclosed separately. A screenshot/mockup alone does not prove behavior.

## Platform and data constraints
Use native SwiftUI, not a web wrapper. Minimum deployment iOS17. Use SwiftData,Core Data or atomic Codable storage. Equal split rule: divide integer minor units,assign remainder cents to participant IDs in lexical order. Default fixture exchange rates to EUR:EUR1.0,USD0.92,GBP1.17; store rates with each expense unless an explicit user revalue operation is implemented. No signing identity is required for simulator builds. If Xcode is unavailable, still deliver complete source/project/tests and accurately report that native execution was not performed. Do not fabricate screenshots or successful build output.

## Required features

### Trips and budgets
- F01: Create,edit and archive trips with name,date range,base currency and budget.
- F02: Validate date range and positive budgets with inline feedback.
- F03: Support EUR,USD and GBP using documented user-editable fixed exchange rates.
- F04: Show trip overview with budget,spent and remaining amounts.
- F05: Persist trips and settings across app relaunch.

### Expense capture
- F06: Create and edit expenses with amount,currency,date,category,payer and note.
- F07: Store money in integer minor units and apply explicit rounding at conversion.
- F08: Attach a receipt using system photo/file picker.
- F09: Filter expenses by category,payer,date and text.
- F10: Delete with confirmation and support undo or a recoverable trash.

### Participants and splitting
- F11: Manage participants per trip without affecting other trips.
- F12: Split equally among selected participants with deterministic penny allocation.
- F13: Support custom exact shares and reject totals that do not match expense.
- F14: Compute participant paid,owed and net balances from actual expenses.
- F15: Provide settlement suggestions that conserve total debt and never create money.

### Budgets and insights
- F16: Display spending by category with a chart and text equivalent.
- F17: Show daily spending trend and remaining daily allowance.
- F18: Highlight over-budget state without relying only on color.
- F19: Changing exchange rate has a documented predictable effect on existing expenses.
- F20: Handle empty trips,zero expenses and refunds explicitly.

### Export import and privacy
- F21: Export a trip as CSV with formula-safe cells.
- F22: Export and import a versioned JSON backup.
- F23: Validate malformed backup data and duplicate IDs.
- F24: Keep all data on-device and describe receipt retention.
- F25: Request only necessary permissions and handle denied photo access gracefully.

### Native interaction
- F26: Provide trips,expense entry,balances,insights and settings navigation.
- F27: Support Dynamic Type and VoiceOver labels for controls and charts.
- F28: Support dark mode and both small and large iPhone layouts.
- F29: Make expense entry usable with decimal keyboard and locale-aware parsing.
- F30: Preserve user input across validation failures and background transitions.

### Product delivery
- F31: Include deterministic sample trip with4participants and12expenses.
- F32: Provide unit tests for money conversion,split rounding and settlement conservation.
- F33: Provide UI smoke tests or a documented reproducible simulator flow.
- F34: Include complete Xcode project or deterministic XcodeGen manifest plus generation script.
- F35: README documents exact build,test,simulator and data reset steps.

## Security requirements
- S1: No embedded credentials,tracking or unnecessary network permissions.
- S2: Receipt/backup filenames confined to app-owned storage.
- S3: Validate imported monetary values,IDs,currencies and version.
- S4: Safe CSV export and no unsafe force-unwrapping of external input.
- S5: Privacy permission descriptions match actual usage; sensitive receipts excluded from unintended sharing.

## Evaluation contract
Every visible control must perform its claimed action. Demo data must be fictional and deterministic. Tests must validate behavior,not merely assert that files exist. Native signing/store publication is not required. Describe all environment blockers accurately.
