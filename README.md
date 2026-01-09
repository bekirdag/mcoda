![GitHub Actions Workflow Status](https://img.shields.io/github/actions/workflow/status/bekirdag/mcoda/release.yml?branch=main)
![GitHub Actions Workflow Status](https://img.shields.io/github/actions/workflow/status/bekirdag/mcoda/ci.yml?branch=main)
![GitHub Actions Workflow Status](https://img.shields.io/github/actions/workflow/status/bekirdag/mcoda/nightly.yml?branch=main)
![GitHub License](https://img.shields.io/github/license/bekirdag/mcoda)
![GitHub Release](https://img.shields.io/github/v/release/bekirdag/mcoda)
![npm](https://img.shields.io/npm/v/mcoda)
![npm](https://img.shields.io/npm/dm/mcoda)
![Made with TypeScript](https://img.shields.io/badge/Made%20with-TypeScript-3178C6?logo=typescript&logoColor=white)

# mcoda

> Local-first CLI for planning, documentation, and execution workflows with agent assistance.

mcoda turns product intent into structured plans, docs, and execution steps. It keeps your data local, writes repeatable artifacts, and helps teams stay aligned from first draft to shipped code.

## ✨ What is mcoda?
mcoda is a workflow CLI that connects planning, documentation, and delivery. It helps you draft product docs, generate tasks, and run execution loops with consistent structure across teams.

## 🧭 What it does

| Area | Purpose | Output |
| --- | --- | --- |
| 📄 Docs | Draft PDR/SDS/OpenAPI from your inputs | Markdown + OpenAPI YAML |
| 🧠 Planning | Turn specs into tasks and backlog | JSON plans + SQLite state |
| ⚙️ Execution | Drive work, review, and QA loops | Jobs, logs, and telemetry |
| 🤝 Routing | Choose the right agent per command | Defaults and previews |

Optional agent rating is available with `--rate-agents` to score outputs (quality, cost, time, iterations), update per-agent ratings, and inform gateway routing with max-complexity gates and exploration. The reviewer prompt is stored at `.mcoda/prompts/agent-rating.md`.

## 🚀 Why teams use it
- **Local-first**: keeps artifacts and state in your repo.
- **Repeatable**: stable workflows with versioned outputs.
- **Agent-ready**: works with codex, openai, gemini, ollama, and more.
- **Traceable**: jobs, telemetry, and backlog live in one place.

## 🛠️ Quick start
```sh
npm i -g mcoda
mcoda set-workspace --workspace-root .
mcoda --help
```

## 🧰 Docdex & QA
- mcoda ships with the `docdex` CLI. Run `docdex setup` to configure docdex and install Playwright + at least one browser for QA.
- Docdex stores state under `~/.docdex`; mcoda does not create repo-local `.docdex` folders.
- If `~/.docdex/agents.md` exists, it is prepended to every agent run (gateway, work-on-tasks, code-review, QA, docs).

## 🔌 Integrations
- **Docdex** for doc search and context stitching.
- **Git** for task branches and review flows.
- **OpenAPI** for schema-first workflows.
- **QA runners** (Chromium, Maestro, CLI).

## 📂 What gets created
mcoda stores workspace state under `.mcoda/`:
- `docs/` for generated PDR/SDS artifacts.
- `tasks/` for planning outputs.
- `jobs/` for run checkpoints and logs.
- `mcoda.db` for backlog, jobs, and telemetry.

## 📚 Documentation
- Usage guide: `docs/usage.md`
- Quality gates: `docs/quality_gates.md`
- OpenAPI spec: `openapi/mcoda.yaml`
- Release history: `CHANGELOG.md`

## 🤝 Contributing
See `CONTRIBUTING.md`.

## 🧾 License
MIT - see `LICENSE`.
