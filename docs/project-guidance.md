# Project Guidance (mcoda)

## Project summary
mcoda is a local-first CLI and service stack for planning, documentation, and execution workflows with agent assistance. It turns RFP/PDR/SDS inputs into epics, stories, and tasks, then orchestrates work, review, and QA with deterministic Git workflows and docdex-backed context.

## What we are building
- A modular CLI (`packages/cli`) that drives planning, doc generation, task execution, code review, and QA.
- Core services (`packages/core`) that implement workflows (create/refine/work-on-tasks, code-review, qa-tasks, docs PDR/SDS, OpenAPI sync).
- Data storage and migrations (`packages/db`) for workspace state, task metadata, and run logs.
- Integrations (`packages/integrations`) for docdex and external APIs.
- Agent adapters (`packages/agents`) and routing for execution contexts.

## Canonical technology stack (do not deviate)
Use the stack below unless a doc explicitly requires otherwise:
- Language/runtime: **TypeScript + Node.js**
- UI (when applicable): **React**
- Primary relational DB: **MySQL** (SQLite for local workspace persistence where already established)
- Cache/queue: **Redis** when needed
- Scripting/automation: **Bash** when appropriate

Do **not** introduce alternate stacks (e.g., Go, Rust, Python) without explicit doc approval.

## Planned folder tree (target structure)
Keep changes aligned to this structure; add new files in the appropriate module. Include new scripts in `tests/all.js` when added.

```text
.
├── .mcoda/                     # workspace runtime data (db, jobs, logs, prompts)
├── docs/
│   ├── pdr/                     # PDR documents
│   ├── sds/                     # SDS documents
│   ├── rfp/                     # RFP source docs
│   ├── project-guidance.md      # this guidance doc
│   ├── requirements-implementation-plan.md
│   ├── requirements-implementation-tasks.md
│   └── usage.md
├── openapi/
│   └── mcoda.yaml               # canonical API contract
├── packages/
│   ├── agents/                  # agent adapters, runners, tests
│   │   ├── src/
│   │   ├── dist/
│   │   └── README.md
│   ├── cli/                     # CLI commands and tests
│   │   ├── src/
│   │   ├── dist/
│   │   └── README.md
│   ├── core/                    # workflow services (tasks, docs, QA, review)
│   │   ├── src/
│   │   ├── dist/
│   │   └── README.md
│   ├── db/                      # workspace/global DB, migrations, tests
│   │   ├── src/
│   │   ├── dist/
│   │   └── README.md
│   ├── generators/              # generators and helpers
│   ├── integrations/            # docdex + external API clients
│   ├── shared/                  # shared utilities and types
│   └── testing/                 # test helpers
├── prompts/
│   ├── code-writer.md
│   ├── code-reviewer.md
│   └── qa-agent.md
├── scripts/
│   └── run-node-tests.js        # node test harness for dist output
├── tests/
│   ├── all.js                   # run-all test runner (unit/component/integration/api)
│   ├── gateway-trio-plan.test.js
│   └── gateway-trio-docs.test.js
├── package.json
├── pnpm-workspace.yaml
├── tsconfig.base.json
└── README.md
```

## Docdex usage (required)
Use docdex before any non-trivial change:
- **Local search:** `docdex_search` / `docdexd chat` for relevant docs and code references.
- **AST and symbols:** `docdex_ast`, `docdex_symbols` to locate classes/methods before creating new ones.
- **Impact graph:** `docdex_impact_diagnostics` to see downstream effects of changes.
- **Code intelligence:** open relevant snippets with `docdex_open` and confirm contracts.
- **Web research:** `docdex_web_research` only when local docs are missing or unclear.
- **Repo memory:** store key decisions with `docdex_memory_save` and recall with `docdex_memory_recall`.
- **Agent memory:** read/write agent preferences with `docdex_get_profile` and `docdex_save_preference`.

## Reuse & avoid duplication (required)
- Before adding a class or method, **search for an existing one** (AST + docdex search).
- Verify with impact graph whether changes overlap existing behavior.
- Prefer extending existing components/services over creating parallel implementations.
- Confirm naming conflicts before writing new code.
- Review prior task work (task logs, diffs, docdex context) before starting so you don't redo or override earlier solutions.

## Testing discipline (required)
- For each task, create **unit/component/integration/api** tests when relevant.
- Any new test script must be registered in `tests/all.js`.
- Run task-specific tests first, then `node tests/all.js` at the end.
- If any test fails, fix and iterate until all tests pass.
