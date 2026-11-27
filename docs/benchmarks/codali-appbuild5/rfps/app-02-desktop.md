# RFP: AtlasDesk

Platform: desktop

A local-first personal knowledge and project workspace. Electron+TypeScript with a React UI; persistence in SQLite or transactionally written local JSON. Linux desktop runnable; provide portable packaging configuration.

## Delivery contract
Build the application end to end in this workspace. Do not just describe a plan or return code snippets. Read this RFP and ENVIRONMENT.md, then implement, build and test as far as the provided environment permits. Use tools to create actual project files. You may discover available file,shell,Docdex,planning and testing tools. You may install public dependencies inside this workspace. No production deployment,external account creation,paid services or host administration is authorized. Keep secrets and personal host data out of the project.

One initial request is supplied; no further feature clarifications or evaluator fixes will be provided. Make reasonable product decisions and document them. Internal tool calls and self-corrections are allowed. Do not lower requirements to make tests pass. The common maximum is60minutes,100model calls,200tool calls,1million aggregate model tokens and8192output tokens per call, subject to64K context. Finish early only if the application is actually complete or you have accurately documented a blocker. Do not claim tests/builds you did not run.

Deliver source,dependency manifests and lockfiles,build configuration,tests,demo fixtures,and README. Include DELIVERY.md with implemented features,exact executed commands and results,known bugs,unverified checks,and missing requirements. Provide a machine-readable delivery.json with keys app,platform,buildCommand,runCommand,testCommand,artifactPaths,knownLimitations. Never include production secrets. Do not remove or rewrite RFP.md or ENVIRONMENT.md. No human will repair submitted code before scoring. Generated dependencies/build caches are excluded from source review but source and produced artifacts are preserved.

## Quality rubric (100points)
Features35: each of the35 numbered feature checks is worth1point. Build/delivery15,reliability/tests15,UI/UX15,code quality10,security10. Evaluation uses actual build/test/runtime evidence plus code review. An absent feature fails. An implemented but untestable native-platform behavior is marked unverified,not passed. Scores include verification coverage; environment gaps are disclosed separately. A screenshot/mockup alone does not prove behavior.

## Platform and data constraints
Use Electron with contextIsolation=true,nodeIntegration=false and a narrow validated preload API. No remote pages or network accounts. Store runtime user data under a configurable app data directory, never overwrite arbitrary host files. Export/import must reject ../ and absolute archive paths. Use system file pickers through main-process IPC. Generated icons may be simple original vector shapes. A browser-only page is not a completed desktop application.

## Required features

### Workspaces and persistence
- F01: Create,rename and switch between multiple independent workspaces.
- F02: Persist notes,tasks,tags and settings across application restart.
- F03: Prevent data from one workspace appearing in another.
- F04: Use atomic writes or DB transactions to protect against partial saves.
- F05: Present recoverable corrupt-file or storage-error state instead of crashing.

### Notes and editor
- F06: Create,rename,edit and soft-delete Markdown notes.
- F07: Autosave with visible saved/unsaved state.
- F08: Render a split editor/preview with sanitized Markdown.
- F09: Maintain at least10note revisions and restore a selected revision.
- F10: Provide trash with restore and confirmed permanent delete.

### Search and organization
- F11: Full-text search note titles and bodies.
- F12: Tag notes with multiple tags and filter by tag.
- F13: Pin and unpin notes with stable ordering.
- F14: Show breadcrumbs and keyboard-focusable note navigation.
- F15: Search results update after edits,deletes and restores.

### Project tasks
- F16: Create tasks with title,due date,priority,status and linked note.
- F17: Kanban columns todo,doing,done with keyboard-accessible movement.
- F18: Filter tasks by overdue,due this week,priority and project.
- F19: Show project progress computed from task state.
- F20: Link from task to note and back without losing edits.

### Import export and backup
- F21: Import a folder of Markdown notes without overwriting existing notes silently.
- F22: Export notes and metadata to a documented backup format.
- F23: Restore a backup into a new workspace.
- F24: Validate malformed backups and reject paths outside selected workspace.
- F25: Provide export/import UI with progress and success/error feedback.

### Desktop UX
- F26: Provide native window menu or equivalent keyboard shortcuts for new note,search and save.
- F27: Persist light/dark/system theme preference.
- F28: Keep layout usable at900x600 and1440x900.
- F29: Provide confirmation before discarding unsaved work or destructive actions.
- F30: Show desktop-specific file chooser behavior rather than fake upload controls.

### Product delivery
- F31: Include sample workspace with12notes,3projects and12tasks.
- F32: Include deterministic tests for persistence,search and backup validation.
- F33: Start through npm run dev and package through npm run package.
- F34: Document Linux requirements and where user data lives.
- F35: Separate main/preload/renderer code and provide typed domain models.

## Security requirements
- S1: No renderer Node integration;context isolation and restricted window navigation.
- S2: IPC validates operation names,payloads and workspace membership.
- S3: Sanitize Markdown; no executable untrusted HTML or arbitrary eval.
- S4: Import/archive paths cannot escape destination or overwrite external files.
- S5: No shell interpolation of user content; least-privilege filesystem access.

## Evaluation contract
Every visible control must perform its claimed action. Demo data must be fictional and deterministic. Tests must validate behavior,not merely assert that files exist. Native signing/store publication is not required. Describe all environment blockers accurately.
