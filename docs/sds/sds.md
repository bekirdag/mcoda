# mcoda sds v0.3 {#mcoda-sds-v0.3}

## Table of contents {#table-of-contents}

[mcoda sds v0.3](#mcoda-sds-v0.3)

[Table of contents](#table-of-contents)

[mcoda — Software Design Specification (SDS) v0.3](#mcoda-—-software-design-specification-\(sds\)-v0.3)

[Table of Contents](#table-of-contents-1)

[1\. Introduction](#1.-introduction)

[1.1 Purpose](#1.1-purpose)

[1.2 Scope](#1.2-scope)

[1.2.1 In scope for mcoda v1](#1.2.1-in-scope-for-mcoda-v1)

[1.2.2 Out of scope for this SDS (v1)](#1.2.2-out-of-scope-for-this-sds-\(v1\))

[1.3 Design Principles](#1.3-design-principles)

[1.4 Key Concepts](#1.4-key-concepts)

[2\. gpt‑creator Overview](#2.-gpt‑creator-overview)

[2.1 High‑Level Capabilities](#2.1-high‑level-capabilities)

[2.2 Strengths to Preserve](#2.2-strengths-to-preserve)

[2.3 Pain Points & Anti‑patterns to Avoid](#2.3-pain-points-&-anti‑patterns-to-avoid)

[2.4 Capabilities to Match or Exceed](#2.4-capabilities-to-match-or-exceed)

[3\. Migration Strategy & Rules](#3.-migration-strategy-&-rules)

[3.1 High‑Level Migration Goals](#3.1-high‑level-migration-goals)

[3.2 Naming & Repository Rules](#3.2-naming-&-repository-rules)

[3.3 Command Migration & Consolidation Rules](#3.3-command-migration-&-consolidation-rules)

[3.4 Data Model Migration Rules](#3.4-data-model-migration-rules)

[3.5 Agent & Adapter Rules](#3.5-agent-&-adapter-rules)

[3.6 Documentation & OpenAPI Rules](#3.6-documentation-&-openapi-rules)

[3.7 Token Tracking & Reporting Rules](#3.7-token-tracking-&-reporting-rules)

[3.8 Implementation Phasing (High‑Level)](#3.8-implementation-phasing-\(high‑level\))

[4\. System Architecture Overview](#4.-system-architecture-overview)

[4.1 System Context & External Dependencies](#4.1-system-context-&-external-dependencies)

[4.1.1 Runtime Environment & Actors](#4.1.1-runtime-environment-&-actors)

[4.1.2 docdex (prompting, doc usage, OpenAPI alignment)](#4.1.2-docdex-\(prompting,-doc-usage,-openapi-alignment\))

[4.1.3 LLM Providers (Agents) (global agent registry, encrypted auth)](#4.1.3-llm-providers-\(agents\)-\(global-agent-registry,-encrypted-auth\))

[4.1.4 VCS (Version Control Systems) (deterministic mcoda/... branches, task‑branch mapping, logs per run)](#4.1.4-vcs-\(version-control-systems\)-\(deterministic-mcoda/...-branches,-task‑branch-mapping,-logs-per-run\))

[4.1.5 Issue Trackers (encrypted tokens in global DB)](#4.1.5-issue-trackers-\(encrypted-tokens-in-global-db\))

[4.2 Core Components](#4.2-core-components)

[4.2.1 CLI Layer (no TUI; new commands: test-agent, task detail/print, dependency‑ordering, mcoda update, telemetry commands)](#4.2.1-cli-layer-\(no-tui;-new-commands:-test-agent,-task-detail/print,-dependency‑ordering,-mcoda-update,-telemetry-commands\))

[4.2.2 Core Runtime (command runs logging, SP/h calculation over histories, update checks)](#4.2.2-core-runtime-\(command-runs-logging,-sp/h-calculation-over-histories,-update-checks\))

[4.2.3 Agent Layer (global agent registry only, prompt files for job description & character, test‑agent plumbing, QA adapters like Chromium/Maestro)](#4.2.3-agent-layer-\(global-agent-registry-only,-prompt-files-for-job-description-&-character,-test‑agent-plumbing,-qa-adapters-like-chromium/maestro\))

[4.2.4 DB Layer (two DBs: global \~/.mcoda/mcoda.db and workspace /.mcoda/mcoda.db; token\_usage, command\_runs, task\_runs, comments)](#4.2.4-db-layer-\(two-dbs:-global-~/.mcoda/mcoda.db-and-workspace-/.mcoda/mcoda.db;-token_usage,-command_runs,-task_runs,-comments\))

[4.2.5 Job Engine (per‑run logging, resumability, integration with token\_usage and SP/h)](#4.2.5-job-engine-\(per‑run-logging,-resumability,-integration-with-token_usage-and-sp/h\))

[4.3 Trust Boundaries & Security Overview](#4.3-trust-boundaries-&-security-overview)

[4.3.1 Trust Zones (/.mcoda/, \~/.mcoda/, remote services)](#4.3.1-trust-zones-\(/.mcoda/,-~/.mcoda/,-remote-services\))

[4.3.2 Boundary: Local Workspace ↔ LLM Providers (central prompt assembly, task history \+ comments, no raw DB/log dumps)](#4.3.2-boundary:-local-workspace-↔-llm-providers-\(central-prompt-assembly,-task-history-+-comments,-no-raw-db/log-dumps\))

[4.3.3 Boundary: Local Workspace ↔ docdex (SDS/PDR/RFP prompts, OpenAPI‑aligned behavior)](#4.3.3-boundary:-local-workspace-↔-docdex-\(sds/pdr/rfp-prompts,-openapi‑aligned-behavior\))

[4.3.4 Boundary: Local Workspace ↔ VCS Remotes / Issue Trackers (.mcoda in .gitignore, deterministic task branches, per‑run logging)](#4.3.4-boundary:-local-workspace-↔-vcs-remotes-/-issue-trackers-\(.mcoda-in-.gitignore,-deterministic-task-branches,-per‑run-logging\))

[4.3.5 Secrets & Credential Handling (no keychain; encrypted in mcoda DBs; minimal env‑var reliance)](#4.3.5-secrets-&-credential-handling-\(no-keychain;-encrypted-in-mcoda-dbs;-minimal-env‑var-reliance\))

[4.3.6 OpenAPI & Code Integrity (OpenAPI as single contract for each workspace; SQL, code & docs must follow it)](#4.3.6-openapi-&-code-integrity-\(openapi-as-single-contract-for-each-workspace;-sql,-code-&-docs-must-follow-it\))

[4.3.7 Token Usage & Observability (per‑action token\_usage, linkage to command\_runs and SP/h estimations)](#4.3.7-token-usage-&-observability-\(per‑action-token_usage,-linkage-to-command_runs-and-sp/h-estimations\))

[5\. Project Structure & Folder Layout (TypeScript)](#5.-project-structure-&-folder-layout-\(typescript\))

[5.1 Repository Layout](#5.1-repository-layout)

[5.2 Module Boundaries](#5.2-module-boundaries)

[5.2.1 shared](#5.2.1-shared)

[5.2.2 db](#5.2.2-db)

[5.2.3 agents](#5.2.3-agents)

[5.2.4 integrations](#5.2.4-integrations)

[5.2.5 core](#5.2.5-core)

[5.2.6 generators](#5.2.6-generators)

[5.2.7 cli](#5.2.7-cli)

[5.2.8 testing](#5.2.8-testing)

[5.3 Dependency Management & Layering Rules](#5.3-dependency-management-&-layering-rules)

[5.3.1 Layered Architecture](#5.3.1-layered-architecture)

[5.3.2 TypeScript Path Aliases](#5.3.2-typescript-path-aliases)

[5.3.3 OpenAPI‑Driven Contracts](#5.3.3-openapi‑driven-contracts)

[5.3.4 Dependency Constraints & CI Guards](#5.3.4-dependency-constraints-&-ci-guards)

[5.3.5 Testing Strategy per Layer](#5.3.5-testing-strategy-per-layer)

[6\. OpenAPI Contract (Single Source of Truth)](#6.-openapi-contract-\(single-source-of-truth\))

[6.1 OpenAPI Structure & Tags](#6.1-openapi-structure-&-tags)

[6.1.1 File layout (single openapi/mcoda.yaml truth; referenced per workspace)](#6.1.1-file-layout-\(single-openapi/mcoda.yaml-truth;-referenced-per-workspace\))

[6.1.2 Tags & operation grouping](#6.1.2-tags-&-operation-grouping)

[6.1.3 x-mcoda-\* extensions](#6.1.3-x-mcoda-*-extensions)

[6.1.4 Components / Schemas](#6.1.4-components-/-schemas)

[6.2 Operation Groups](#6.2-operation-groups)

[6.2.1 Agents (global‑only agent creation; auth; prompt manifests; test-agent)](#6.2.1-agents-\(global‑only-agent-creation;-auth;-prompt-manifests;-test-agent\))

[6.2.2 Routing (workspace defaults without workspace‑local agent definitions)](#6.2.2-routing-\(workspace-defaults-without-workspace‑local-agent-definitions\))

[6.2.3 Tasks (task comments, task detail, dependency ordering)](#6.2.3-tasks-\(task-comments,-task-detail,-dependency-ordering\))

[6.2.4 Work / Review / QA (work‑on‑tasks, code‑review, qa‑tasks with QA tools)](#6.2.4-work-/-review-/-qa-\(work‑on‑tasks,-code‑review,-qa‑tasks-with-qa-tools\))

[6.2.5 Backlog](#6.2.5-backlog)

[6.2.6 Estimation (SP/h from token\_usage \+ command\_runs)](#6.2.6-estimation-\(sp/h-from-token_usage-+-command_runs\))

[6.2.8 Telemetry (per‑action token usage)](#6.2.8-telemetry-\(per‑action-token-usage\))

[6.3 Versioning & Compatibility Policy (mcoda‑only)](#6.3-versioning-&-compatibility-policy-\(mcoda‑only\))

[6.4 Code Generation & Validation Workflows](#6.4-code-generation-&-validation-workflows)

[6.5 Handling OpenAPI Changes via Agents](#6.5-handling-openapi-changes-via-agents)

[7\. Data Model & Persistence (mcoda.db)](#7.-data-model-&-persistence-\(mcoda.db\))

[7.1 SQLite Configuration & PRAGMAs](#7.1-sqlite-configuration-&-pragmas)

[7.2 Core Tables (Workspace DB)](#7.2-core-tables-\(workspace-db\))

[7.2.1 projects, epics, user\_stories, tasks](#7.2.1-projects,-epics,-user_stories,-tasks)

[7.2.2 jobs](#7.2.2-jobs)

[7.2.3 task\_runs, command\_runs, task\_qa\_runs](#7.2.3-task_runs,-command_runs,-task_qa_runs)

[7.2.4 task\_comments](#7.2.4-task_comments)

[7.2.5 token\_usage (per‑action)](#7.2.5-token_usage-\(per‑action\))

[7.2.6 task\_logs (per‑run log stream)](#7.2.6-task_logs-\(per‑run-log-stream\))

[7.3 Agent & Model Registry Tables (Global DB Only)](#7.3-agent-&-model-registry-tables-\(global-db-only\))

[7.4 Relationships & Constraints](#7.4-relationships-&-constraints)

[7.5 Migration Strategy & Schema Versioning](#7.5-migration-strategy-&-schema-versioning)

[8\. Agent & Multi‑Agentic Layer](#8.-agent-&-multi‑agentic-layer)

[8.1 Adapter Interface & Base Classes (QA adapters, docdex, OpenAPI tools)](#8.1-adapter-interface-&-base-classes-\(qa-adapters,-docdex,-openapi-tools\))

[8.2 Supported Agents (agent prompts, roles, characters)](#8.2-supported-agents-\(agent-prompts,-roles,-characters\))

[8.3 Agent Registry, Auth, and Installation Flows (global, encrypted, no keychain)](#8.3-agent-registry,-auth,-and-installation-flows-\(global,-encrypted,-no-keychain\))

[8.4 Health Checks, Capabilities, and Error Normalization](#8.4-health-checks,-capabilities,-and-error-normalization)

[8.5 Routing & Workspace Defaults (--agent override, docdex & QA capabilities)](#8.5-routing-&-workspace-defaults-\(--agent-override,-docdex-&-qa-capabilities\))

[9\. Documentation & docdex Integration](#9.-documentation-&-docdex-integration)

[9.1 docdex Overview & Required Capabilities](#9.1-docdex-overview-&-required-capabilities)

[9.1.3 Per‑workspace Configuration (.mcoda/config.json)](#9.1.3-per‑workspace-configuration-\(.mcoda/config.json\))

[9.2 RFP/PDR/SDS Retrieval & Context Assembly](#9.2-rfp/pdr/sds-retrieval-&-context-assembly)

[9.3 Doc Generation Flows (SDS/PDR by Agents)](#9.3-doc-generation-flows-\(sds/pdr-by-agents\))

[9.4 Removing Local Indexers — Simplified Architecture](#9.4-removing-local-indexers-—-simplified-architecture)

[9.5 Consistency between Docs, OpenAPI, and Code](#9.5-consistency-between-docs,-openapi,-and-code)

[10\. Task Model & Workflow Orchestration](#10.-task-model-&-workflow-orchestration)

[10.1 Entities & Relationships (epics/user stories/tasks, dependencies, comments, branches)](#10.1-entities-&-relationships-\(epics/user-stories/tasks,-dependencies,-comments,-branches\))

[10.2 Task State Machine & Transitions (per‑command transitions, QA states)](#10.2-task-state-machine-&-transitions-\(per‑command-transitions,-qa-states\))

[10.3 Job Model & Long‑running Orchestration (logging, token\_usage linkage, resumability)](#10.3-job-model-&-long‑running-orchestration-\(logging,-token_usage-linkage,-resumability\))

[10.4 Mapping Tasks to Files, Branches, and PRs (deterministic mcoda/... branches, reuse on reruns, branch stored on tasks/task\_runs)](#10.4-mapping-tasks-to-files,-branches,-and-prs-\(deterministic-mcoda/...-branches,-reuse-on-reruns,-branch-stored-on-tasks/task_runs\))

[11\. CLI Design & Command Surface](#11.-cli-design-&-command-surface)

[11.1 CLI Principles & UX Goals](#11.1-cli-principles-&-ux-goals)

[11.2 Flag & Output Conventions](#11.2-flag-&-output-conventions)

[11.3 Command Reference](#11.3-command-reference)

[11.3.1 mcoda create-tasks](#11.3.1-mcoda-create-tasks)

[11.3.2 mcoda refine-tasks](#11.3.2-mcoda-refine-tasks)

[11.3.3 mcoda work-on-tasks](#11.3.3-mcoda-work-on-tasks)

[11.3.4 mcoda code-review](#11.3.4-mcoda-code-review)

[11.3.5 mcoda qa-tasks](#11.3.5-mcoda-qa-tasks)

[11.3.6 mcoda backlog](#11.3.6-mcoda-backlog)

[11.3.7 mcoda estimate](#11.3.7-mcoda-estimate)

[11.3.8 Agent management (global‑only)](#11.3.8-agent-management-\(global‑only\))

[11.3.9 Routing commands (advanced)](#11.3.9-routing-commands-\(advanced\))

[11.3.10 Telemetry & token tracking](#11.3.10-telemetry-&-token-tracking)

[11.3.11 Job commands](#11.3.11-job-commands)

[11.3.12 mcoda test-agent](#11.3.12-mcoda-test-agent)

[11.3.13 mcoda task-detail / mcoda task show](#11.3.13-mcoda-task-detail-/-mcoda-task-show)

[11.3.14 mcoda order-tasks / dependency ordering](#11.3.14-mcoda-order-tasks-/-dependency-ordering)

[11.3.15 mcoda update](#11.3.15-mcoda-update)

[12\. create-tasks Command](#12.-create-tasks-command)

[12.1 Inputs (docdex, OpenAPI‑aligned doc usage)](#12.1-inputs-\(docdex,-openapi‑aligned-doc-usage\))

[12.2 Flow (epics → stories → tasks, dependencies, SP)](#12.2-flow-\(epics-→-stories-→-tasks,-dependencies,-sp\))

[12.3 Interaction with docdex & Token Usage (per‑action token\_usage)](#12.3-interaction-with-docdex-&-token-usage-\(per‑action-token_usage\))

[12.4 Checkpointing & Resumability (job \+ checkpoint, per‑run logs)](#12.4-checkpointing-&-resumability-\(job-+-checkpoint,-per‑run-logs\))

[13\. refine-tasks Command (uses comments, dependencies, token usage, docdex)](#13.-refine-tasks-command-\(uses-comments,-dependencies,-token-usage,-docdex\))

[13.1 Refinement Strategies & Allowed Mutations](#13.1-refinement-strategies-&-allowed-mutations)

[13.2 CLI & OpenAPI Contract](#13.2-cli-&-openapi-contract)

[13.3 Auditing & History](#13.3-auditing-&-history)

[14.1 Task Selection Strategies (dependencies & statuses)](#14.1-task-selection-strategies-\(dependencies-&-statuses\))

[14.2 Code Generation Pipeline](#14.2-code-generation-pipeline)

[14.3 File System & Git Integration (.mcoda, branches, per‑run logging)](#14.3-file-system-&-git-integration-\(.mcoda,-branches,-per‑run-logging\))

[15\. code-review Command](#15.-code-review-command)

[15.1 Scope & Goals (reviews feeding task\_comments)](#15.1-scope-&-goals-\(reviews-feeding-task_comments\))

[15.2 Flow (use docdex \+ OpenAPI \+ task history in prompts)](#15.2-flow-\(use-docdex-+-openapi-+-task-history-in-prompts\))

[15.2.1 Job creation & task selection](#15.2.1-job-creation-&-task-selection)

[15.2.2 Per‑task context assembly](#15.2.2-per‑task-context-assembly)

[15.2.3 Prompt construction & agent invocation](#15.2.3-prompt-construction-&-agent-invocation)

[15.2.4 Applying decisions & writing comments](#15.2.4-applying-decisions-&-writing-comments)

[15.4 Auditing & Reproducibility (jobs, checkpoints, token\_usage, historical reviews)](#15.4-auditing-&-reproducibility-\(jobs,-checkpoints,-token_usage,-historical-reviews\))

[15.4.1 Jobs, command runs, and checkpoints](#15.4.1-jobs,-command-runs,-and-checkpoints)

[15.4.2 Token usage & cost attribution](#15.4.2-token-usage-&-cost-attribution)

[15.4.3 Historical reviews as re‑run context](#15.4.3-historical-reviews-as-re‑run-context)

[15.4.4 External traceability (optional)](#15.4.4-external-traceability-\(optional\))

[16.1 QA Scope & Modes (QA profiles, acceptance criteria, OpenAPI compliance)](#16.1-qa-scope-&-modes-\(qa-profiles,-acceptance-criteria,-openapi-compliance\))

[16.2 Modes & Flows](#16.2-modes-&-flows)

[16.2.1 CLI modes (auto/manual)](#16.2.1-cli-modes-\(auto/manual\))

[16.2.2 Automated QA flow (Chromium/Maestro etc., QA adapters)](#16.2.2-automated-qa-flow-\(chromium/maestro-etc.,-qa-adapters\))

[16.2.3 Manual QA flow](#16.2.3-manual-qa-flow)

[16.2.4 Job & resumability](#16.2.4-job-&-resumability)

[16.3 Running Tests & Changing States (TaskStateService, token usage, logs)](#16.3-running-tests-&-changing-states-\(taskstateservice,-token-usage,-logs\))

[17.4 Reporting & Velocity (token\_usage \+ command\_runs)](#17.4-reporting-&-velocity-\(token_usage-+-command_runs\))

[17.4.1 Source tables](#17.4.1-source-tables)

[17.4.2 Stage mapping (implementation / review / QA)](#17.4.2-stage-mapping-\(implementation-/-review-/-qa\))

[17.4.3 Deriving empirical SP/hour from history](#17.4.3-deriving-empirical-sp/hour-from-history)

[17.4.4 Combining baseline & empirical velocity](#17.4.4-combining-baseline-&-empirical-velocity)

[17.4.5 Backlog & estimate consumption](#17.4.5-backlog-&-estimate-consumption)

[17.5 CLI: mcoda backlog / mcoda estimate](#17.5-cli:-mcoda-backlog-/-mcoda-estimate)

[17.5.1 mcoda backlog (read‑only SP buckets)](#17.5.1-mcoda-backlog-\(read‑only-sp-buckets\))

[17.5.2 mcoda estimate (baseline 15 SP/h \+ rolling averages)](#17.5.2-mcoda-estimate-\(baseline-15-sp/h-+-rolling-averages\))

[18\. Token Tracking & Telemetry](#18.-token-tracking-&-telemetry)

[18.1 Token Usage Data Model (per‑action token\_usage rows)](#18.1-token-usage-data-model-\(per‑action-token_usage-rows\))

[18.1.1 Scope & placement](#18.1.1-scope-&-placement)

[18.1.2 Logical schema](#18.1.2-logical-schema)

[18.1.3 Relationships & indexes](#18.1.3-relationships-&-indexes)

[18.1.4 Recording semantics](#18.1.4-recording-semantics)

[18.2 Telemetry APIs & CLI (aggregation, grouping, JSON output)](#18.2-telemetry-apis-&-cli-\(aggregation,-grouping,-json-output\))

[18.2.1 OpenAPI telemetry surface](#18.2.1-openapi-telemetry-surface)

[18.2.2 CLI: mcoda tokens & mcoda telemetry](#18.2.2-cli:-mcoda-tokens-&-mcoda-telemetry)

[18.2.3 Output contracts](#18.2.3-output-contracts)

[18.2.4 Aggregation & retention](#18.2.4-aggregation-&-retention)

[18.3 Integration with Jobs & Commands (linking to command\_runs, SP/h derivation)](#18.3-integration-with-jobs-&-commands-\(linking-to-command_runs,-sp/h-derivation\))

[18.3.1 Linking token usage to jobs and command\_runs](#18.3.1-linking-token-usage-to-jobs-and-command_runs)

[18.3.2 Per‑command SP/h derivation](#18.3.2-per‑command-sp/h-derivation)

[18.3.3 Command‑level dashboards & debugging](#18.3.3-command‑level-dashboards-&-debugging)

[18.3.4 Responsibilities & invariants](#18.3.4-responsibilities-&-invariants)

[19\. Jobs & Checkpointing](#19.-jobs-&-checkpointing)

[19.1 Job Model](#19.1-job-model)

[19.1.1 Job types](#19.1.1-job-types)

[19.1.2 Jobs table (workspace DB)](#19.1.2-jobs-table-\(workspace-db\))

[19.1.3 Job states](#19.1.3-job-states)

[19.1.4 Lifecycle stages](#19.1.4-lifecycle-stages)

[19.1.5 Linkage to tasks, token usage & logs](#19.1.5-linkage-to-tasks,-token-usage-&-logs)

[19.2 Disk‑based Checkpoint Format (.mcoda/jobs/\<job\_id\>/...)](#19.2-disk‑based-checkpoint-format-\(.mcoda/jobs/\<job_id\>/...\))

[19.2.1 Layout on disk](#19.2.1-layout-on-disk)

[19.2.2 Checkpoint file format (\*.ckpt.json)](#19.2.2-checkpoint-file-format-\(*.ckpt.json\))

[19.2.3 Design rules](#19.2.3-design-rules)

[19.3 Job Control & Resume](#19.3-job-control-&-resume)

[19.3.1 CLI & API surfaces](#19.3.1-cli-&-api-surfaces)

[19.3.2 Resume algorithm](#19.3.2-resume-algorithm)

[19.3.3 Failure categories & exit codes](#19.3.3-failure-categories-&-exit-codes)

[19.3.4 Command‑specific partial work rules](#19.3.4-command‑specific-partial-work-rules)

[19.3.5 No hidden background workers](#19.3.5-no-hidden-background-workers)

[20\. Security & Secrets](#20.-security-&-secrets)

[20.1 Credential Storage (global vs workspace DB)](#20.1-credential-storage-\(global-vs-workspace-db\))

[20.2 DB‑Only Encrypted Secrets (no keychain)](#20.2-db‑only-encrypted-secrets-\(no-keychain\))

[20.3 Redaction & Logging Rules (task runs, QA runs, token\_usage)](#20.3-redaction-&-logging-rules-\(task-runs,-qa-runs,-token_usage\))

[20.4 Threat Model Overview (DB‑only secrets, .mcoda folder, no keychain)](#20.4-threat-model-overview-\(db‑only-secrets,-.mcoda-folder,-no-keychain\))

[21\. Configuration, Workspaces & Extensibility](#21.-configuration,-workspaces-&-extensibility)

[21.1 Config Files & Environment Variables](#21.1-config-files-&-environment-variables)

[21.1.1 Config layers & precedence](#21.1.1-config-layers-&-precedence)

[21.1.2 Config file schema (v1)](#21.1.2-config-file-schema-\(v1\))

[21.1.3 Environment variables](#21.1.3-environment-variables)

[21.2 Workspace Resolution & Multi‑workspace Support](#21.2-workspace-resolution-&-multi‑workspace-support)

[21.2.1 Workspace identity & layout](#21.2.1-workspace-identity-&-layout)

[21.2.2 Workspace resolution algorithm](#21.2.2-workspace-resolution-algorithm)

[21.2.3 Multi‑workspace behavior](#21.2.3-multi‑workspace-behavior)

[21.3 Plugin & Adapter Extensions](#21.3-plugin-&-adapter-extensions)

[21.3.1 Adapter & provider extensions](#21.3.1-adapter-&-provider-extensions)

[21.3.2 QA and docdex extensions](#21.3.2-qa-and-docdex-extensions)

[21.3.3 Command & feature extension points (v1 scope)](#21.3.3-command-&-feature-extension-points-\(v1-scope\))

[22.1 Phase Breakdown (MVP → Parity → Advanced Features)](#22.1-phase-breakdown-\(mvp-→-parity-→-advanced-features\))

[22.1.1 Phase 0 – Foundations & Skeleton](#22.1.1-phase-0-–-foundations-&-skeleton)

[22.1.2 Phase 1 – MVP (Self‑hosted Task System, Single Agent)](#22.1.2-phase-1-–-mvp-\(self‑hosted-task-system,-single-agent\))

[22.1.3 Phase 2 – Full Workflow & Productization](#22.1.3-phase-2-–-full-workflow-&-productization)

[22.1.4 Phase 3 – Advanced Features & Optimization](#22.1.4-phase-3-–-advanced-features-&-optimization)

[22.2 Risk Analysis & Mitigation Strategies](#22.2-risk-analysis-&-mitigation-strategies)

[22.2.1 Technical risks](#22.2.1-technical-risks)

[22.2.2 Product & UX risks](#22.2.2-product-&-ux-risks)

[22.2.3 Security & secrets risks](#22.2.3-security-&-secrets-risks)

[22.2.4 Performance & cost risks](#22.2.4-performance-&-cost-risks)

[22.3 Testing Strategy & CI Matrix](#22.3-testing-strategy-&-ci-matrix)

[22.3.1 Test layers](#22.3.1-test-layers)

[22.3.2 CI matrix](#22.3.2-ci-matrix)

[22.1 Phase Breakdown (MVP → Parity → Advanced Features)](#22.1-phase-breakdown-\(mvp-→-parity-→-advanced-features\)-1)

[22.1.1 Phase 0 – Foundations & Skeleton](#22.1.1-phase-0-–-foundations-&-skeleton-1)

[22.1.2 Phase 1 – MVP (Self‑hosted Task System, Single Agent)](#22.1.2-phase-1-–-mvp-\(self‑hosted-task-system,-single-agent\)-1)

[22.1.3 Phase 2 – Full Workflow & Productization](#22.1.3-phase-2-–-full-workflow-&-productization-1)

[22.1.4 Phase 3 – Advanced Features & Optimization](#22.1.4-phase-3-–-advanced-features-&-optimization-1)

[22.2 Risk Analysis & Mitigation Strategies](#22.2-risk-analysis-&-mitigation-strategies-1)

[22.2.1 Technical risks](#22.2.1-technical-risks-1)

[22.2.2 Product & UX risks](#22.2.2-product-&-ux-risks-1)

[22.2.3 Security & secrets risks](#22.2.3-security-&-secrets-risks-1)

[22.2.4 Performance & cost risks](#22.2.4-performance-&-cost-risks-1)

[22.3 Testing Strategy & CI Matrix](#22.3-testing-strategy-&-ci-matrix-1)

[22.3.1 Test layers](#22.3.1-test-layers-1)

[22.3.2 CI matrix](#22.3.2-ci-matrix-1)

[23\. Appendices](#23.-appendices)

[23.1 Glossary](#23.1-glossary)

[23.2 Example Configs & Workflows](#23.2-example-configs-&-workflows)

[23.3 Sample OpenAPI Snippets](#23.3-sample-openapi-snippets)

[23.3.1 Telemetry: token usage](#23.3.1-telemetry:-token-usage)

[23.3.2 Tasks: comments](#23.3.2-tasks:-comments)

[23.3.3 Agents: test‑agent](#23.3.3-agents:-test‑agent)

[23.3.4 Tasks: dependency ordering](#23.3.4-tasks:-dependency-ordering)

[23.3.5 System: update check & apply](#23.3.5-system:-update-check-&-apply)

[23.4 References](#23.4-references)

# **mcoda — Software Design Specification (SDS) v0.3** {#mcoda-—-software-design-specification-(sds)-v0.3}

## **Table of Contents** {#table-of-contents-1}

1. Introduction

2. gpt-creator Overview

3. Migration Strategy & Rules

4. System Architecture Overview

5. Project Structure & Folder Layout (TypeScript)

6. OpenAPI Contract (Single Source of Truth)

7. Data Model & Persistence (mcoda.db)

8. Agent & Provider Abstraction

9. Documentation & docdex Integration

10. Task Model & Workflow Orchestration

11. CLI Design & Command Catalogue

12. create-tasks Command

13. refine-tasks Command

14. work-on-tasks Command

15. code-review Command

16. qa-tasks Command

17. Backlog & Estimation

18. Token Tracking & Telemetry

19. Job Engine & Resumability

20. Security & Secrets

21. Configuration, Workspaces & Extensibility

22. Implementation Plan & Milestones

23. Configuration Examples & Reference

---

## **1\. Introduction** {#1.-introduction}

### **1.1 Purpose** {#1.1-purpose}

mcoda is a multi‑agent, LLM‑agnostic CLI and library for:

* structured documentation creation (RFP → PDR → SDS),

* task and backlog generation (epics → user stories → tasks),

* code writing & refactoring,

* code review (including structured review comments back to tasks),

* QA workflows (test planning & execution, including external tools such as headless browsers or mobile QA runners like Chromium / Maestro),

* all driven by a single OpenAPI specification and a small set of SQLite schemas that cover planning, agents, telemetry, and run history.

Each project workspace has a `.mcoda` directory that holds mcoda’s workspace‑local state (workspace DB, prompts, logs, documentation snapshots, job checkpoints, task comments and run logs). Global, cross‑workspace data (agent registry, credentials, encryption keys, global defaults, telemetry) lives under `~/.mcoda`.

The purpose of this SDS is to define, in enough detail to implement and evolve mcoda, the:

* **Target architecture** of mcoda: CLI, core runtime, multi‑agent layer, DB layer (global `~/.mcoda/mcoda.db` and per‑workspace `<repo>/.mcoda/mcoda.db`), job engine, and integrations (docdex, VCS, issue trackers, QA adapters).

* **Data model & OpenAPI contracts** for projects, epics, user stories, tasks, task dependencies, task comments, jobs, token usage, and command/task run logs — including how these map to OpenAPI schemas (`x-mcoda-db-table`) and are synchronized across global and workspace DBs.

* **CLI commands and workflows**, including (but not limited to):  
   `create-tasks`, `refine-tasks`, `work-on-tasks`, `code-review`, `qa-tasks`, `gateway-trio`, `backlog`, `estimate`, token/telemetry views, `task show`/task-detail, task dependency ordering, agent management, `test-agent`, and `mcoda update`.

* **Agent routing, prompts, and character model**: a global agent registry only (no workspace‑local agents) stored in `~/.mcoda/mcoda.db`; prompt files per agent for its **job description** and its **character**, plus command‑specific prompt templates that describe how to use tools (docdex, Git, QA runners, SDS generation, etc.). These are wired via OpenAPI `x-mcoda-*` extensions so agents “know what to do” for each command.

* **Token accounting, SP/hour behavior, and telemetry**: per‑command, per‑agent, per‑job and per‑action token tracking, a 15 SP/hour default that is refined over time from actual task runs (e.g. rolling averages over the last 10/20/50 `work-on-tasks` executions), and reporting surfaces for cost and throughput.

* **Long‑running jobs, checkpointing, logging, and run history**: job and run models, including `jobs`, `task_runs`, `command_runs`, `task_comments`, and associated logs so that every run is auditable and can be resumed or re‑run with full historical context.

* **Security and secret‑handling model**: DB‑backed encrypted secret storage (no OS keychains), redaction rules for logs and prompts, and trust boundaries between the local workspace, docdex, LLM providers, VCS, and issue trackers.

* **Packaging and update flows**: mcoda as a TypeScript CLI published as an npm package, with automated release on `v*` tag pushes and explicit update mechanisms (`mcoda update`, on‑run update checks).

Whenever there is a conflict between implementation, SQL, and documentation, the OpenAPI Swagger YAML (`openapi/mcoda.yaml`) is the single technical source of truth for every workspace. All generators, DB schemas, prompt manifests, and runtime code must be derived from, and validated against, that OpenAPI spec; SDS and other docs are secondary and must be kept in sync via mcoda itself.

---

### **1.2 Scope** {#1.2-scope}

#### **1.2.1 In scope for mcoda v1** {#1.2.1-in-scope-for-mcoda-v1}

* **CLI & library**  
   A TypeScript codebase providing both CLI commands (`mcoda …`) and an embeddable library API, distributed as an npm package.

* **Agent layer**  
   Adapter‑based support for multiple agent clients and LLM providers (OpenAI, Anthropic, Gemini, Ollama, etc.), selected per command via `--agent`. The agent layer also covers non‑LLM tools (docdex, Git/VCS, headless browser, Maestro/mobile QA runner) behind a unified adapter interface.

* **Global agent registry (no workspace‑local agents)**  
   All agents are defined globally in `~/.mcoda/mcoda.db` and referenced from workspaces by ID/slug. Workspaces may configure **which** global agent to use (defaults and overrides), but they do not define their own agent records or auth rows.

* **Task system & workspace model**  
   Epics, user stories, tasks, and task dependencies as first‑class entities in mcoda DBs, with a consistent hierarchy and state machine.  
   Each Git repository that mcoda operates on is a **workspace**: mcoda creates `<repo>/.mcoda/` on first use, including the workspace DB, prompts, job checkpoints, and logs. This directory is auto‑added to `.gitignore` so mcoda artifacts are never committed.

* **create‑tasks pipeline and docdex integration**  
   Generation of epics, user stories, and tasks from RFP/PDR/SDS and other docs via docdex. The SDS specifies how docdex is called, what DTOs are used, and how retrieved context is assembled.

* **Task execution commands**  
   `refine-tasks`, `work-on-tasks`, `code-review`, `qa-tasks`, and the `gateway-trio` orchestration loop are responsible for evolving tasks through their lifecycle, updating task state, creating comments, and writing run logs. Their behavior, persistence model and interaction with docdex, VCS, and QA tools are in scope.

* **Backlog & estimation**  
   Story‑point‑based modeling of work, including SP/hour (SP/h) defaults and learned velocities from historical task runs, broken down by lane (e.g., implementation vs review vs QA). Estimation for “ready‑to‑review”, “ready‑to‑qa”, and “completed” milestones is in scope.

* **Token tracking & telemetry**  
   Per‑command, per‑agent, per‑job, and per‑action token accounting, persisted via `token_usage` and linked to `command_runs` / `task_runs` so that usage can be reported by time range, project, agent, and command.

* **Documentation & OpenAPI**  
   OpenAPI YAML as the single contract for CLI and internal services; docdex as the only documentation indexer (no local full‑text index). SDS/PDR/other docs are generated and refined through mcoda itself, using the same OpenAPI and docdex pipelines.

* **Prompts and agentic command usage**  
   Prompt files for agents (job description and character) and command‑specific templates are part of the product surface. OpenAPI `x-mcoda-*` metadata specifies which prompts to load, which tools can be used, and what context (SDS sections, task history, task comments, token usage) must be provided to agents for each command (including `create-tasks`, `work-on-tasks`, SDS generation and QA flows).

* **Long‑running jobs & resumability**  
   Job model for SDS generation, bulk task creation, long‑running refactors and QA runs; checkpoint structures, resumable workflows, and their persistence under `.mcoda`.

* **Security & secrets**  
   DB‑backed secret storage (provider keys, docdex tokens, issue tracker tokens, QA credentials) encrypted at rest; no OS keychain integration; env vars allowed only as bootstrap inputs that are persisted immediately into encrypted DB rows.

* **Packaging & updates**  
   Release process for the `mcoda` npm package (including auto‑publish on `v*` tags), startup update checks, and the `mcoda update` command that upgrades the CLI when the user opts in.

* **New utility commands**  
   Commands such as `test-agent` (sanity‑checking agent connectivity), `task show`/task-detail, and dependency‑based task ordering (prioritizing tasks with many dependents) are first‑class and covered in the SDS.

#### **1.2.2 Out of scope for this SDS (v1)** {#1.2.2-out-of-scope-for-this-sds-(v1)}

Out of scope items remain as in v0.2, with clarifications:

* A full‑blown **web UI or TUI**; mcoda v1 is CLI‑first, with APIs and OpenAPI contracts sufficient for future UI layers.

* A hosted **SaaS backend**; mcoda is local‑first, relying only on remote APIs for LLM providers, docdex, VCS, and issue trackers.

* Complex **multi‑tenant user management**; we assume a single developer or small team sharing a workspace.

* Any automated **migration path from gpt‑creator**; mcoda is treated as a fresh product. Historical experience informs design, but this SDS does not specify data or command‑level migration flows from gpt‑creator.

* Acting as a general‑purpose **issue tracker**, **CI system**, or **secret‑management service**; integrations exist, but these systems remain external.

* Non‑developer workflows (end‑user support, marketing pipelines, etc.) — only developer‑centric planning, implementation, review, and QA flows are covered.

---

### **1.3 Design Principles** {#1.3-design-principles}

mcoda is designed from scratch, informed by prior multi‑agent systems, but without inheriting legacy complexity or requiring any migration from gpt‑creator. The guiding principles are:

* **OpenAPI‑first**  
   Every command and internal service maps to OpenAPI operations. SQL schemas, TypeScript types, and CLI help are generated from or validated against the spec.  
   `openapi/mcoda.yaml` (plus validated plugin fragments) is the single technical source of truth for commands, DB tables, job types, state transitions and external integrations. When OpenAPI, code and SQL disagree, OpenAPI wins.

* **Agent‑agnostic, model‑agnostic core**  
   A unified adapter interface (install/auth/ping/list/invoke/capabilities) supports multiple LLM providers and tool adapters (docdex, VCS, QA). All commands accept `--agent` and can run against any compatible adapter registered globally.

* **Global agents, deterministic defaults**  
   Agents are defined only in the global registry (`~/.mcoda/mcoda.db`). Each workspace configures a default agent; if it cannot be resolved or is unhealthy and no override is given, commands fail fast with a clear error instead of silently re‑routing.

* **Prompt‑driven behavior with explicit metadata**  
   Agents use separate prompt files for **job description** and **character**, plus command‑specific templates. OpenAPI `x-mcoda-*` extensions describe which prompts to load, allowed tools, and required context (SDS sections, task history, task comments, run logs), so that agentic commands like SDS generation, `work-on-tasks`, `code-review`, and `qa-tasks` behave predictably.

* **Single source of truth for task hierarchy & docs**  
   RFP, PDR, SDS, epics, user stories, and tasks live in a consistent model and flow; there are no duplicated “doc generation” implementations scattered across commands. Docdex is the only document indexer; mcoda never maintains its own full‑text index.

* **Simplicity over cleverness**  
   No unnecessary containers or “big bang” refactors for small changes. Prefer incremental file edits, structured diffs, and explicit user confirmation for destructive operations.

* **Resumable long‑running operations**  
   Commands that may take a long time (SDS generation, bulk task creation, deep refactors, large QA suites) always persist checkpoints and can resume from the last consistent state via the job engine.

* **Observability & token awareness**  
   Each LLM/tool call records usage, latency, and context (command, job, task). Users can inspect token usage per command, project, agent and time window; SP/hour metrics are derived from historical task runs rather than hard‑coded.

* **Local‑first, security‑conscious**  
   All long‑lived secrets are stored only in encrypted SQLite DBs (`~/.mcoda/mcoda.db` and optional workspace DBs), with a local encryption key under `~/.mcoda`. There is no OS keychain integration; env vars are used once at setup and then discarded after persisting into encrypted storage. Logs and prompts are passed through redaction, so secrets never leak.

* **Configuration via files & DBs, not env‑var sprawl**  
   Persistent configuration and secrets live under `~/.mcoda` and `<workspace>/.mcoda`. Environment variables are treated as ephemeral overrides or bootstrap inputs, not as the primary store for key/value configuration.

* **CLI‑first, automation‑friendly**  
   The CLI is the primary interface; all commands can emit stable machine‑readable output (`--json`) and compose well in shell and CI environments. There is no built‑in TUI; any future UI will sit on top of the same OpenAPI and DB contracts.

---

### **1.4 Key Concepts** {#1.4-key-concepts}

* **Workspace**  
   A project rooted at a Git repository that mcoda operates on. On first use, mcoda creates `<repo>/.mcoda/` containing the workspace DB (`mcoda.db`), logs, prompts, checkpoints, and other local artifacts; `.mcoda/` is automatically added to `.gitignore`.

* **Global store (`~/.mcoda`)**  
   Machine‑local directory holding the global `mcoda.db`, encryption keys, global agent registry, credentials, and cross‑workspace telemetry/config.

* **Agent**  
   A logical provider of LLM or tool capabilities (e.g., OpenAI, Anthropic, local Ollama, Chromium QA runner), accessed via a common adapter interface and registered only in the global DB. Each agent has associated job and character prompts, plus metadata derived from OpenAPI.

* **Job**  
   A long‑lived, resumable operation (e.g., “Generate SDS for service X”, “Implement feature Y and update docs”) modeled as a DAG of tasks, with checkpoints and run history.

* **Epic → User Story → Task**  
   The core planning hierarchy. Tasks are the atomic units of work executed by agents and humans; they carry status, assignee, dependencies and links to VCS artifacts (branches, commits, PRs).

* **Task comments**  
   Structured comments attached to tasks (e.g., issues found by code‑review or QA agents) that record feedback, defects, and instructions for follow‑up runs. Stored in a dedicated table (e.g. `task_comments`) and used as context on subsequent `work-on-tasks`, `code-review`, and `qa-tasks` runs.

* **Runs & logs (`task_runs`, `command_runs`)**  
   Every invocation of a command that touches tasks or jobs is recorded as a run, with timestamps, agent, branch/commit info, status, and summarized logs. These are reused on re‑runs to reconstruct what happened previously and to compute SP/h and token metrics.

* **Token usage (`token_usage`)**  
   A per‑action, per‑call record of tokens consumed (prompt, completion, total), linked to `command_runs` and `task_runs`. Forms the basis for cost reporting and for learning SP/hour from real history.

* **docdex**  
   External documentation indexing/search service. mcoda never maintains its own full‑text index; all doc retrieval goes through typed `DocdexClient` calls using OpenAPI DTOs.

* **SP/hour (SP/h) and velocity**  
   Story‑point throughput metrics computed from historical task runs and token usage, used for estimation and capacity planning. A 15 SP/h default is used initially and gradually replaced by empirically measured SP/h over configurable windows (e.g., last 10/20/50 tasks for `work-on-tasks`).

* **Job engine**  
   The orchestrator that schedules tasks within a job, persists checkpoints, resumes failed or paused jobs, and links jobs to tasks, runs, and token usage records.

---

## **2\. gpt‑creator Overview** {#2.-gpt‑creator-overview}

mcoda is a greenfield tool, but its architecture is informed by the strengths and weaknesses of gpt‑creator. gpt‑creator remains a separate product; mcoda does **not** share its codebase or database, and there is no runtime dependency on `tasks.db`. This section exists only to capture prior‑art lessons that shape mcoda’s design.

---

### **2.1 High‑Level Capabilities** {#2.1-high‑level-capabilities}

From the existing multi‑agent documentation and architecture, gpt‑creator provided:

* **Multi‑agent registry backed by SQLite**

  * Central `tasks.db` storing agents, auth, models, health, installers, and routing rules.

* **CLI for agent and routing management**

  * Commands for agent lifecycle (add‑llm, logout‑llm, auth‑status, llm‑list).

  * Workspace defaults (use‑llm) and routing‑rule inspection (routing commands, job‑type rules, explain‑routing).

* **Adapter layer**

  * Unified invoke API with streaming, cancellation, error normalization, and capabilities introspection.

  * Adapters for OpenAI, Anthropic, Ollama, and CLI‑based tools.

* **Routing engine**

  * Workspace‑level defaults and rules (`routing_rules`) for selecting agents by job type/pattern.

  * Health‑aware routing with explainability.

* **Installation & auth orchestrator**

  * Installer driven by manifests and OS/arch detection.

  * Catalog of available providers/models merged with a local registry.

mcoda reuses these ideas conceptually but reimplements them around its own goals, schemas, and file layout.

---

### **2.2 Strengths to Preserve** {#2.2-strengths-to-preserve}

mcoda keeps the “good bones” from gpt‑creator while changing how and where they are implemented:

* **Solid multi‑agent abstractions**

  * Typed adapter interface (`ping`, `list_models`, `invoke`, `capabilities`) with conformance tests.

  * Error normalization, streaming contracts, and capabilities introspection.

* **SQLite‑backed registry with real constraints**

  * Strong schemas with foreign keys, optimistic concurrency (`row_version`), and WAL mode.

  * Clear install/auth state machines for agents.

* **CLI UX discipline**

  * Strict argument parsing and predictable exit codes.

  * Consistent help text and JSON output suitable for scripting.

* **Routing & workspace defaults**

  * Per‑workspace default agent with a global fallback and explicit routing rules by job type.

* **Secrets & logging discipline (reinterpreted)**

  * Careful invariants and redaction in logs.

  * In mcoda, this becomes “all long‑lived credentials are stored only in encrypted SQLite (`~/.mcoda/mcoda.db`), never in OS keychains”, while keeping the same focus on auditability and redaction.

---

### **2.3 Pain Points & Anti‑patterns to Avoid** {#2.3-pain-points-&-anti‑patterns-to-avoid}

Experience with gpt‑creator surfaced several issues that mcoda explicitly avoids:

* **Messy command surface & duplication**

  * Overlapping, poorly named commands (especially around tasks and JIRA) that re‑implemented similar logic in multiple places.

  * Doc‑generation logic scattered across commands, causing drift and inconsistent behavior.

* **Over‑engineered flows for simple edits**

  * Heavy use of containers or multi‑step pipelines for small changes.

  * Large, multi‑file “mass moves” where small, explicit patches would have been safer.

* **Local documentation indexing**

  * Maintaining an internal indexer alongside docdex‑like services increased complexity and created consistency problems.

  * mcoda must rely solely on docdex (or equivalent) for document search and context.

* **Incomplete long‑job handling**

  * Long‑running commands without robust checkpoint/resume semantics.

  * Ad‑hoc retries and limited observability around partial failures.

* **Implicit or missing token accounting**

  * Token usage tracked inconsistently (or not at all) per command/agent.

  * Limited tooling to analyze cost and usage across projects.

* **Entangled responsibilities in `tasks.db`**

  * Agent registry, task data, and miscellaneous metadata mixed into a single DB with fuzzy boundaries.

* **Fragmented secrets model**

  * Multiple storage backends (DB \+ OS keychains \+ env vars) made configuration and debugging harder, especially cross‑platform.

  * mcoda moves to a single secrets model: encrypted credentials in `~/.mcoda/mcoda.db` only, no keychain integration.

* **Legacy coupling**

  * gpt‑creator’s schemas and command naming leaked into downstream tools.

  * mcoda treats gpt‑creator purely as prior art: there is no shared code, no reuse of `tasks.db`, and no built‑in “run in gpt‑creator‑compat mode”.

---

### **2.4 Capabilities to Match or Exceed** {#2.4-capabilities-to-match-or-exceed}

At a minimum, mcoda must match gpt‑creator’s multi‑agent capabilities and then go significantly further in planning, execution, and observability.

**Multi‑agent core**

* Connect to and manage multiple LLM and tool providers via a global agent registry in `~/.mcoda/mcoda.db`.

* Provide clear CLI commands for inspecting and managing agents, plus a dedicated `mcoda test-agent` command that validates connectivity with a simple probe (e.g., “what is 2+2?”).

* Drive all agent usage from prompt files: each agent has a **job‑description** prompt and a **character** prompt, with additional command‑specific prompts describing how to use tools and follow each workflow.

**Task system & workflows**

* Model epics → user stories → tasks, with explicit dependency graphs and a command that can order tasks by dependencies for prioritization.

* Provide a deterministic `work-on-tasks` workflow that:

  * Loads the appropriate agent and its prompts.

  * Commits/stashes dirty state, checks out `mcoda-dev`, then checks out or creates a deterministic task branch whose name includes `mcoda`.

  * Works locally on code, tests, and docs, commits to the task branch, pushes it, merges back into `mcoda-dev` on success, and pushes again.

* Maintain workspace‑local state under `<workspace>/.mcoda/` (DB, docs, prompts, logs), ensure `.mcoda` is added to `.gitignore`, and expose a command to print rich task details (status, history, comments, runs).

**Telemetry, SP/h, and history**

* Record every agent invocation into an append‑only `token_usage` table, attributed by command, phase, agent, model, job, and task.

* Track all task runs and command runs in SQLite, with structured logs attached to each run so agents can reuse prior context on re‑runs instead of starting from scratch.

* Treat “15 SP/h” as a configurable starting baseline and continuously refine it using sliding‑window averages over the last 10/20/50 completed tasks per command type (e.g., implementation vs review vs QA).

**Docs, OpenAPI, and QA**

* Use docdex for all documentation retrieval; mcoda must not implement its own indexer.

* Treat a single `openapi/mcoda.yaml` file per workspace as the canonical technical source of truth for commands, schemas, and state transitions; DB schema, TypeScript types, and docs are generated from or validated against this file.

* Provide a dedicated `qa-tasks` command that can orchestrate CLI‑based tests as well as external extensions (e.g., Chromium or Maestro) under agent control.

**Packaging & updates**

* Ship mcoda as an npm package that can be installed as a standard CLI (`npx`/global install) and automatically published on `v*` tag pushes.

* Offer a `mcoda update` command and lightweight “check for update” behavior on manual runs so users can accept or skip upgrades explicitly.

* Keep all global configuration and encrypted credentials under `~/.mcoda`, avoid relying on environment variables for durable config, and remain CLI‑only (no separate TUI layer).

## **3\. Migration Strategy & Rules** {#3.-migration-strategy-&-rules}

This section defines how mcoda “lands” in a repository, how the global vs workspace data model evolves over time, and which rules keep commands, OpenAPI, and storage consistent. There is **no migration from gpt‑creator**; mcoda is a from‑scratch product. “Migration” here means:

* onboarding an existing Git repo into the standard `~/.mcoda` \+ `<repo>/.mcoda` structure, and

* evolving mcoda’s own schemas and commands via forwards‑only migrations.

All rules below are binding for any implementation or refactor.

---

### **3.1 High‑Level Migration Goals** {#3.1-high‑level-migration-goals}

* **Single, predictable layout**

  * Global state lives under `~/.mcoda` (global `mcoda.db`, encrypted credentials, global defaults).

  * Each Git workspace has a `<repo>/.mcoda` directory for workspace‑local DB, logs, prompts, docs, and job artifacts.

  * `.mcoda` must exist before any stateful command runs and must be added to `.gitignore`.

* **OpenAPI‑first evolution**

  * `openapi/mcoda.yaml` in the repo is the **single technical source of truth** for CLI commands, DB‑backed entities, jobs, and telemetry.

  * SQL schemas, TypeScript DTOs, and CLI handlers are generated or validated against this file; migrations are driven from spec changes, not ad‑hoc code.

* **Complete run history**

  * Every stateful command run (e.g. `create-tasks`, `work-on-tasks`, `code-review`, `qa-tasks`) creates a durable `command_runs` row and per‑run logs.

  * All agent calls are logged into `token_usage`.

  * All inter‑agent comments are persisted into `task_comments` and reused on re‑runs.

* **Simple, forwards‑only schema migrations**

  * Both global and workspace `mcoda.db` use ordered, idempotent migrations.

  * Migration failures must be explicit and recoverable; commands do not run against a partially migrated DB.

* **Deterministic workflows**

  * Git branch names, task selection rules, status transitions, and update flows are deterministic so that re‑runs behave predictably.

  * Defaults like 15 SP/h are treated as a starting point and automatically reshaped from real task history over sliding windows.

---

### **3.2 Naming & Repository Rules** {#3.2-naming-&-repository-rules}

**Directories & files**

* Global root: `~/.mcoda/`

  * `~/.mcoda/mcoda.db` – global SQLite DB (agents, credentials, global defaults, global telemetry).

  * `~/.mcoda/agents/...` – global agent configs and prompt files.

  * `~/.mcoda/releases.json` (or equivalent) – update metadata for `mcoda update` and auto‑update checks.

* Workspace root: `<repo>/.mcoda/`

  * `<repo>/.mcoda/mcoda.db` – workspace SQLite DB (tasks, task\_comments, command\_runs, token\_usage, run logs).

  * `<repo>/.mcoda/jobs/` – job checkpoints and per‑run artifacts.

  * `<repo>/.mcoda/docs/` – workspace docs under mcoda control (SDS, PDR, RFP, etc).

  * `<repo>/.mcoda/prompts/` – command‑level prompt snippets.

  * `<repo>/.mcoda/config.*` – workspace config.

**Git ignore**

* On first attach, mcoda **must**:

  * Create `<repo>/.mcoda/` if missing.

  * Ensure `.mcoda/` is present in `.gitignore`. If missing, append a standardized entry.

**Branches & naming**

* Integration branch:

  * `mcoda-dev` is the default integration branch for mcoda‑driven work.

  * Created from the project’s base branch (e.g. `main`) if missing.

* Task branches:

  * Deterministic per task, always containing the `mcoda` prefix, e.g.:

    * `mcoda/task/<TASK_KEY>` or `mcoda/task/<TASK_ID>`.

  * The chosen branch name is stored on the task (or in `command_runs`) and **reused** on every `work-on-tasks` re‑run.

**CLI naming**

* Commands are verbs with consistent names:

  * Planning: `create-tasks`, `refine-tasks`.

  * Execution: `work-on-tasks`, `code-review`, `qa-tasks`.

  * Introspection: `backlog`, `estimate`, `task show`, `tasks order-by-deps`, `tokens`, `telemetry`, `job *`.

  * Agent lifecycle: `agent *`, `test-agent`.

  * Lifecycle / upgrade: `mcoda update`.

* There is **no TUI**; all UX is CLI (plus any future API/GUI layers built on the same OpenAPI).

---

### **3.3 Command Migration & Consolidation Rules** {#3.3-command-migration-&-consolidation-rules}

mcoda exposes a **small, canonical command surface**; legacy or overlapping commands are not carried forward.

**Canonical command families**

* **Planning & backlog shaping**

  * `mcoda create-tasks` – epics/specs → stories → tasks.

  * `mcoda refine-tasks` – controlled enrichment, splitting/merging, re‑estimation.

* **Pipeline stages**

  * `mcoda work-on-tasks` – implementation; drives the deterministic Git workflow:

    1. Load agent and prompts (job \+ character \+ command‑specific).

    2. Commit or stash dirty repo state.

    3. Check out `mcoda-dev`.

    4. Check out/create deterministic task branch (contains `mcoda`).

    5. Apply code/doc changes.

    6. Commit to task branch, push branch.

    7. Merge to `mcoda-dev` on success, push `mcoda-dev`.

    8. Iterate per task.

  * `mcoda code-review` – review stage (diffs \+ docs \+ OpenAPI), writes structured feedback to `task_comments`, advances tasks to `ready_to_qa` or back to `in_progress`.

  * `mcoda qa-tasks` – QA stage, orchestrating CLI, Chromium, or Maestro runners via QA agents, and updating `task_qa_runs` / task statuses.

* **Inspection & ordering**

  * `mcoda backlog` – bucketed backlog views (implementation / review / QA / done).

  * `mcoda estimate` – estimates with SP/h based on history.

  * `mcoda task show <TASK>` – prints full task details (hierarchy, status history, comments, last runs).

  * `mcoda tasks order-by-deps` (or `backlog --order dependencies`) – returns tasks topologically ordered by `task_dependencies` so the most depended‑on work can be prioritized.

* **Agents & health**

  * `mcoda agent *` – create/list/edit/remove agents in the **global** registry.

  * `mcoda test-agent <NAME>` – resolves a global agent, runs “what is 2+2?” (or similar) through it, and records a `command_runs` \+ `token_usage` entry.

* **Lifecycle & updates**

  * On manual CLI runs, mcoda may **check for updates** (via npm metadata) and prompt the user whether to update.

  * `mcoda update` – checks and installs an update to the CLI itself, following npm installation rules.

  * The published CLI is an **npm package** and is auto‑deployed on `v*` tag pushes via CI.

**Rules**

* Every command maps 1:1 to one or more **OpenAPI operations**; no hidden “special” commands.

* Deprecated commands must be removed (not just hidden), with a clear migration path to the canonical ones above.

* All stateful commands:

  * create a `command_runs` row on start and update it at end,

  * record per‑run logs in the workspace DB,

  * emit `token_usage` rows for all agent/tool calls.

---

### **3.4 Data Model Migration Rules** {#3.4-data-model-migration-rules}

*(per‑workspace `.mcoda/mcoda.db`, task\_comments, command\_runs, token\_usage, logging per run)*

**Database placement**

* Global DB: `~/.mcoda/mcoda.db`

  * Cross‑workspace data: agents, encrypted credentials, global defaults, global aggregates.

* Workspace DB: `<repo>/.mcoda/mcoda.db`

  * Workspace‑local planning and execution data: projects, epics, user stories, tasks, task\_dependencies, task\_comments, command\_runs, task\_run\_logs, token\_usage, jobs.

* On first use in a workspace, mcoda:

  * creates `.mcoda/` and `.mcoda/mcoda.db` if missing,

  * ensures `.mcoda/` is ignored by Git,

  * runs migrations to bring the workspace DB to the latest schema.

**Epics, stories, tasks**

* Tables `epics`, `user_stories`, and `tasks` exist in every workspace DB.

* Relationships:

  * each `tasks` row references exactly one `user_story`,

  * each `user_stories` row references exactly one `epic`.

* Task statuses are finite and normalized (e.g. `not_started`, `in_progress`, `ready_to_review`, `ready_to_qa`, `completed`, `blocked`, `cancelled`); state transitions are owned by commands like `work-on-tasks`, `code-review`, and `qa-tasks`.

**Task comments (inter‑agent communication)**

* `task_comments` table in the workspace DB holds structured comments on tasks:

  * `task_id`, `author_type` (`agent` / `human`), `agent_id` (if applicable),

  * `source_command` (`work-on-tasks`, `code-review`, `qa-tasks`, etc.),

  * `category` (`bug`, `style`, `test`, `docs`, …),

  * `body`,

  * timestamps and optional `resolved_*` fields.

* Rules:

  * `code-review` and `qa-tasks` must write findings into `task_comments`, not only stdout/PR comments.

  * `work-on-tasks` must load unresolved comments and treat them as first‑class context for re‑runs.

**Command runs & logs**

* `command_runs` (name may vary slightly) exists in each workspace DB:

  * `command_name`, `workspace_id`, `job_id` (if any),

  * git info (`git_branch`, `git_base_branch`),

  * `task_ids` (list or join table),

  * timestamps and status (`success|failed|cancelled`),

  * optional throughput metrics (SP processed, duration).

* Per‑run logs:

  * `task_run_logs` (or equivalent) records phase‑level logs per run:

    * `command_run_id`, `task_id`, `phase`, `status`, and `details_json`.

* Rules:

  * All long‑running commands (`create-tasks`, `refine-tasks`, `work-on-tasks`, `code-review`, `qa-tasks`) **must** create a `command_runs` row and logs.

  * On re‑runs, commands consult prior `command_runs` \+ logs to understand what happened previously and to build agent context.

**Jobs & checkpoints**

* Long‑running flows are modeled as `jobs` in the workspace DB plus on‑disk checkpoints under `.mcoda/jobs/<job_id>/...`.

* Jobs are forward‑only and resumable; historical jobs are never rewritten, only appended.

**Token usage**

* `token_usage` table logs **every** agent or tool invocation:

  * `workspace_id`, `command_run_id`, `command_name`, `action/phase`,

  * `agent_id`, `model_name`,

  * optional `project_id`, `epic_id`, `user_story_id`, `task_id`,

  * `tokens_prompt`, `tokens_completion`, `tokens_total`,

  * optional cached token fields (`tokens_cached`, `tokens_cache_read`, `tokens_cache_write`),

  * optional timing fields (`started_at`, `finished_at`, `duration_ms`),

  * optional invocation metadata (`invocation_kind`, `provider`, `currency`),

  * optional `cost_estimate`,

  * `timestamp`.

* `token_usage` is append‑only; rows are never edited, and deletions only happen via explicit retention policies.

---

### **3.5 Agent & Adapter Rules** {#3.5-agent-&-adapter-rules}

*(global‑only agents in `~/.mcoda/mcoda.db`, no workspace agent tables)*

**Global agent registry**

* All agents are **global** and stored only in `~/.mcoda/mcoda.db`:

  * `agents` – logical agents (slugs, display names, adapter type, config).

  * `agent_auth` (or `credentials`) – encrypted API keys and tokens.

  * `agent_capabilities` – capabilities such as `plan`, `work`, `review`, `qa`, `docdex_query`, `qa_extension_chromium`, `qa_extension_maestro`.

  * `workspace_defaults` – mapping from workspace identifier to default agents per command (implemented in the global DB; no agent tables in workspace DBs).

* Workspaces refer to global agents by ID/slug; no workspace‑local agent creation or duplication.

**Adapters & tools**

* Adapters are TypeScript modules implementing a common `AgentAdapter` interface (initialize, healthCheck, invoke, invokeStreaming, getCapabilities).

* Both LLMs and tools (e.g. docdex, Git, Chromium QA, Maestro mobile QA) are exposed as agents/adapters behind the same telemetry path.

**Prompts & character files**

* Every agent has at least two prompt files, stored under `~/.mcoda/agents/<agent-name>/prompts/`:

  * a **job description** prompt (`job.md`): what this agent does for mcoda (work, review, QA, etc.),

  * a **character** prompt (`character.md`): tone, style, and risk tolerance.

* Command‑specific prompts live under workspace and/or global paths, e.g.:

  * `<repo>/.mcoda/prompts/work-on-tasks/system.md`

  * `<repo>/.mcoda/prompts/sds/generate.md`

* At runtime, command adapters compose:

  * agent job prompt,

  * agent character prompt,

  * command‑specific tool‑usage prompt (e.g. how to use docdex; how to follow the work‑on‑tasks Git workflow),

  * task \+ run history.

**Command‑level agent usage & `test-agent`**

* All agent‑using commands accept `--agent <NAME>` and resolve it through the global registry.

* A dedicated `mcoda test-agent <NAME>` (or `mcoda agent test <NAME>`) command:

  * loads prompts and credentials,

  * runs a trivial probe (“what is 2+2?”),

  * records a `command_runs` \+ `token_usage` entry,

  * surfaces health (OK/degraded/unreachable) and latency.

**Secrets & credentials**

* All API keys and credentials are stored **only** in encrypted columns in the global `mcoda.db` (`agent_auth` / `credentials`).

* mcoda **does not use OS keychains**; environment variables may be used to bootstrap secrets but are not a durable store.

* A small key file (e.g. `~/.mcoda/key`) is used for application‑level encryption/decryption.

---

### **3.6 Documentation & OpenAPI Rules** {#3.6-documentation-&-openapi-rules}

*(OpenAPI as single source of truth for SQL, code, and docs)*

**Single canonical OpenAPI**

* Each mcoda repo has a single canonical spec:

  * `openapi/mcoda.yaml` (optionally split via `$ref` into components).

* This spec defines:

  * all CLI‑backed operations (tasks, jobs, agents, tokens, telemetry, update checks, etc.),

  * schemas for persisted entities (tasks, jobs, task\_comments, command\_runs, token\_usage, agents),

  * error models and status transitions.

* All workspaces depend on their `openapi/mcoda.yaml`; no workspace‑local API drift is allowed.

**SQL, types, and code from OpenAPI**

* TypeScript DTOs and API clients are generated from `mcoda.yaml`.

* DB schemas for entities annotated with `x-mcoda-db-table` are derived or validated from the spec:

  * spec changes → regenerate types → generate/apply migrations → update code.

* If code/SQL/docs disagree with OpenAPI, **OpenAPI wins**; migrations and codegen must be fixed.

**Prompt & tool metadata in OpenAPI**

* OpenAPI operations use `x-mcoda-*` extensions to describe:

  * required roles (work agent, review agent, QA agent, estimator),

  * which prompt files (job/character/command) must be loaded,

  * allowed tools (docdex, Git, QA extensions),

  * required context (task history, comments, command\_runs, token\_usage joins).

* SDS generation, `work-on-tasks`, `code-review`, `qa-tasks`, `create-tasks`, `refine-tasks`, `mcoda update`, and `test-agent` all have well‑defined OpenAPI operations with these extensions.

**docdex integration**

* docdex is the single storage/index source of truth for docs.

* docdex endpoints (search, fetch, segment retrieval) are defined in OpenAPI; mcoda does not implement its own index.

* Workspace docs under `.mcoda/docs/` are synchronized with docdex via these documented operations.

---

### **3.7 Token Tracking & Reporting Rules** {#3.7-token-tracking-&-reporting-rules}

*(per‑action `token_usage`, reporting dimensions, SP/h based on last N tasks)*

**Per‑action recording**

* Every agent/tool call records a `token_usage` row (no sampling), linked to:

  * `command_run_id`, `command_name`, `action/phase`,

  * `agent_id`, `model_name`,

  * workspace/project/epic/story/task identifiers when applicable.

* `openapi_operation_id` must be recorded wherever possible for traceability.

**Reporting capabilities**

* `mcoda tokens` and `mcoda telemetry` must provide grouping/filtering by:

  * command, action/phase,

  * agent/model,

  * workspace/project/epic/story/task,

  * time window,

  * job status.

* Outputs:

  * human‑readable tables by default,

  * JSON for tooling with `--json`.

**SP/h behavior & sliding windows**

* The global config starts with a default **15 SP/h** for implementation, review, and QA lanes.

* Effective SP/h per lane is continuously shaped from historical data:

  * for each lane (e.g. `work-on-tasks`, `code-review`, `qa-tasks`), mcoda looks at the last **N completed tasks** where that lane made the relevant state transition,

  * N must support at least `{10, 20, 50}` as configurable window sizes.

* For a given window N:

  * compute total SP completed and total wall‑clock time (from status transitions / command\_runs),

  * derive empirical SP/h for that lane,

  * blend with configured baseline as per `VelocityConfig` (see Backlog & Estimation section).

* These effective SP/h values are:

  * surfaced via `mcoda estimate` (with explicit `config|empirical|mixed` modes),

  * used to refine ETAs in backlog/estimate views,

  * never replace raw data in `token_usage` and `command_runs`.

---

### **3.8 Implementation Phasing (High‑Level)** {#3.8-implementation-phasing-(high‑level)}

Implementation is phased, but **not** as a migration from gpt‑creator. Instead, mcoda is delivered in incremental, internal phases:

* **Phase 0 – Foundations**

  * Establish `~/.mcoda` and `<repo>/.mcoda` layout.

  * Implement global \+ workspace DBs, migrations, and SecretsService (encrypted DB, no keychain).

  * Introduce OpenAPI baseline, agent registry, prompt loading, and `mcoda test-agent`.

  * Set up CI with lint/tests and npm publishing on `v*` tag releases.

* **Phase 1 – Core Task System**

  * Implement `create-tasks`, `work-on-tasks` (with deterministic branch workflow), `backlog`, `estimate` (with 15 SP/h baseline), and `token_usage` \+ `command_runs`.

  * Wire docdex integration and basic SP/h reporting.

* **Phase 2 – Full Pipeline & Telemetry**

  * Add `refine-tasks`, `code-review`, `qa-tasks`, `task show`, dependency‑ordered backlog/`tasks order-by-deps`.

  * Add QA integrations (Chromium, Maestro) behind agents.

  * Harden `token_usage` reporting, SP/h sliding windows per lane, and `mcoda update` flows.

* **Phase 3 – Advanced & Polishing**

  * Refine prompts and OpenAPI `x-mcoda-*` metadata.

  * Enrich telemetry, dashboards, and optional integrations (issue trackers, CI hooks).

  * Tighten migrations and schema evolution tooling.

All phases share the same invariants defined in this section: OpenAPI as the source of truth, global‑only agents in `~/.mcoda`, workspace `.mcoda` DBs for tasks/runs/tokens/logs, deterministic Git workflows, encrypted credentials in SQLite (no keychains), and comprehensive per‑run logging.

## 4\. System Architecture Overview {#4.-system-architecture-overview}

mcoda is a local CLI \+ library that runs on a developer machine or CI runner, using two SQLite databases (`~/.mcoda/mcoda.db` global, `<workspace>/.mcoda/mcoda.db` per repo) and a job engine to orchestrate agents, documentation, and VCS/issue‑tracker operations via a single OpenAPI contract.

---

### **4.1 System Context & External Dependencies** {#4.1-system-context-&-external-dependencies}

#### **4.1.1 Runtime Environment & Actors** {#4.1.1-runtime-environment-&-actors}

* **Actors:** individual developers and CI pipelines invoking `mcoda` in a Git workspace.

* **Local state:** each repo has `<workspace>/.mcoda/` for the workspace DB, job checkpoints, logs, generated docs/prompts, and config; global cross‑workspace state lives in `~/.mcoda/`.

* **Remote dependencies:** LLM providers exposed as “agents”, docdex for documentation indexing/search, VCS remotes (GitHub/GitLab/etc.), issue trackers (Jira/Linear/…), and optional QA runners (Chromium/Maestro).

#### **4.1.2 docdex (prompting, doc usage, OpenAPI alignment)** {#4.1.2-docdex-(prompting,-doc-usage,-openapi-alignment)}

* mcoda outsources all doc indexing/search to **docdex**; it never builds its own index.

* docdex is accessed through a typed `DocdexClient` that is defined in `openapi/mcoda.yaml` and returns normalized DTOs (search, segments, registration).

* RFP/PDR/SDS and related docs under `.mcoda/docs/` (and other configured sources) are registered in docdex and retrieved for:

  * SDS/PDR/RFP read flows,

  * task creation/refinement (requirements context),

  * work / review / QA prompts (architecture, constraints, runbooks).

* docdex tokens are stored encrypted in the global DB; configuration and usage are driven by OpenAPI tags/operations (`Docdex`, `Docs`) so code and SQL cannot drift from the contract.

#### **4.1.3 LLM Providers (Agents) (global agent registry, encrypted auth)** {#4.1.3-llm-providers-(agents)-(global-agent-registry,-encrypted-auth)}

* All LLMs and tool‑style adapters (Chromium, Maestro, CLI tools) are exposed as **agents** behind a single adapter interface; mcoda remains provider‑agnostic.

* A **global agent registry** in `~/.mcoda/mcoda.db` tracks agents, models, capabilities, prompts, and workspace defaults; workspaces can override defaults but not redefine the registry shape.

* Credentials (API keys, tokens) are stored only in encrypted tables (e.g. `agent_auth` / `credentials`) in the global DB; no OS keychain, no long‑lived env‑var storage.

* Commands call agents via a routing layer that resolves `--agent` overrides, verifies capabilities, and records per‑call token usage; `mcoda test-agent` exercises the same path for diagnostics.

#### **4.1.4 VCS (Version Control Systems) (deterministic mcoda/... branches, task‑branch mapping, logs per run)** {#4.1.4-vcs-(version-control-systems)-(deterministic-mcoda/...-branches,-task‑branch-mapping,-logs-per-run)}

* mcoda shells out to `git` via a `VcsClient`; it does not manage Git credentials itself.

* Each workspace ensures `<workspace>/.mcoda/` is in `.gitignore`, so DBs, logs, checkpoints, and prompts are never committed.

* A dedicated integration branch (e.g. `mcoda-dev`) plus **deterministic per‑task branches** (e.g. `mcoda/task/<task_id>`) are used by `work-on-tasks`:

  * Branch names are stored on the task/job and reused on re‑runs.

  * `task_runs` / `command_runs` capture branch and commit SHAs for every run.

* Diffs and branch metadata from VCS are consumed by `code-review` and `qa-tasks`, and logged per run for later debugging and estimation.

#### **4.1.5 Issue Trackers (encrypted tokens in global DB)** {#4.1.5-issue-trackers-(encrypted-tokens-in-global-db)}

* Connectors for Jira/Linear/etc. are implemented as typed clients defined in OpenAPI and configured per workspace/project.

* Issue‑tracker tokens are stored encrypted in the global DB (same model as agent/docdex credentials); they are never written to workspace config or logs.

* mcoda syncs titles, descriptions, status changes, and comments (including references to `task_id` / `job_id` / branch names); all calls pass through the clients so retries, rate‑limits, and logging are centralized.

---

### **4.2 Core Components** {#4.2-core-components}

#### **4.2.1 CLI Layer (no TUI; new commands: test-agent, task detail/print, dependency‑ordering, mcoda update, telemetry commands)** {#4.2.1-cli-layer-(no-tui;-new-commands:-test-agent,-task-detail/print,-dependency‑ordering,-mcoda-update,-telemetry-commands)}

* `mcoda` is a **pure CLI**; there is no TUI. Every subcommand is a thin wrapper over one or more OpenAPI operations annotated with `x-mcoda-cli`.

* Responsibilities:

  * Parse flags, resolve workspace/project context, choose output format (`table|json|yaml|raw`).

  * Dispatch to the core runtime with a typed request built from OpenAPI DTOs.

  * Handle exit codes and human‑friendly vs machine‑readable output.

* Surface area (selected):

  * Agent commands (`mcoda agent ...`, `mcoda test-agent`).

  * Task commands (`mcoda create-tasks`, `refine-tasks`, `work-on-tasks`, `task show`, dependency‑ordered views).

  * Quality lane (`mcoda code-review`, `qa-tasks`).

  * Read‑only reporting (`mcoda backlog`, `mcoda estimate`, `mcoda tokens`, `mcoda telemetry ...`).

  * Distribution (`mcoda update` for version checks and upgrades).

#### **4.2.2 Core Runtime (command runs logging, SP/h calculation over histories, update checks)** {#4.2.2-core-runtime-(command-runs-logging,-sp/h-calculation-over-histories,-update-checks)}

* Hosts the main orchestration layer:

  * Resolves workspace/global config, agents, docdex/VCS/issue‑tracker clients, and DB connections for each command.

  * Creates and updates **`command_runs`** rows for every significant CLI invocation (command name, workspace, job id, status, timing, error summary).

* Uses task and job histories plus `token_usage` to compute effective SP/hour for implementation, review, and QA lanes, feeding `mcoda estimate` and backlog views.

* Performs periodic **update checks** against a release feed and surfaces available versions through `mcoda update`.

* Enforces that all behavior is described by `openapi/mcoda.yaml`; runtime types and DB migrations are generated or validated from that spec.

#### **4.2.3 Agent Layer (global agent registry only, prompt files for job description & character, test‑agent plumbing, QA adapters like Chromium/Maestro)** {#4.2.3-agent-layer-(global-agent-registry-only,-prompt-files-for-job-description-&-character,-test‑agent-plumbing,-qa-adapters-like-chromium/maestro)}

* Implements the **AgentAdapter** abstraction for all LLM and tool integrations, reusing a common interface (`invoke`, `invokeStream`, `healthCheck`, `getCapabilities`).

* Reads from the global agent registry to:

  * Resolve agents by slug/ID and workspace defaults.

  * Load **prompt files** for each agent:

    * “Job description” prompt (responsibilities, scope).

    * “Character” prompt (tone, risk tolerance, style).

    * Command‑specific prompt snippets for `create-tasks`, `work-on-tasks`, `code-review`, `qa-tasks`, etc.

* Provides plumbing for:

  * `mcoda test-agent` (health, latency, connectivity).

  * Non‑LLM QA adapters such as Chromium and Maestro, exposed as agents with QA capabilities.

* All invocations go through a single telemetry path that records token usage, provider/model information, and normalized errors.

#### **4.2.4 DB Layer (two DBs: global \~/.mcoda/mcoda.db and workspace /.mcoda/mcoda.db; token\_usage, command\_runs, task\_runs, comments)** {#4.2.4-db-layer-(two-dbs:-global-~/.mcoda/mcoda.db-and-workspace-/.mcoda/mcoda.db;-token_usage,-command_runs,-task_runs,-comments)}

* Uses two SQLite databases, both called `mcoda.db` but living in different scopes:

  * **Global DB** (`~/.mcoda/mcoda.db`): agents, models, encrypted credentials, routing rules, global defaults, aggregate telemetry.

  * **Workspace DB** (`<workspace>/.mcoda/mcoda.db`): projects/epics/stories/tasks, `task_runs`, `task_comments`, `task_logs`, `jobs`, `command_runs` (workspace‑scoped), and `token_usage`.

* Common configuration:

  * WAL mode, foreign keys enabled, application‑level encryption for secret columns.

  * Clear separation: global DB never holds tasks; workspace DB never holds long‑lived credentials.

* Core tables for observability and coordination:

  * `task_runs` – per‑task execution history for `work-on-tasks`, `code-review`, `qa-tasks`.

  * `command_runs` – per CLI invocation, including non task‑scoped commands.

  * `task_comments` – structured comments from agents/humans for work, review, and QA.

  * `token_usage` – append‑only per‑call token accounting linked to commands/jobs/tasks.

#### **4.2.5 Job Engine (per‑run logging, resumability, integration with token\_usage and SP/h)** {#4.2.5-job-engine-(per‑run-logging,-resumability,-integration-with-token_usage-and-sp/h)}

* Long‑running or multi‑step commands (`create-tasks`, `refine-tasks`, `work-on-tasks`, `code-review`, `qa-tasks`) are executed as **jobs** with:

  * A `jobs` row capturing type, payload, progress, and terminal status.

  * Disk‑based checkpoints under `.mcoda/jobs/<job_id>/` (manifest \+ checkpoint files \+ artifacts).

* The engine:

  * Emits structured per‑phase logs to `task_logs` and job log files.

  * Supports resuming jobs from the last checkpoint (`mcoda job resume <job_id>`).

  * Updates `command_runs` and `task_runs` as phases complete.

* Every agent call during a job writes to `token_usage`, allowing SP/hour computation and cost analysis per job, command, agent, and task.

---

### **4.3 Trust Boundaries & Security Overview** {#4.3-trust-boundaries-&-security-overview}

#### **4.3.1 Trust Zones (/.mcoda/, \~/.mcoda/, remote services)** {#4.3.1-trust-zones-(/.mcoda/,-~/.mcoda/,-remote-services)}

* **Local Workspace (highly trusted):**

  * Git checkout, source/tests, local config, and all workspace mcoda artifacts under `<workspace>/.mcoda/` (DB, jobs, logs, docs, prompts).

  * May contain sensitive IP and secrets in code/config; mcoda must not leak this data by default.

* **Local Machine & Global mcoda Home (trusted, but constrained):**

  * `~/.mcoda/` with the global DB, encryption key material, and optional global logs/telemetry.

  * Protected by OS user permissions; used only for cross‑workspace data and credentials.

* **Remote Services (untrusted / semi‑trusted):**

  * LLM providers, docdex, VCS remotes, issue trackers, QA services.

  * Treated as untrusted: mcoda trusts their contracts but not their privacy guarantees; prompts and data crossing these boundaries are minimized and redacted.

#### **4.3.2 Boundary: Local Workspace ↔ LLM Providers (central prompt assembly, task history \+ comments, no raw DB/log dumps)** {#4.3.2-boundary:-local-workspace-↔-llm-providers-(central-prompt-assembly,-task-history-+-comments,-no-raw-db/log-dumps)}

* All calls to LLMs go through a **centralized prompt assembly layer**:

  * Combines command‑level templates, agent job/character prompts, docdex context, and **summaries** of task history/comments.

  * Commands cannot send arbitrary raw text directly to providers; they must use this layer.

* What may cross:

  * Targeted code snippets, design fragments, test excerpts, SDS/PDR/RFP segments.

  * Summaries of prior `task_runs` and `task_comments`, never full DB tables or raw logs.

* What must **not** cross:

  * Raw `mcoda.db` contents, unbounded log streams, `.env` files, or private key material.

* Prompt/completion logging is disabled by default; when enabled, all content passes through the same redaction middleware used for standard logs.

#### **4.3.3 Boundary: Local Workspace ↔ docdex (SDS/PDR/RFP prompts, OpenAPI‑aligned behavior)** {#4.3.3-boundary:-local-workspace-↔-docdex-(sds/pdr/rfp-prompts,-openapi‑aligned-behavior)}

* mcoda sends only explicitly selected docs to docdex:

  * RFP/PDR/SDS and related architecture docs,

  * chosen in‑repo docs and generated artifacts (e.g. SDS drafts) when opted in.

* All docdex traffic flows through a typed `DocdexClient` that:

  * Enforces timeouts, retries, and error mapping.

  * Normalizes responses into OpenAPI‑defined DTOs so agents see a stable structure.

* docdex credentials are stored encrypted in the global DB and only accessible to the client; they are never exposed to CLI output or prompts.

* Sensitive directories such as `.mcoda`, `.git`, secret vaults, and key files are excluded from automatic docdex registration.

#### **4.3.4 Boundary: Local Workspace ↔ VCS Remotes / Issue Trackers (.mcoda in .gitignore, deterministic task branches, per‑run logging)** {#4.3.4-boundary:-local-workspace-↔-vcs-remotes-/-issue-trackers-(.mcoda-in-.gitignore,-deterministic-task-branches,-per‑run-logging)}

* To VCS remotes:

  * mcoda pushes branches, commits, and PR/MR metadata via `git` and optional API clients.

  * `<workspace>/.mcoda/` is always kept out of version control via `.gitignore`.

  * Deterministic **task branches** and commit messages link VCS artifacts back to task/job ids; these links are persisted in `task_runs`.

* To issue trackers:

  * mcoda sends issue titles, descriptions, status transitions, and comments.

  * All operations pass through typed clients that use encrypted tokens from the global DB, with central logging and rate‑limit handling.

* VCS and issue‑tracker secrets are never written to logs or prompts; only redacted identifiers or fingerprints may appear.

#### **4.3.5 Secrets & Credential Handling (no keychain; encrypted in mcoda DBs; minimal env‑var reliance)** {#4.3.5-secrets-&-credential-handling-(no-keychain;-encrypted-in-mcoda-dbs;-minimal-env‑var-reliance)}

* Long‑lived secrets (LLM keys, docdex tokens, issue‑tracker tokens, QA credentials) are stored **only** in encrypted columns in `~/.mcoda/mcoda.db`.

* Encryption keys live under `~/.mcoda/` and are protected by OS permissions; secrets are decrypted only in memory.

* mcoda deliberately **does not** use OS keychains as a primary backend:

  * Environment variables may be used once for bootstrap (`mcoda agent add`, initial setup) but are not treated as durable configuration.

  * After bootstrap, secrets must be read from the encrypted DB; env‑vars are treated as overrides, not storage.

* All logging goes through a redaction layer that masks keys, tokens, Authorization headers, and secret‑like patterns; raw secret values never appear in `.mcoda/logs` or stdout/stderr.

#### **4.3.6 OpenAPI & Code Integrity (OpenAPI as single contract for each workspace; SQL, code & docs must follow it)** {#4.3.6-openapi-&-code-integrity-(openapi-as-single-contract-for-each-workspace;-sql,-code-&-docs-must-follow-it)}

* `openapi/mcoda.yaml` is the **single technical source of truth**:

  * Describes CLI operations, request/response schemas, errors, jobs, telemetry models, and DB‑backed entities marked with `x-mcoda-db-table`.

  * All CLI handlers, DTOs, and SQL schemas are generated from or validated against this spec.

* If OpenAPI, SQL, and code disagree, **OpenAPI wins**:

  * CI enforces spec validation, type generation, and DB schema sync.

  * Changes to persisted fields visible in the API require corresponding migrations and doc updates.

* Agents may only modify OpenAPI via dedicated operations and jobs (e.g. `openapi_change`), which:

  * Propose a diff, run `openapi:validate` \+ generation \+ DB sync in a temporary workspace,

  * Apply changes only if all checks pass, and

  * Record the full flow as a job with token usage and artifacts for audit.

#### **4.3.7 Token Usage & Observability (per‑action token\_usage, linkage to command\_runs and SP/h estimations)** {#4.3.7-token-usage-&-observability-(per‑action-token_usage,-linkage-to-command_runs-and-sp/h-estimations)}

* Every agent/tool call records an append‑only row in `token_usage`:

  * Includes workspace, command name, action/phase, agent id, model name, job id, optional project/epic/story/task ids, token counts, cost estimate, and timestamp.

  * Links back to `command_runs` / `task_runs` for joinable histories.

* Reporting commands (`mcoda tokens`, `mcoda telemetry ...`, `mcoda estimate`) query `token_usage` and run histories to:

  * Break down usage by command, agent, model, workspace, project, and time window.

  * Derive effective SP/hour per lane (implementation, review, QA) over configurable windows (e.g. last 10/20/50 tasks).

* Storage guarantees:

  * `token_usage` is append‑only; counts are never mutated.

  * Any archival/cleanup must preserve the ability to answer “who used what, for which task, when, and at what cost?” for the configured retention window.

### **5\. Project Structure & Folder Layout (TypeScript)** {#5.-project-structure-&-folder-layout-(typescript)}

mcoda is a single TypeScript monorepo. Runtime state (SQLite DBs, prompts, logs, job checkpoints, docs snapshots) lives outside the repo, under \~/.mcoda/ for global data and \<workspace\>/.mcoda/ for per‑workspace data. All behavior, schemas, and DTOs are driven from a single openapi/mcoda.yaml file.

#### **5.1 Repository Layout** {#5.1-repository-layout}

mcoda is shipped as an npm package from this monorepo; CI builds and publishes on v\* tag pushes via scripts/release.ts.

**Root Layout**

Plaintext

```

mcoda/
  package.json
  pnpm-workspace.yaml
  tsconfig.base.json
  .eslintrc.cjs
  .prettierrc
  .editorconfig

  /docs/
    sds/
    pdr/
    rfp/

  /openapi/
    mcoda.yaml              # single source of truth for all workspaces
    /generated/
      types/                # TS DTOs (global + workspace-scoped)
      clients/              # REST clients (optional)
    gen-openapi.ts          # codegen scripts

  /scripts/
    dev.ts
    build-all.ts
    release.ts              # tags v* → publish npm package

  /packages/
    cli/
    core/
    db/
    agents/
    integrations/
    generators/
    shared/
    testing/

```

##### **5.1.1 Planned Folder Tree** {#5.1.1-planned-folder-tree}

The following tree represents the expected end-state of the repository (plus runtime folders where relevant). It includes all planned scripts and the run-all tests entrypoint.

Plaintext

```

mcoda/
  .mcoda/                     # workspace runtime data (not committed)
    docs/                     # cached PDR/SDS/RFP snapshots
    jobs/                     # job manifests and artifacts
    logs/                     # execution logs
    prompts/                  # per-workspace prompt overrides
    state/                    # checkpoints, last-run metadata
    mcoda.db                  # workspace SQLite DB
  docs/
    pdr/
    sds/
    rfp/
    project-guidance.md
    requirements-implementation-plan.md
    requirements-implementation-tasks.md
    usage.md
  openapi/
    mcoda.yaml
    generated/
      types/
      clients/
    gen-openapi.ts
  prompts/
    README.md
    code-writer.md
    code-reviewer.md
    gateway-agent.md
    qa-agent.md
  scripts/
    dev.ts
    build-all.ts
    release.ts
    run-node-tests.js
    install-local-cli.sh
    pack-npm-tarballs.js
  packages/
    agents/
      src/
      dist/
      README.md
    cli/
      src/
      dist/
      README.md
    core/
      src/
      dist/
      README.md
    db/
      src/
      dist/
      README.md
    generators/
      src/
      dist/
      README.md
    integrations/
      src/
      dist/
      README.md
    shared/
      src/
      dist/
      README.md
    testing/
      src/
      dist/
      README.md
  tests/
    all.js
    unit/
    component/
    integration/
    api/
    gateway-trio-plan.test.js
    gateway-trio-docs.test.js
    artifacts.md
    results/
      test-summary.json
  package.json
  pnpm-workspace.yaml
  tsconfig.base.json
  README.md
  .editorconfig
  .eslintrc.cjs
  .prettierrc
  .gitignore

```

**Runtime Data Locations (Not in Repo)**

*Global data (machine‑wide, shared across workspaces):*

Plaintext

```

~/.mcoda/
  mcoda.db          # global schema: agents, auth, routing defaults, telemetry, config, etc.
  logs/             # optional global logs
  prompts/agents/   # default job + character prompts per agent
  prompts/commands/ # default command‑level runbooks
  config.json       # minimal config; no secrets in env vars

```

*   
  All **agent registry tables and credentials** live only in \~/.mcoda/mcoda.db.  
* Secrets (API keys, tokens) are stored **only as encrypted columns** in this DB; the OS keychain is never used.

*Workspace data (per Git repo):*

Plaintext

```

<workspace-root>/.mcoda/
  mcoda.db          # workspace schema: projects, epics, stories, tasks, jobs,
                    # task_comments, command_runs/task_runs, token_usage, task_logs
  prompts/agents/   # workspace overrides for agent job+character prompts
  prompts/commands/ # workspace-specific command prompts (e.g. SDS conventions)
  docs/             # cached SDS/PDR/RFP fragments, local snapshots
  state/            # job checkpoints, last-run metadata

```

**Workspace DB Guarantees**

* Workspace DBs focus on **task orchestration and execution history**: tasks, task\_dependencies, task\_runs, task\_comments, task\_logs, token\_usage, optional sp\_metrics, plus jobs and planning tables.  
* Workspace DBs **never** contain global credentials or cross‑workspace configuration; those live only in \~/.mcoda/mcoda.db.

**CLI Responsibilities for Layout**

The CLI must:

* Create \<workspace\>/.mcoda/ on first use in a repo.  
* Ensure .mcoda/ is present in .gitignore.  
* Treat \~/.mcoda and \<workspace\>/.mcoda as **data‑only**; no code is checked in there.

openapi/mcoda.yaml defines one logical schema that both global and workspace mcoda.db instances implement (different table subsets per scope). OpenAPI remains the single contract; DB files are scoped projections of that model.

---

#### **5.2 Module Boundaries** {#5.2-module-boundaries}

We keep strict module boundaries and push all “agentic” rules (prompts, workflows) into @mcoda/core and the OpenAPI spec, rather than scattering literals.

##### **5.2.1 shared** {#5.2.1-shared}

**Provides**

* Logging interface, error types, lightweight utilities.  
* OpenAPI DTO re‑exports (@mcoda/shared/openapi).  
* Crypto utilities for encrypting/decrypting secrets stored in mcoda.db.  
* Helpers for resolving \~/.mcoda and \<workspace\>/.mcoda paths.

**Rules**

* **May depend on:** nothing else in the repo.  
* **Used by:** all other packages.

##### **5.2.2 db** {#5.2.2-db}

**Provides**

* Connection factories for:  
  * Global DB: \~/.mcoda/mcoda.db.  
  * Workspace DB: \<workspace\>/.mcoda/mcoda.db.  
* Migration runners and schema validation against OpenAPI (global \+ workspace).

**Repository APIs for**

* **Global‑only** agent registry & auth (agents, agent\_auth, agent\_models, agent\_health) in \~/.mcoda/mcoda.db; workspaces reference these via IDs and workspace\_defaults / routing\_rules, not by duplicating agent rows.  
* Workspace and global defaults, routing rules, and other configuration tables (still stored in the global DB, but referenced by workspace).  
* Planning entities in workspace DBs: projects, epics, user\_stories, tasks, task\_dependencies.  
* Execution and history tables in workspace DBs: jobs, task\_runs, command\_runs, task\_logs, task\_comments, token\_usage, optional sp\_metrics.

Repositories are DTO‑centric and use OpenAPI‑generated types; no ad‑hoc domain types that can drift from the spec.

**Rules**

* **May depend on:** @mcoda/shared, OpenAPI types.  
* **Must not depend on:** @mcoda/core, @mcoda/agents, @mcoda/integrations, @mcoda/cli.

##### **5.2.3 agents** {#5.2.3-agents}

**Provides**

* Adapter interface and canonical multi‑agent Invoke types.  
* Concrete adapters (OpenAI, Anthropic, Gemini, Ollama, CLI‑based tools, QA extensions like Chromium/Maestro wrappers).

**Registry & Routing**

* **Global agent registry only**, backed by \~/.mcoda/mcoda.db: agents, agent\_auth, agent\_models, agent\_health, agent\_aliases, agent\_installers, etc.  
* No workspace‑local agent definitions; workspaces only store **defaults and routing rules** that reference global agents by ID/alias (e.g. “default code agent for this workspace”).  
* Auth orchestration backed **only by encrypted secrets in mcoda.db** (no OS keychain, no secrets in config files; env vars only for one‑off bootstrap if needed).

**Prompt & Capability Integration**

* Surfaces capabilities from OpenAPI x-mcoda-\* metadata:  
  * Expected roles (code‑writer, code‑reviewer, qa‑agent, etc.).  
  * Allowed tools (docdex, VCS, Chromium/Maestro, etc.).  
* Works with @mcoda/core’s PromptService to load:  
  * Per‑agent **job description** prompt files.  
  * Per‑agent **character** prompt files.  
  * Per‑command prompt snippets (e.g. work-on-tasks, SDS generation, QA flows).

**Rules**

* **May depend on:** @mcoda/shared, @mcoda/db (for global registry tables).  
* **Must not depend on:** @mcoda/core, @mcoda/cli.  
* Adapters are LLM‑agnostic; no adapter hard‑codes a single provider.

##### **5.2.4 integrations** {#5.2.4-integrations}

**Provides**

* DocdexClient (doc search/fetch; index lives in docdex, not in mcoda).  
* VcsClient (local Git \+ optional GitHub/GitLab APIs).  
  * Knows deterministic mcoda branch naming, e.g. mcoda/task-\<taskId\> or mcoda/task-\<taskId\>-\<n\>, always prefixed with mcoda and stable across re‑runs.  
* IssueTrackerClient (Jira, Linear, GitHub Issues, etc.).  
* QA clients (e.g. browser runner, Chromium, mobile automation/maestro runner).

**Rules**

* **May depend on:** @mcoda/shared, OpenAPI DTOs.  
* **Must not depend on:** @mcoda/core, @mcoda/cli, @mcoda/agents.  
* All network/CLI specifics live here; upper layers see typed interfaces only.

##### **5.2.5 core** {#5.2.5-core}

Provides

Domain model \+ services for:

* Epics / user stories / tasks, including the dependency graph and status state machine.  
* Jobs & checkpoints, per‑run logs (jobs, task\_runs, command\_runs, task\_logs).  
* Token usage, estimation, and SP/h statistics from recent runs, derived from:  
  * token\_usage (per‑action, per‑agent),  
  * command\_runs / task\_runs,  
  * story points at run, status transitions.  
  * SP/h starts from a configurable baseline (e.g. **15 SP/h**) and is refined via rolling windows (e.g. last 10/20/50 tasks) per command type (work/review/QA).  
* Task comments and review/QA feedback (task\_comments) powering inter‑agent communication.

**Services (examples)**

* CreateTasksService, RefineTasksService.  
* WorkOnTasksService, CodeReviewService, QaTasksService:  
  * Implement the full work-on-tasks / code-review / qa-tasks workflows.  
  * This includes loading agents and prompts, committing dirty state, cleaning repo, checking out mcoda-dev, managing deterministic task branches, orchestrating edits/QA, and logging runs.  
* BacklogService, EstimationService (SP/h and throughput estimates).  
* AgentManagementService (global agent registry operations).  
* PromptService:  
  * Loads job \+ character prompts per agent from \<workspace\>/.mcoda overrides (fallback to \~/.mcoda).  
  * Loads command‑level runbooks (SDS generation, work-on-tasks, etc.).  
  * Uses OpenAPI x-mcoda-\* metadata to assemble central prompts.

**Rules**

* **May depend on:** @mcoda/shared, @mcoda/db, @mcoda/agents, @mcoda/integrations, OpenAPI DTOs.  
* **Must not depend on:** @mcoda/cli.  
* Only @mcoda/core reads prompt files and orchestrates command‑specific agent flows; adapters remain generic.

##### **5.2.6 generators** {#5.2.6-generators}

**Provides**

* OpenAPI → TS/SQL synchronization scripts:  
  * Generate DTOs into openapi/generated/types.  
  * Validate DB schemas (global \+ workspace) against OpenAPI.  
  * Generate migration stubs.  
* Workspace and global scaffolders:  
  * Create .mcoda folders and default .gitignore entries.  
  * Seed default prompt files in \~/.mcoda/prompts and \<workspace\>/.mcoda/prompts.  
  * Generate SDS/PDR/RFP templates.  
* Prompt & tool metadata checks from OpenAPI x-mcoda-\* extensions (ensure referenced prompt files, tools, and agents exist).

**Rules**

* **May depend on:** @mcoda/shared, openapi/generated/types, optionally @mcoda/core.  
* **Must not depend on:** @mcoda/cli.

##### **5.2.7 cli** {#5.2.7-cli}

**Provides**

* The mcoda binary and command wiring only.  
* Commands include (non‑exhaustive):  
  * Planning: create-tasks, refine-tasks, backlog, estimate.  
  * Execution: work-on-tasks, code-review, qa-tasks.  
  * Agents: mcoda agent add, mcoda agent list, mcoda agent use, mcoda test-agent \<name\>.  
  * Introspection: task show, tasks order-by-dependencies.  
  * Telemetry: mcoda tokens, mcoda telemetry ..., mcoda jobs.  
  * Updates: mcoda update, mcoda \--check-updates.

mcoda test-agent sends a trivial prompt (e.g. “what is 2+2?”) to the selected agent and reports connectivity, basic health, and the answer; it records token usage like any other agent call.

**Rules**

* **May depend on:** @mcoda/shared, @mcoda/core.  
* **Must not depend on:** @mcoda/db, @mcoda/agents, @mcoda/integrations directly (always via @mcoda/core).  
* On manual runs, CLI may call core’s update‑check API and prompt the user before applying mcoda update.

##### **5.2.8 testing** {#5.2.8-testing}

**Provides**

* Shared test fixtures for global \+ workspace DBs.  
* Fake adapters (LLMs \+ QA runners).  
* Fake docdex/VCS/issue tracker implementations.  
* End‑to‑end CLI tests for: work-on-tasks (including deterministic branch behavior), test-agent, task show, update checks.

**Rules**

* **May depend on:** anything (dev‑only).  
* **Must never be imported by production code.**

---

#### **5.3 Dependency Management & Layering Rules** {#5.3-dependency-management-&-layering-rules}

To avoid “everything imports everything”, mcoda enforces a clear layering model and keeps OpenAPI \+ prompts at the center.

##### **5.3.1 Layered Architecture** {#5.3.1-layered-architecture}

From lowest to highest:

* **Layer 0 – Shared**  
  * @mcoda/shared: Pure utilities, OpenAPI DTOs, crypto, path helpers.  
* **Layer 1 – Infrastructure**  
  * @mcoda/db, @mcoda/agents, @mcoda/integrations: Persistence, global agent registry, external clients (docdex, VCS, issue trackers, QA tools).  
* **Layer 2 – Core Domain**  
  * @mcoda/core: Business workflows, task state machines, job orchestration, estimation, token tracking, prompt orchestration, SP/h derivation, command/run logging.  
* **Layer 3 – Interfaces**  
  * @mcoda/cli: CLI wiring, presentation, update prompts, JSON output. (Future: HTTP/IDE frontends; **no TUI** layer).

**Rule:** Imports flow **upwards only** (2→1→0, 3→2→1→0). No downward or sideways imports.

##### **5.3.2 TypeScript Path Aliases** {#5.3.2-typescript-path-aliases}

tsconfig.base.json defines stable import paths:

Code snippet

```

{
  "compilerOptions": {
    "baseUrl": ".",
    "paths": {
      "@mcoda/shared/*":      ["packages/shared/src/*"],
      "@mcoda/db/*":          ["packages/db/src/*"],
      "@mcoda/agents/*":      ["packages/agents/src/*"],
      "@mcoda/integrations/*":["packages/integrations/src/*"],
      "@mcoda/core/*":        ["packages/core/src/*"],
      "@mcoda/generators/*":  ["packages/generators/src/*"],
      "@mcoda/cli/*":         ["packages/cli/src/*"]
    }
  }
}

```

Static checks enforce:

* No importing @mcoda/cli from non‑CLI code.  
* @mcoda/core is not imported by db, agents, or integrations.  
* @mcoda/agents never imports core or cli.

##### **5.3.3 OpenAPI‑Driven Contracts** {#5.3.3-openapi‑driven-contracts}

* All DTOs (TaskDTO, EpicDTO, JobDTO, etc.) are generated from openapi/mcoda.yaml into openapi/generated/types.  
* Repositories in @mcoda/db and service interfaces in @mcoda/core use these DTOs directly; there are no parallel “domain” types that can drift.  
* Generators verify that DB schemas (global \+ workspace) match DTO shapes and fail CI on mismatches.  
* The same OpenAPI spec drives global/workspace DBs, CLI schemas, agent payloads, and docdex/VCS operations.  
* OpenAPI x-mcoda-\* extensions define prompt file expectations, allowed tools, and required context.

**Rule:** If code, SQL, prompts, and documentation ever disagree with OpenAPI, **OpenAPI wins**. Code, SQL, prompts, and docs must be regenerated or patched to match the spec.

##### **5.3.4 Dependency Constraints & CI Guards** {#5.3.4-dependency-constraints-&-ci-guards}

CI and static analysis enforce:

* No relative imports across package boundaries.  
* No circular dependencies.  
* Layering rules (0–3) via import restrictions.

CI runs: pnpm lint, pnpm test, pnpm openapi:check (DTOs up to date), and pnpm db:validate (schema vs OpenAPI).

##### **5.3.5 Testing Strategy per Layer** {#5.3.5-testing-strategy-per-layer}

* **Layer 0 (shared):** Pure unit tests.  
* **Layer 1 (db, agents, integrations):** In‑memory SQLite for DBs, adapter conformance tests.  
* **Layer 2 (core):** Service‑level tests for state transitions, dependency ordering, SP/h calculations, workflow orchestration.  
* **Layer 3 (cli):** End‑to‑end tests for commands (work-on-tasks, test-agent) and update prompts.

---

## **6\. OpenAPI Contract (Single Source of Truth)** {#6.-openapi-contract-(single-source-of-truth)}

The mcoda OpenAPI specification is the **single technical source of truth** for the CLI, agents, DB schema, jobs, telemetry, and documentation‑driven flows. All behavior exposed through the CLI or internal libraries must be expressible as OpenAPI operations, schemas, and `x-mcoda-*` extensions. If OpenAPI, code, SQL, and docs disagree, **OpenAPI wins** and the other artifacts must be regenerated or migrated.

---

### **6.1 OpenAPI Structure & Tags** {#6.1-openapi-structure-&-tags}

The canonical spec is a single OpenAPI 3.x document that:

* Describes every CLI command and internal API as operations with tagged groups.

* Defines all persisted entities (tasks, jobs, command runs, token usage, QA runs, agents, routing defaults) as schemas, with `x-mcoda-db-table` metadata linking them to concrete tables.

* Embeds mcoda‑specific metadata via `x-mcoda-*` extensions for CLI mapping, DB sync, prompt wiring, and tool usage.

OpenAPI tags group operations into **logical domains** that correspond to mcoda sub‑systems and CLI verbs:

* `Agents`, `Routing`, `Tasks`, `Work`, `Review`, `QA`, `Backlog`, `Estimate`, `Telemetry`, `Jobs`, `Docdex`, `Config`, `System`.

This ensures a consistent mental model between the spec, CLI help, and internal module layout.

#### **6.1.1 File layout (single `openapi/mcoda.yaml` truth; referenced per workspace)** {#6.1.1-file-layout-(single-openapi/mcoda.yaml-truth;-referenced-per-workspace)}

* The canonical spec lives at **`openapi/mcoda.yaml`** in the mcoda repo.

  * The file may internally use `$ref` to split out `components/*.yaml` or `paths/*.yaml`, but these fragments are implementation details; the **merged file** is the contract.

* Each mcoda release pins a **single OpenAPI version**:

  * `info.version` is tied to the CLI/library version (SemVer).

  * The CLI embeds this spec at build time and also ships the raw `openapi/mcoda.yaml` on disk for inspection and generation.

  * `mcoda openapi-from-docs` regenerates the canonical file from SDS/PDR/docdex context using an OpenAPI-aware agent, logs an `openapi_change` job + `command_runs`/`token_usage`, and overwrites `openapi/mcoda.yaml` (with `.bak` backup) unless run with `--dry-run`/`--validate-only`.

* Workspaces **do not fork** the spec:

  * A workspace records the **OpenAPI version** it was created or last migrated against (e.g. `tasks.openapi_version_at_creation`, `task_runs.openapi_version_at_run`).

  * All workspace behavior must be a **subset** of what `openapi/mcoda.yaml` defines; workspace config may select options, but cannot introduce new fields or operations.

* Optional plugin fragments (future):

  * Additional specs (e.g. extensions or org‑specific APIs) can be composed in during build time, but the merged result is still a **single canonical spec** per mcoda version.

#### **6.1.2 Tags & operation grouping** {#6.1.2-tags-&-operation-grouping}

Operations are organized under tags that mirror the CLI and subsystems:

* **Agents**

  * Agent registry, auth, prompt manifests, `test-agent` diagnostics.

* **Routing**

  * Workspace defaults, routing rules, and resolution previews.

* **Tasks**

  * CRUD, comments, dependency ordering, task detail/history endpoints.

* **Work**

  * `create-tasks`, `refine-tasks`, `work-on-tasks` job starters and status.

* **Review**

  * `code-review` job operations and review artifacts.

* **QA**

  * `qa-tasks` job operations, QA run records.

* **Backlog**

  * Backlog summaries, dependency‑ordered views.

* **Estimate**

  * SP/h derivation and completion forecasts.

* **Telemetry**

  * Token usage and command‑run telemetry reporting and config.

* **Docdex**

  * RFP/PDR/SDS/doc retrieval endpoints used by agents.

* **Jobs**

  * Generic job lifecycle (create, list, status, logs, resume).

CLI commands map one‑to‑one or one‑to‑few with these operations via `x-mcoda-cli` metadata.

#### **6.1.3 `x-mcoda-*` extensions** {#6.1.3-x-mcoda-*-extensions}

The spec uses a small, stable set of `x-mcoda-*` extensions to carry mcoda‑specific metadata:

* **CLI mapping**

  * `x-mcoda-cli.name` – canonical CLI command (e.g. `work-on-tasks`, `code-review`).

  * `x-mcoda-cli.output-shape` – table vs list vs scalar vs job descriptor.

* **DB mapping**

  * `x-mcoda-db-table` on schemas that correspond to concrete tables (e.g. `tasks`, `task_comments`, `command_runs`, `token_usage`, `qa_profiles`, `agent_prompts`).

  * Column‑level hints for indexing or migration defaults (optional).

* **Job & status metadata**

  * `x-mcoda-job-type` for job‑creating operations (`work`, `create-tasks`, `task_refinement`, `review`, `qa`, `openapi_change`).

  * Allowed state transitions baked into error/response models (e.g. valid task status transitions).

* **Agent & prompt metadata**

  * `x-mcoda-agent-roles` – expected agent roles (work, review, qa, planner, openapi-editor).

  * `x-mcoda-prompts` – prompt assets to load (job/character/command templates).

  * `x-mcoda-tools` – allowed tools/adapters (docdex, VCS, QA runners).

* **Docdex**

  * `x-mcoda-docdex-profile` – retrieval profile to use for a given operation (e.g. SDS vs PDR).

These extensions drive code generation, DB sync, prompt scaffolding, and safety validation; they are treated as part of the contract, not informal comments.

#### **6.1.4 Components / Schemas** {#6.1.4-components-/-schemas}

Key schemas in `components/schemas` and their intended mappings:

* **Tasks & comments**

  * `Task`, `TaskSummary`, `TaskHistoryEntry`

  * `TaskComment` – comment body, author (agent/human), source (`work-on-tasks`, `code-review`, `qa-tasks`), category (`bug`, `style`, `test`, `docs`, etc.), timestamps, optional `resolved_at`.

  * Mapped to `tasks`, `task_comments`, and history tables with `x-mcoda-db-table`.

* **Runs & command history**

  * `CommandRun` – a normalized record of each CLI command execution:

    * `command_name`, `workspace_id`, `job_id`, `task_ids`, branch information, start/end timestamps, status, error summary, SP processed, duration.

  * Backed by the `command_runs` (or equivalent) table and joined from job, tokens, and task history.

* **Jobs & checkpoints**

  * `Job` – job ID, type, status, progress metrics, timestamps, payload.

  * `JobCheckpoint` – JSON snapshot metadata (seq, status, progress, tool‑specific state).

  * Backed by `jobs` table plus the on‑disk checkpoint files under `.runtime/jobs/<job_id>/`.

* **Token & telemetry**

  * `TokenUsage` – per‑action token accounting:

    * `command_name`, `openapi_operation_id`, `agent_id`, `model_name`, `job_id`, `task_id`, `workspace_id`, `tokens_prompt`, `tokens_completion`, `tokens_total`, `cost_estimate`, `timestamp`.

  * `TelemetrySummary` – aggregation views grouped by project/agent/command/time.

* **QA profiles & runs**

  * `QaProfile` – name, runner (`cli|chromium|maestro|...`), test command, env, matchers.

  * `QaRun` – per‑task QA execution (source `auto|manual|post_completion`, profile, raw outcome, agent recommendation, log paths).

* **Agents & prompts**

  * `Agent`, `AgentCapability`, `AgentPromptManifest` – registry records and prompt wiring:

    * scopes (global/workspace), adapter type, default model, capabilities, prompt file hints.

  * Mapped to global `agents`, `agent_capabilities`, `agent_prompts` and routing tables.

* **Backlog & estimation**

  * `BacklogTotals`, `EpicBacklogSummary`, `StoryBacklogSummary` – aggregated SP per status bucket.

  * `EstimateResult`, `EffectiveVelocity` – SP buckets, effective SP/h per lane (impl/review/QA), durations, optional ETAs.

Every schema that corresponds to a persisted entity or CLI output is generated into TypeScript types and tied to specific tables via `x-mcoda-db-table`, ensuring a single conceptual shape from OpenAPI → SQL → DTO → CLI.

---

### **6.2 Operation Groups** {#6.2-operation-groups}

Operations are grouped by tag; CLI commands are thin wrappers over these operations, and any new command must first be expressed as an OpenAPI operation.

#### **6.2.1 Agents (global‑only agent creation; auth; prompt manifests; `test-agent`)** {#6.2.1-agents-(global‑only-agent-creation;-auth;-prompt-manifests;-test-agent)}

**Tag: `Agents`**

Key responsibilities:

* **Global agent lifecycle**

  * `GET /agents` – list agents (global \+ workspace overrides).

  * `POST /agents` – create a **global** agent; workspace‑scoped overrides reference these by ID/slug, they do not create new agent rows.

  * `GET /agents/{id}`, `PATCH /agents/{id}`, `DELETE /agents/{id}` – inspect and modify agent config (model, adapter options, capabilities).

* **Auth & credentials**

  * `POST /agents/{id}/auth` – attach or update encrypted credentials for an agent’s provider, via the global credential store.

  * Credentials are never returned raw; responses surface redacted metadata only.

* **Prompt manifests**

  * `GET /agents/{id}/prompts` – return the effective prompt manifest (job, character, command‑specific prompts and paths).

  * Used to scaffold or validate prompt files in `~/.mcoda/agents` and `<workspace>/.mcoda/agents`.

* **Health checks & `test-agent`**

  * `POST /agents/{id}/test` – underlying operation for `mcoda test-agent`:

    * resolves agent, authenticates, sends a trivial probe, records `token_usage` and `command_runs`.

  * Response includes health status, latency, model info, and a short normalized answer.

All agent creation operations are **global**; workspace specifics are handled by Routing operations via references to agent IDs.

#### **6.2.2 Routing (workspace defaults without workspace‑local agent definitions)** {#6.2.2-routing-(workspace-defaults-without-workspace‑local-agent-definitions)}

**Tag: `Routing`**

Routing operations configure **which agents** are used per command in a workspace, without redefining agents:

* `GET /workspaces/{id}/defaults`

  * Returns `workspace_defaults` including per‑command default agent slugs, default QA profiles, and docdex scopes.

* `PUT /workspaces/{id}/defaults`

  * Updates default mappings, restricted to referencing **existing** global agents and QA profiles.

* `POST /routing/preview`

  * Given a workspace, command name, and optional `--agent` override, returns the resolved agent, model, and capabilities.

Routing operations expressly **may not**:

* create new agents,

* modify global agent definitions.

They only change workspace preference and override rules, enforcing a clean split between **agent registry** and **workspace routing**.

#### **6.2.3 Tasks (task comments, task detail, dependency ordering)** {#6.2.3-tasks-(task-comments,-task-detail,-dependency-ordering)}

**Tag: `Tasks`**

Task operations expose the planning and execution graph:

* **Backlog & list**

  * `GET /tasks` – filterable list (project, epic/story, status, assignee, search).

* **Detail & history**

  * `GET /tasks/{id}` – full task detail (hierarchy, SP, status, latest runs).

  * `GET /tasks/{id}/history` – revision and status history.

* **Comments**

  * `GET /tasks/{id}/comments` – read all `task_comments` (code review, QA, general notes).

  * `POST /tasks/{id}/comments` – add a structured comment (source, category, message).

* **Dependencies**

  * `GET /tasks/dependency-order` – returns a topologically sorted, dependency‑aware ordering for a filtered set of tasks.

  * Backed by `task_dependencies` and used by CLI (`backlog --order dependencies` / `tasks order-by-deps`).

`mcoda task show` and `mcoda backlog` are thin wrappers over these operations.

#### **6.2.4 Work / Review / QA (work‑on‑tasks, code‑review, qa‑tasks with QA tools)** {#6.2.4-work-/-review-/-qa-(work‑on‑tasks,-code‑review,-qa‑tasks-with-qa-tools)}

**Tags: `Work`, `Review`, `QA`**

Job‑creating operations for the three main lanes:

* **Work**

  * `POST /tasks/work` – start a `work-on-tasks` job:

    * scope: project/epic/story/task filters, status filters, limits.

    * response: `Job` descriptor (`type="work"`) and initial per‑task selection.

* **Review**

  * `POST /tasks/code-review` – start a `code-review` job:

    * scope: similar filters, optional base branch, `dry_run`, `require_approval`.

    * response: `Job` descriptor plus optional preview of planned reviews/findings.

* **QA**

  * `POST /tasks/qa` – start a `qa-tasks` job:

    * scope: tasks ready for QA, mode (`auto|manual`), QA profile/level overrides.

    * response: `Job` descriptor.

These operations:

* Always create `jobs` rows with appropriate `x-mcoda-job-type`.

* Record `command_runs` entries linking command invocations to jobs and tasks.

* Rely on `TokenUsage` and `QaRun` schemas to track cost and outcomes.

#### **6.2.5 Backlog** {#6.2.5-backlog}

**Tag: `Backlog`**

Read‑only backlog views:

* `GET /backlog/summary`

  * Returns `BacklogSummary` for a scope (project/epic/story/assignee).

  * SP totals per lane: Implementation, Review, QA, Done.

* `GET /backlog/dependency-ordered`

  * Same aggregation, but includes a dependency‑ordered list of tasks (via the `Tasks` dependency endpoint).

These operations are cheap, DB‑only, and never invoke agents or docdex.

#### **6.2.6 Estimation (SP/h from `token_usage` \+ `command_runs`)** {#6.2.6-estimation-(sp/h-from-token_usage-+-command_runs)}

**Tag: `Estimate`**

Estimation endpoints combine **backlog SP** and **empirical/ configured SP/h**:

* `GET /estimate`

  * Inputs: same scope as backlog, plus velocity mode (`config|empirical|mixed`), SP/h overrides, and history window (10/20/50 tasks).

  * Output: `EstimateResult`:

    * SP buckets (`S_impl`, `S_review`, `S_qa`, `S_done`).

    * Effective velocities per lane (`v_impl`, `v_review`, `v_qa`), with `source` and `windowTasks`.

    * Derived durations (`T_impl`, `T_review`, `T_qa`) and optional ETAs.

* Empirical velocities are computed from `command_runs` \+ `token_usage` \+ status history, but all exposed via this single OpenAPI operation.

`mcoda estimate` is a strict client of this endpoint.

#### **6.2.8 Telemetry (per‑action token usage)** {#6.2.8-telemetry-(per‑action-token-usage)}

**Tag: `Telemetry`**

Telemetry endpoints surface token and run statistics:

* `GET /tokens`

  * Filter by workspace, project, agent, command, time window.

  * `group_by` dimension (`project|agent|command|day`) returns aggregated `TokenUsage` views.

* `GET /telemetry/config`

  * Returns current telemetry/collection settings (opt‑in/opt‑out, sampling—currently always 100%).

* `POST /telemetry/opt-out` / `POST /telemetry/opt-in`

  * Toggle collection and reporting configuration.

Both CLI (`mcoda tokens`, `mcoda telemetry`) and external dashboards consume these endpoints; they are the only supported interface to token accounting.

---

### **6.3 Versioning & Compatibility Policy (mcoda‑only)** {#6.3-versioning-&-compatibility-policy-(mcoda‑only)}

OpenAPI versioning follows **SemVer** and is **mcoda‑native** (no gpt‑creator migration semantics):

* **`info.version`**

  * `MAJOR.MINOR.PATCH` tracks mcoda CLI/library versions.

  * The CLI ships only one OpenAPI version per release.

* **Compatibility rules**

  * **Non‑breaking changes** (MINOR/PATCH):

    * Additive: new optional fields, new operations, new enums where defaults are preserved.

    * Deprecations: fields/operations marked with `deprecated: true` and optional `x-mcoda-deprecated-reason`.

  * **Breaking changes** (MAJOR):

    * Removing fields or operations.

    * Making previously optional fields required.

    * Changing types or semantics in ways that break generated clients or DB mappings.

* **Workspace pinning**

  * Workspaces record the OpenAPI version in key entities (`tasks.openapi_version_at_creation`, `task_runs.openapi_version_at_run`).

  * Migrations upgrade workspace DBs **forward only**, in lockstep with OpenAPI changes.

* **Client compatibility**

  * Generated TS clients include the expected OpenAPI version; CI ensures that the embedded spec and generated code match.

  * Older CLI binaries always talk to the spec they ship with; cross‑major wire compatibility is not guaranteed.

No gpt‑creator‑specific migration logic is encoded in OpenAPI; mcoda’s migration stories live in DB migrations and SDS documentation, with OpenAPI strictly describing the **current** contract.

---

### **6.4 Code Generation & Validation Workflows** {#6.4-code-generation-&-validation-workflows}

(OpenAPI → SQL → TS → CLI)

The OpenAPI spec drives all downstream artifacts; the canonical pipeline is:

1. **Edit `openapi/mcoda.yaml`**

   * Changes must be authored via PR and reviewed as code.

   * Every change includes rationale and, for breaking changes, a migration plan.

2. **Validate & generate**

   * `openapi:validate` – structural and semantic validation.

   * `openapi:generate` – regenerate:

     * TypeScript DTOs and API clients (`openapi/generated/types` / `openapi/generated/client`).

     * Internal metadata (e.g. maps of tag→module).

3. **Sync DB schema**

   * `openapi:sync-db` uses `x-mcoda-db-table` and property metadata to:

     * detect table/column additions, removals, type changes,

     * scaffold or verify SQL migrations for:

       * global DB (`~/.mcoda/mcoda.db`),

       * workspace DB (`<workspace>/.mcoda/mcoda.db`).

   * Migrations are checked into the repo and versioned.

4. **Bind CLI & runtime**

   * CLI handlers are wired by `x-mcoda-cli`:

     * each handler references the generated client type for its operation.

   * Compile‑time checks ensure:

     * handler input/output types match the OpenAPI operation,

     * no “hidden” commands exist without a corresponding operation.

5. **CI enforcement**

   * CI pipelines fail if:

     * `openapi/mcoda.yaml` is changed without regenerated types/clients,

     * DB migrations and runtime schema disagree with OpenAPI,

     * CLI handlers lack a matching `x-mcoda-cli` operation.

6. **Doc & prompt alignment**

   * OpenAPI changes that affect behavior (new fields, state transitions, error models) must trigger:

     * prompt regeneration or review (via `x-mcoda-prompts`),

     * SDS/docs updates via docdex‑driven jobs.

This workflow enforces the “OpenAPI first” principle: **no change to behavior is considered real until it is expressed in `openapi/mcoda.yaml` and passes validation & sync.**

---

### **6.5 Handling OpenAPI Changes via Agents** {#6.5-handling-openapi-changes-via-agents}

OpenAPI changes can be proposed and applied by agents, but only through **dedicated OpenAPI operations** and jobs.

**Tag: `OpenAPI` / job type: `openapi_change`**

Agentic change flow:

1. **Proposal**

   * An agent (often driven from SDS or RFP changes) submits an `OpenApiChangeProposal` via:

     * `POST /openapi/changes/propose`

       * Fields: textual rationale, structured diff (JSONPatch or YAML diff), impacted operations/schemas, required follow‑up docs.

   * The proposal is stored as a job (`type="openapi_change"`) and may await human approval.

2. **Staging & validation**

   * `POST /openapi/changes/{id}/apply-dry-run`

     * Applies the diff in a temporary workspace copy of `mcoda.yaml`.

     * Runs `openapi:validate`, `openapi:generate`, `openapi:sync-db` in isolation.

     * Emits a checkpoint with:

       * validation results,

       * generated type/migration previews,

       * impact analysis (which tables, operations, CLI commands).

3. **Apply**

   * Once validated (and optionally approved by a human), a follow‑up operation:

     * `POST /openapi/changes/{id}/apply`

       * Writes the updated `openapi/mcoda.yaml` into the repo,

       * commits regenerated TS types/clients,

       * adds or updates SQL migrations,

       * updates any prompt manifests driven by `x-mcoda-prompts`.

   * The job transitions to `completed` with a full audit trail.

4. **Doc & prompt updates**

   * As part of the `openapi_change` job, agents also:

     * create or update SDS/RFP/PDR sections (via docdex) so text docs match the new spec,

     * update prompt templates that reference changed operations or fields.

5. **Restrictions**

   * Agents cannot:

     * edit `mcoda.yaml` directly on disk via generic file tools,

     * bypass validation or DB sync.

   * All agent‑driven OpenAPI changes **must** go through the `openapi_change` job type and its pipeline.

6. **Audit & telemetry**

   * Every change proposal and application:

     * is tracked as a `jobs` row (`type="openapi_change"`),

     * records `command_runs` and `token_usage` entries (including agent model and cost),

     * is linked to docdex entries for the associated SDS/doc updates.

This keeps OpenAPI edits safe, auditable, and tightly coupled to schema, docs, and prompts, while still allowing agents to participate meaningfully in evolving mcoda’s contract.

## 7\. Data Model & Persistence (mcoda.db) {#7.-data-model-&-persistence-(mcoda.db)}

mcoda uses **two** SQLite databases, both called `mcoda.db`, but in different scopes:

* **Global DB**: `~/.mcoda/mcoda.db`  
   Holds global configuration, the **only** agent & model registry, encrypted credentials, global defaults (e.g. SP/h baselines), and any global roll‑up telemetry.

* **Workspace DB**: `<workspace>/.mcoda/mcoda.db`  
   Holds planning entities (projects/epics/user\_stories/tasks), task dependency graph, task/job/run logs, `task_comments`, and **per‑action** `token_usage` for that workspace.

The workspace DB lives under `<workspace>/.mcoda/`. That directory is created on first use, **must be added to `.gitignore`**, and contains all mcoda runtime artifacts (DB, logs, prompts, job checkpoints, generated docs).

Global configuration and credentials are persisted only in the global DB, **not in env vars or OS keychains**; env vars are at most bootstrap inputs.

---

#### **7.1 SQLite Configuration & PRAGMAs** {#7.1-sqlite-configuration-&-pragmas}

Both global and workspace DBs share a common configuration:

* **Connection profile**

  * Single connection factory per process, with helpers like `withReadTx` / `withWriteTx` to centralize transaction behavior and apply PRAGMAs.

  * `busy_timeout` configured (e.g. 5–10s) to reduce `SQLITE_BUSY` errors.

* **Core PRAGMAs**

  * `PRAGMA foreign_keys = ON;` – enforce referential integrity across planning, runs, comments, token usage.

  * `PRAGMA journal_mode = WAL;` – allow concurrent reads with a single writer (CLI/daemon use).

  * `PRAGMA synchronous = NORMAL;` – balance durability and performance for local dev.

  * `PRAGMA temp_store = MEMORY;` and tuned `cache_size` – keep temp data in memory subject to reasonable RAM usage.

  * `PRAGMA user_version = <schema_version>;` – migration engine reads/writes this as the canonical schema version.

* **Encryption model**

  * No full‑DB transparent encryption required; instead, the **application encrypts sensitive fields** (API keys, tokens, secrets) before writing, and decrypts them only in memory.

* **Scope isolation**

  * Global DB must never contain workspace‑local planning or run state.

  * Workspace DB must never contain global credentials or agent registry rows – those live only in `~/.mcoda/mcoda.db`.

---

#### **7.2 Core Tables (Workspace DB)** {#7.2-core-tables-(workspace-db)}

The **workspace** `mcoda.db` models planning, execution, and telemetry for a single repo/workspace.

##### **7.2.1 `projects`, `epics`, `user_stories`, `tasks`** {#7.2.1-projects,-epics,-user_stories,-tasks}

These tables define the planning hierarchy and are mostly inherited from v0.2 with clarifications:

* **`projects`** – logical containers (name, key, repo path/remote, docdex project id, optional default agent).

* **`epics`** → **`user_stories`** → **`tasks`**

  * `projects (1) → epics (N) → user_stories (N) → tasks (N)`, with cascades on delete.

  * Redundant `project_id` / `epic_id` columns on `tasks` for fast backlog queries, kept consistent via FKs and optional triggers.

* **`tasks`** – atomic work items:

  * Planning fields: `key`, `title`, `description`, `type`, `status`, `story_points`, assignee, created/updated timestamps.

  * **Deterministic branch fields**:

    * `vcs_branch` – deterministic mcoda task branch name (e.g. `mcoda/task/<task_key>`), reused on re‑runs.

    * `vcs_commit` – latest commit SHA for that task’s work.

  * Linking:

    * `last_job_id` → latest `jobs.id` that touched this task.

    * Optional `metadata` JSON for extensibility (e.g. changed files, test coverage).

  * Status enum enforced with `CHECK` (e.g. `not_started | in_progress | ready_to_review | ready_to_qa | completed | blocked | cancelled`).

* **`task_dependencies`** – explicit dependency graph:

  * `task_id` → `tasks.id`, `depends_on_task_id` → `tasks.id`, `relation_type` (e.g. `blocks` / `is_blocked_by`).

  * Used by dependency‑ordering commands to prioritize highly depended‑on tasks.

##### **7.2.2 `jobs`** {#7.2.2-jobs}

Long‑running operations (SDS generation, task creation/refinement, `work-on-tasks`, `code-review`, `qa-tasks`, OpenAPI change, etc.) are modeled in `jobs`:

* `id` (UUID), `project_id`, `type` (e.g. `work`, `review`, `qa`, `openapi_change`), `state` (pending/running/paused/failed/completed/cancelled).

* `command_name`, `agent_id` (FK to global `agents.id`), timestamps (`started_at`, `completed_at`, `last_checkpoint_at`), `progress` (0–100), `checkpoint_uri`, `error_code` / `error_message`, `payload` JSON, `row_version`.

Jobs tie together disk checkpoints under `.mcoda/jobs/<job_id>/...` and DB state.

##### **7.2.3 `task_runs`, `command_runs`, `task_qa_runs`** {#7.2.3-task_runs,-command_runs,-task_qa_runs}

Per‑run logging is split along two axes:

* **`command_runs`** – **one row per CLI/command invocation**:

  * `id`, `workspace_id`, `command_name`, `job_id`, `git_branch` (task branch), `git_base_branch` (e.g. `mcoda-dev`), `task_ids` (list or join table), `status`, `started_at`, `completed_at`, `error_summary`, `sp_processed`, `duration_seconds`.

  * Used to answer: *“what happened when `mcoda work-on-tasks` ran last time?”*

* **`task_runs`** – **one row per task per command run**:

  * `task_id`, `command` (e.g. `work-on-tasks`, `code-review`, `qa-tasks`), `agent_id`, `status` (queued/running/succeeded/failed/cancelled), timestamps, SP at run, SP/h estimates, `run_context_json` (high‑level metadata).

* **`task_qa_runs`** – QA‑specific runs:

  * `task_id`, `job_id`, `source` (`auto|manual|post_completion`), `profile` / `runner` (CLI/Chromium/Maestro), raw results (`pass|fail|blocked|unclear`), agent recommendation, artifact/log paths, notes.

Together, these tables capture **per‑run history** so agents can reuse prior context when re‑running tasks.

##### **7.2.4 `task_comments`** {#7.2.4-task_comments}

`task_comments` supports **structured agent/human comments** attached to tasks:

* Columns (conceptual): `id`, `task_id`, optional `task_run_id`, `author_type` (`agent|human`), optional `agent_id`, `source_command` (`work-on-tasks|code-review|qa-tasks|...`), `category` (`bug|style|test|docs|qa_failure|general`), `body`, `created_at`, optional `resolved_at` / `resolved_by`.

* Required behavior:

  * `code-review` and `qa-tasks` **must write** review/QA issues into `task_comments` rather than just stdout.

  * `work-on-tasks` **must read** unresolved comments for a task and treat them as first‑class input when planning changes.

##### **7.2.5 `token_usage` (per‑action)** {#7.2.5-token_usage-(per‑action)}

Fine‑grained token and cost accounting, one row per **agent/tool call**:

* FKs: `project_id`, `epic_id`, `user_story_id`, `task_id`, `job_id`, `agent_id`.

* Context: `command_name`, optional `action/phase`, `model_name`, timestamps.

* Metrics: `tokens_prompt`, `tokens_completion`, `tokens_total`, optional `cost_estimate`.

* Rows are append‑only and linked back to `command_runs`/`task_runs` for reporting and SP/h derivation.

##### **7.2.6 `task_logs` (per‑run log stream)** {#7.2.6-task_logs-(per‑run-log-stream)}

A detailed log stream per `task_run`:

* `task_run_id`, `sequence`, `timestamp`, `level`, `source` (agent/tool/core), `message`, `details_json`.

These logs are summarized into prompts so agents know **what went wrong last time** without dumping raw logs into the LLM.

---

#### **7.3 Agent & Model Registry Tables (Global DB Only)** {#7.3-agent-&-model-registry-tables-(global-db-only)}

All **agent and model registry tables exist only in the global DB** `~/.mcoda/mcoda.db`. The workspace DB has **no agent tables**; it only holds FKs like `tasks.assignee` or `jobs.agent_id` pointing to global IDs.

Key global tables:

* **`agents`**

  * Global registry: `id`, `slug` (unique), `display_name`, `adapter_type`, config JSON, enabled flag.

  * Performance fields: `rating`, `rating_samples`, `rating_last_score`, `rating_updated_at`, `max_complexity`, `complexity_samples`, `complexity_updated_at`.

* **`agent_prompts`**

  * Prompt content and file mapping:

    * `agent_id`, `prompt_kind` (`job_description|character|command_specific`), optional `command`, `path_hint`, `content`, `version`.

* **`models`**

  * Provider/model catalog (`provider`, `model_name`, limits, pricing, enabled, default\_for\_agent\_id).

* **`agent_capabilities`**

  * Per‑agent capability flags: `plan`, `work`, `review`, `qa`, `docdex_query`, `qa_extension_maestro`, `qa_extension_chromium`, etc.

* **`agent_run_ratings`**

  * Per-run rating telemetry: `agent_id`, `job_id`, `command_run_id`, `task_id`, `task_key`, `command_name`, `discipline`, `complexity`, `quality_score`, `tokens_total`, `duration_seconds`, `iterations`, `total_cost`, `run_score`, `rating_version`, `raw_review_json`, `created_at`.

* **`credentials` / `agent_auth`**

  * Encrypted secrets: `method`, `encrypted_payload`, provider metadata, timestamps. API keys/tokens are stored **only here**, encrypted with a key managed under `~/.mcoda/`, never in keychains.

* **Workspace defaults/routing**

  * Tables like `workspace_defaults`, `routing_rules`, etc., live in the global DB and reference `agents.id` to encode per‑workspace default agents and routing rules.

**Global‑only agents requirement**

* Agents are **defined and stored only globally** in `~/.mcoda/mcoda.db`.

* Workspace behavior is controlled via:

  * FKs from workspace entities (e.g. `jobs.agent_id`), and

  * global tables that map workspace fingerprints/paths to default agents.

* There are **no agent tables** (`agents`, `agent_auth`, etc.) in the workspace DB.

---

#### **7.4 Relationships & Constraints** {#7.4-relationships-&-constraints}

The data model enforces a consistent, auditable graph of planning, runs, and telemetry:

* **Planning hierarchy**

  * `epics.project_id` → `projects.id`

  * `user_stories.epic_id` → `epics.id`

  * `tasks.user_story_id` → `user_stories.id`

  * Redundant `tasks.project_id` / `tasks.epic_id` for fast backlog queries; optional trigger ensures they match the story’s project/epic.

* **Tasks & dependencies**

  * `task_dependencies.task_id` → `tasks.id`

  * `task_dependencies.depends_on_task_id` → `tasks.id`

  * Cycles are prevented in application logic; DB enforces FKs only.

* **Tasks & runs**

  * `task_runs.task_id` → `tasks.id` (many runs per task).

  * `task_qa_runs.task_id` → `tasks.id`.

* **Runs, comments, logs, token usage**

  * `task_comments.task_run_id` → `task_runs.id` (nullable).

  * `task_logs.task_run_id` → `task_runs.id`.

  * `token_usage.task_run_id` → `task_runs.id` (nullable) and/or `command_run_id`.

* **Jobs & tasks**

  * `jobs.project_id` → `projects.id` (SET NULL on delete).

  * `jobs.agent_id` → global `agents.id` (SET NULL on delete).

  * `tasks.last_job_id` → `jobs.id` (SET NULL on delete).

* **Token usage links**

  * `token_usage.project_id/epic_id/user_story_id/task_id` → planning tables (SET NULL).

  * `token_usage.job_id` → `jobs.id` (SET NULL).

  * `token_usage.agent_id` → global `agents.id` (CASCADE).

* **Agent registry (global)**

  * `agent_auth.agent_id`, `agent_models.agent_id`, `agent_health.agent_id`, `workspace_defaults.agent_id`, `routing_rules.agent_id` all FK → `agents.id` (CASCADE), with audit tables like `agent_revisions` not cascading.

* **Optimistic concurrency & enums**

  * `row_version` columns on core tables (`projects`, `epics`, `user_stories`, `tasks`, `jobs`, agent tables) with `UPDATE ... WHERE id=? AND row_version=?` pattern and VERSION\_CONFLICT on `changes()=0`.

  * `CHECK` constraints on enums: `tasks.status`, `tasks.type`, `jobs.state`, `jobs.type`, `agents.install_state`, etc., staying in sync with OpenAPI enums.

These constraints ensure we can reliably join `token_usage` → `command_runs` → `task_runs` → `tasks` → global `agents` for telemetry, SP/h metrics, and audit trails.

---

#### **7.5 Migration Strategy & Schema Versioning** {#7.5-migration-strategy-&-schema-versioning}

mcoda treats both the global and workspace `mcoda.db` schemas as **versioned**, tightly coupled to the OpenAPI spec (e.g. `x-mcoda-schema-version`), but **no longer tied to gpt‑creator migration**.

* **Metadata & versioning**

  * Use `PRAGMA user_version` plus optional `schema_migrations(version INTEGER PRIMARY KEY, applied_at TEXT)` to track applied migrations.

  * Each SQL migration file `NNN_description.sql` corresponds to `version = NNN`.

* **Migration runner**

  * On startup/upgrade:

    1. Detect current `user_version`.

    2. Apply ordered migrations (idempotent) forward for **global and workspace DBs separately**, reusing the same migration engine.

  * Migrations favor additive changes; destructive operations are avoided or gated behind explicit maintenance tools.

* **OpenAPI‑driven evolution**

  * Any persisted entity exposed via OpenAPI (tasks, jobs, token\_usage, comments, runs, agents) must have a **direct mapping** between OpenAPI schema and DB columns.

  * Workflow for changes:

    1. Update `openapi/mcoda.yaml`.

    2. Run OpenAPI validation/codegen and DB sync tooling (e.g. `openapi:sync-db`) to derive required schema changes.

    3. Add SQL migrations for global/workspace DBs.

    4. Regenerate TS DTOs and update code/CLI handlers.

  * Enums and required fields must be updated in lockstep; historical rows get sensible defaults/backfills where needed.

* **New tables & forward‑only behavior**

  * Migrations initialize or evolve tables such as `task_comments`, `token_usage`, `task_logs`, `agent_prompts`, `agent_capabilities`, and `credentials`, with optional backfills (e.g. initial SP/h estimates computed from existing runs).

  * Existing mcoda installations migrate forward in place; there is no special gpt‑creator path and no requirement to import legacy data.

This strategy keeps the DB layer fully aligned with OpenAPI and SDS while allowing mcoda to evolve without brittle one‑off migrations from previous products.

### **8\. Agent & Multi‑Agentic Layer** {#8.-agent-&-multi‑agentic-layer}

The agent layer gives mcoda a single abstraction over LLM providers, docdex, and external tools (QA runners, browsers, mobile automation). Agents are defined globally in `~/.mcoda/mcoda.db`, referenced from workspaces as defaults, and orchestrated in multi‑step flows such as `create-tasks → work-on-tasks → code-review → qa-tasks`. Each agent is driven by a pair of prompts (job \+ character) plus command‑specific instructions derived from OpenAPI metadata.

---

#### **8.1 Adapter Interface & Base Classes (QA adapters, docdex, OpenAPI tools)** {#8.1-adapter-interface-&-base-classes-(qa-adapters,-docdex,-openapi-tools)}

All providers and tools implement a common TypeScript adapter interface; the core does not care whether an adapter is “LLM”, “docdex”, or “QA runner”:

```ts
interface AgentAdapter {
  ensureInstalled(): Promise<void>;          // optional, for local tools
  ensureAuthed(): Promise<void>;            // validates credentials

  ping(): Promise<HealthStatus>;            // cheap liveliness check
  listModels?(): Promise<ModelSummary[]>;   // for LLM-style providers

  invoke(req: AgentRequest): Promise<AgentResponse>;
  invokeStream?(
    req: AgentRequest,
    onDelta: (delta: AgentDelta) => void
  ): Promise<AgentResponse>;

  capabilities(): CapabilityDescriptor[];   // declarative capability list
}
```

Key adapter families:

* **LLM providers** (OpenAI, Anthropic, local gateways, etc.)  
   Implement `invoke`/`invokeStream`, map provider errors into normalized error kinds, and emit token usage rows on every call.

* **docdex adapter**  
   Wraps docdex HTTP APIs behind a typed `DocdexClient` but is exposed to agents as a tool/capability (e.g. `docdex.search`, `docdex.getSegments`). The tool schema comes from OpenAPI `Docdex` tags so agents see a consistent, typed surface.

* **OpenAPI tools**  
   Code‑generated clients for mcoda’s own OpenAPI operations (e.g. `tasks.refine`, `jobs.resume`) are wired as tools that agents can call via structured tool‑calling. Operations annotated with `x-mcoda-tool=true` become callable tools with explicit argument/response schemas.

* **QA adapters**  
   Wrap external QA systems behind the same interface:

  * **CLI runner** – executes test commands (`npm test`, `pytest`, etc.) with scoped environment and working directory.

  * **Chromium adapter** – runs browser‑based QA suites (Playwright/Cypress‑style).

  * **Maestro/mobile adapter** – runs mobile flows on devices/emulators (e.g. `maestro test`).

* QA adapters normalize results into a shared `QaRunResult` (pass/fail/blocked, logs, artifacts) used by `qa-tasks` and QA agents.

Common base classes:

* `BaseLLMAgentAdapter` – shared logic for LLM providers (retry, streaming, token accounting, error mapping).

* `BaseToolAdapter` – shared logic for non‑LLM tools (time‑outs, structured error codes, redacted logging).

* Role‑focused wrappers like `PlanningAgent`, `WorkAgent`, `ReviewAgent`, and `QaAgent` compose:

  * prompt loading and layering,

  * core adapter calls,

  * tool registration (docdex, OpenAPI tools, QA runners, VCS).

---

#### **8.2 Supported Agents (agent prompts, roles, characters)** {#8.2-supported-agents-(agent-prompts,-roles,-characters)}

The SDS expects at least the following **logical agents**; actual slugs and model configs live in the global agent registry:

* **Work Agent** (e.g. `default-work-agent`)  
   *Role*: implementation (`work-on-tasks`).  
   *Prompts*:

  * **Job** – how to plan and apply small, safe patches, respect OpenAPI/SDS, and follow the branch workflow.

  * **Character** – deterministic, terse, code‑focused persona.  
     *Capabilities*: `plan`, `code_write`, `docdex_query`, `git_apply_patch`.

* **Code Review Agent** (e.g. `default-review-agent`)  
   *Role*: `code-review`.  
   *Prompts*:

  * **Job** – review diffs against RFP/PDR/SDS/OpenAPI, classify findings, propose focused fixes.

  * **Character** – strict but constructive reviewer.  
     *Capabilities*: `code_review`, `docdex_query`, `openapi_contract_check`.

* **QA Agent** (e.g. `default-qa-agent`)  
   *Role*: interpret QA runs, map results to acceptance criteria, suggest follow‑ups.  
   *Prompts*:

  * **Job** – understand QA profiles, interpret CLI/Chromium/Maestro logs, align with SDS/OpenAPI.

  * **Character** – precise, risk‑sensitive.  
     *Capabilities*: `qa_interpretation`, `docdex_query`, `qa_runner_cli`, `qa_runner_chromium`, `qa_runner_maestro`.

* **Planning / Ordering Agent**  
   *Role*: backlog shaping and dependency ordering (`create-tasks`, `refine-tasks`, dependency‑ordered views).  
   *Capabilities*: `plan`, `order_tasks`, `docdex_query`.

* **Test-Agent Utility Agent**  
   *Role*: lightweight diagnostics for `mcoda test-agent`.  
   *Capabilities*: minimal `chat`/`math` only; job prompt describes its diagnostics responsibilities.

* **Reporting / Analytics Agent (optional)**  
   *Role*: summarize `token_usage`, `task_runs`, and SP/h metrics for human‑readable telemetry.

Each agent always has:

* Exactly one **job description prompt** and one **character prompt** (global, with optional workspace overrides).

* Optional **command‑specific prompt fragments** (e.g. extra rules for `qa-tasks` vs `code-review`) wired via `x-mcoda-prompt-*` OpenAPI metadata.

---

#### **8.3 Agent Registry, Auth, and Installation Flows (global, encrypted, no keychain)** {#8.3-agent-registry,-auth,-and-installation-flows-(global,-encrypted,-no-keychain)}

All agent definitions and credentials live in the **global** SQLite DB at `~/.mcoda/mcoda.db`; workspaces never define their own agent rows or store secrets.

**Registry tables (recap)**

* `agents` – one row per agent slug (work, review, QA, etc.); stores adapter type, default model, and base configuration.

* `agent_prompts` – materialized job/character/command‑specific prompts (content \+ path hints).

* `agent_capabilities` – normalized capability list for routing and health reporting.

* `agent_auth` / `credentials` – encrypted secrets for providers (API keys, tokens, OAuth refresh tokens).

**Auth model**

* Secrets are **only** stored in encrypted form inside `~/.mcoda/mcoda.db`:

  * Application‑level encryption using a key held under `~/.mcoda/` with OS‑user‑only permissions.

  * No OS keychain integration; macOS Keychain / DPAPI / etc. are deliberately not required.

* Discovery:

  * First run may optionally read API keys from env vars (e.g. `OPENAI_API_KEY`) as a bootstrap.

  * On `mcoda agent auth set`, secrets are written into `agent_auth` and the env var is no longer needed.

  * All adapters call `ensureAuthed()` which resolves and decrypts secrets; failures yield clear `AUTH_REQUIRED` or `AUTH_FAILED` error kinds.

**Installation & update flows**

* `mcoda agent add <slug>`:

  * Creates an `agents` row with adapter type, default model, and config.

  * Scaffolds prompt files under `~/.mcoda/agents/<slug>/prompts/{job,character}.md` if missing.

  * Optionally prompts for credentials and stores them in `agent_auth`.

* `mcoda agent edit`, `mcoda agent delete` update or remove registry entries (with integrity checks to avoid orphaned workspace defaults).

* `mcoda test-agent <slug>`:

  * Loads agent \+ prompts \+ credentials.

  * Runs `ensureInstalled`/`ensureAuthed` and a trivial `invoke` probe.

  * Records a synthetic `token_usage` row and an `agent_health` entry.

Workspaces reference **existing global agents** by ID/slug; they do not own separate agent or auth tables.

---

#### **8.4 Health Checks, Capabilities, and Error Normalization** {#8.4-health-checks,-capabilities,-and-error-normalization}

Every adapter implements a common **health and error model** so CLI and higher‑level flows can reason about agents uniformly.

**Health checks**

* `ping()` plus a small `invoke` probe (for LLM‑style agents) drive health status:

  * `healthy` – last check succeeded within latency budget.

  * `degraded` – reachable but slow, partially misconfigured, or rate‑limited.

  * `unreachable` – auth or connectivity failures.

* Results are persisted in `agent_health` (or equivalent) with:

  * `agent_id`, `status`, `last_checked_at`, `latency_ms`, and opaque `details_json`.

* `mcoda agent list` and `mcoda test-agent` surface this state, and routing can avoid degraded agents by default.

**Capabilities**

* `agent_capabilities` rows (and the adapter’s `capabilities()` method) describe capabilities like:

  * `chat`, `plan`, `code_write`, `code_review`, `qa_interpretation`,

  * `docdex_query`,

  * `qa_runner_cli`, `qa_runner_chromium`, `qa_runner_maestro`,

  * `openapi_tool:tasks.refine`, `openapi_tool:jobs.resume`, etc.

* Routing and OpenAPI `x-mcoda-agent-roles` metadata use this to:

  * validate that an agent can perform required roles before it is chosen,

  * fail fast with a clear error when capabilities are missing.

**Error normalization**

Provider‑specific errors are mapped into a shared error enum, for example:

* `AUTH_ERROR`

* `RATE_LIMIT`

* `PROVIDER_UNAVAILABLE`

* `CONTEXT_TOO_LARGE`

* `VALIDATION_ERROR` (bad tool arguments, invalid JSON)

* `TOOL_ERROR` (docdex, QA adapters, VCS)

* `INTERNAL_ERROR`

Normalized errors:

* Are logged into `task_logs` with structured payloads.

* Are attached to `token_usage.metadata_json` for later forensics.

* Are included as summarized context when re‑running a job so agents know what failed previously (e.g. “last QA run failed with PROVIDER\_UNAVAILABLE from Maestro adapter”).

QA adapters additionally record per‑run status (exit code, infra vs functional failures) using the same error model, so `qa-tasks` can distinguish between “tests are red” and “QA infra is down”.

---

#### **8.5 Routing & Workspace Defaults (`--agent` override, docdex & QA capabilities)** {#8.5-routing-&-workspace-defaults-(--agent-override,-docdex-&-qa-capabilities)}

Routing decides **which global agent** is invoked for a given command in a given workspace.

**Workspace defaults referencing global agents**

* A `workspace_defaults` / `routing_rules` layer (stored in global `~/.mcoda/mcoda.db`) maps:

  1. `(workspace_id, command_name)` → `agent_id` (FK into `agents`).

* Workspaces do **not** define their own agents; they only hold:

  1. references to global agents (by id/slug),

  2. optional per‑workspace config (e.g. lower temperature) stored as override JSON.

* On command start, the router resolves:

  1. Workspace‑specific mapping for that command (if present).

  2. Global default mapping with `workspace_id='__GLOBAL__'`.

  3. Fails with a clear error if no suitable agent is found.

**`--agent` override**

* Any agent‑using command supports `--agent <slug>`:

  * The router resolves the slug to a global `agents` row.

  * Validates required capabilities for the command.

  * Uses that agent for this invocation only; the override does **not** mutate workspace defaults.

* The chosen `agent_id` is recorded on `jobs`, `task_runs`, and `token_usage` to support SP/h metrics and auditing.

**Capability‑aware routing (docdex & QA)**

* Commands declare **required capabilities** via OpenAPI metadata (e.g. `x-mcoda-required-capabilities: ["docdex_query"]` for SDS‑heavy flows, `["qa_interpretation","qa_runner_cli"]` for unit‑test QA).

* The router:

  * Filters candidate agents for the command by capabilities.

  * Prefers agents with matching specialized capabilities (e.g. a QA agent for `qa-tasks`, not a generic chat agent).

  * Rejects agents missing required QA or docdex capabilities, even if they are defaults.

**Performance-aware routing (rating + complexity)**

* Agents maintain a rolling `rating` (0-10) and `max_complexity` (1-10) in the global registry.

* `--rate-agents` enables post-run scoring that combines reviewer quality, token usage, duration, iterations, and cost into a run score, persists `agent_run_ratings`, and updates the agent's rating via EMA.

* When task complexity is provided, routing filters candidates where `max_complexity >= task_complexity` and prefers higher-rated agents among eligible candidates.

**Exploration / calibration**

* Gateway routing uses a small epsilon-greedy exploration rate to:

  * test low-rated agents on low-complexity tasks (redemption), and

  * stretch agents slightly above `max_complexity` to recalibrate their ceiling.

**Multi‑agent workflows**

* High‑level commands may orchestrate multiple agents in sequence (e.g. `work-on-tasks` → `code-review` → `qa-tasks`), but each step:

  * selects its agent via routing rules (plus optional `--agent`),

  * passes outputs (tasks, comments, QA runs) via shared DB tables (`task_comments`, `task_logs`, `task_qa_runs`) rather than ad‑hoc channels.

* Because all routing decisions and agent IDs are persisted:

  * `backlog` and `estimate` can compute per‑agent SP/h,

  * users can see which agents were responsible for which changes and what they cost.

This design centralizes agent definition and credentials in a single global registry, keeps workspaces as thin references with per‑command defaults, and uses capability‑aware routing plus `--agent` overrides to keep behavior explicit and predictable.

**Gateway router (gateway-agent)**

The gateway router is an optional preflight layer that runs before a job to analyze task context and docdex snippets, then selects a best-fit agent for the requested job.

* Produces a structured JSON analysis (summary, currentState, todo, plan, files, assumptions, risks) that is recorded for handoff.
* Selects agents using routing defaults, required capabilities, health, rating, max-complexity gates, and exploration signals.
* Supports plan-only runs (`--no-offload`/`--plan-only`) or offloading to the chosen agent; offload writes a handoff file under `.mcoda/handoffs` and sets `MCODA_GATEWAY_HANDOFF_PATH` for the downstream command.
* Does not mutate routing defaults; it is per-run only.

`mcoda gateway-trio` uses the gateway router before each work/review/QA step, persisting per-step handoffs under `.mcoda/jobs/<job_id>/gateway-trio/`, and loops tasks back to implementation when review or QA reports issues.

### **9\. Documentation & docdex Integration** {#9.-documentation-&-docdex-integration}

docdex is the **only** documentation index/search system used by mcoda. All RFP, PDR, SDS, architecture notes, and generated docs flow through docdex; mcoda does **not** maintain any parallel local index or embedding store. docdex is responsible for search, metadata, and retrieval; mcoda is responsible for prompt assembly, OpenAPI alignment, and doc generation workflows.

---

#### **9.1 docdex Overview & Required Capabilities** {#9.1-docdex-overview-&-required-capabilities}

docdex must provide a small, stable set of capabilities that are fully described in `openapi/mcoda.yaml` under a dedicated `Docdex` tag:

* **Document registration**

  * Register or update documents (RFP, PDR, SDS, ADRs, READMEs, runbooks) with:

    * `doc_type` (e.g. `RFP`, `PDR`, `SDS`, `Architecture`, `Runbook`),

    * product/component identifiers,

    * version / branch / tag,

    * source (repo path, external system id),

    * lifecycle status (`draft`, `in_review`, `approved`, `archived`).

* **Segmented retrieval**

  * Split documents into segments (sections, headings, tables) with stable IDs.

  * Support:

    * semantic search,

    * metadata‑only filters (e.g. `doc_type=SDS` \+ `component=mcoda-client`),

    * hybrid scoring (keywords \+ embeddings \+ metadata).

* **Fetch by ID**

  * Fetch full document metadata and individual segments by `(doc_id, segment_id)`.

  * Provide stable URLs/handles for use in task metadata and comments.

* **Workspace‑aware scoping**

  * All docdex operations are scoped by mcoda workspace/project:

    * A workspace cannot see docs from other workspaces unless explicitly shared.

  * ACLs and multi‑tenant behavior are handled by docdex; mcoda trusts its API contract but treats the service as remote/untrusted.

All of the above is expressed as OpenAPI operations and DTOs; mcoda never shells out directly to docdex or embeds ad‑hoc HTTP calls.

---

##### **9.1.3 Per‑workspace Configuration (`.mcoda/config.json`)** {#9.1.3-per‑workspace-configuration-(.mcoda/config.json)}

Each workspace configures **how** it talks to docdex via `<repo>/.mcoda/config.json`. Conceptually:

```
{
  "docdex": {
    "base_url": "https://docdex.example.com",
    "workspace_id": "acme-core-platform",
    "collection": "mcoda",
    "credential_name": "docdex-default",   // lookup in global ~/.mcoda/mcoda.db

    "indexing": {
      "paths": [
        "docs/**/*.md",
        ".mcoda/docs/**/*.md"
      ],
      "exclude": [
        ".git/**",
        ".mcoda/jobs/**",
        "node_modules/**"
      ],
      "doc_type_overrides": {
        "docs/rfp/**": "RFP",
        "docs/pdr/**": "PDR",
        "docs/sds/**": "SDS"
      }
    },

    "retrieval_profiles": {
      "rfp_default": {
        "doc_types": ["RFP"],
        "max_snippets": 20
      },
      "pdr_default": {
        "doc_types": ["PDR"],
        "max_snippets": 20
      },
      "sds_default": {
        "doc_types": ["SDS"],
        "max_snippets": 30
      }
    }
  }
}
```

Design rules:

* **No secrets in `config.json`**:

  * `credential_name` maps to an encrypted record in the global `~/.mcoda/mcoda.db` (same model as agent credentials); only the `DocdexClient` reads the decrypted token.

* **Indexing is explicit**:

  * mcoda never auto‑indexes arbitrary files; only configured paths are registered with docdex.

* **Profiles are named**:

  * Commands refer to retrieval profiles (e.g. `sds_default`) instead of hardcoding filters, so behavior is consistent across agents and runs.

---

#### **9.2 RFP/PDR/SDS Retrieval & Context Assembly** {#9.2-rfp/pdr/sds-retrieval-&-context-assembly}

All doc‑aware commands (e.g. `create-tasks`, `work-on-tasks` for doc work, `code-review`, `qa-tasks`, SDS/PDR generation) use a common **DocContextAssembler** that wraps docdex.

**Retrieval pipeline (per command or task)**

1. **Scope & intent detection**

   * Decide which doc types are relevant (`RFP` vs `PDR` vs `SDS` or combinations).

   * Derive product/component from workspace config, task metadata, or CLI scope.

   * Select a retrieval profile (`rfp_default`, `pdr_default`, `sds_default`, or command‑specific).

2. **Query building**

   * Build a hybrid query from:

     * user query or task title/description,

     * relevant OpenAPI operation ids, schema names, endpoint paths,

     * file/module names from the diff or target files.

   * Apply metadata filters (`doc_type`, `product`, `component`, `version_range`).

3. **docdex search**

   * Call docdex’s search endpoint with profile \+ query.

   * Retrieve top‑K segments including:

     * `doc_id`, `segment_id`, `doc_type`, `title`, `heading_path`,

     * short snippet and scoring metadata.

4. **Context assembly**

   * Group by document and section.

   * Deduplicate overlapping segments.

   * Prioritize **constraints and contracts** sections (e.g. “Interfaces”, “Failure Modes”, “Limits”).

   * Enforce a per‑command token budget; fall back to per‑doc summaries when needed.

**SDS as a first‑class document**

* SDS docs are tagged `doc_type = 'SDS'` and treated as **first‑class** artifacts:

  * SDS sections are referenced by ID from tasks, comments, and job payloads.

  * Agents receive SDS context as a dedicated block distinct from “misc docs”.

* docdex’s SDS segments are aligned with OpenAPI:

  * Where possible, SDS sections reference `openapi_operation_id` or schema names so that agents can cross‑check behavior and contracts.

The assembler always includes the **current workspace OpenAPI excerpt** alongside SDS/PDR/RFP segments for commands that can affect behavior, so the agent sees both the normative spec (OpenAPI) and explanatory docs (SDS/PDR/RFP).

---

#### **9.3 Doc Generation Flows (SDS/PDR by Agents)** {#9.3-doc-generation-flows-(sds/pdr-by-agents)}

Doc generation is modeled as **jobs** (e.g. `sds_generate`, `sds_update`, `pdr_generate`) driven by dedicated doc agents and prompt sets.

**Flow (per document)**

1. **Trigger**

   * User runs `mcoda docs sds generate ...`, `mcoda docs pdr update ...`, or a higher‑level job requires a new/updated SDS/PDR.

2. **Template & prompts**

   * mcoda selects a template (e.g. `SDS_backend_service`, `PDR_web_app`) defined in repo or `.mcoda/docs/templates`.

   * The doc agent is invoked with:

     * its **job description prompt** (how to write/maintain SDS/PDR),

     * its **character prompt** (tone, risk tolerance),

     * command‑specific prompts under `.mcoda/prompts/docs/*` describing section shapes and style.

3. **Context build**

   * Use docdex to fetch:

     * existing versions of the doc (if any),

     * related RFP/PDR/SDS, ADRs, runbooks.

   * Pull relevant OpenAPI segments and code snippets (via standard code search APIs).

4. **Section‑by‑section drafting**

   * Agent generates or updates each section independently:

     * input: template section, prior content, context bundle.

     * output: structured section payload (e.g. Markdown/AsciiDoc plus metadata such as `openapi_operation_ids` it refers to).

   * Low‑confidence areas are explicitly marked with TODOs/questions.

5. **Review & iteration**

   * Results are written to a working file under `.mcoda/docs/` or repo docs directory.

   * mcoda can:

     * open an editor,

     * or create a follow‑up `doc_review` task for a human.

6. **Publishing & indexing**

   * Once approved:

     * docs are committed to the repo (if repo‑backed), or uploaded to the configured system.

     * mcoda calls docdex’s registration endpoints to upsert the doc and its segments.

   * doc IDs and key section IDs are recorded on the job and associated tasks for traceability.

All doc jobs are tracked as `jobs` rows, with agent calls recorded in `token_usage` under the appropriate command and job type.

---

#### **9.4 Removing Local Indexers — Simplified Architecture** {#9.4-removing-local-indexers-—-simplified-architecture}

mcoda **does not** implement its own document indexer or vector store. Any legacy “local index” behavior from previous systems is removed:

* No local embeddings, SQLite‑backed search tables, or per‑workspace index daemons.

* No “index this repo” CLI for docs beyond explicit **doc registration flows** that push to docdex.

The architecture is:

* Commands → `DocContextAssembler` → `DocdexClient` → docdex API.

* docdex is the **single** index/search backend for all documentation, regardless of where docs are stored (Git, Confluence, Drive, etc.).

Benefits:

* **One source of truth** for doc search and metadata.

* **Simpler failure modes** (either docdex is available or commands degrade with clear “no docs” behavior).

* **Less drift** – no separate local indexes that can become stale or misconfigured per workspace.

If docdex is unavailable, doc‑dependent commands must either:

* run in a “no‑doc” degraded mode (explicitly indicated in output), or

* fail with a clear error; they must not silently fall back to different search implementations.

---

#### **9.5 Consistency between Docs, OpenAPI, and Code** {#9.5-consistency-between-docs,-openapi,-and-code}

OpenAPI remains the **single technical source of truth** for behavior; docs and code must follow it.

**Rules**

* **OpenAPI is normative**

  * `openapi/mcoda.yaml` (or the workspace‑merged variant) defines:

    * operations, schemas, status transitions,

    * docdex API surface,

    * task/job DTOs.

  * If OpenAPI, code, SQL, and docs disagree, OpenAPI wins; code/SQL/docs must be updated.

* **Docs reference OpenAPI**

  * SDS, PDR, and other design docs should:

    * reference `openapi_operation_id` and schema names where relevant,

    * avoid restating contracts in ways that contradict OpenAPI.

  * Doc generation flows may **summarize** or **explain** behavior, but may not invent new operations or schemas.

* **Code aligns to OpenAPI**

  * Code‑centric commands (`work-on-tasks`, `code-review`, `qa-tasks`) always load OpenAPI:

    * agents are instructed to treat OpenAPI as authoritative over SDS/PDR text,

    * changes that deviate from OpenAPI must either:

      * create/trigger an `openapi_change` job, or

      * be rejected and surfaced as `contract` issues in review/QA.

* **docdex indexing is keyed to spec**

  * docdex records for SDS/PDR can carry OpenAPI references:

    * enabling consistency checks (e.g. “this SDS section mentions operation X that no longer exists”),

    * allowing future tools to scan for doc/spec drift.

* **Consistency flows**

  * Dedicated jobs (e.g. `docs_consistency_check`) can:

    * retrieve docs via docdex,

    * compare referenced operations/schemas to the current OpenAPI,

    * emit tasks for:

      * docs that reference removed endpoints,

      * OpenAPI that diverges from long‑standing SDS decisions.

This keeps documentation (via docdex), OpenAPI, SQL schemas, and code changes tightly aligned, with clear precedence rules and explicit agent/CLI flows for reconciling any drift.

### **10\. Task Model & Workflow Orchestration** {#10.-task-model-&-workflow-orchestration}

mcoda models work as **tasks** flowing through a shared state machine, executed by **commands** (`create-tasks`, `refine-tasks`, `work-on-tasks`, `code-review`, `qa-tasks`), and grouped into **jobs** for long‑running, resumable workflows. All orchestration is persisted in the workspace `mcoda.db` and mirrored onto Git branches, commits, and PRs so every task has concrete, auditable artifacts.

---

#### **10.1 Entities & Relationships (epics/user stories/tasks, dependencies, comments, branches)** {#10.1-entities-&-relationships-(epics/user-stories/tasks,-dependencies,-comments,-branches)}

**Core planning hierarchy**

All planning entities are workspace‑local and live in `<repo>/.mcoda/mcoda.db`:

* **`projects`**

  * Top‑level container for epics, docs, repos, and configuration.

* **`epics`**

  * Large initiatives within a project.

  * Fields: `id`, `project_id`, `key`, `title`, `description`, `story_points_total`, labels/metadata.

* **`user_stories`**

  * User‑facing slices of work under an epic.

  * Fields: `id`, `epic_id`, `key`, `title`, `description`, `acceptance_criteria`, `story_points_total`.

* **`tasks`**

  * Smallest unit mcoda operates on.

  * Fields (conceptual superset of §7.2):

    * Hierarchy: `id`, `user_story_id`, `epic_id` (denormalized), `project_id`.

    * Identity: `key` (human key), optional `external_id` (issue tracker).

    * Work: `title`, `description`, `type`, `status`, `story_points`, `priority`.

    * Routing: `assigned_agent_id`, `assignee_human` (optional), labels/tags.

    * VCS: `vcs_branch`, `vcs_base_branch`, `vcs_last_commit_sha`.

    * Scope hints: `metadata.files`, `metadata.tests`, `metadata.test_requirements`, `metadata.components`, `metadata.doc_links`.

    * Audit: timestamps, `openapi_version_at_creation`.

**Dependencies**

* **`task_dependencies`**

  * Models a DAG of blocking relationships:

    * `task_id` → `depends_on_task_id`, `relation_type` (`blocks`, `is_blocked_by`).

  * Used by:

    * dependency‑ordered backlog (`backlog --order dependencies`),

    * schedulers that pick tasks with minimal unmet dependencies.

**Runs, jobs, and logs**

* **`jobs`**

  * One row per long‑running operation:

    * `id`, `workspace_id`, `type` (`create-tasks`, `work`, `code_review`, `qa`, `task_refinement`, …),

    * `state` (`queued`, `running`, `paused`, `completed`, `failed`, `cancelled`),

    * `command_name`, `payload_json` (filters, options, input docs),

    * `progress` fields (total/processed tasks, last checkpoint).

* **`command_runs`** (workspace‑local)

  * One row per CLI/API command invocation:

    * `id`, `workspace_id`, `command_name`,

    * `job_id` (nullable),  
       `git_branch`, `git_base_branch`,

    * `task_ids` (serialized or via join table),

    * `started_at`, `completed_at`, `status`, `error_summary`.

  * `task_runs` (from §7.2) can reference `command_run_id` for per‑task/per‑command history.

* **`task_runs`**

  * One row per *task × command* execution:

    * `task_id`, `command` (`create-tasks`, `work-on-tasks`, `code-review`, `qa-tasks`, …),

    * `job_id`, `command_run_id`, `agent_id`,

    * `status` (`queued`, `running`, `succeeded`, `failed`, `cancelled`),

    * `started_at`, `finished_at`,

    * `story_points_at_run`, `sp_per_hour_effective`,

    * `git_branch`, `git_base_branch`, `git_commit_sha`,

    * `run_context_json` (high‑level metadata).

* **`task_logs`**

  * Ordered log stream attached to a `task_run`:

    * `task_run_id`, `sequence`, `timestamp`, `level`, `source`,

    * human‑readable `message`, structured `details_json`.

  * Used for debugging *and* as context on re‑runs.

**Comments and review/QA artifacts**

* **`task_comments`** (shared inbox across commands)

  * Fields:

    * `task_id`, optional `task_run_id` and `job_id`,

    * `author_type` (`agent|human`), `author_agent_id`,

    * `source_command` (`work-on-tasks`, `code-review`, `qa-tasks`, `refine-tasks`, …),

    * `category` (`bug`, `style`, `design`, `test`, `docs`, `qa_failure`, `blocking_issue`, …),

    * `file`, `line`, `path_hint` (for code/PR mapping),

    * `body`, `created_at`, optional `resolved_at` / `resolved_by`.

  * Populated by:

    * `code-review` (review findings),

    * `qa-tasks` (QA failures/gaps),

    * `work-on-tasks` (self‑notes / partial fixes),

    * humans via CLI or integrations (PR comments imported).

* **Review/QA tables**

  * `task_reviews` – structured review events per task (decision, summary, findings JSON).

  * `task_qa_runs` – structured QA events per task (profile, source, result, artifact paths).

**Token usage & telemetry**

* **`token_usage`**

  * Append‑only rows per agent/tool invocation:

    * `workspace_id`, `command_name`, `action/phase`,

    * `agent_id`, `model_name`,

    * `job_id`, optional `command_run_id`, `task_run_id`, `task_id`/`project_id`/`epic_id`/`user_story_id`,

    * `tokens_prompt`, `tokens_completion`, `tokens_total`, `cost_estimate`, `timestamp`.

* **`sp_metrics`**

  * Aggregated SP/hour metrics per agent/command, used to adapt the 15 SP/h baseline over time.

**VCS mapping**

* The planning entities are linked to Git via:

  * `tasks.vcs_branch` – deterministic branch name for the task (see 10.4).

  * `task_runs.git_branch`, `git_base_branch`, `git_commit_sha`.

  * Optional mapping to PR IDs kept in task/job metadata when integrations are enabled.

---

#### **10.2 Task State Machine & Transitions (per‑command transitions, QA states)** {#10.2-task-state-machine-&-transitions-(per‑command-transitions,-qa-states)}

mcoda uses a **single finite task status set** across all commands:

* `not_started` – in backlog; no implementation yet.

* `in_progress` – currently being implemented or reworked.

* `ready_to_review` – implementation complete; awaiting `code-review`.

* `ready_to_qa` – review approved; awaiting `qa-tasks`.

* `completed` – implementation \+ review \+ QA accepted.

* `blocked` – cannot progress (missing context, infra issues, diff too large, etc.).

* `cancelled` – explicitly abandoned/merged into another task.

Status changes are owned by commands and are enforced through a TaskStateService / OpenAPI operations, never via ad‑hoc SQL updates.

**Creation & refinement**

* `create-tasks`

  * New tasks enter as:

    * `status = not_started`.

* `refine-tasks`

  * May update titles/descriptions, estimates, hints.

  * May:

    * mark redundant tasks as `cancelled` (e.g., merges),

    * clear `blocked` → `not_started` when constraints are reclassified,

  * but **never** sets `ready_to_review`, `ready_to_qa`, or `completed`. Those lanes are reserved for implementation, review, and QA commands.

**Implementation: `work-on-tasks`**

* When work begins:

  * `not_started → in_progress`.

  * `in_progress` stays `in_progress`.

  * (Optionally) `blocked → in_progress` when the blocked reason has been explicitly resolved (e.g., after refine‑tasks/doc updates).

* On successful run (patch applied, validations/tests as per policy):

  * `in_progress → ready_to_review`.

* On failure:

  * `in_progress → blocked` with a structured `blocked_reason` such as:

    * `diff_too_large`, `patch_validation_failed`, `git_apply_error`,

    * `tests_failed`, `tests_not_configured`, `doc_context_missing`, `qa_profile_not_found`, …

* `work-on-tasks` never sets `ready_to_qa` or `completed`.

**Review: `code-review`**

Precondition: tasks are usually selected with `status = ready_to_review`.

* If LLM/human review **approves**:

  * `ready_to_review → ready_to_qa`.

* If **changes requested**:

  * `ready_to_review → in_progress`.

* If **blocked** (design/SDS/OpenAPI misalignment, security concerns, etc.):

  * `ready_to_review → blocked` plus review comments and a structured blocked reason.

`code-review` does not directly set `completed`; that is owned by QA.

**QA: `qa-tasks`**

Precondition: tasks are usually selected with `status = ready_to_qa`.

* Automated or manual QA **pass**:

  * `ready_to_qa → completed`.

* QA **failures requiring code changes**:

  * `ready_to_qa → in_progress` (fixes needed).

* **Infra/environment issues**:

  * `ready_to_qa → blocked` with `blocked_reason = qa_infra_issue` (or similar).

* Ambiguous outcomes:

  * Status remains `ready_to_qa`; QA notes are recorded, but state is not advanced.

**Reopening & cancellation**

* Reopen flows (via dedicated commands/API):

  * `completed → in_progress` (bug discovered post‑release),

  * `completed → blocked` (if new external dependency prevents shipping).

* Cancellation:

  * Any non‑terminal state → `cancelled` with a reason (duplicate, out of scope, merged, etc.).

  * `cancelled` tasks are excluded from capacity/velocity calculations but kept for audit history.

**Idempotency & re‑runs**

* Commands are idempotent w.r.t. status:

  * `work-on-tasks` will normally **skip** tasks already in `ready_to_review` unless `--allow-rework` is set.

  * `code-review` and `qa-tasks` refuse to advance tasks that are not in their expected input state unless explicitly overridden.

* On re‑run:

  * The same task status is used as input, but context includes:

    * historical `task_runs`, `task_logs`, `task_comments`,

    * last review/QA outcomes,

    * last blocked reason.

  * This lets agents learn from previous failures instead of “starting from scratch”.

Backlog and estimation commands rely entirely on this state machine when grouping SP into Implementation / Review / QA / Done buckets.

---

#### **10.3 Job Model & Long‑running Orchestration (logging, token\_usage linkage, resumability)** {#10.3-job-model-&-long‑running-orchestration-(logging,-token_usage-linkage,-resumability)}

Every non‑trivial command runs as a **job** so it can be monitored, resumed, and audited.

**Job lifecycle**

* Job creation

  * On start, commands like `create-tasks`, `refine-tasks`, `work-on-tasks`, `code-review`, and `qa-tasks` create a `jobs` row:

    * `type` (e.g., `create_tasks`, `work`, `code_review`, `qa`, `task_refinement`),

    * `command_name` (CLI verb),

    * initial `state = queued` or `running`,

    * `payload` (scope filters, options, doc inputs),

    * `progress` counters (total tasks, processed tasks).

  * A `command_runs` row is also created and linked to `job_id`.

* States

  * Jobs move through:

    * `queued → running → completed`,

    * or `running → checkpointing → running`,

    * or `running → paused / failed / cancelled`.

  * State updates are written to both DB and the latest checkpoint, and surfaced via `mcoda job status/watch`.

* Checkpointing & disk layout

  * Each job periodically writes a checkpoint under:

    * `<repo>/.mcoda/jobs/<job_id>/checkpoint.json` (or a sequence of numbered checkpoints).

  * Checkpoints contain:

    * job state and progress counters,

    * list of processed task IDs,

    * last stable outputs and associated artifacts (e.g., generated tasks, review findings),

    * any opaque per‑command cursors used to resume (e.g., “last processed story index”).

  * Larger artifacts (diffs, logs, docs) may be stored as separate files under `.mcoda/jobs/<job_id>/…` with references in the checkpoint.

* Resumability

  * Commands accept `--resume <job_id>`:

    * reloads the latest checkpoint for that job,

    * replays internal cursors,

    * continues from the first unprocessed task or stage.

  * Already processed tasks are not duplicated; partial results are preserved.

**Linking jobs, runs, logs, and token usage**

* **`jobs` ↔ `command_runs`**

  * Each CLI invocation that starts a job has:

    * `command_runs.job_id = jobs.id`.

  * Fast queries over `command_runs` make it easy to answer “what happened on the last `code-review` run for this workspace?”.

* **`command_runs` ↔ `task_runs`**

  * For task‑scoped commands:

    * `task_runs.command_run_id` links each task run back to its command run.

* **`task_runs` ↔ `task_logs`**

  * All per‑phase logs are written via `task_logs` with a monotonically increasing sequence per run.

  * `mcoda job logs <job_id>` aggregates task logs for that job, optionally grouped by task.

* **`token_usage` linkage**

  * Every agent/tool call records a `token_usage` row with:

    * `command_name`,

    * `job_id`,

    * `command_run_id` (when applicable),

    * `task_run_id` and `task_id` where relevant,

    * model/agent and token counts.

  * This allows:

    * cost reporting (`mcoda tokens`),

    * velocity derivation (`mcoda estimate` reading SP/hour from real history),

    * debugging of anomalous runs (e.g., one task consuming disproportionate tokens).

**Short‑lived commands**

* Cheap read‑only commands (`backlog`, `estimate`, `task show`) may:

  * create a `command_runs` entry for auditability,

  * **skip** jobs and checkpoints entirely when they can run to completion quickly.

---

#### **10.4 Mapping Tasks to Files, Branches, and PRs (deterministic mcoda/... branches, reuse on reruns, branch stored on tasks/task\_runs)** {#10.4-mapping-tasks-to-files,-branches,-and-prs-(deterministic-mcoda/...-branches,-reuse-on-reruns,-branch-stored-on-tasks/task_runs)}

Tasks must map cleanly to real code and docs in Git so that automation is **safe**, **repeatable**, and **traceable**.

**File & doc scope**

* `create-tasks` and `refine-tasks` populate:

  * `tasks.metadata.files` – candidate paths for implementation,

  * `tasks.metadata.tests` – candidate test paths,

  * `tasks.metadata.test_requirements` – unit/component/integration/api test expectations,

  * `tasks.metadata.doc_links` – SDS/RFP/docdex links.

* `work-on-tasks`:

  * uses these hints plus SDS/OpenAPI context to derive a **small, explicit file set** to edit,

  * rejects patches that touch files outside the permitted scope unless explicitly configured.

* `code-review` and `qa-tasks`:

  * scope diffs/tests to these files where possible,

  * write findings back into `task_comments` with file/line metadata.

**Deterministic branch naming**

mcoda uses a deterministic naming scheme for task branches (exact pattern is configurable but must be stable). A typical default is:

* Integration branch (shared):

  * `mcoda-dev` – base branch for mcoda‑driven work.

* Per‑task branches:

  * `mcoda/task/<TASK_KEY>` or  
     `mcoda/<project_key>/<TASK_KEY>`.

Rules:

* First `work-on-tasks` run for a task:

  * ensures `mcoda-dev` exists (creating from `main` or configured base if necessary),

  * creates a per‑task branch from `mcoda-dev`,

  * writes the branch name to `tasks.vcs_branch`,

  * records `git_branch` / `git_base_branch` on the `task_run` / `command_run`.

* Subsequent runs for the same task:

  * always reuse `tasks.vcs_branch`,

  * fail fast if branch is missing or divergent beyond policy limits.

This guarantees that “work for TASK‑123” always happens on the same branch across re‑runs and commands.

**Commits, diffs, and PRs**

* **Commits**

  * `work-on-tasks`:

    * applies validated patches,

    * commits only the scoped files with a standardized message, e.g.:

      * `[TASK-123] Implement X`,

    * updates `tasks.vcs_last_commit_sha`.

* **Diffs**

  * `code-review`:

    * computes diffs as `git diff <base_ref>...<task_branch>`,

    * stores a structured `ReviewDiff` snapshot under `.mcoda/jobs/<job_id>/review/`,

    * uses `tasks.metadata.files` to filter down to relevant paths.

* **PRs/MRs**

  * When VCS integration is configured, jobs can:

    * open or update PRs tied to task branches (or to `mcoda-dev`),

    * mirror `task_comments` findings into inline PR comments using file/line metadata,

    * store external PR IDs/URLs in task/job metadata for later lookup.

  * Typical flows:

    * per‑task PR: `task_branch` → `mcoda-dev` or `main`,

    * per‑job PR: `mcoda-dev` → `main` once a batch of tasks is completed.

**Reuse on reruns & traceability**

* Re‑running `work-on-tasks`, `code-review`, or `qa-tasks` for the same task:

  * checks out `tasks.vcs_branch` and base branch,

  * reloads `task_runs`, `task_logs`, `task_comments`, and last review/QA outcomes,

  * ensures diffs and test scopes are recomputed against the current commit on that branch.

* All relevant identifiers are persisted:

  * `tasks.vcs_branch`, `tasks.vcs_last_commit_sha`,

  * `task_runs.git_branch`, `git_base_branch`, `git_commit_sha`,

  * optional external PR IDs in task/job metadata.

This end‑to‑end mapping lets mcoda answer, for any task:

* “Which files and docs were touched?”

* “Which branch and commits contain the changes?”

* “Which PR(s) and reviews correspond to those commits?”

* “What did implementation, review, and QA runs do, and how many tokens did they consume?”

## **11\. CLI Design & Command Surface** {#11.-cli-design-&-command-surface}

The `mcoda` CLI is the primary interface for planning, implementation, review, QA, telemetry and agent management. It is **CLI‑only** (no TUI), scriptable, and tightly coupled to the OpenAPI spec, the global `~/.mcoda/mcoda.db`, and per‑workspace `<repo>/.mcoda/mcoda.db`. All agentic commands are driven by prompt files (job \+ character \+ command runbook) and produce structured telemetry and logs.

`mcoda openapi-from-docs` is the canonical way to regenerate `openapi/mcoda.yaml` from SDS/PDR/docdex context. It resolves workspace defaults (or `--agent` overrides), streams agent output by default, writes a `.bak` when overwriting unless `--dry-run`, and records `openapi_change` jobs plus `command_runs`/`token_usage` rows even in validation-only mode.

---

### **11.1 CLI Principles & UX Goals** {#11.1-cli-principles-&-ux-goals}

**CLI‑only, automation‑friendly**

* Single binary: `mcoda`, with flat commands (`create-tasks`, `work-on-tasks`, `estimate`, `backlog`) and namespaced subcommands (`agent ...`, `routing ...`, `job ...`, `telemetry ...`).

* No fullscreen TUI or curses UI. UX is plain stdout/stderr: tables, progress lines, and optional spinners.

**Low cognitive load**

* Predictable verbs: `create-*`, `refine-*`, `work-*`, `qa-*`, `list`, `show`, `estimate`, `test`, `update`.

* Stable flag names and semantics across commands (`--project`, `--agent`, `--json`, `--no-telemetry`, etc.).

**Safe by default**

* Read‑only commands (`backlog`, `estimate`, `tokens`, `telemetry`, `task show`, `job list/status`, `test-agent --quick`) never mutate state.

* Mutating commands support `--dry-run` where sensible, and avoid surprising VCS or DB changes.

**Deterministic & resumable workflows**

* Every long‑running command (`create-tasks`, `refine-tasks`, `work-on-tasks`, `code-review`, `qa-tasks`, doc generation) runs as a **job**, with:

  * A `jobs` row.

  * Per‑step logs (`command_runs`, `task_runs`, `task_run_logs` / `task_logs`).

  * Checkpoints so `mcoda job resume` can complete interrupted work.

**Branching & workspace discipline**

* Work commands always:

  * Bootstrap `<repo>/.mcoda/` on first use (DB, config, prompts, logs).

  * Ensure `.mcoda` is present in `.gitignore`.

  * Use a configured base branch (typically `mcoda-dev`).

  * Use **deterministic per‑task branch names** containing `"mcoda"` so reruns reuse the same branch.

**Token‑aware & SP/h‑aware**

* Each agent invocation records a `token_usage` row with:

  * `command_name`, `agent_id`, `job_id`, `task_id` (when applicable), prompt/completion tokens.

* `mcoda estimate` starts from a **15 SP/h** default but also maintains sliding‑window SP/h averages (e.g. last 10/20/50 completed tasks per phase: work, review, QA) and surfaces them.

**Update‑aware**

* On interactive manual runs (not CI) and when enabled in config, the CLI calls the update‑check API.

* If a newer npm version is available, the user is prompted and can opt in to running `mcoda update`.

**Exit codes (shared across commands)**

* `0` – success (warnings allowed).

* `1` – usage error (invalid flags, missing args, unknown subcommand).

* `2` – cancelled (user or system).

* `3` – timeout (agent or network).

* `4` – network failure (docdex, VCS, issue tracker, etc.).

* `5` – auth/agent/routing failure (no default agent, bad credentials, no eligible agent).

* `6` – install failure (missing tools/adapters).

* `7` – DB/schema issues (SQLite error, schema mismatch).

---

### **11.2 Flag & Output Conventions** {#11.2-flag-&-output-conventions}

**Global flags (available on all commands)**

* `--agent <NAME>`  
   Override workspace default agent for this command. Resolves against the **global** registry in `~/.mcoda/mcoda.db`. If the agent is unhealthy or lacks capabilities, the command fails (exit code 5).

* `--workspace <PATH>`  
   Override workspace autodetection (default: from `git` root / CWD). Affects:

  * Which `<repo>/.mcoda/` directory is used.

  * Workspace‑Scoping for tasks/backlog queries.

  * Default agent selection (via routing defaults).

* `--project <PROJECT_KEY>`  
   Shortcut for scoping backlog, estimation and task commands to a project.

* `--json`  
   Machine‑readable output only; no spinners or decorative text. Shape matches OpenAPI response DTOs.

* `--quiet`  
   Suppress non‑essential logs and progress messages (still prints results and errors).

* `--debug`  
   Verbose logs (routing traces, job IDs, selected agents, OpenAPI operation names). Secrets remain redacted.

* `--no-color`  
   Disable ANSI colors, even in TTY.

* `--no-telemetry`  
   Per‑command override to avoid sending aggregated telemetry (token\_usage rows may still be written to local DB for SP/h and cost calculations).

* `--help`, `-h`  
   Usage, flags, examples, and exit‑code semantics.

* `--version`  
   Print CLI version and API version (from OpenAPI).

**Output**

* Default: human‑oriented tables, lists, and summaries.

* `--json`: single valid JSON document (no banners or extra text).

* Some commands provide `--format <table|json|yaml>` when multiple human formats are useful.

---

### **11.3 Command Reference** {#11.3-command-reference}

Each CLI command is a thin wrapper over the core runtime and the OpenAPI spec. The CLI:

1. Parses and validates flags.

2. Resolves workspace, project, and agent.

3. Assembles prompts (job \+ character \+ command runbook \+ task/document context).

4. Calls the corresponding OpenAPI‑backed service.

5. Prints results and records `jobs`, `command_runs`, `task_runs`, `task_comments`, and `token_usage` as appropriate.

#### **11.3.x `mcoda docs sds generate`** {#11.3.x-mcoda-docs-sds-generate}

**Purpose**

Generate an SDS from PDR/RFP/docdex context using the configured doc agent and SDS template.

**Usage (simplified)**

```shell
mcoda docs sds generate \
  [--workspace-root <PATH>] \
  [--project <KEY>] \
  [--out <FILE>] \
  [--template <NAME>] \
  [--agent <NAME>] \
  [--agent-stream <true|false>] \
  [--force] \
  [--resume <JOB_ID>] \
  [--dry-run] \
  [--json]
```

**Behavior**

* Builds context via docdex `sds_default` (RFP + PDR + existing SDS + OpenAPI + architecture/constraints docs); falls back to latest local docs if docdex is unavailable and warns.
* Applies the SDS template from `.mcoda/docs/templates/SDS_default.md` (or `--template <NAME>`); streams agent output to stdout by default.
* Creates `jobs` (`type = sds_generate`) and `command_runs`, records `token_usage` with model/provider metadata per agent call.
* Writes the SDS to `.mcoda/docs/sds/<slug>.md` by default; `--force` overwrites an existing file, or `--out` overrides the path. `--agent-stream false` disables streaming.
* Registers the SDS in docdex with `doc_type = 'SDS'` when not running with `--dry-run`.

#### **11.3.1 `mcoda create-tasks`** {#11.3.1-mcoda-create-tasks}

**Purpose**

Generate epics → user stories → tasks from RFP/PDR/SDS documents via docdex and agents, and persist them to the workspace `mcoda.db`.

**Usage (simplified)**

```shell
mcoda create-tasks \
  [--project <PROJECT_KEY>] \
  [--max-epics <N>] \
  [--max-stories-per-epic <N>] \
  [--max-tasks-per-story <N>] \
  [--include-types dev,docs,review,qa,...] \
  [--dry-run] \
  [--agent <NAME>]
```

**Behavior**

* Resolves project and workspace, validates docdex config from `.mcoda/config.json`.

* Loads SDS/PDR/RFP via docdex and builds a planning prompt (command runbook \+ agent job \+ agent character).

* Sends a single `tasks/generate` request through the selected agent.

* Creates a `jobs` row of type `task_creation` and writes checkpoints while creating epics, stories, and tasks.

* Captures test requirements per task (unit/component/integration/api) in task metadata and description so `work-on-tasks` can create the relevant tests.

**State & side‑effects**

* Inserts rows in `epics`, `user_stories`, `tasks`.

* Creates `jobs`, `command_runs`, and `token_usage` entries.

* Initial task status: `not_started`.

* With `--dry-run`, no DB mutations; only a preview is printed.

---

#### **11.3.2 `mcoda refine-tasks`** {#11.3.2-mcoda-refine-tasks}

**Purpose**

Enrich, split, merge and re‑estimate existing tasks without regenerating the entire hierarchy.

**Usage**

```shell
mcoda refine-tasks \
  [--project <PROJECT_KEY>] \
  [--epic <EPIC_KEY> | --story <STORY_KEY>] \
  [--status <STATUS_FILTER>] \
  [--max-tasks <N>] \
  [--strategy split|merge|enrich|estimate|auto] \
  [--agent <NAME>]
```

**Behavior**

* Filters tasks by project/epic/story/status.

* For each group (typically per story), builds a prompt containing:

  * Epic/story details.

  * Task descriptions, status, SP, metadata.

  * Relevant SDS/PDR sections from docdex.

  * Recent `task_run_logs` so the agent knows prior failures.

* Agent proposes structured operations (`update`, `create`, `cancel/merge`, `estimate`), which are validated and applied.

**State & side‑effects**

* Updates `tasks` rows and optionally creates new ones.

* Updates aggregate SP on stories/epics.

* Writes a `jobs` row (for larger runs), `command_runs`, `task_run_logs`, and `token_usage` (`command_name = "refine-tasks"`).

---

#### **11.3.3 `mcoda work-on-tasks`** {#11.3.3-mcoda-work-on-tasks}

**Purpose**

Perform AI‑assisted implementation work on tasks: generating or modifying code, tests, and inline docs, while enforcing deterministic Git workflows and logging.

**Usage**

```shell
mcoda work-on-tasks \
  [--project <PROJECT_KEY>] \
  [--task <TASK_KEY> ... | --epic <EPIC_KEY> | --story <STORY_KEY>] \
  [--status not_started,in_progress] \
  [--limit <N>] \
  [--no-commit] \
  [--agent <NAME>]
```

**Behavior (per task)**

* **Selection:** pick eligible tasks (default states `not_started` / `in_progress`) respecting filters.

* **Workspace bootstrap:**

  * Ensure `<repo>/.mcoda/` exists, with a workspace DB and config.

  * Ensure `.mcoda` is present in `.gitignore`, adding it if missing.

* **Agent & prompts:**

  * Resolve agent (`--agent` override or workspace default).

  * Load agent **job** and **character** prompts from `~/.mcoda/agents/...` plus any workspace overrides under `.mcoda/agents/...`.

  * Load command runbook prompt for `work-on-tasks` (including docdex usage, OpenAPI discipline, VCS rules).

  * Compose prompts with task metadata, prior `task_comments` and `task_run_logs`.

* **Deterministic branch workflow:**

  * Stash or commit dirty changes if needed.

  * Checkout base branch (default `mcoda-dev`, from `.mcoda/config.json`).

  * Checkout or create deterministic task branch (e.g. `mcoda/task-{taskKey}` or configured `taskBranchPattern`), reusing the same branch on reruns.

* **Work execution:**

  * Use docdex \+ SDS/OpenAPI context to propose small, safe patches to code, tests, and docs.

  * Apply patches, run required tests, and iterate fixes until tests pass before proceeding.

  * Commit changes with structured message (unless `--no-commit`).

  * Push task branch to remote, merge into `mcoda-dev` on success, and push `mcoda-dev`.

* **State updates:**

  * Update `tasks.vcs_branch` / `tasks.vcs_commit`.

  * Transition `not_started → in_progress → ready_to_review` on success, or to `blocked` with reason on failure.

**State & side‑effects**

* Code changes in repo and Git commits.

* `jobs` row (`type = 'work'`, `command_name = 'work-on-tasks'`).

* `task_runs` and `task_run_logs` rows per step (selection, context, agent, apply, tests).

* `task_comments` when the agent needs to leave notes for future runs.

* `token_usage` entries per agent call.

---

#### **#### **11.3.4 `mcoda code-review`** {#11.3.4-mcoda-code-review}

**Purpose**

Run AI-assisted code review on task branches, capturing structured comments, follow-up tasks, and advancing tasks to QA.

**Usage**

```shell
mcoda code-review \
  [--workspace-root <PATH>] \
  [--project <PROJECT_KEY>] \
  [--task <TASK_KEY> ... | --epic <EPIC_KEY> | --story <STORY_KEY>] \
  [--status ready_to_review] \
  [--base <BRANCH>] \
  [--dry-run] \
  [--resume <JOB_ID>] \
  [--limit N] \
  [--agent <NAME>] \
  [--agent-stream <true|false>] \
  [--json]
```

**Behavior**

* Starts a `review` job (`command_name = "code-review"`) and a `command_run`, writes checkpoints under `.mcoda/jobs/<job_id>/review/` (tasks_selected, context_built, review_applied), and records `token_usage` per agent call.
* Task selection via Tasks/Backlog API filters (`project/epic/story/task`, default `status=ready_to_review`, optional `limit`); the task set is persisted in job payload/checkpoints for resume.
* For each task, identify its branch and diff (from `tasks.vcs_branch` / repo), scoped to `tasks.metadata.files` when present, and store both raw diff and structured `ReviewDiff` JSON.
* Build review prompts including:
  * SDS/PDR/API docs (via docdex) for changed components and acceptance criteria.
  * Task description & acceptance criteria.
  * Prior `task_comments` and `task_run_logs`.
  * OpenAPI slices relevant to changed paths/criteria.
  * Command runbook/checklists for code-review.
* Agent produces structured JSON (decision, summary, findings, testRecommendations).
* CLI writes findings into `task_comments` (`source_command = "code-review"`), inserts `task_reviews`, may auto-create follow-up tasks for critical/blocking findings, updates `task_runs`, and (unless `--dry-run`) transitions tasks:
  * `ready_to_review → ready_to_qa` on approve,
  * `ready_to_review → in_progress` on changes_requested,
  * `ready_to_review → blocked` on block (with reason),
  * transitions are skipped when `--dry-run` is set.

**State & side-effects**

* New `task_comments` rows and `task_reviews` rows; optional follow-up tasks for review findings (generic `epic-bugs/us-bugs` used when no story fits).
* `task_run_logs` and `token_usage` for each review phase (`review_main`/`review_retry`), plus job/command/task runs.
* Checkpoints and artifacts (diffs/context) under `.mcoda/jobs/<job_id>/review/`.
* Output: human table (task, status before/after, decision, finding severity counts, job dir hint) or `--json` with `{ job: { id, commandRunId }, tasks: [...], errors: [...], warnings: [...] }`.

---

#### **11.3.5 `mcoda qa-tasks`** {#11.3.5-mcoda-qa-tasks}

**Purpose**

Run QA flows (unit, integration, browser, mobile) under agent orchestration, using QA tools such as Chromium and Maestro when configured.

**Usage**

```shell
mcoda qa-tasks \
  [--project <PROJECT_KEY>] \
  [--task <TASK_KEY> ... | --epic <EPIC_KEY> | --story <STORY_KEY>] \
  [--profile <QA_PROFILE>] \
  [--agent <NAME>]
```

**Behavior**

* Select tasks in `ready_to_qa` (and optional filters).

* Use workspace `.mcoda/config.json` to select a QA profile (unit, integration, mobile, etc.).

* Orchestrate QA tools via adapters (e.g. Chromium, Maestro) under the QA agent:

  * Run tests or scripted flows.

  * Interpret test logs, screenshots, and artifacts.

* Write results into:

  * `task_comments` (`comment_type = qa_issue` or `qa_result`).

  * `task_run_logs` for each QA step.

**State & side‑effects**

* Status transitions:

  * `ready_to_qa → completed` on success.

  * `ready_to_qa → in_progress` or `blocked` on failures.

* `jobs`, `task_runs`, `task_run_logs`, and `token_usage` entries.

**Gateway-trio (work + review + QA loop)**

**Usage**

```shell
mcoda gateway-trio \
  [--project <PROJECT_KEY>] \
  [--task <TASK_KEY> ... | --epic <EPIC_KEY> | --story <STORY_KEY>] \
  [--status <CSV>] \
  [--max-iterations N] \
  [--max-cycles N] \
  [--gateway-agent <NAME>] \
  [--review-base <BRANCH>] \
  [--qa-profile <NAME>] \
  [--resume <JOB_ID>]
```

**Behavior**

* Orchestrates `work-on-tasks → code-review → qa-tasks` per task, routing each step through the gateway router and looping back to implementation when review or QA reports issues.

* Re-selects tasks after each cycle to pick up newly created follow-ups or tasks unblocked by dependencies.

* Stops when QA reports `infra_issue`, dependencies block a task, or iteration/cycle limits are reached (if set).

* Persists state and handoff artifacts under `.mcoda/jobs/<job_id>/gateway-trio/` for resume and auditability.

---

#### **11.3.6 `mcoda backlog`** {#11.3.6-mcoda-backlog}

**Purpose**

Inspect the backlog of epics, stories, and tasks with filters and optional dependency‑aware ordering.

**Usage**

```shell
mcoda backlog \
  [--project <PROJECT_KEY>] \
  [--epic <EPIC_KEY>] \
  [--story <STORY_KEY>] \
  [--assignee <USER>] \
  [--status <STATUS_FILTER>|all] \
  [--include-done] \
  [--include-cancelled] \
  [--view summary|epics|stories|tasks] \
  [--limit <N> | --top <N>] \
  [--order dependencies] \
  [--verbose] \
  [--json]
```

**Example**

```shell
mcoda backlog --project WEB --view tasks --limit 10 --include-done --order dependencies --verbose
```

**Behavior**

* Queries backlog views for the workspace DB and project filters.

* Aggregates SP totals per status and hierarchy (epic/story/task).

* Defaults to active statuses only; use `--status all` or include flags to show done/cancelled items.

* `--view` controls which sections print, and `--limit`/`--top` caps the visible rows after ordering.

* `--verbose` adds task descriptions to the task table.

* When `--order dependencies` is set:

  * Uses the dependency graph (`task_dependencies`) to return tasks in an order where tasks that unlock others are prioritized appropriately (topological ordering).
  * Emits ordering metadata and warnings (JSON mode) when dependency ordering is skipped or cross‑lane dependencies are detected.

---

#### **11.3.7 `mcoda estimate`** {#11.3.7-mcoda-estimate}

**Purpose**

Estimate throughput and timelines based on story points, SP/h defaults, and learned SP/h from history.

**Usage**

```shell
mcoda estimate \
  [--project <PROJECT_KEY>] \
  [--epic <EPIC_KEY>] \
  [--story <STORY_KEY>] \
  [--assignee <USER>] \
  [--sp-per-hour <FLOAT>] \
  [--sp-per-hour-implementation <FLOAT>] \
  [--sp-per-hour-review <FLOAT>] \
  [--sp-per-hour-qa <FLOAT>] \
  [--velocity-mode config|empirical|mixed] \
  [--velocity-window 10|20|50] \
  [--json]
```

**Example**

```shell
mcoda estimate --project WEB --sp-per-hour-implementation 12 --velocity-mode mixed --velocity-window 20
```

**Behavior**

* Computes SP totals over selected tasks (e.g. not\_started, in\_progress, ready\_to\_review, ready\_to\_qa).

* Reads SP/h metrics for:

  * Implementation (`work-on-tasks`),

  * Review (`code-review`),

  * QA (`qa-tasks`),  
     from `task_runs` and `token_usage`, using sliding windows (last N completed tasks).

* If insufficient history, falls back to the **15 SP/h** default and gradually replaces it with learned SP/h as data accumulates.

* Output includes DONE/TOTAL rows, velocity sample counts (with window), and ETA values as ISO + local time + relative duration.

**State & side‑effects**

* Read‑only; may record aggregated estimation snapshots for telemetry.

---

#### **11.3.8 Agent management (global‑only)** {#11.3.8-agent-management-(global‑only)}

**Commands**

```shell
mcoda agent list
mcoda agent add <NAME> [OPTIONS]
mcoda agent auth-status <NAME>
mcoda agent remove <NAME>
mcoda agent use <NAME> [--workspace <PATH>]
```

**Principles**

* Agents are **global only** and stored in `~/.mcoda/mcoda.db` (tables for `agents`, `agent_auth`, models, health).

* No agent tables exist in workspace DBs; workspaces only refer to global agents by ID or name.

* Credentials (API keys, tokens) are stored **encrypted** in the global DB; **no OS keychains** are used.

* Env vars may bootstrap credentials but are not long‑term storage.

**Behavior outline**

* `agent list`: show registered agents, models, and basic health.

* `agent add`: create or update a global agent definition and prompt locations; optionally capture credentials interactively and store them encrypted.

* `agent auth-status`: inspect auth health.

* `agent remove`: delete a global agent definition (with safety checks to avoid breaking active workspaces).

* `agent use`: set the default agent for the current workspace via routing defaults; does **not** create a workspace‑scoped agent.

---

#### **11.3.9 Routing commands (advanced)** {#11.3.9-routing-commands-(advanced)}

**Commands**

```shell
mcoda routing list
mcoda routing add --job-type <TYPE> --agent <NAME> [--pattern <PATTERN>] [--priority <N>]
mcoda routing enable <ID>
mcoda routing disable <ID>
mcoda routing explain [--job-type <TYPE>] [--agent <OVERRIDE>] [--json]
```

**Behavior**

* Manage routing rules that map job types/patterns to global agents.

* `routing explain` runs the router in dry‑run mode and prints the candidate list, health, capabilities and final selection for debugging.

* `gateway-agent` is a preflight router (`mcoda gateway-agent <job>`) that produces a handoff summary and can optionally offload to the selected agent; it does not change routing defaults.

* Routing always returns global agents; workspaces only influence defaults and patterns, not agent storage.

---

#### **11.3.10 Telemetry & token tracking** {#11.3.10-telemetry-&-token-tracking}

**Commands**

```shell
mcoda tokens \
  [--project <PROJECT_KEY>] \
  [--agent <NAME>] \
  [--command <COMMAND_NAME>] \
  [--since <ISO_TIMESTAMP|DURATION>] \
  [--group-by <project|agent|command|day>] \
  [--format <table|json>]

mcoda telemetry show
mcoda telemetry opt-out
mcoda telemetry opt-in
```

**Behavior**

* `mcoda tokens` queries the `token_usage` table and aggregates tokens (and cost when pricing is configured) per command, agent, job, or project.

* `mcoda telemetry …` controls opt‑in/out for aggregated telemetry and describes what is collected.

* `--no-telemetry` flag and environment overrides can disable telemetry on a per‑run basis, while still allowing local `token_usage` logging if needed for SP/h.

---

#### **11.3.11 Job commands** {#11.3.11-job-commands}

**Core commands**

```shell
mcoda job list [--project <PROJECT_KEY>] [--status <STATE>] [--type <TYPE>] [--since <DURATION>] [--limit <N>] [--json]
mcoda job status <JOB_ID> [--json]
mcoda job watch <JOB_ID> [--interval <SECONDS>] [--no-logs]
mcoda job logs <JOB_ID> [--since <TIMESTAMP|DURATION>] [--follow]
mcoda job inspect <JOB_ID> [--json]
mcoda job resume <JOB_ID> [--agent <NAME>]
mcoda job cancel <JOB_ID> [--force]
```

**Behavior**

* Expose long‑running operations (`create-tasks`, `work-on-tasks`, `qa-tasks`, doc generation) as first‑class entities.

* Allow users (and agents) to:

  * List and filter jobs.

  * Inspect state, progress, last activity and error summaries.

  * Stream progress and logs.

  * Resume from checkpoints.

  * Request cancellation.

---

#### **11.3.12 `mcoda test-agent`** {#11.3.12-mcoda-test-agent}

**Purpose**

Validate that a global agent is correctly configured and responsive with a low‑cost probe.

**Usage**

```shell
mcoda test-agent <AGENT_NAME> \
  [--project <PROJECT_KEY>] \
  [--scenario <FILE>] \
  [--quick] \
  [--verbose]
```

**Behavior**

* Resolves the global agent and loads its prompts and credentials.

* **Static checks:** required configuration present, credentials decrypt, adapters installed.

* **Dynamic checks:**

  * Sends a simple deterministic prompt (e.g. “What is 2+2?”) through the adapter.

  * Optionally runs a small scenario (from YAML/JSON) against a project.

* Prints health, latency, and a summarized response; writes `command_runs` and `token_usage` like any other agent call.

---

#### **11.3.13 `mcoda task-detail` / `mcoda task show`** {#11.3.13-mcoda-task-detail-/-mcoda-task-show}

**Purpose**

Inspect a single task in depth, including hierarchy, branch/PR mapping, comments, logs and history.

**Usage**

```shell
mcoda task show <TASK_KEY> \
  [--include-logs] \
  [--include-history] \
  [--format <table|json|yaml>]

# shorthand alias
mcoda task <TASK_KEY>
```

**Behavior**

* Calls `GET /tasks/{taskId}` plus comment and log endpoints.

* Prints:

  * ID, title, type, status, SP.

  * Epic/story linkage.

  * Assignee (human or agent).

  * VCS details (branch, PR, files).

  * Dependency summary.

  * Recent `task_comments` (code review, QA, human notes).

  * Recent `task_run_logs` (when `--include-logs`).

  * Optional full revision history when `--include-history`.

---

#### **11.3.14 `mcoda order-tasks` / dependency ordering** {#11.3.14-mcoda-order-tasks-/-dependency-ordering}

**Purpose**

Produce a dependency‑aware ordering of tasks so that unblockers and highly‑depended‑on tasks can be prioritized.

**Usage**

```shell
mcoda order-tasks \
  [--project <PROJECT_KEY>] \
  [--epic <EPIC_KEY>] \
  [--status <STATUS_FILTER>] \
  [--json]
```

*(Implementation may be surfaced as `mcoda tasks order-by-dependencies`; `mcoda order-tasks` is the ergonomic alias.)*

**Behavior**

* Uses the `task_dependencies` graph and filters to compute a topological ordering.

* Returns tasks sorted such that:

  * Tasks that unlock many others (roots) are surfaced early.

  * Hard constraints (no cycles, must respect dependencies) are enforced.

---

#### **11.3.15 `mcoda update`** {#11.3.15-mcoda-update}

**Purpose**

Check for and apply updates to the `mcoda` CLI, distributed as an npm package.

**Usage**

```shell
mcoda update \
  [--check] \
  [--channel <stable|beta|nightly>] \
  [--version <SEMVER>] \
  [--force]
```

**Behavior**

* Calls the update-check API (which in turn inspects published npm metadata).

* With `--check`, prints whether an update is available and exits without changes.

* Without `--check`, runs an npm-based self-update (e.g. `npm install -g mcoda@<version>` or equivalent), respecting the chosen channel (`stable|beta|nightly`).

* `--force` skips interactive confirmation and is required when the terminal is non-interactive/CI.

* `--version` pins the npm version installed; `--channel` is also accepted as a query param for the check API.

* Records last update check time in local/global config so future runs can decide whether to prompt again.

* Release pipeline is assumed to publish new versions automatically on `v*` tags; `mcoda update` simply consumes those releases.

**State & side‑effects**

* Updates the installed CLI version.

* May update global config (e.g. channel, last check timestamp).

* Records a `command_runs` row in the **global** DB (`~/.mcoda/mcoda.db`) for each invocation (status, exit code, error summary).

* Does not touch workspace DBs or tasks.

---

This section defines the public CLI surface for mcoda v0.3. All commands are backed by OpenAPI operations, operate against the global `~/.mcoda` data and per‑workspace `.mcoda` directories, and respect the invariants around deterministic branches, encrypted secrets, token usage tracking, and resumable jobs.

## **11.9 `openapi-from-docs` Command** {#11.9-openapi-from-docs-command}

`openapi-from-docs` regenerates or validates the canonical `openapi/mcoda.yaml` from SDS/PDR/docdex context.

**CLI / API inputs**

```shell
mcoda openapi-from-docs [--workspace-root <PATH>] [--agent <NAME>] [--agent-stream <true|false>] [--force] [--dry-run] [--validate-only]
```

**Behavior**

* Resolves workspace defaults (or `--agent`) to pick an agent with `docdex_query` + `doc_generation` capabilities; streams output by default (only `--agent-stream=false` disables).
* Builds docdex context focused on SDS/PDR/OpenAPI and DB schemas; falls back to local docs if docdex is unavailable and emits warnings.
* Invokes an OpenAPI-aware prompt that must emit raw YAML; parser injects `info.title` (`mcoda API`) and `info.version` (CLI package version) and enforces required sections/tags/schemas plus a full OpenAPI validator pass.
* `--validate-only` reads the existing file, runs structural + OpenAPI validation, logs issues, and exits without agent calls.
* `--dry-run` prints the generated YAML instead of writing; otherwise writes to `openapi/mcoda.yaml`, creating an automatic `.bak` when `--force` overwrites an existing file.
* Registers the spec in docdex when available, tagging it as canonical for the workspace/branch.

**State & telemetry**

* Creates a job row (`type="openapi_change"`, `command_name="openapi-from-docs"`) plus `command_runs` and `token_usage` entries for context assembly, agent calls, and validation.
* Checkpoints capture context build, validation results, and output path/backup metadata.

## **12\. `create-tasks` Command** {#12.-create-tasks-command}

`create-tasks` converts higher‑level inputs (epics, specs, user stories) into a normalized backlog of user stories and executable tasks, with dependencies and initial story‑point estimates. It always runs through the job engine (job type `create_tasks`) so large runs are resumable and fully auditable.

---

### **12.1 Inputs (docdex, OpenAPI‑aligned doc usage)** {#12.1-inputs-(docdex,-openapi‑aligned-doc-usage)}

**CLI / API inputs**

```shell
mcoda create-tasks [INPUT...] [OPTIONS]
```

Supported inputs:

* **Existing planning objects**

  * `--epic-id <ID>` – use an existing epic as the “root” requirement.

  * `--story-id <ID>` – re‑generate or augment tasks for a story.

* **Free‑form / doc‑based inputs**

  * `--from-spec <FILE...>` – Markdown / text specs, RFPs, design docs.

  * `--from-diff <BASE..HEAD>` – Git diff; derive tasks from the change set.

* **Project context**

  * `--project <ID>` – required to bind new epics/stories/tasks to a project.

  * Optional flags to constrain scope (components, labels, etc.; defined in OpenAPI).

**OpenAPI alignment**

* The request/response for `create-tasks` is defined as an OpenAPI operation (e.g. `POST /tasks/create` with `CreateTasksRequest` / `CreateTasksResponse`).

* For each generated object:

  * **Epics / stories / tasks** are shaped exactly as their OpenAPI DTOs (IDs, keys, fields, enums).

  * Each generated task may carry OpenAPI‑aware metadata (e.g. `openapi_operation_ids[]`, `component`, `doc_ids[]`) so code‑writing and QA commands can map work back to contracts and docs.

* Any fields or enums not present in `openapi/mcoda.yaml` are rejected by validation before persistence; the agent is not allowed to “invent” schema.

**docdex input usage**

* Textual inputs (spec files, epic/story descriptions) are **mirrored into docdex queries**:

  * Product / component are inferred from project and path.

  * Doc type filters (e.g. `RFP`, `PDR`, `SDS`) are applied based on flags and heuristics.

* docdex returns:

  * Relevant SDS/PDR/RFP segments.

  * Architecture / API docs.

  * Prior related epics/stories (when indexed).

* These are summarized into compact context bundles that guide story/task generation; full docs are never inlined wholesale.

---

### **12.2 Flow (epics → stories → tasks, dependencies, SP)** {#12.2-flow-(epics-→-stories-→-tasks,-dependencies,-sp)}

The core pipeline is a fixed sequence of phases:

1. **Input normalization**

   * Resolve epics/stories from IDs (or create a synthetic “virtual epic” for raw specs).

   * Parse spec files:

     * Extract headings, sections, numbered requirements, and inline “MUST/SHOULD” constraints.

   * Associate each input with a **project** and (where possible) a **component**.

2. **Context enrichment (docdex \+ history)**

   * For each epic / spec section:

     * Query docdex for SDS/PDR/RFP, ADRs, and API docs related to that area.

     * Pull existing epics/stories/tasks with similar titles or tags for reuse.

   * Compress results into a **per‑epic context pack**:

     * Goals, constraints, key APIs, prior art.

3. **Epic → story expansion**

   * If epics already have stories:

     * Optionally run in “enrich” mode (improve text / acceptance criteria, but don’t radically change structure).

   * Otherwise:

     * Identify personas, flows, and high‑level capabilities from inputs \+ docdex context.

     * Generate user stories with:

       * `title`, `description`, `acceptance_criteria`, `labels`, and optional `story_points`.

     * Deduplicate by title/goal; drop or merge near‑duplicates.

4. **Story → task decomposition**

   * For each story:

     * Split into **work streams**: backend, frontend, infra, data, tests, docs, migration, etc.

     * Generate tasks with:

       * Clear titles and “definition of done”.

       * Optional `component` / `area` tags and OpenAPI operation links.

       * Explicit test expectations (`unitTests`, `componentTests`, `integrationTests`, `apiTests`), persisted into `tasks.metadata.test_requirements`.

       * Initial `story_points` estimate on the configured scale (e.g. Fibonacci).

     * Ensure tasks are reasonably sized (no “do everything” mega‑tasks).

5. **Dependency inference**

   * Build a candidate `task_dependencies` graph by:

     * Parsing requirement language (“before”, “after”, “depends on”).

     * Recognizing standard patterns (migrations before feature flags, feature flags before UI rollout, tests/docs after code).

     * Reusing explicit dependency hints from the input docs or project metadata.

   * Normalize into:

     * `blocks` / `is_blocked_by` relations.

     * Cycle‑free DAG (cycles rejected and logged; command may either trim edges or mark tasks as needing manual fix).

6. **SP normalization and roll‑up**

   * Optionally run a second pass (same or dedicated estimation agent) to smooth **story points**:

     * Clamp to configured min/max per task.

     * Ensure aggregate story SP aligns with epic/story‑level expectations.

   * Store:

     * `tasks.story_points`,

     * `user_stories.story_points = sum(tasks)`,

     * `epics.story_points_total = sum(tasks)`.

7. **Validation & persistence**

   * Schema validation against OpenAPI (required fields, enums, IDs).

   * Business rules:

     * Every story has at least one task.

     * No orphaned tasks without a user story.

   * In `--dry-run`:

     * Return the proposed epics/stories/tasks and dependency graph only.

   * Otherwise:

     * Upsert epics/stories/tasks and `task_dependencies` in the workspace `mcoda.db`.

     * Set new tasks to `status = 'not_started'` and attach origin metadata (job id, spec source, docdex doc IDs).

---

### **12.3 Interaction with docdex & Token Usage (per‑action `token_usage`)** {#12.3-interaction-with-docdex-&-token-usage-(per‑action-token_usage)}

**docdex integration**

* For each epic/story/spec chunk, `create-tasks` performs **explicit docdex operations**:

  * `search` – retrieve candidate docs/snippets with filters by product/component/doc type.

  * `fetch_segments` – get specific sections (e.g., “SDS → Non‑Functional → Observability”).

* The command supports (via OpenAPI/CLI flags):

  * `--no-docdex` – disable docdex calls; rely only on inline specs.

  * `--docdex-scope` – limit to a workspace / repo / collection.

  * `--docdex-max-snippets` – cap per‑story snippet count for token control.

* docdex results are:

  * Summarized down to short notes before being passed to the LLM.

  * Tagged onto tasks (e.g. `doc_ids[]`, `sds_sections[]`) so later commands can reuse the same context cheaply.

**Token usage accounting**

Every agent or tool call in `create-tasks` **must** write an entry to `token_usage`:

* `command_name = "create-tasks"`.

* `action`/`phase` values like (examples):

  * `"analyze-input"`, `"docdex-search"`, `"docdex-summarize"`,

  * `"generate-stories"`, `"generate-tasks"`, `"infer-dependencies"`, `"estimate-sp"`.

* Additional columns:

  * `workspace_id`, `project_id`, optional `epic_id` / `user_story_id`.

  * `agent_id`, `model_name`.

  * `openapi_operation_id` for both the main create‑tasks API and docdex operations, where known.

  * `tokens_prompt`, `tokens_completion`, `tokens_total`, `cost_estimate`.

This allows:

* `mcoda tokens` to show per‑phase cost for `create-tasks`.

* Future tuning of strategies (e.g., cheaper retrieval vs more detailed context) based on real usage data.

---

### **12.4 Checkpointing & Resumability (job \+ checkpoint, per‑run logs)** {#12.4-checkpointing-&-resumability-(job-+-checkpoint,-per‑run-logs)}

`create-tasks` is always executed as a **job** so large inputs (multi‑epic specs, big diffs) are safe to run and easy to resume.

**Job model**

* On start:

  * Insert a `jobs` row:

    * `type = "create_tasks"`, `command_name = "create-tasks"`.

    * Payload includes project, input sources, flags (`--no-docdex`, limits, etc.).

  * Insert a `command_runs` row linked to the job for this CLI invocation.

* The job id is returned to the user and can be inspected via `mcoda job status <job_id>` and `mcoda job logs <job_id>`.

**Checkpointing**

* The runtime writes periodic checkpoints under the workspace job directory (see generic job engine spec):

  * Logical stages like:

    * `input_normalized`

    * `stories_generated`

    * `tasks_generated`

    * `dependencies_built`

    * `persisted`

  * Each checkpoint records:

    * Which epics/stories have been processed.

    * Last successful index / cursor into the input list.

    * Lightweight summaries (counts of stories/tasks, any validation errors so far).

* Checkpoints are append‑only; they reference any larger artifacts (e.g. intermediate plans) via blob IDs so files do not need to be re‑written.

**Resuming**

* `mcoda create-tasks --resume <job_id>`:

  * Loads the job and last checkpoint.

  * Skips already‑persisted parts of the pipeline.

  * Continues with remaining epics/stories using the same configuration (agent, model, flags).

* Re‑runs are idempotent:

  * Existing tasks are not duplicated.

  * New tasks created on resume are tagged with the same origin job id and clearly distinguishable timestamps.

**Per‑run logs**

* Per‑job / per‑phase logs are written to:

  * `command_runs` (high‑level outcome, start/end, error summary).

  * `task_logs` (or equivalent) for detailed tracing:

    * Phases, decisions, validation failures.

* On subsequent runs (resume or fresh), `create-tasks` can:

  * Read previous logs for the same job to avoid repeating known‑bad inputs.

  * Use prior errors as context for agents (e.g., “previous attempt exceeded token budget; stay under X tokens”).

* refine-tasks Command  
   `refine-tasks` is the only command allowed to bulk‑reshape an existing backlog after `create-tasks`. It enriches, splits, merges, and re‑estimates tasks and user stories while preserving the hierarchy (project → epic → story → task) and status‑ownership rules (implementation, review, QA transitions stay owned by `work-on-tasks` / `code-review` / `qa-tasks`).

All executions run as jobs of type `task_refinement`, are fully logged, and are auditable per task.

---

## 13\. refine-tasks Command (uses comments, dependencies, token usage, docdex) {#13.-refine-tasks-command-(uses-comments,-dependencies,-token-usage,-docdex)}

### 

### **13.1 Refinement Strategies & Allowed Mutations** {#13.1-refinement-strategies-&-allowed-mutations}

**Goals**

`refine-tasks` exists to:

* Improve textual quality (titles, descriptions, acceptance criteria).

* Adjust estimation (story points, types) based on better understanding.

* Restructure work (split over‑large tasks, merge trivial or overlapping ones).

* Attach implementation hints (likely files, tests, doc links) to tasks.

It must *not* break invariants:

* `(project_id, key)` for epics, stories, tasks remains stable.

* Parentage (`epic_id`, `user_story_id`) is not changed by `refine-tasks`.

* Statuses reserved for other commands (`ready_to_review`, `ready_to_qa`, `completed`) are never set directly here.

**Strategies**

Strategies are explicit and map to an OpenAPI enum:

* `enrich` – improve text, acceptance criteria, labels/metadata, hints.

* `split` – keep a parent task, create child tasks underneath the same story.

* `merge` – cancel redundant tasks into a single target task.

* `estimate` – adjust SP (and optionally type) without structural change.

* `auto` – agent decides per task which of the above to apply, within constraints.

**Allowed mutations (per entity)**

*Tasks (`tasks`)* – **allowed**:

* `title`, `description`, `acceptance_criteria`, `type`, `story_points`,

* metadata fields (labels, file hints, doc links, dependency hints),

* attaching additional hints derived from docdex (e.g., related SDS sections, suggested files, test suites).

\*Tasks – **not allowed**:

* Changing `project_id`, `epic_id`, `user_story_id`, or `key`.

* Setting status to `ready_to_review`, `ready_to_qa`, or `completed`.

* Deleting tasks except as part of a controlled merge (status → `cancelled` with reason).

*User stories (`user_stories`) – allowed*:

* `title`, `description`, `acceptance_criteria`, story‑level labels.

* Story‑level SP adjustments that are consistent with aggregated task SP.

*User stories – not allowed*:

* Changing `project_id`, `epic_id`, or `key`.

*Epics (`epics`) – allowed*:

* `title`, `description`, labels and narrative fields only.

*Epics – not allowed*:

* Changing `project_id` or `key`.

**Application algorithm (per job)**

High‑level algorithm:

1. **Selection**

   * Compute candidate tasks via filters (project, epic, story, task keys, status, `max_tasks`).

   * Group by `user_story_id` (and implicitly `epic_id`) to give the agent local context.

2. **Context building**  
    For each group, load:

   * epic \+ story details,

   * all selected tasks with relevant fields,

   * RFP/PDR/SDS segments from docdex that relate to the story or epic,

   * dependency graph edges from `task_dependencies` so the agent can see blockers and downstream impact.

3. **Agent invocation**

   * Build a structured prompt describing:

     * selected strategy (`split | merge | enrich | estimate | auto`),

     * hard constraints on IDs / keys / statuses and allowed fields,

     * limits (`max_tasks`, SP bounds, min/max children per split, merge rules, etc.).

   * Expect a normalized operations list (update / create / cancel / estimate) per OpenAPI schema, e.g.:

     * `UpdateTaskOp`

     * `SplitTaskOp` (with new child tasks)

     * `MergeTasksOp` (target \+ cancelled sources)

     * `UpdateEstimateOp`.

4. **Validation**  
    For each proposed operation:

   * Verify task keys and story/epic relationships.

   * Enforce allowed‑fields rules (no forbidden field changes).

   * Enforce SP ranges and structural constraints:

     * splits/merges only within the same `user_story_id`,

     * no circular `task_dependencies` introduced,

     * children of a split inherit story/epic from the parent.

   * Reject any operation that would violate dependency integrity (e.g., merging tasks that are depended on by disjoint subgraphs without reconciling dependencies).

5. **Execution**

   * Apply operations in transactions per story group.

   * On success, recompute SP aggregates for affected stories and epics.

   * Maintain dependency graph consistency:

     * update `task_dependencies` for split and merge operations,

     * ensure no orphaned dependencies remain.

   * On conflict (row version mismatch), fail with a version error so the job can be re‑run after manual resolution.

6. **Logging & metrics**

   * Record each operation in `task_revisions` (before/after snapshots) and per‑task run logs.

   * Update `tasks.metadata` with refinement provenance (last refinement job, strategy used).

   * Record token usage and routing decisions for each agent call with `command_name = "refine-tasks"`, including docdex calls, so cost and behavior can be analyzed later.

---

### **13.2 CLI & OpenAPI Contract** {#13.2-cli-&-openapi-contract}

`refine-tasks` is a thin CLI over a canonical OpenAPI operation; OpenAPI is the single source of truth for request/response shapes and allowed values.

**CLI surface**

```shell
mcoda refine-tasks \
  [--project <PROJECT_KEY>] \
  [--epic <EPIC_KEY> | --story <STORY_KEY>] \
  [--task <TASK_KEY> ...] \
  [--status <STATUS_FILTER>] \
  [--max-tasks <N>] \
  [--strategy split|merge|enrich|estimate|auto] \
  [--dry-run] \
  [--plan-out <PATH>] \
  [--plan-in <PATH>] \
  [--agent <NAME>] \
  [--json]
```

*   
  `--strategy` selects refinement behavior; `auto` lets the agent choose per task within constraints.

* `--dry-run` runs the full pipeline (selection, context, agent) but does not write to the DB; the planned operations are returned.

* `--plan-out` writes the operations plan (JSON/YAML) for manual inspection or editing.

* `--plan-in` applies a previously generated plan without re‑invoking the agent (no token spend, purely deterministic DB changes).

* `--agent` overrides workspace/global default agent for this run.

**OpenAPI operation**

* Path: `POST /tasks/refine` (tag: `Tasks`).

* Request type: `RefineTasksRequest`:

  * `project_key` (required),

  * `epic_key?`, `user_story_key?`, `task_keys?[]`,

  * `status_filter?[]` (e.g., `["not_started","in_progress","blocked"]`),

  * `strategy`: enum (`split | merge | enrich | estimate | auto`),

  * `max_tasks?`,

  * `dry_run?`,

  * `agent_id_override?`.

* Response types:

  * Non‑dry‑run: job descriptor (`JobDTO`) with `type = "task_refinement"`, plus compact summary of affected tasks (counts by op type: updated/split/merged/estimated/skipped).

  * Dry‑run: either:

    * job descriptor with an attached `RefinePlan` preview, or

    * a direct `RefinePlan` payload (per `x-mcoda-cli` mapping) suitable for `--plan-out`.

The CLI relies entirely on this OpenAPI contract:

* All DTOs used by `refine-tasks` (`RefineTasksRequest`, `RefinePlan`, `RefineOp`, `TaskRevision`, `Job`) are generated from `openapi/mcoda.yaml`.

* DB schema for `task_revisions`, `jobs`, `token_usage`, `task_run_logs`, and `task_dependencies` is kept consistent with OpenAPI via OpenAPI→SQL sync tooling.

* `refine-tasks` never introduces ad‑hoc fields; if spec and DB disagree, migrations and codegen must be updated first.

---

### **13.3 Auditing & History** {#13.3-auditing-&-history}

`refine-tasks` is high‑impact, so every change must be explainable after the fact, both at job level and per task.

**Job‑level audit**

Each `refine-tasks` invocation:

* Creates a `jobs` row:

  * `type = "task_refinement"`,

  * `command_name = "refine-tasks"`,

  * payload includes:

    * filters (project, epic/story, status, `max_tasks`),

    * chosen strategy,

    * agent/model,

    * docdex scope and sampling parameters.

* Emits structured log events linked to the job id:

  * phases per story group (selection, context, agent, apply),

  * high‑level counts (tasks updated, split, merged, re‑estimated, skipped, conflicts).

This lets you answer:

* Who ran refinement, when, and with which agent/model,

* What scope they targeted,

* How far the job progressed and where it failed (if it did).

**Task revision history**

For fine‑grained history, mcoda maintains a `task_revisions` table:

* Each row records:

  * `task_id`, `job_id`,

  * `op` (e.g. `update`, `split_parent`, `split_child`, `merge_target`, `merge_cancelled`, `estimate`),

  * redacted `before_json` / `after_json` snapshots,

  * `changed_by` (CLI user or automation id),

  * `changed_at`.

Writes follow a strict pattern:

1. Refinement transaction:

   * Read current task row.

   * Compute updated/child/merged tasks.

   * Insert `task_revisions` row with `before_json` / `after_json`.

   * Apply `UPDATE`/`INSERT`/`status=cancelled` operations.

2. On version conflict, both change and revision row are rolled back.

An optional `GET /tasks/{id}/history` endpoint exposes a chronological revision chain; CLI can later surface this via `mcoda tasks history` or `mcoda task show --include-history`.

**Run logs & token audit**

Per‑task, per‑phase logs are persisted so agents (and humans) can see what happened on previous runs:

* `task_run_logs` (or equivalent) records:

  * `job_id`, `task_id`, `command_name = "refine-tasks"`,

  * `phase` (`selection`, `context`, `agent`, `apply`),

  * `status` (`ok`, `skipped`, `blocked`, `conflict`),

  * concise machine‑readable `details_json` (reasons, counts, error codes).

* On re‑run, `refine-tasks` loads recent log entries for each candidate task and includes them in the agent prompt (e.g., “prior run failed with VERSION\_CONFLICT for this task”).

Every agent invocation produces `token_usage` rows:

* `command_name = "refine-tasks"`,

* `job_id` and (where applicable) `task_id`,

* `action/phase` (e.g., `context-build`, `refine-group`),

* per‑call `tokens_prompt`, `tokens_completion`, `tokens_total`, and `cost_estimate`.

Together, `jobs` \+ `task_revisions` \+ `task_run_logs` \+ `token_usage` provide a complete, costed audit trail of how the backlog evolved, which docs (via docdex) were consulted, and which refinements were applied when.

## 

## 14\. work-on-tasks Command

 work-on-tasks is the primary “implementation” command. It pulls tasks from the backlog, orders them using dependency and status rules, prepares the local repo and `.mcoda` workspace, drives a code‑editing agent through a deterministic Git workflow, and advances tasks toward `ready_to_review`. Every invocation runs as a `jobs` row of type `work` with `command_name = "work-on-tasks"`, and every task touched produces structured DB records and disk logs so runs are resumable and auditable.

---

### **14.1 Task Selection Strategies (dependencies & statuses)** {#14.1-task-selection-strategies-(dependencies-&-statuses)}

work-on-tasks never “picks random tasks”; it always works from a deterministic, queryable selection plan.

**14.1.1 Scope & status filters**

Given CLI/API input (project, epic, story, explicit task keys, `--status`, `--limit`, `--parallel`), a `TaskSelectionService` builds the candidate set:

* **Scope filters**

  * Project / epic / story / assignee constraints are applied first.

  * Explicit task keys always win: if the user passes task IDs, only those tasks are eligible.

* **Status gating (implementation lane only)**  
   By default, work-on-tasks only considers tasks in the *implementation* lane:

  * Eligible: `not_started`, `in_progress`, and selected `blocked` tasks (see below).

  * Ineligible unless explicitly overridden:

    * `ready_to_review` (owned by `code-review`),

    * `ready_to_qa` (owned by `qa-tasks`),

    * `completed`, `cancelled`.

* The `--status` filter lets the user narrow or widen this set (e.g. “only `not_started`” or “include `blocked`”).

**14.1.2 Dependency gating**

Dependencies are modeled as a DAG in `task_dependencies`. For each candidate:

* A task is **“dependency‑clear”** if all of its `depends_on_task_id` rows point to tasks that are:

  * `completed` or `cancelled`, or

  * out of scope for the current workspace/project (e.g., upstream tracked elsewhere).

* A task is **“dependency‑blocked”** if any dependency is still in an implementation or review state.

Selection rules:

* By default, work-on-tasks will **skip** dependency‑blocked tasks in automatic runs and may:

  * leave them in `not_started`, or

  * set them to `blocked` with `blocked_reason = 'dependency_not_ready'` when configured.

* When an explicit task key is passed, work-on-tasks may still run but will:

  * surface the dependency graph in logs, and

  * record a clear “working on dependency‑blocked task” reason in metadata.

This logic mirrors the dependency‑ordered backlog view (§17.1.5) but is scoped to the implementation lane.

**14.1.3 Ordering & batching**

Once eligible tasks are known, ordering is deterministic:

1. **Topological order** over the dependency graph:

   * tasks whose dependencies are clear appear before those that depend on them.

2. **Priority & aging** within each topo “layer”:

   * higher `priority` first,

   * then smaller `story_points` (to pull in quick wins),

   * then older `created_at` (to avoid starving old tasks).

3. **Status as a tie‑breaker**:

   * `in_progress` tasks are preferred over `not_started` so that existing branches are finished first,

   * `blocked` tasks only enter the queue when an explicit flag or selection asks for them.

Batching:

* `--limit` caps the total number of tasks for the job.

* `--parallel` caps how many tasks may be processed concurrently; the selection order is still deterministic, and per‑task pipelines run independently within the job.

The resulting ordered list is stored in the job payload and in the workspace DB so a resumed job can continue from “task N+1” without re‑deciding the order.

---

### **14.2 Code Generation Pipeline** {#14.2-code-generation-pipeline}

For each selected task, work-on-tasks runs the same multi‑step pipeline. The goal is to make re‑runs predictable: identical inputs (task, branch, code, docs) lead to the same high‑level behavior.

**14.2.1 Per‑task phases**

For every task in the ordered list:

1. **Load task & history**

   * Fetch task, user story, epic, SP, status, and metadata.

   * Load recent `task_run_logs` and `task_comments` (especially from `code-review` and `qa-tasks`) so the agent sees prior failures and requested changes.

2. **Workspace & `.mcoda` bootstrap**

   * Ensure `<repo>/.mcoda/` exists; create if missing.

   * Ensure `.mcoda` is present in `.gitignore`; if not, append a standard entry.

   * Open or create the workspace `mcoda.db` and migrate it to the current schema.

   * Create job-local directories under `.mcoda/jobs/<JOB_ID>/` for logs, context, checkpoints.

3. **Agent resolution & prompt loading**

   * Resolve the agent in this order:

     * `--agent` override,

     * workspace default for `work-on-tasks`,

     * global default (only if routing rules allow).

   * Load and compose prompts:

     * **Job description** prompt (what “work agent” does).

     * **Character** prompt (tone, risk posture, communication style).

     * **Command‑specific** prompt for `work-on-tasks` (small diffs, safe edits, VCS workflow, OpenAPI/SDS primacy).

   * Build the final system / assistant scaffolding used for all downstream LLM calls in this task run.

4. **VCS prep: commit dirty repo & branch workflow**

   * Inspect working tree:

     * if dirty and outside the task’s scope, either:

       * auto‑stash, or

       * auto‑commit a “WIP” commit, according to workspace policy.

   * Ensure and update the integration branch:

     * create `mcoda-dev` from the project base branch (e.g. `main`) if missing,

     * optionally fast‑forward `mcoda-dev` from remote.

   * Resolve deterministic task branch:

     * if `tasks.vcs_branch` is already set, check it out,

     * otherwise create `mcoda/task/<TASK_KEY>` from `mcoda-dev`, store it in `tasks.vcs_branch`, and push it if configured.

   * From this point, all edits happen on the task branch; re‑runs re‑enter the same branch.

5. **File scope discovery & code context**

   * Compute a narrow file set (targeting 1–10 files) combining:

     * any `metadata.files` hints,

     * mappings from OpenAPI/SDS (endpoints → modules → paths),

     * simple heuristics (language/framework conventions).

   * Read current contents of these files and construct a `CodeContext` bundle (path, language, relevant slices and symbols).

6. **Docs, comments & history context**

   * Query docdex for RFP/PDR/SDS, OpenAPI, and in‑repo docs relevant to the task’s components.

   * Gather:

     * task description, acceptance criteria, SP, type,

     * unresolved `task_comments` (especially from review and QA),

     * summarized prior `task_run_logs` (e.g. “tests failed last time with …”).

   * Trim context to fit per‑command token budgets.

7. **Prompt assembly & agent invocation**

   * Build the final LLM request:

     * System: mcoda rules (OpenAPI as contract, no secrets, small diffs, safe patch format, no mass renames).

     * Assistant: SDS/OpenAPI/docdex snippets and any job‑level instructions.

     * User: the task, code snippets, file list, constraints, and “done means…” criteria.

   * Optionally use a two‑step flow for larger work:

     * **Planner** mode: propose a structured plan for edits.

     * **Editor** mode: generate a concrete `PatchSet` based on plan \+ context.

8. **Patch validation & safe apply**

   * Normalize agent output into a structured `PatchSet` (file‑level operations \+ hunks).

   * Validate:

     * enforce changed‑lines/changed‑files limits,

     * ensure all touched paths are within the computed scope,

     * reject full‑file rewrites or suspiciously large hunks unless “high‑risk” mode is explicitly enabled.

   * Apply patches using the Git abstraction; on failure, revert to the pre‑task snapshot and mark the task as `blocked` with a precise `blocked_reason`.

9. **Required tests & retry loop**

   * Determine test commands from task metadata (`metadata.tests`). If tests are required via `metadata.test_requirements` but no command is configured, block with `tests_not_configured`.

   * Run tests after each patch application (scoped when possible).

   * If tests fail, capture a concise failure summary, re‑invoke the agent to fix issues, and retry until tests pass or the max retry budget is exhausted.

   * Only advance to `ready_to_review` once all required tests pass; otherwise mark `blocked` with `tests_failed`.

10. **Commit, push, merge & metrics**

    * If `--no-commit` is not set:

      * stage only changed files,

      * commit with a standardized message like `"[<TASK_KEY>] <task title>"`,

      * store the resulting SHA in `tasks.vcs_commit`.

    * Push the task branch to remote when configured.

    * When the run is successful and policy allows:

      * merge the task branch back into `mcoda-dev` (fast‑forward or simple merge),

      * push `mcoda-dev` as well.

    * Update DB and telemetry:

      * record a `task_run` / `command_run` row for this task,

      * write detailed `task_run_logs` for each phase,

      * record `token_usage` for every agent call with `command_name = "work-on-tasks"`,

      * compute effective SP/h (task SP divided by elapsed execution time) and feed it into rolling velocity metrics.

Each phase is checkpointed in `.mcoda/jobs/<JOB_ID>/` so that if a job is interrupted, re‑running work-on-tasks with `--resume <JOB_ID>` can continue from the next unprocessed task without redoing successful ones.

---

### **14.3 File System & Git Integration (.mcoda, branches, per‑run logging)** {#14.3-file-system-&-git-integration-(.mcoda,-branches,-per‑run-logging)}

The work-on-tasks implementation relies on a small set of invariants around the local filesystem, Git, and logging.

**14.3.1 `.mcoda` directory & ignore rules**

* Every workspace is rooted at a Git repo; mcoda’s runtime artifacts live under `<repo>/.mcoda/`:

  * workspace `mcoda.db`,

  * job checkpoints (`.mcoda/jobs`),

  * logs (`.mcoda/logs`),

  * generated docs/prompts (`.mcoda/docs`, `.mcoda/prompts`),

  * any command‑specific scratch files.

* On first run:

  * `.mcoda/` is created if missing,

  * `.gitignore` is auto‑patched (idempotently) to include a standard `.mcoda/` entry so DBs, logs, and checkpoints are never committed.

* All file I/O goes through a workspace service that knows:

  * where `.mcoda` lives,

  * how to resolve job directories (`.mcoda/jobs/<JOB_ID>/`),

  * how to apply redaction rules before writing logs.

**14.3.2 GitClient & deterministic branch naming**

All Git operations are mediated by a `GitClient` abstraction (lib or thin wrapper around the `git` binary):

* Core operations:

  * `status`, `currentBranch`, `createBranch`, `checkout`, `merge`, `applyPatch`, `commit`, `push`.

* Branch strategy:

  * **Integration branch**: `mcoda-dev` is the default base for mcoda‑driven work; it tracks the project’s main branch and is kept up to date via fast‑forwards.

  * **Task branches**: each task gets a deterministic branch name, e.g.:

    * `mcoda/task/<TASK_KEY>` (or `<TASK_ID>` where keys are not stable),

    * stored in `tasks.vcs_branch` and on the job payload.

  * On first run, the branch is created from `mcoda-dev`; on re‑runs, the same branch is reused instead of creating new ones.

* Safety:

  * If the working tree is dirty in files that work-on-tasks cares about, the command fails fast for that task with a clear error instead of silently trampling changes.

  * Auto‑stash / auto‑commit behavior for unrelated dirt is configurable and always logged.

**14.3.3 Per‑run logging & traceability**

Every work-on-tasks run leaves a machine‑readable trail in both the DB and the filesystem:

* **DB‑level logs**

  * A `jobs` row for the overall invocation (`type = 'work'`, `command_name = 'work-on-tasks'`) tracks start/end, status, and basic parameters.

  * Per‑task `task_runs` / `command_runs` rows capture:

    * task id, agent id, model, status (`succeeded|failed|blocked`),

    * timestamps, branch name, commit SHA,

    * SP at run time and effective SP/h snapshot.

  * `task_run_logs` provide a structured log stream per task/phase (selection, agent, patch, tests, commit).

* **Disk‑level artifacts**

  * Under `.mcoda/jobs/<JOB_ID>/`, work-on-tasks stores:

    * a small `manifest.json` with job metadata,

    * per‑task summaries (JSON) with changed files, commit SHAs, and blocked reasons,

    * optional expanded logs or agent outputs (subject to redaction rules).

  * These artifacts are considered ephemeral but must be sufficient to:

    * debug failures,

    * reconstruct what happened on a given task run,

    * prime future agent runs with relevant context.

* **Telemetry**

  * Every LLM/tool call records a `token_usage` row keyed by `job_id` and `task_id`, so cost and throughput for implementation work can be analyzed by project, epic, or agent.

  * Aggregates are consumed by `mcoda tokens`, `mcoda telemetry`, and `mcoda estimate` to refine the default 15 SP/hour baseline over time.

Together, these rules ensure that work-on-tasks behaves predictably, keeps `.mcoda` isolated from version control, and leaves enough structured history that subsequent commands (backlog/estimate, code-review, qa-tasks) can build on real implementation data instead of ad‑hoc logs.

## 15\. code-review Command  {#15.-code-review-command}

---

`code-review` is the dedicated review stage in the mcoda pipeline. It consumes diffs produced by `work-on-tasks`, evaluates them against project docs (RFP/PDR/SDS), the canonical OpenAPI spec, and task history, then writes structured findings back into `task_comments` and `task_reviews`. It owns the transition from `ready_to_review` toward `ready_to_qa` (or back to `in_progress` / `blocked`) within the shared task state machine.

---

### **15.1 Scope & Goals (reviews feeding `task_comments`)** {#15.1-scope-&-goals-(reviews-feeding-task_comments)}

**Scope**

`code-review` is responsible for:

* Reviewing changes for one or more tasks selected by project/epic/story/task filters.

* Operating only on tasks that are in `ready_to_review` by default.

* Using the workspace’s canonical OpenAPI (`openapi/mcoda.yaml`) and docdex‑backed docs as contract and design truth.

* Producing structured, durable artifacts rather than ephemeral console output.

**Goals**

* **Structured feedback into `task_comments`**

  * Each review finding becomes a first‑class comment, attached to a task (and optionally file/line), with:

    * `source_command = "code-review"`,

    * `author_type = "agent"` (or `"human"` for manual reviewers),

    * `category` (e.g. `bug`, `style`, `test`, `docs`, `contract`, `security`),

    * free‑form `body` plus optional metadata (file, line, severity).

  * These comments are consumed by:

    * `work-on-tasks` on re‑runs (fixing requested changes),

    * `qa-tasks` (understanding known gaps or risks).

* **Decision model per task**

  * For each task, the review produces a decision recorded in `task_reviews`:

    * `approve` – eligible for promotion to `ready_to_qa`.

    * `changes_requested` – send back to `in_progress`.

    * `block` – transition to `blocked` with a structured reason.

    * `info_only` – comments exist but no state change is requested.

  * Decisions are applied via a centralized TaskStateService, never by ad‑hoc SQL.

* **Contract & docs alignment**

  * Ensure code stays aligned with:

    * OpenAPI operations and schemas for the workspace.

    * SDS/PDR/RFP constraints resolved via docdex.

  * Any divergence (new/changed endpoints, undocumented behavior, broken invariants) must be surfaced as `contract` or `docs` findings, not silently ignored.

* **Stage isolation**

  * `code-review` never:

    * runs heavy QA suites (owned by `qa-tasks`),

    * edits code or docs directly (owned by `work-on-tasks`),

    * mutates task hierarchy (owned by `create-tasks` / `refine-tasks`).

  * Its only side effects are:

    * review artifacts (`task_reviews`, `task_comments`),

    * task status transitions within the review lane,

    * telemetry (`jobs`, `command_runs`, `token_usage`).

---

### **15.2 Flow (use docdex \+ OpenAPI \+ task history in prompts)** {#15.2-flow-(use-docdex-+-openapi-+-task-history-in-prompts)}

`code-review` is a job‑based, checkpointed workflow. Conceptually:

```shell
mcoda code-review \
  [--project <PROJECT_KEY>] \
  [--task <TASK_KEY> ... | --epic <EPIC_KEY> | --story <STORY_KEY>] \
  [--status ready_to_review] \
  [--base <BRANCH>] \
  [--dry-run] \
  [--resume <JOB_ID>] \
  [--limit N] \
  [--agent <NAME>] \
  [--agent-stream <true|false>] \
  [--json]
```

#### **15.2.1 Job creation & task selection** {#15.2.1-job-creation-&-task-selection}

1. **Job row**

   * Create a `jobs` row with:

     * `type = "code_review"`,

     * `command_name = "code-review"`,

     * payload including scope filters, `base_ref`, `dry_run`, agent/model info.

2. **Task resolution**

   * Resolve tasks by:

     * project/epic/story/task filters,

     * default `status_filter = ["ready_to_review"]` unless overridden,
     * optional `--limit` to cap the selection,
     * deterministic ordering from the Tasks/Backlog API (priority/story points/updated_at).

   * Persist the resolved task set in the job payload/checkpoints so re‑runs see the same scope.

3. **Checkpoint 1 – `tasks_selected`**

   * Write first checkpoint under `.mcoda/jobs/<job_id>/review/` capturing the list of task ids, base ref, and agent config.

#### **15.2.2 Per‑task context assembly** {#15.2.2-per‑task-context-assembly}

For each task in the job:

1. **Git diff**

   * Resolve:

     * `task_branch` from `tasks.vcs_branch` (created by `work-on-tasks`).

     * `base_ref` from CLI `--base` or project default (usually `mcoda-dev`).

   * Compute scoped diff:

     * `git diff <base_ref>...<task_branch>`,

     * restricted to `tasks.metadata.files` where available.

   * Serialize into a structured `ReviewDiff` object and store under the job’s `review/` folder.

2. **Task hierarchy & history**

   * Load:

     * task, user story, epic (titles, descriptions, SP, status).

     * recent `task_comments` where `source_command IN ("work-on-tasks","code-review","qa-tasks")`.

     * last `task_reviews` decision, if any.

     * recent `task_run_logs` / `command_runs` for the task (e.g., prior failures, review outcomes).

   * Summarize into:

     * “what this task is about”,

     * “what has already been requested/attempted”,

     * “which comments are still unresolved”.

3. **docdex + SDS/RFP/PDR**

   * Query docdex for:

     * SDS and PDR sections relevant to changed components/modules and acceptance criteria.

     * RFP fragments for requirement‑driven tasks.

     * in‑repo docs / ADRs matching file paths or symbols.

   * Build a compact doc context bundle honoring token budgets.

4. **OpenAPI**

   * Load the workspace‑canonical `openapi/mcoda.yaml`.

   * Extract only:

     * endpoints, operations, and schemas referenced by changed files or acceptance criteria,

     * any security/validation rules that may be impacted.

   * Mark OpenAPI as **non‑negotiable** source of truth in the prompt (code must match this, not vice versa).

5. **Checkpoint 2 – `context_built`**

   * Persist a per‑task context snapshot (diff \+ docdex refs \+ OpenAPI refs \+ history summary) so re‑runs do not need to recompute it unless inputs change.

#### **15.2.3 Prompt construction & agent invocation** {#15.2.3-prompt-construction-&-agent-invocation}

1. **Agent resolution**

   * Order:

     * CLI `--agent` override,

     * workspace default for `code-review`,

     * global default agent.

   * Load:

     * agent job prompt (`code-review` role & rules),

     * agent character prompt (tone, style),

     * command‑specific fragments describing:

       * how to interpret diffs,

       * how to use docdex/OpenAPI,

       * how to emit structured JSON findings.

2. **Prompt assembly**

   * System / assistant layers include:

     * job \+ character prompts,

     * review checklist (correctness, style, tests, security, performance, docs, contracts),

     * project‑specific policies loaded from `.mcoda/checklists/*`.

   * User layer includes:

     * task/story/epic summaries,

     * diff (summarized \+ focused hunks),

     * SDS/RFP/OpenAPI snippets,

     * tests/CI context (if available),

     * summarized prior comments and review history.

3. **Agent call**

   * Invoke the review agent with a schema‑constrained request (via OpenAPI DTOs), requiring output as:

     * overall decision (`approve|changes_requested|block|info_only`),

     * short summary,

     * structured findings list (type, severity, file, line, message, suggested fix),

     * optional test/doc recommendations.

   * Every invocation records a `token_usage` row with:

     * `command_name = "code-review"`,

     * `job_id`, `task_id`, `agent_id`, `model_name`,

     * `openapi_operation_id` for the review method,

     * prompt/completion token counts, cost estimate.

#### **15.2.4 Applying decisions & writing comments** {#15.2.4-applying-decisions-&-writing-comments}

1. **Mapping findings → `task_comments`**

   * For each finding:

     * create a `task_comments` row with:

       * `task_id`, optional `task_run_id`/`review_id`,

       * `source_command = "code-review"`,

       * `author_type = "agent"` (or `"human"` for manual edits),

       * `category` mapped from finding type,

       * `body` containing the reviewer message,

       * optional `metadata` (file, line, severity).

   * Optionally mirror high‑value findings into external PR comments via VCS adapters.

2. **Recording review outcome**

   * Insert a `task_reviews` row:

     * `task_id`, `job_id`, `decision`, `summary`,

     * `findings_json`, `test_recommendations_json`,

     * attribution (`created_by`, timestamps).

   * Update `tasks.metadata.last_review_*` with:

     * latest decision,

     * agent/model used,

     * `job_id` and `task_review_id`.

3. **State transitions**

   * If not in `--dry-run` or `--require-approval` mode:

     * `ready_to_review → ready_to_qa` when `decision = "approve"` and no blocking findings,

     * `ready_to_review → in_progress` when `decision = "changes_requested"`,

     * `ready_to_review → blocked` when `decision = "block"` with a machine‑readable reason.

   * All transitions go through TaskStateService and are logged in the task state history.

4. **Human‑in‑the‑loop variants**

   * `--dry-run`:

     * Runs the full pipeline but:

       * does not update task status,

       * may optionally skip writing `task_reviews`/`task_comments` (configurable).

   * `--require-approval` (future):

     * Writes `task_reviews` \+ `task_comments`,

     * records recommended decision,

     * defers status transitions to a later “apply review” command (e.g. `mcoda tasks apply-review --from-job <JOB_ID>`).

5. **Checkpoint 3 – `review_applied`**

   * Persist per‑task outcome (decision, counts of findings, status changes) in the job’s checkpoint stream so that the job can be resumed mid‑batch without double‑applying decisions.

---

### **15.4 Auditing & Reproducibility (jobs, checkpoints, token\_usage, historical reviews)** {#15.4-auditing-&-reproducibility-(jobs,-checkpoints,-token_usage,-historical-reviews)}

`code-review` must be fully auditable and reproducible. Any “why was this approved/blocked?” question should be answerable from mcoda’s own artifacts.

#### **15.4.1 Jobs, command runs, and checkpoints** {#15.4.1-jobs,-command-runs,-and-checkpoints}

* Each invocation of `mcoda code-review`:

  * Creates a `jobs` row with:

    * `type = "code_review"`,

    * `command_name = "code-review"`,

    * serialized payload (scope, flags, agent/model, base ref).

  * Optionally creates a `command_runs` row per CLI invocation, linked to the job and listing the set of task ids reviewed.

* Disk artifacts:

  * Under `<workspace>/.mcoda/jobs/<job_id>/review/`:

    * `manifest.json` – immutable job metadata (type, parameters).

    * `checkpoints/*.ckpt.json` – ordered checkpoints capturing:

      * which tasks have been selected,

      * which tasks have completed context assembly,

      * which tasks have been reviewed and with what summary outcome.

    * `diffs/`, `context/` (optional) – cached diffs and docdex/OpenAPI slices keyed by task.

* Checkpoints are:

  * append‑only and versioned (`schema_version`),

  * written atomically (temp file \+ rename),

  * read by `mcoda job status/watch/resume` to:

    * show progress,

    * resume partially completed review batches,

    * avoid re‑invoking agents for already‑reviewed tasks unless explicitly requested.

#### **15.4.2 Token usage & cost attribution** {#15.4.2-token-usage-&-cost-attribution}

* Every agent call in `code-review` produces a `token_usage` row with:

  * `workspace_id`, `project_id`, `task_id`, `job_id`,

  * `command_name = "code-review"`, `action`/`phase` (e.g. `context_summarize`, `review_main`),

  * `agent_id`, `model_name`,

  * `tokens_prompt`, `tokens_completion`, `tokens_total`,

  * `cost_estimate`, `timestamp`.

* This enables:

  * `mcoda tokens --project ... --group-by command` to show:

    * total tokens/cost for `code-review` per project, per agent, per task.

  * stage‑specific SP/hour analysis that distinguishes review throughput from implementation and QA.

* `token_usage` is append‑only; it never mutates historical token counts, preserving an exact cost and usage ledger over time.

#### **15.4.3 Historical reviews as re‑run context** {#15.4.3-historical-reviews-as-re‑run-context}

* When `code-review` is re‑run for a task:

  * It loads:

    * latest `task_reviews` rows,

    * all open `task_comments` from prior reviews and QA,

    * prior job checkpoints and `task_run_logs`/`command_runs` for that task.

  * The prompt explicitly distinguishes:

    * resolved vs unresolved comments,

    * previously accepted decisions vs new considerations.

* This makes re‑runs:

  * **incremental** – agents focus on deltas (new changes or unresolved items),

  * **idempotent** – already‑approved changes are not repeatedly re‑debated unless code changed,

  * **explainable** – you can diff two review runs (old vs new `task_reviews`/`task_comments`) to see how feedback evolved.

#### **15.4.4 External traceability (optional)** {#15.4.4-external-traceability-(optional)}

* If PR/issue tracker integrations are enabled:

  * `code-review` records external IDs (PR comment IDs, review threads) in:

    * `task_reviews.metadata`,

    * `task_comments.metadata`.

  * Subsequent runs can:

    * update or resolve existing external comments,

    * avoid creating duplicate threads for the same finding.

* Even when external systems are unavailable, mcoda’s own DB and checkpoints are sufficient to reconstruct:

  * which diffs were reviewed,

  * which docs/OpenAPI sections were consulted,

  * which findings were reported,

  * which decisions were taken and by which agent/human at what time.

Together, jobs, checkpoints, `task_reviews`, `task_comments`, `command_runs`, and `token_usage` provide a complete, reproducible history of the review lane, and form the basis for higher‑level reporting, estimation, and compliance workflows.

## 16\. qa-tasks Command

 `qa-tasks` is the QA lane in the mcoda pipeline. It runs automated or manual tests, lets a QA agent interpret results against acceptance criteria and the canonical OpenAPI/SDS, and updates task status via the shared TaskStateService, with full job, token, and log tracking.

---

### **16.1 QA Scope & Modes (QA profiles, acceptance criteria, OpenAPI compliance)** {#16.1-qa-scope-&-modes-(qa-profiles,-acceptance-criteria,-openapi-compliance)}

**Scope & responsibilities**

QA is responsible for:

* Checking behavior against **task/user‑story acceptance criteria** and higher‑level RFP/PDR/SDS requirements.

* Verifying that observable behavior matches the workspace’s **canonical OpenAPI spec** (`openapi/mcoda.yaml`), not ad‑hoc contracts in code.

* Producing **structured, auditable QA runs** per task (what was tested, how, and with what outcome).

**QA profiles**

Per‑project configuration defines named QA profiles (unit, integration, acceptance, UI, mobile, etc.). Conceptually:

```ts
interface QaProfile {
  name: string;                    // e.g. "unit", "integration", "acceptance", "ui"
  runner?: 'cli' | 'chromium' | 'maestro' | string;
  test_command?: string;           // for 'cli' profiles
  working_dir?: string;
  env?: Record<string,string>;
  default?: boolean;
  matcher?: {
    task_types?: string[];         // e.g. ["backend", "api"]
    tags?: string[];               // e.g. ["login-flow", "mobile"]
  };
}
```

*   
  `runner = "cli"` – shell command (e.g. Jest, pytest, Maven).

* `runner = "chromium"` – browser/UI flows via a Chromium QA adapter (Playwright/Cypress, etc.).

* `runner = "maestro"` – mobile/device flows via a Maestro‑style adapter.

* Additional runners map to custom QA adapters, but all go through the same agent/telemetry layer.

Profiles live in workspace config under `.mcoda/` and are purely configuration; no schema changes are needed to add or remove profiles.

**Acceptance criteria & docs**

For each task, QA collects:

* Task fields (title, description, type, `story_points`, `status`).

* User story and epic **acceptance criteria**.

* SDS/RFP/PDR segments from docdex for the relevant component.

* OpenAPI fragments (endpoints, request/response schemas, status codes) affected by the task.

The QA agent is instructed to treat:

* **OpenAPI** as the contract of record for behavior at interfaces.

* **SDS/RFP/PDR** as the source for higher‑level requirements and constraints.

* Task/user‑story acceptance criteria as the primary check for “done”.

Any divergence between tests/logs and OpenAPI/SDS is classified explicitly (code bug vs doc/API bug vs infra issue) and can lead to follow‑up tasks.

**Task → profile mapping**

Per task, `qa-tasks` chooses a profile by:

1. Honoring an explicit `--profile` flag.

2. Otherwise, first profile whose `matcher.task_types`/`matcher.tags` hits the task’s type/tags/metadata.

3. Falling back to the configured default profile.

A `--level unit|integration|acceptance` flag can further constrain or hint which profile is appropriate, but `--profile` always wins.

---

### **16.2 Modes & Flows** {#16.2-modes-&-flows}

`qa-tasks` supports automated QA (mcoda runs tests and asks an agent to interpret them) and manual QA (humans declare outcomes, optionally with agent summarization).

#### **16.2.1 CLI modes (auto/manual)** {#16.2.1-cli-modes-(auto/manual)}

Canonical CLI shape:

```shell
mcoda qa-tasks \
  [--project <PROJECT_KEY>] \
  [--task <TASK_KEY> ... | --epic <EPIC_KEY> | --story <STORY_KEY>] \
  [--status ready_to_qa] \
  [--mode auto|manual] \
  [--profile <PROFILE_NAME>] \
  [--level unit|integration|acceptance] \
  [--test-command "<CMD>"] \
  [--agent <NAME>] \
  [--agent-stream true|false] \
  [--resume <JOB_ID>] \
  [--dry-run] \
  [--json]
```

*  
  `--mode auto` (default) – run tests via a QA adapter, then use a QA agent to interpret logs and map to a canonical outcome.

* `--mode manual` – accept a human‑provided result per task (pass/fail/blocked), optionally with notes and evidence URLs.

* `--profile` – pick a specific QA profile; otherwise profile selection is automatic.

* `--level` – hint the desired level (unit/integration/acceptance) when multiple profiles exist.

* `--test-command` – one‑off override of the profile’s default CLI command.

* `--agent` – override the workspace/global QA agent for this run.

* `--agent-stream` – defaults to **true**; stream agent interpretation output while persisting full text. Set to false to suppress streaming.

* `--resume <JOB_ID>` – continue a previously started QA job; tasks with recorded outcomes for that job are skipped.

Example automated QA run (Chromium profile) with explicit profile and streaming enabled by default:

```shell
mcoda qa-tasks --workspace-root ~/workspaces/web --project WEB --profile ui --mode auto --task web-01-us-01-t01
```

OpenAPI exposes a `POST /tasks/qa` or equivalent operation that mirrors this surface; the CLI is a thin wrapper over that operation.

#### **16.2.2 Automated QA flow (Chromium/Maestro etc., QA adapters)** {#16.2.2-automated-qa-flow-(chromium/maestro-etc.,-qa-adapters)}

In **auto** mode, per selected task:

1. **Branch resolution**

   * Resolve `tasks.vcs_branch` (set earlier by `work-on-tasks`).

   * Checkout that branch; if missing or dirty in disallowed ways, mark the task as blocked and record a QA failure reason.

2. **Profile & runner selection**

   * Resolve the QA profile (`--profile` → matcher → default).

   * Select runner:

     * `cli` – run `test_command` in `working_dir` with profile env.

     * `chromium` – call the Chromium QA adapter with scenario info (path, tags) derived from profile and task metadata.

     * `maestro` – call the Maestro/mobile QA adapter with the appropriate test suite.

   * QA adapters are implemented as **non‑LLM agents** in the shared agent/adapter layer, so they reuse routing, telemetry, and token logging machinery.

3. **Test execution**

   * Execute the test run via the chosen adapter.

   * Capture:

     * exit code,

     * start/end timestamps,

     * stdout/stderr (or structured report paths),

     * artifact paths (JUnit XML, HTML reports, screenshots, videos).

   * Persist raw artifacts under `.mcoda/jobs/<job_id>/qa/<task_key>/...`.

4. **QA agent interpretation**

   * Assemble a QA prompt containing:

     * task/story/epic context and acceptance criteria,

     * SDS/RFP/PDR/OpenAPI snippets from docdex,

     * profile metadata (unit/integration/acceptance, runner type),

     * summarized test results and links to artifacts.

   * The QA agent returns a structured result, conceptually:

```json
{
  "tested_scope": "login flow (web, Chrome, desktop)",
  "coverage_summary": "...",
  "failures": [
    {
      "kind": "functional|contract|perf|security|infra",
      "message": "...",
      "evidence": "reference to log/test/screenshot"
    }
  ],
  "recommendation": "pass|fix_required|infra_issue|unclear",
  "follow_up_tasks": [ /* optional suggestions */ ]
}
```

   *   
     This call is recorded in `token_usage` with `command_name = "qa-tasks"` and `action = "interpret-results"`.

5. **Outcome calculation**

   * Combine raw test result (exit code, known failing tests) and the QA agent’s recommendation.

   * Normalize to a canonical outcome (`pass`, `fix_required`, `infra_issue`, `unclear`) that the TaskStateService can map to state transitions (see 16.3).

6. **Comment & artifact linking**

   * Persist a `task_qa_runs` row for the task (see 16.3).

   * Optionally mirror key failures to `task_comments` with `source = "qa-tasks"` so `work-on-tasks` and `code-review` see them on re‑runs.

   * Keep artifact paths in metadata so other tools (PR integrations, dashboards) can link back.

#### **16.2.3 Manual QA flow** {#16.2.3-manual-qa-flow}

In **manual** mode, mcoda records a human outcome rather than running tests itself:

```shell
mcoda qa-tasks \
  --mode manual \
  --task <TASK_KEY> \
  --result pass|fail|blocked \
  [--notes "short summary"] \
  [--evidence-url "https://ci.example/testrun/123"]
```

*  
  Expected starting state is usually `ready_to_qa` (see 16.3).

* The command:

  * Validates that the task is in an allowed state.

  * Writes a `task_qa_runs` row with `source = "manual"`, the declared result, notes, and evidence URLs.

  * Optionally writes `task_comments` entries summarizing failures when `result = fail` or `blocked`.

  * Applies state transitions via TaskStateService (16.3).

Manual results can also come via API (e.g. from external test systems); the manual flow is still surfaced through the same OpenAPI operation, with the CLI as one client.

Optionally, a QA agent can be invoked purely to **summarize** external reports (JUnit/Allure URLs, CI logs) into human‑readable comments without affecting the state transition logic.

Quick example:

```shell
mcoda qa-tasks --project WEB --task web-01-us-01-t01 --mode manual --result fail --notes "Checkout button unresponsive" --evidence-url "https://ci.example/run/123"
```

#### **16.2.4 Job & resumability** {#16.2.4-job-&-resumability}

Large QA sweeps (e.g. `--epic` or `--story` scopes) are always modeled as jobs:

* `qa-tasks` creates a `jobs` row with `type = "qa"` and `command_name = "qa-tasks"`.

* Checkpoints are written under `.mcoda/jobs/<job_id>/qa/` capturing:

  * list of tasks in scope and the last processed index,

  * per‑task QA outcomes,

  * summary statistics (passes/fails/blocked, profile usage).

* A partially completed job can be resumed via:

```shell
mcoda job resume <JOB_ID>
```

  *   
    Tasks that already have a QA outcome for that job are skipped by default.

  * Future flags (e.g. `--retest-failed` or `--include-completed`) can force re‑execution.

Job status and logs integrate with the generic job/telemetry model:

* `mcoda job status <JOB_ID>` shows progress (`N/M tasks processed`, counts by outcome).

* `mcoda job logs <JOB_ID>` streams QA‑phase logs for debugging.

* All QA agent calls in the job share the same `job_id` in `token_usage` so their cost can be grouped.

---

### **16.3 Running Tests & Changing States (TaskStateService, token usage, logs)** {#16.3-running-tests-&-changing-states-(taskstateservice,-token-usage,-logs)}

This section defines how QA results are translated into task state transitions, token usage records, and logs.

**Starting states**

By default, `qa-tasks` operates on tasks with:

* `status = "ready_to_qa"` – the normal entry point into QA.

Explicit selection (`--task`) can allow:

* `status = "in_progress"` – exploratory QA / early feedback loops.

* `status = "completed"` – regression or post‑deployment investigations, usually with an explicit `--reopen` flag.

**State transitions via TaskStateService**

All QA outcomes are applied via the shared TaskStateService, not direct SQL updates, to preserve the global task state machine:

* For tasks at `ready_to_qa` in **auto** mode:

  * Outcome `pass` → `ready_to_qa → completed`.

  * Outcome `fix_required` → `ready_to_qa → in_progress` (the task re‑enters implementation; QA writes comments explaining failures).

  * Outcome `infra_issue` → `ready_to_qa → blocked` with `blocked_reason = "qa_infra_issue"` (or similar).

  * Outcome `unclear` → remain `ready_to_qa`, but a QA run is recorded with notes pointing to ambiguous or flaky results.

* In **manual** mode:

  * `result = pass` → `ready_to_qa → completed`.

  * `result = fail` → `ready_to_qa → in_progress`.

  * `result = blocked` → `ready_to_qa → blocked`.

Allowed reopen transitions:

* `completed → in_progress` when QA is used to reopen a task (e.g. `qa-tasks --mode manual --reopen --result fail`).

* `completed → blocked` for environmental or cross‑cutting issues detected after completion.

The TaskStateService enforces that illegal jumps (e.g. `not_started → completed` via QA) are rejected with a clear error.

**QA runs, logs, and comments**

Each QA event is recorded in a `task_qa_runs` (or `qa_runs`) table:

* One row per QA run per task:

  * `task_id`, `job_id`,

  * `source` (`"auto" | "manual" | "post_completion"`),

  * `profile_name`, `runner`,

  * raw result (`pass|fail|blocked`),

  * normalized recommendation (`pass|fix_required|infra_issue|unclear` when a QA agent is involved),

  * timestamps, evidence URLs,

  * `logs_path` under `.mcoda/jobs/<job_id>/qa/<task_key>/`.

Complementary logging:

* `task_logs` entries are written for QA phases (`run-tests`, `interpret-results`, `apply-state-transition`), with:

  * timestamps, log level, source (`qa-adapter`, `qa-agent`, `task-state-service`),

  * concise `message` and structured `details_json` (exit codes, failing tests, error kinds).

* When failures are actionable, QA findings are also mirrored into `task_comments` with:

  * `source = "qa-tasks"`,

  * type `qa_failure` or `qa_note`,

  * references to artifacts (file paths, test names, evidence URLs).

On re‑runs, `qa-tasks` loads recent `task_qa_runs`, `task_logs`, and `task_comments` as context for the QA agent so it can distinguish **regressions** from already‑known issues and avoid repeating low‑value commentary.

**Token usage**

Every QA agent invocation (automated interpretation or summarization) records a `token_usage` row:

* `workspace_id`, `project_id`, `task_id`, `job_id`.

* `command_name = "qa-tasks"`.

* `action`/`phase` such as:

  * `"plan-tests"` (future),

  * `"interpret-results"`,

  * `"summarize-external-report"`.

* `agent_id`, `model_name`.

* `tokens_prompt`, `tokens_completion`, `tokens_total`, `cost_estimate`.

* Timestamp and any error classification (auth, rate‑limit, context‑too‑large, etc.).

This lets `mcoda tokens` and `mcoda telemetry` answer:

* How expensive QA is per project/epic/profile.

* Which QA profiles or runners tend to produce the highest token spend.

* How QA cost correlates with backlog state (e.g. a surge in `fix_required` outcomes).

Together, TaskStateService transitions, `task_qa_runs`, `task_logs`, `task_comments`, and `token_usage` give a complete, auditable picture of how QA was executed for each task and what it cost.

### 

## **17\. Backlog & Estimation**

Backlog & estimation give you a **pipeline view** (impl → review → QA) and time predictions based on story points and configurable SP/hour rates. All logic is deterministic and DB‑driven (no LLM/docdex calls) so it’s cheap and predictable.

---

### **17.1 Backlog Views & Filtering**

#### **17.1.1 Conceptual model**

Backlog is always computed over a **scope**:

* Project (`project_id` / `--project`)

* Optional narrower scopes:

  * Epic (`--epic <EPIC_KEY>`)

  * User story (`--story <STORY_KEY>`)

  * Assignee (`--assignee <USER>`, future field)

* Optional status filter (`--status`), though defaults make sense for most workflows.

Within that scope, we partition tasks into **pipeline buckets**:

* **Implementation bucket**  
   `status IN ('not_started','in_progress','blocked')`

* **Review bucket**  
   `status = 'ready_to_review'`

* **QA bucket**  
   `status = 'ready_to_qa'`

* **Done bucket**  
   `status IN ('completed','cancelled')` (used for historical velocity, not “remaining”)

* **Excluded**  
   Tasks outside the scope or explicitly filtered out.

Backlog is primarily **about remaining work**, so most views focus on implementation, review, and QA buckets.

#### **17.1.2 Backlog query behavior**

`BacklogService` powers both CLI and API:

* Inputs:

  1. `project_id` (required),

  2. optional: `epic_key`, `user_story_key`, `assignee`, `status_filter`.

* Behavior:

  1. Resolve scope:

     * find project, epic, story, assignee IDs.

  2. Pull tasks:

     * `SELECT * FROM tasks WHERE project_id=? AND (filters…) AND status NOT IN ('cancelled')`.

  3. Group tasks:

     * by bucket (impl/review/QA/done),

     * by epic and story.

For each group we compute:

* `task_count`

* `story_points_total`

* optional `task_type_breakdown` (dev/docs/review/qa/research).

#### **17.1.3 Views & hierarchy**

Backlog JSON (`BacklogSummary`) roughly:

```ts
interface BacklogSummary {
  scope: {
    project_id: number;
    project_key: string;
    epic_key?: string;
    user_story_key?: string;
    assignee?: string;
  };
  totals: {
    implementation: { tasks: number; story_points: number; };
    review:         { tasks: number; story_points: number; };
    qa:             { tasks: number; story_points: number; };
    done:           { tasks: number; story_points: number; };
  };
  epics: EpicBacklogSummary[];
}

interface EpicBacklogSummary {
  epic_id: number;
  epic_key: string;
  title: string;
  totals: BacklogTotals;        // same shape as above
  stories: StoryBacklogSummary[];
}

interface StoryBacklogSummary {
  user_story_id: number;
  user_story_key: string;
  title: string;
  totals: BacklogTotals;
}
```

CLI (`mcoda backlog`) presents:

* Top‑level summary:

  * SP & counts for Implementation / Review / QA / Done.

* Epic table:

  * `EPIC | IMPL_SP | REVIEW_SP | QA_SP | DONE_SP | TASKS`.

* Optional story detail with `--stories` or `--verbose`.

#### **17.1.4 Filtering capabilities**

`mcoda backlog` flags (recap):

```shell
mcoda backlog \
  [--project <PROJECT_KEY>] \
  [--epic <EPIC_KEY>] \
  [--story <STORY_KEY>] \
  [--assignee <USER>] \
  [--status <STATUS_FILTER>] \
  [--json]
```

*   
  `--status` is an **inclusive** filter; useful to focus on e.g. only review or QA.

* `--assignee` allows rough personal workload views (subject to DB schema support).

* `--epic`/`--story` narrow the hierarchy; epics/stories outside the filter are not included.

Backlog **never** calls agents or docdex; it’s purely DB and cheap to run even in automation.

---

### **17.2 Story Points & 15 SP/hour Baseline**

#### **17.2.1 Story points scale**

mcoda assumes story points (SP) are:

* **Relative effort** units, not time, usually using a Fibonacci‑like scale (1,2,3,5,8,13,…).

* Stored per task (`tasks.story_points`).

* For epics/stories, SP are **derived** from tasks:

  * `user_stories.story_points` \= sum of its tasks’ SP.

  * `epics.story_points_total` \= sum of tasks’ SP under that epic.

These aggregates are maintained by service logic whenever tasks change.

#### **17.2.2 Baseline throughput**

You specified:

“we give story points to every task and assume we keep **15 SP/hour** rate by default. this number should be adjusted per each status and command run type (code writing, reviewing and qaing).”

Implementation:

* Global (or per‑project) **velocity config**:

```ts
interface VelocityConfig {
  implementationSpPerHour: number; // default 15
  reviewSpPerHour: number;         // default 15 (or tuned per project)
  qaSpPerHour: number;             // default 15 (or tuned per project)
}
```

*   
  Exposed via config file (e.g. `.mcoda/config.json`) and overridable by CLI flags (17.5).

mcoda uses this as the **starting assumption** for all estimates, even before enough history exists to compute empirical velocities.

#### **17.2.3 Per‑command type differentiation**

Each pipeline stage is primarily driven by a **command**:

* Implementation → `work-on-tasks`

* Review → `code-review`

* QA → `qa-tasks`

`EstimateService` maps:

* implementation work to `implementationSpPerHour`,

* review work to `reviewSpPerHour`,

* QA work to `qaSpPerHour`.

Later versions can refine this per‑command or per‑assignee, but v1 uses per‑stage rates.

---

### **17.3 Status-specific Velocity (code vs review vs QA)**

mcoda distinguishes **three stage velocities**, matching the three main commands:

* `v_impl` – implementation velocity (SP/h)

* `v_review` – review velocity

* `v_qa` – QA velocity

#### **17.3.1 Config vs empirical velocity**

Velocity can come from two sources:

1. **Configured velocity** (baseline)

   * From `VelocityConfig` (above) and CLI overrides.

2. **Empirical velocity** (optional enhancement)

   * From historical job and status data:

     * tasks that moved:

       * `in_progress → ready_to_review` → implementation throughput,

       * `ready_to_review → ready_to_qa` → review throughput,

       * `ready_to_qa → completed` → QA throughput,

     * within a rolling time window (e.g. last 14 or 30 days),

     * using job durations or timestamps of status transitions.

SDS defines:

* v1: **config‑only** (simpler, predictable).

* later: optional “auto‑calibrate” mode that adjusts config based on history.

The estimation engine is written so that plugging empirical velocities later is straightforward.

#### **17.3.2 Effective velocity selection**

At estimate time:

```ts
interface EffectiveVelocity {
  implementationSpPerHour: number;
  reviewSpPerHour: number;
  qaSpPerHour: number;
  source: 'config' | 'empirical' | 'mixed';
}
```

Algorithm:

1. Start from config values.

2. If empirical data is available and stable for a stage (enough data points, variance acceptable), optionally blend:

   * `v_effective = α * v_empirical + (1-α) * v_config`, with α configurable (e.g. 0.5).

3. Report which source was used in the `EstimateResult` (`source` field), so users know if estimates are purely configured or history‑informed.

(For initial implementation, `source` will almost always be `"config"`.)

### **17.4 Reporting & Velocity (token\_usage \+ command\_runs)** {#17.4-reporting-&-velocity-(token_usage-+-command_runs)}

Backlog & estimation consume **only mcoda’s own DB data** – primarily `tasks`, `task_runs`, `command_runs`, `token_usage`, and optional `sp_metrics`. They never invoke agents or docdex at runtime.

#### **17.4.1 Source tables** {#17.4.1-source-tables}

At minimum, velocity and reporting read from:

* **`tasks` (workspace db)**

  * `id`, `project_id`, `epic_id`, `user_story_id`, `status`, `story_points`.

* **`task_runs` (workspace db)**

  * Per‑task/per‑command execution history (`command`, `status`, `started_at`, `finished_at`, `sp_per_hour_effective`, etc.).

* **`command_runs` (workspace db)**

  * Per‑invocation records for high‑level commands (`command_name`, `started_at`, `completed_at`, `status`, `sp_processed`, `duration_seconds`).

* **`token_usage` (workspace or global db, FK → `command_runs` / `task_runs`)**

  * Per‑agent call usage: `command_name`, `job_id`, `task_id`, `tokens_total`, `cost_estimate`, `timestamp`.

* **`sp_metrics` (workspace db, optional)**

  * Aggregated SP/hour snapshots per command/agent/window (`sp_per_hour_avg`, `sample_count`, `window_size`).

`token_usage` is **append‑only**; `command_runs` and `task_runs` are updated only to close out runs (status, end timestamps, derived metrics).

#### **17.4.2 Stage mapping (implementation / review / QA)** {#17.4.2-stage-mapping-(implementation-/-review-/-qa)}

Velocity is tracked per **lane**, mapped from commands:

* **Implementation lane** – `work-on-tasks`

  * Uses `command_runs.command_name = 'work-on-tasks'` and/or `task_runs.command = 'work-on-tasks'`.

* **Review lane** – `code-review`

  * Uses `command_runs.command_name = 'code-review'`.

* **QA lane** – `qa-tasks`

  * Uses `command_runs.command_name = 'qa-tasks'`.

Each lane has an associated **configured baseline SP/h**:

```ts
implementationSpPerHour // default 15
reviewSpPerHour         // default 15
qaSpPerHour             // default 15
```

stored in global/workspace config and exposed via `VelocityConfig`.

#### **17.4.3 Deriving empirical SP/hour from history** {#17.4.3-deriving-empirical-sp/hour-from-history}

The **VelocityService** computes empirical SP/h from recent history using `task_status_events` (preferred) and `task_runs` as fallback, with `command_runs` as a last resort:

1. **Collect samples per lane**

    For each lane:

   * Select tasks with status transitions:

     * `in_progress -> ready_to_review` (implementation),

     * `ready_to_review -> ready_to_qa` (review),

     * `ready_to_qa -> completed` (QA).

   * Optionally filter by:

     * project / epic / story,

     * time window (`since`), or

     * last **N** tasks (window \= 10, 20, 50).

   * Determine **SP processed** per sample from `tasks.story_points`.

   * Determine **duration** per sample:

     * Prefer elapsed time between status transitions in `task_status_events`.

     * Else use `task_runs` duration for that task and lane.

     * Else fall back to `command_runs` duration.

2. **Compute lane‑level throughput**

    For each lane:

```
v_empirical_lane = sum(SP_processed) / sum(duration_hours)
```

3.   
   where `duration_hours = duration_seconds / 3600`.

    If there are fewer than a minimum sample threshold (e.g. `< 3 runs` or `< X SP`), empirical velocity for that lane is considered **insufficient** and falls back to config baseline.

4. **Persisting aggregates (optional)**

    A background job or on‑demand call may:

   * write/update a row in `sp_metrics` for `(lane, agent, window_size)`,

   * store `sp_per_hour_avg`, `sample_count`, `last_updated_at`.

5. `mcoda estimate` can either recompute on the fly or read from `sp_metrics` when present.

#### **17.4.4 Combining baseline & empirical velocity** {#17.4.4-combining-baseline-&-empirical-velocity}

Effective per‑lane velocity is a blend of config and history:

```ts
interface EffectiveVelocity {
  implementationSpPerHour: number;
  reviewSpPerHour:         number;
  qaSpPerHour:             number;
  source: 'config' | 'empirical' | 'mixed';
  windowTasks?: 10 | 20 | 50;
}
```

Algorithm per lane:

1. **Start** with `v_config_lane` from `VelocityConfig`.

2. If `velocity-mode = config`, use `v_config_lane` only.

3. If `velocity-mode = empirical`:

   * Use `v_empirical_lane` if enough samples; otherwise fall back to `v_config_lane`.

4. If `velocity-mode = mixed` (default when `autoCalibrate=true`):

   * When `v_empirical_lane` available, blend:

```
v_effective_lane = α * v_empirical_lane + (1 - α) * v_config_lane
```

   *   
     where `α` is a configurable weight (e.g. 0.5).

   * Mark `source='mixed'` and record `windowTasks`.

`token_usage` is primarily used for **cost and token reporting** (via `mcoda tokens` / `mcoda telemetry`); `command_runs` and `tasks` provide SP and duration for velocity. `token_usage.command_run_id` allows joining cost and throughput to show “SP/h and $/SP per lane”.

#### **17.4.5 Backlog & estimate consumption** {#17.4.5-backlog-&-estimate-consumption}

`BacklogService` and `EstimateService` consume `EffectiveVelocity`:

* **Backlog** uses only `tasks` (status \+ SP) to compute buckets and SP totals; it does **not** depend on velocity.

* **Estimate**:

  * Reads `BacklogTotals` (Implementation / Review / QA SP buckets).

  * Gets `EffectiveVelocity` per lane.

  * Computes durations and ETAs (as described in §17.4 of the main text).

  * Annotates results with:

    * per‑lane `sp_per_hour` values,

    * `source` (`config/empirical/mixed`),

    * `windowTasks` used.

These values are surfaced in both CLI human output and JSON (`EstimateResult.effectiveVelocity`).

---

### **17.5 CLI: `mcoda backlog` / `mcoda estimate`** {#17.5-cli:-mcoda-backlog-/-mcoda-estimate}

The CLI exposes backlog & estimation via two read‑only commands built on the APIs above.

#### **17.5.1 `mcoda backlog` (read‑only SP buckets)** {#17.5.1-mcoda-backlog-(read‑only-sp-buckets)}

**Synopsis**

```shell
mcoda backlog \
  [--project <PROJECT_KEY>] \
  [--epic <EPIC_KEY>] \
  [--story <STORY_KEY>] \
  [--assignee <USER>] \
  [--status <STATUS_FILTER>|all] \
  [--include-done] \
  [--include-cancelled] \
  [--view summary|epics|stories|tasks] \
  [--limit <N> | --top <N>] \
  [--order dependencies] \
  [--json] \
  [--verbose]
```

**Behavior**

* Resolves scope (project/epic/story/assignee).

* Queries `tasks` in the workspace db and groups them into 4 buckets by status:

  * Implementation: `not_started | in_progress | blocked`

  * Review: `ready_to_review`

  * QA: `ready_to_qa`

  * Done: `completed | cancelled`

* Aggregates **counts** and **SP totals** per bucket and per epic/story as needed.

* Defaults to active statuses only; use `--status all` or include flags to include done/cancelled in the results.

* `--view` limits which sections print; `--limit`/`--top` caps the visible rows after ordering.

* Tasks table shows a TITLE column by default; descriptions only render with `--verbose`.

* Returns a `BacklogSummary` DTO in JSON mode; renders a table in human mode.

  * JSON output also includes warnings and ordering metadata (for dependency ordering and cross‑lane dependencies).

It never touches `token_usage` or `command_runs`; those are only used by reporting/velocity and `estimate`.

#### **17.5.2 `mcoda estimate` (baseline 15 SP/h \+ rolling averages)** {#17.5.2-mcoda-estimate-(baseline-15-sp/h-+-rolling-averages)}

**Synopsis (extended)**

```shell
mcoda estimate \
  [--project <PROJECT_KEY>] \
  [--epic <EPIC_KEY>] \
  [--story <STORY_KEY>] \
  [--assignee <USER>] \
  [--sp-per-hour <FLOAT>] \
  [--sp-per-hour-implementation <FLOAT>] \
  [--sp-per-hour-review <FLOAT>] \
  [--sp-per-hour-qa <FLOAT>] \
  [--velocity-mode config|empirical|mixed] \
  [--velocity-window 10|20|50] \
  [--json]
```

**Step 1 – SP buckets**

* Internally calls the same backlog query to compute SP totals:

  * `S_impl` (Implementation lane),

  * `S_review` (Review lane),

  * `S_qa` (QA lane).

**Step 2 – Velocity resolution**

* Starts from **config baselines** (default 15 SP/h per lane).

* Applies overrides:

  * `--sp-per-hour` sets **all** lanes.

  * `--sp-per-hour-implementation` overrides implementation only.

  * `--sp-per-hour-review`, `--sp-per-hour-qa` override per lane.

* If `--velocity-mode` requests history (`empirical`/`mixed`), calls `VelocityService` to:

  * read recent `task_status_events` for lane transitions (window `--velocity-window` \= 10/20/50 tasks),

  * fall back to `task_runs` (and then `command_runs`) when events are missing,

  * compute `v_empirical_lane`,

  * blend with config baselines as per 17.4.4.

**Step 3 – Durations & ETAs**

* Computes:

```
T_impl            = S_impl / v_impl
T_review_pipeline = (S_impl + S_review) / v_review
T_qa_pipeline     = (S_impl + S_review + S_qa) / v_qa
```

*   
  Derives pipeline milestones (subtract elapsed in-progress time from `T_impl` when status events are available):

  * `ready_to_review_eta` from `T_impl`,

  * `ready_to_qa_eta` from `max(T_impl, T_review_pipeline)`,

  * `complete_eta` from `max(T_impl, T_review_pipeline, T_qa_pipeline)`.

* Optionally converts hours to wall‑clock timestamps relative to “now” (configurable working‑hours calendar in future versions).

**Output**

* **Human mode (table)** shows:

  * SP per lane and totals,

  * effective SP/h per lane (including whether they’re config/empirical/mixed),

  * velocity sample counts with the window used,

  * hours per lane and ETAs formatted as ISO + local time + relative duration.

* **`--json`** returns an `EstimateResult` DTO containing:

  * `backlogTotals`,

  * `effectiveVelocity`,

  * `durationsHours`,

  * `etas` (optional).

Both `mcoda backlog` and `mcoda estimate` are **safe, read‑only commands**: they do not mutate tasks or jobs, and they do not call agents. Their only side‑effect is optional logging/telemetry for command execution.

## 18\. Token Tracking & Telemetry {#18.-token-tracking-&-telemetry}

Token tracking is the backbone for:

* local cost accounting,

* per‑command diagnostics,

* SP/hour estimation and auto‑calibration, and

* optional export to external telemetry sinks.

This section defines the canonical `token_usage` data model, the telemetry APIs/CLI built on top of it, and how those tie into `jobs`, `command_runs`, and velocity computation (SP/h) described in §17.

---

### **18.1 Token Usage Data Model (per‑action `token_usage` rows)** {#18.1-token-usage-data-model-(per‑action-token_usage-rows)}

#### **18.1.1 Scope & placement** {#18.1.1-scope-&-placement}

* **Workspace DB** (`<repo>/.mcoda/mcoda.db`) is the **source of truth** for raw token usage:

  * one row per agent/tool invocation,

  * append‑only, never mutated in place.

* **Global DB** (`~/.mcoda/mcoda.db`) may maintain **aggregated roll‑ups** (e.g., per‑day/per‑workspace summaries) but does not store per‑call detail.

All cost/velocity features (`mcoda tokens`, `mcoda estimate`, SP/h auto‑calibration) rely on the workspace‑local `token_usage` table.

#### **18.1.2 Logical schema** {#18.1.2-logical-schema}

Conceptually, `token_usage` in the workspace DB is:

```
token_usage (
  id                  PK,
  workspace_id        TEXT NOT NULL,
  project_id          INTEGER NULL,
  epic_id             INTEGER NULL,
  user_story_id       INTEGER NULL,
  task_id             INTEGER NULL,

  job_id              INTEGER NULL,  -- FK -> jobs.id
  command_run_id      INTEGER NULL,  -- FK -> command_runs.id
  command_name        TEXT NOT NULL, -- e.g. "create-tasks", "work-on-tasks"
  action              TEXT NOT NULL, -- e.g. "plan", "docdex-query", "apply-patch"
  invocation_kind     TEXT NOT NULL, -- "llm_call" | "tool_call" | "docdex" | ...

  agent_id            INTEGER NOT NULL,
  provider            TEXT NOT NULL, -- "openai", "anthropic", "ollama", ...
  model_name          TEXT NOT NULL, -- "gpt-5.1-pro", etc.
  openapi_operation_id TEXT NULL,    -- links to OpenAPI operation

  tokens_prompt       INTEGER NOT NULL,
  tokens_completion   INTEGER NOT NULL,
  tokens_total        INTEGER NOT NULL,

  cost_estimate       REAL NULL,     -- in configured currency
  currency            TEXT NULL,     -- default "USD"

  started_at          DATETIME NOT NULL,
  finished_at         DATETIME NOT NULL,
  duration_ms         INTEGER NOT NULL,

  error_kind          TEXT NULL,     -- normalized error enum if call failed
  http_status         INTEGER NULL,  -- for HTTP‑backed adapters

  metadata_json       JSON NULL      -- tool name, endpoint, docdex index, etc.
);
```

Key points (formalized from §3.7 and §7.2):

* **Context fields** (`workspace_id`, `project_id`, `epic_id`, `user_story_id`, `task_id`) make every call attributable to “who used what, for which task, when, and at what cost”.

* **Linkage fields** (`job_id`, `command_run_id`, `command_name`, `action`, `invocation_kind`) bind usage to jobs and CLI commands.

* **Model fields** (`agent_id`, `provider`, `model_name`, `openapi_operation_id`) support routing diagnostics and per‑model cost breakdowns.

* **Token fields** (`tokens_prompt`, `tokens_completion`, `tokens_total`, `cost_estimate`) are the primary metrics for cost and throughput.

* **Timing fields** (`started_at`, `finished_at`, `duration_ms`) allow latency SLOs and correlation with job timelines.

* **Error/metadata fields** give enough detail to understand why a call failed without storing raw prompts or completions.

#### **18.1.3 Relationships & indexes** {#18.1.3-relationships-&-indexes}

* Foreign keys (workspace DB):

  * `token_usage.job_id → jobs.id`

  * `token_usage.command_run_id → command_runs.id`

  * `token_usage.task_id → tasks.id`

  * `token_usage.agent_id → agents.id` (global DB; usually via cached mapping)

* Required indexes (minimum):

  * `(workspace_id, started_at)`

  * `(workspace_id, command_name, started_at)`

  * `(workspace_id, agent_id, started_at)`

  * `(workspace_id, project_id, started_at)`

  * `(job_id)` and `(command_run_id)` for join‑heavy paths.

These are tuned for typical queries used by `mcoda tokens`, `mcoda telemetry`, and `mcoda estimate`.

#### **18.1.4 Recording semantics** {#18.1.4-recording-semantics}

* **Coverage**: whenever token tracking is enabled, **every** agent/tool call is recorded; there is no sampling.

* **Ordering**: `started_at` is wall‑clock UTC at adapter call start; `finished_at` is set just before insert.

* **Append‑only**:

  * Token counts and cost estimates are never updated; corrections are represented as new rows.

  * Deletion (e.g., data retention) is done by **range delete** (time‑ or workspace‑scoped) or compaction into aggregate tables, never by “fixing” existing rows.

* **Privacy**:

  * No raw prompt/completion bodies are stored in `token_usage`.

  * Any optional prompt capture uses separate, redacted log tables and shares the same redaction middleware described in §4.3.5 and §20.3.

---

### **18.2 Telemetry APIs & CLI (aggregation, grouping, JSON output)** {#18.2-telemetry-apis-&-cli-(aggregation,-grouping,-json-output)}

#### **18.2.1 OpenAPI telemetry surface** {#18.2.1-openapi-telemetry-surface}

OpenAPI defines a small set of telemetry operations (tagged `Telemetry`):

* `GET /telemetry/token-usage`

  * Returns paginated raw `token_usage` rows for advanced tooling.

  * Filters: `workspace_id`, `project_id`, `agent_id`, `command_name`, `from`, `to`, `invocation_kind`, `job_id`, `task_id`.

* `GET /telemetry/summary`

  * Returns grouped aggregates:

```ts
interface TokenUsageSummaryRow {
  workspace_id: string;
  project_id?: number;
  agent_id?: number;
  model_name?: string;
  command_name?: string;
  action?: string;
  day?: string; // YYYY-MM-DD
  calls: number;
  tokens_prompt: number;
  tokens_completion: number;
  tokens_total: number;
  cost_estimate: number | null;
}
```

  *   
    Query params:

    * `group_by`: CSV enum subset of `workspace|project|agent|model|command|action|day`.

    * `from`, `to`: time window.

* `GET /telemetry/velocity`

  * Exposes derived SP/h metrics (§17.3) per stage (impl/review/QA) and per command:

    * `implementationSpPerHour`, `reviewSpPerHour`, `qaSpPerHour`,

    * `source` (`config|empirical|mixed`),

    * `windowTasks` (10/20/50).

Telemetry endpoints are **read‑only**; all writes happen via command runtimes inserting into `token_usage`, `jobs`, and `command_runs`.

#### **18.2.2 CLI: `mcoda tokens` & `mcoda telemetry`** {#18.2.2-cli:-mcoda-tokens-&-mcoda-telemetry}

`mcoda tokens` is a thin wrapper over `GET /telemetry/summary`:

```shell
mcoda tokens \
  [--project <ID>] \
  [--agent <NAME|ID>] \
  [--since <DURATION|TIMESTAMP>] \
  [--group-by <project|agent|command|day|model>] \
  [--format <table|json>]
```

*   
  Default grouping: `group_by = project,command,agent` over `--since 7d`.

* Table columns (human mode):

  * `PROJECT | COMMAND | AGENT | CALLS | TOKENS_IN | TOKENS_OUT | TOKENS_TOTAL | COST`

* JSON mode:

  * Emits the raw `TokenUsageSummaryRow[]` from `GET /telemetry/summary`.

`mcoda telemetry` manages telemetry configuration (local \+ remote):

```shell
mcoda telemetry show
mcoda telemetry opt-out   # disable remote export; optionally disable local tracking
mcoda telemetry opt-in
```

*   
  **Default behavior**:

  * Local `token_usage` rows are always recorded.

  * `opt-out` disables **remote export** (e.g., sending aggregates to mcoda’s own telemetry service or user‑configured sinks).

* **Strict privacy mode** (workspace or global config):

  * Allows disabling local token recording as well.

  * Commands warn loudly that cost accounting and SP/h estimates will be degraded or unavailable.

Per‑command:

* `--no-telemetry` skips remote export for that invocation (but still writes local `token_usage` unless strict mode is enabled).

* `MCODA_TELEMETRY=off` is a global env override equivalent to `opt-out` for remote export.

#### **18.2.3 Output contracts** {#18.2.3-output-contracts}

All telemetry outputs are **stable and documented**:

* **Human `table` output**:

  * Column ordering and names are fixed, with minor additions allowed only in new minor versions.

  * Numeric values are human‑formatted but easily parseable (no localized thousands separators in JSON).

* **JSON output**:

  * Directly mirrors OpenAPI DTOs with no renaming in the CLI layer.

  * Safe for piping into `jq`, dashboards, or CI scripts.

Telemetry never includes:

* prompt bodies,

* file contents,

* credential material,

* repository paths beyond high‑level project identifiers.

#### **18.2.4 Aggregation & retention** {#18.2.4-aggregation-&-retention}

A background maintenance flow (or explicit `mcoda telemetry compact`) may:

* Aggregate older `token_usage` rows into **daily roll‑ups** in the workspace DB and/or global DB.

* Delete raw rows older than a configurable retention window (e.g., 90 days) **after** they have been compacted, preserving:

  * per‑day per‑dimension totals,

  * cost estimates,

  * counts and latency percentiles (if tracked).

Retention config lives alongside other DB/telemetry settings (§7.5, §19.4), and defaults favor keeping at least several weeks of detailed history for SP/h computation.

---

### **18.3 Integration with Jobs & Commands (linking to `command_runs`, SP/h derivation)** {#18.3-integration-with-jobs-&-commands-(linking-to-command_runs,-sp/h-derivation)}

#### **18.3.1 Linking token usage to `jobs` and `command_runs`** {#18.3.1-linking-token-usage-to-jobs-and-command_runs}

Every command that invokes an agent (LLM or tool adapter) must:

1. **Create or reuse** a `jobs` row (for long‑running operations) and a `command_runs` row (per CLI invocation in the workspace DB).

2. Pass the resolved `job_id` and `command_run_id` to the Agent Layer.

3. Ensure the Agent Layer writes `token_usage` rows with:

   * `job_id = jobs.id`,

   * `command_run_id = command_runs.id`,

   * `command_name = <CLI command>`,

   * `action = <logical phase>` (e.g., `plan`, `docdex-query`, `patch-apply`, `review`, `qa-run`).

This gives a complete chain:

```
jobs → command_runs → token_usage
                     ↘ tasks / task_runs / task_qa_runs
```

and supports:

* “show me all LLM calls for this job”

* “show me token usage for this run of `work-on-tasks` on TASK‑123”

* “compare cost of `create-tasks` across two runs of the same epic”

#### **18.3.2 Per‑command SP/h derivation** {#18.3.2-per‑command-sp/h-derivation}

For SP/hour metrics, `token_usage` is combined with:

* `tasks` (story points, status),

* status transition history (or `task_runs`),

* `command_runs`/`jobs` (durations).

Implementation:

1. **Identify completed transitions**:

   * Implementation lane:

     * tasks that went `in_progress → ready_to_review`

     * attributable primarily to `work-on-tasks`.

   * Review lane:

     * tasks that went `ready_to_review → ready_to_qa`

     * attributable to `code-review`.

   * QA lane:

     * tasks that went `ready_to_qa → completed`

     * attributable to `qa-tasks`.

2. **Compute per‑task sample** for each lane:

```
sample_SP   = tasks.story_points
sample_time = (transition_completed_at - transition_started_at) in hours
```

   *   
     `transition_*` timestamps come either from explicit status history or from the relevant `command_runs` (start/end) associated with the lane’s command.

3. **Rolling window aggregation**:

   * Take the last N tasks per lane (`N ∈ {10,20,50}`, configurable).

   * Compute:

```
v_empirical_lane = sum(sample_SP) / sum(sample_time)
```

4.   
   **Effective velocity**:

   * Blend empirical and configured baselines per §17.3:

```
v_effective_lane = α * v_empirical_lane + (1 - α) * v_config_lane
```

   *   
     Emit via `GET /telemetry/velocity` and surface in `mcoda estimate`:

     * `implementationSpPerHour` (`v_impl`),

     * `reviewSpPerHour` (`v_review`),

     * `qaSpPerHour` (`v_qa`),

     * `source` (`config|empirical|mixed`),

     * `windowTasks`.

`token_usage` itself is not strictly required for SP/h, but it allows correlating **cost** with **throughput** (e.g., SP/hour per dollar per command/agent), which can be exposed in future telemetry views.

#### **18.3.3 Command‑level dashboards & debugging** {#18.3.3-command‑level-dashboards-&-debugging}

The tight integration between `token_usage`, `command_runs`, and `jobs` enables rich diagnostics:

* `mcoda job status <JOB_ID> --json`

  * includes per‑command and per‑task token summaries from `token_usage`.

* `mcoda tokens --group-by command,agent --since 24h`

  * shows which commands and agents are responsible for most usage in the last day.

* `mcoda tokens --project <ID> --group-by task`

  * (future) can surface “expensive” tasks for optimization.

For debugging, a `mcoda job tokens <JOB_ID>` convenience command (thin wrapper over `/telemetry/token-usage`) can:

* list all invocations in chronological order,

* show action/phase, tokens, duration, error\_kind,

* highlight outliers (e.g., single calls with unusually high context).

#### **18.3.4 Responsibilities & invariants** {#18.3.4-responsibilities-&-invariants}

* Runtime responsibilities:

  * Every adapter call **must** go through a single Agent Layer that:

    * normalizes provider metrics,

    * records `token_usage` with all relevant FKs,

    * never bypasses the DB.

* DB responsibilities:

  * Foreign keys and NOT NULL constraints ensure no orphaned usage rows.

  * Migrations preserve `token_usage` semantics; new fields are additive and aligned with OpenAPI (§7.5.4, §3.6).

* CLI responsibilities:

  * `mcoda tokens`, `mcoda telemetry`, and `mcoda estimate` are **read‑only** views over this data.

  * Any future remote telemetry exporters must consume **only** aggregates or anonymized dimensions, never raw prompts or sensitive content.

Together, this makes token tracking and telemetry a first‑class, auditable subsystem that powers cost visibility, performance tuning, and realistic SP/hour estimates without compromising local privacy guarantees.

## **19\. Jobs & Checkpointing** {#19.-jobs-&-checkpointing}

Long‑running workflows (SDS/PDR generation, `create-tasks`, large `work-on-tasks` / `code-review` / `qa-tasks` runs, OpenAPI changes) always run as **jobs** backed by:

* a **`jobs`** row in the workspace DB `<repo>/.mcoda/mcoda.db`, and

* a **checkpoint directory** under `<repo>/.mcoda/jobs/<job_id>/`.

Jobs are resumable, observable, and linked to `task_runs`, `command_runs`, and `token_usage` so agents can reason about past attempts on re‑runs.

---

### **19.1 Job Model** {#19.1-job-model}

#### **19.1.1 Job types** {#19.1.1-job-types}

`jobs.type` is a small, canonical enum mapping directly to CLI commands and flows:

* `task_creation` – `mcoda create-tasks` (RFP/PDR/SDS → epics/stories/tasks)

* `task_refinement` – `mcoda refine-tasks`

* `work` – `mcoda work-on-tasks`

* `review` – `mcoda code-review`

* `qa` – `mcoda qa-tasks`

* `doc_generation` – SDS/PDR/RFP and other doc flows

* `openapi_change` – OpenAPI evolution flows (schema \+ SQL \+ TS \+ docs kept in sync)

* `other` – reserved for future flows

`jobs.command_name` is always the CLI command string (`"create-tasks"`, `"work-on-tasks"`, `"qa-tasks"`, `"openapi-change"`, etc.) to make aggregation and telemetry straightforward.

#### **19.1.2 Jobs table (workspace DB)** {#19.1.2-jobs-table-(workspace-db)}

A single `jobs` table in the **workspace** DB records every long‑running operation:

* `id TEXT PK` – job UUID

* `type TEXT NOT NULL` – job type enum (above)

* `command_name TEXT NOT NULL` – CLI command that owns this job

* `workspace_id TEXT NOT NULL` – logical workspace key, reused by `token_usage`

* `project_id, epic_id, user_story_id, task_id` – optional scoping FKs (per planning hierarchy)

* `agent_id` – primary agent used for the run

* `job_state TEXT NOT NULL` – lifecycle state (see below)

* `job_state_detail TEXT` – short human‑readable reason / detail

* `total_units, completed_units` – coarse progress counters (e.g. number of tasks targeted vs processed)

* `payload_json` – redacted, immutable job request payload (CLI/OpenAPI inputs)

* `result_json` – final summary / aggregate metrics

* `error_code, error_message` – normalized error category and short message

* `resume_supported INTEGER` – 0/1 flag; only jobs with `1` can be resumed

* `checkpoint_path TEXT` – path to the job’s checkpoint root (see 19.2)

* `created_at, started_at, last_checkpoint_at, completed_at` – timestamps (UTC ISO 8601\)

Jobs live **only** in the workspace DB. The global DB `~/.mcoda/mcoda.db` has no `jobs` table; it holds global agents, credentials, and config instead.

#### **19.1.3 Job states** {#19.1.3-job-states}

`job_state` is a strict enum describing the lifecycle of a job:

* `queued` – job row created; about to start (very short‑lived in CLI flows)

* `running` – actively executing work in the current process

* `checkpointing` – briefly used while flushing a new checkpoint to disk

* `paused` – execution suspended but resumable (future server/daemon support)

* `completed` – finished successfully; `result_json` populated

* `failed` – terminal error (may still be resumable if `resume_supported=1`)

* `cancelled` – intentionally stopped (Ctrl‑C or future explicit cancel cmd)

Allowed transitions (high‑level):

* `queued → running` – when the first unit of work executes

* `running ↔ checkpointing` – around checkpoint write boundaries

* `running → completed | failed | cancelled` – terminal outcomes

* `failed | cancelled | paused → running` – only via explicit resume (`mcoda job resume` or command‑specific `--resume` flag) when `resume_supported=1`

Any other transition is rejected with a structured error (`INVALID_JOB_STATE_TRANSITION`) and logged in `jobs.error_code/error_message`.

`jobs.total_units` / `jobs.completed_units` and `jobs.progress` are updated on each logical stage or batch; for example, one “unit” per task for `work`, `review`, and `qa` jobs.

#### **19.1.4 Lifecycle stages** {#19.1.4-lifecycle-stages}

For every long‑running command (e.g. `create-tasks`, `work-on-tasks`, `qa-tasks`):

1. **Create**

   * Insert `jobs` row with `job_state='queued'`, `payload_json` containing redacted request, `resume_supported=1` if the command implements checkpoints.

   * Create `<repo>/.mcoda/jobs/<job_id>/` directory (see 19.2).

2. **Start**

   * Set `job_state='running'`, `started_at=now`.

   * Initialize `total_units` when a target set is known (e.g. number of tasks in scope).

3. **Progress \+ checkpoint**

   * As units complete, increment `completed_units` and recompute `progress`.

   * After each logical stage or batch, write a new checkpoint file and update `last_checkpoint_at`.

4. **Complete / fail / cancel**

   * On success: `job_state='completed'`, `completed_at=now`, `result_json` summarizing counts, IDs, and key metrics.

   * On error: `job_state='failed'`, `error_code`/`error_message` populated.

   * On user cancellation: `job_state='cancelled'`, `error_code='CANCELLED'`.

The job row plus on‑disk checkpoints ensure even CLI‑bound jobs can be resumed after crashes or restarts.

#### **19.1.5 Linkage to tasks, token usage & logs** {#19.1.5-linkage-to-tasks,-token-usage-&-logs}

Jobs are the hub for other observability tables:

* **Planning:** created/updated tasks record `last_job_id` (FK → `jobs.id`) for the job that last touched them.

* **Execution:** `task_runs` rows (per task, per command run) record `job_id`, `task_id`, `command_name`, `agent_id`, branch/commit info, timestamps, outcome, and structured logs. These are the primary source of context for re‑runs; agents are fed the last N summaries when retrying work, review, or QA.

* **Telemetry:** every agent call writes a `token_usage` row linked to `job_id`, `task_id`, and `command_name`, so SP/h estimation and cost reporting can be derived from real histories.

---

### **19.2 Disk‑based Checkpoint Format (`.mcoda/jobs/<job_id>/...`)** {#19.2-disk‑based-checkpoint-format-(.mcoda/jobs/<job_id>/...)}

Disk checkpoints are the **canonical persistence format** for long‑running jobs. They must be:

* atomic to write,

* cheap to read incrementally,

* forward/backward compatible.

#### **19.2.1 Layout on disk** {#19.2.1-layout-on-disk}

Under the workspace root:

```
<repo>/
  .mcoda/
    jobs/
      <job_id>/
        manifest.json
        checkpoints/
          000001.ckpt.json
          000002.ckpt.json
          ...
        blobs/
          <content_hash_1>
          <content_hash_2>
          ...
```

*   
  `manifest.json` – immutable job metadata: job id, workspace root, creation time, job type, command name, and initial parameters.

* `checkpoints/` – ordered sequence of logical checkpoints (`000001.ckpt.json`, `000002.ckpt.json`, …).

* `blobs/` – content‑addressed binary payloads (e.g., large model outputs, generated docs, archives) stored as `<sha256>` files, referenced from checkpoints.

`jobs.checkpoint_path` points at the **job root** (`.mcoda/jobs/<job_id>/`); the runtime derives `manifest.json` and the latest checkpoint from there. Older rows that still point directly to `checkpoint.json` remain valid because the loader treats that as a single‑checkpoint job and emulates `checkpoints/000001.ckpt.json`.

#### **19.2.2 Checkpoint file format (`*.ckpt.json`)** {#19.2.2-checkpoint-file-format-(*.ckpt.json)}

Each checkpoint is a self‑contained JSON document describing both the engine and the logical state of the job:

```json
{
  "schema_version": 1,
  "job_id": "string",
  "checkpoint_seq": 12,
  "checkpoint_id": "uuid-or-ulid",
  "created_at": "2025-01-13T12:34:56.789Z",

  "status": "running",
  "reason": "optional short summary for last transition",

  "engine": {
    "runtime_version": "x.y.z",
    "platform": "darwin-x64",
    "model": "gpt-5.1-pro",
    "tooling_hash": "git:abcd1234"
  },

  "graph_state": {
    "nodes": { /* node states, local variables, cursors */ },
    "edges": [ /* dependencies */ ],
    "pending_tasks": [ /* queue snapshot */ ]
  },

  "io_state": {
    "inputs": { /* canonical original inputs */ },
    "outputs": { /* last stable outputs */ },
    "artifacts": [
      {
        "id": "string",
        "kind": "file | dir | blob | url | handle",
        "path": "relative/path/or/logical/name",
        "blob_hash": "sha256:...",
        "size": 12345,
        "mime": "text/plain",
        "created_at": "..."
      }
    ]
  },

  "progress": {
    "step": 42,
    "estimated_total_steps": 100,
    "tokens_in": 123456,
    "tokens_out": 78910,
    "custom_metrics": { "batches_completed": 7 }
  },

  "indexes": {
    "tags": ["finetune", "nightly"],
    "cursor": "opaque-cursor-for-resume",
    "parents": ["prev-checkpoint-id-if-non-linear"]
  },

  "extensions": {
    "tool:sql_migration": { },
    "tool:data_pipeline": { }
  }
}
```

Key points:

* `schema_version` – mandatory; bumped when the format changes. Readers must ignore unknown fields and treat missing optional fields as defaults.

* `status` – mirrors or refines `jobs.job_state` for this checkpoint (`running`, `paused`, `completed`, `failed`, `cancelled`, etc.).

* `graph_state` – opaque DAG representation so complex flows (e.g. multi‑branch QA) can resume without recomputing planner state.

* `io_state.artifacts[*].blob_hash` – references into `blobs/`; blobs are immutable and never overwritten.

* `progress.*` – redundant with `jobs.total_units/completed_units` but richer and more tool‑specific; used by `mcoda job inspect` and higher‑level dashboards.

* `indexes.tags` – ad‑hoc tags; `pinned` and `release/*` tags drive retention.

For simple flows, the runtime may still write a single checkpoint; advanced flows can emit multiple checkpoints per job.

#### **19.2.3 Design rules** {#19.2.3-design-rules}

* **Versioned schema**

  * `schema_version` is mandatory.

  * Older versions must be handled by a backward‑compatible loader or explicitly rejected with a clear error (`UNSUPPORTED_CHECKPOINT_VERSION`).

* **Atomic write**

  * Always write to `checkpoints/000012.ckpt.json.tmp`, `fsync`, then rename to `000012.ckpt.json`.

  * `manifest.json` is written once at job creation and updated via atomic full‑file replacement only when necessary.

* **Blobs**

  * Binary artifacts live in `blobs/<sha256>` and are never mutated; multiple checkpoints can reference the same blob.

* **Retention**

  * Keep at least the last **N** checkpoints per job (configurable, e.g. 10).

  * Keep all checkpoints whose `indexes.tags` include `pinned` or `release/*`.

  * A periodic GC pass can remove unreferenced blobs.

* **Consistency with DB**

  * `job_id`, `status`, and key progress fields in the latest checkpoint must match the `jobs` row; mismatches cause `CHECKPOINT_MISMATCH` on resume.

---

### **19.3 Job Control & Resume** {#19.3-job-control-&-resume}

Jobs are controlled through a small set of CLI entrypoints and internal APIs; there are **no background workers** in v1. All work happens in the client process that started the job.

#### **19.3.1 CLI & API surfaces** {#19.3.1-cli-&-api-surfaces}

* `mcoda job list` – lists jobs in the current workspace; columns include `id`, `type`, `command_name`, `job_state`, `% progress`, `created_at`, `last_checkpoint_at`.

* `mcoda job inspect <JOB_ID>` – prints `jobs` row, latest checkpoint summary, and recent `task_runs` / `token_usage` aggregates for that job.

* `mcoda job resume <JOB_ID>` – generic resume entrypoint.

* Command‑specific `--resume` flags (thin wrappers around `job resume` filtered by type), e.g.:

```shell
mcoda create-tasks --resume <JOB_ID>
mcoda work-on-tasks --resume <JOB_ID>
mcoda qa-tasks --resume <JOB_ID>
```

All job‑aware commands print the job id they started or resumed (both in human output and in `--json` output) so callers can script around it.

#### **19.3.2 Resume algorithm** {#19.3.2-resume-algorithm}

Given a `JOB_ID`, the runtime resumes a job as follows:

1. **Load job row**

   * Fetch `jobs` row by `id`.

   * If `job_state='completed'` or `'cancelled'` → `CANNOT_RESUME_FINISHED_JOB`.

   * If `resume_supported=0` → `JOB_NOT_RESUMABLE`.

2. **Read checkpoint**

   * Resolve `checkpoint_root = jobs.checkpoint_path` and load `manifest.json`.

   * Determine latest checkpoint (`checkpoints/*.ckpt.json`), read and validate:

     * `job_id` matches `jobs.id`,

     * `command_name` matches,

     * `workspace_id` / `project_id` match.

   * On mismatch → `CHECKPOINT_MISMATCH` and suggest starting a new job.

3. **Rebuild in‑memory context**

   * Recreate docdex client, Git client, `TaskService`, `TokenUsageService`, etc., using data from `payload_json` \+ checkpoint `io_state` and `graph_state`.

   * Hydrate relevant `task_runs` summaries and `task_comments` so prompts can include “what happened last time” for each task in scope.

4. **Agent selection**

   * If user passed `--agent` on resume, resolve and validate via the global agent registry (capabilities, auth, health).

   * Else reuse `jobs.agent_id`. If it’s missing or unhealthy, fail with `NO_ELIGIBLE_AGENT`.

5. **Transition job state**

   * Allowed: `failed | cancelled | queued | paused → running`.

   * Set `started_at` if null; update `job_state='running'`.

6. **Continue from last stage**

   * For planning jobs (`task_creation`, `task_refinement`): resume from `checkpoint.progress.step` / `graph_state` to continue with the next epic/story/task.

   * For execution jobs (`work`, `review`, `qa`): resume from the next pending item in the checkpoint’s logical queue (e.g. next `task_id` whose last `task_runs` entry isn’t terminal for this stage).

   * Reconcile with DB state (e.g. re‑read tasks by `last_job_id`) to avoid duplicating rows; uniqueness constraints ensure idempotence.

#### **19.3.3 Failure categories & exit codes** {#19.3.3-failure-categories-&-exit-codes}

Errors are normalized into a small set of categories (also used by the agent layer and telemetry):

* `NETWORK` – docdex / VCS / remote LLM provider unreachable

* `TIMEOUT` – job exceeded configured time or per‑call timeout

* `AUTH` – invalid or missing credentials (agent or docdex)

* `DB` – SQLite constraint or migration mismatch

* `USAGE` – invalid inputs (e.g. missing project, invalid flags)

* `UNKNOWN` – any unhandled error

On terminal failure:

* `jobs.job_state='failed'`

* `jobs.error_code` set to canonical category

* `jobs.error_message` contains a short, redacted message

* CLI exit code mapped from the category (e.g. TIMEOUT → 3, NETWORK → 4, AUTH → 5, DB → 7).

Resuming:

* Transient errors (`NETWORK`, `TIMEOUT`) are expected to be retried via `mcoda job resume <JOB_ID>` after connectivity/timeouts are fixed.

* Structural errors (`DB`, `USAGE`) may re‑fail quickly until the underlying problem (schema, config, inputs) is fixed.

#### **19.3.4 Command‑specific partial work rules** {#19.3.4-command‑specific-partial-work-rules}

Each command defines how partial work is handled when a job fails mid‑run:

* **`create-tasks` / `refine-tasks`**

  * Writes are stage‑atomic (epics in one transaction, each epic’s stories in another, etc.).

  * On resume, the planner skips epics/stories/tasks already created/refined by checking keys (`project_id`, `key`, or processed flags in the checkpoint).

* **`work-on-tasks`**

  * Each task is handled in its own transactional unit: patch apply \+ status transition \+ metadata updates (including `task_runs` and `task_comments`).

  * On crashes between patch and commit, the next run detects a dirty Git tree and either asks for manual cleanup or re‑attempts the task as `in_progress`.

* **`code-review` / `qa-tasks`**

  * Per‑task runs are independent; partial success is acceptable.

  * Resume skips tasks that already reached the terminal status for that phase (`ready_to_qa` for review, `completed` for QA), inferred from both task state and recent `task_runs`.

#### **19.3.5 No hidden background workers** {#19.3.5-no-hidden-background-workers}

v1 explicitly **does not** introduce background daemons or schedulers:

* Jobs run inside the CLI process that started them.

* Persistence (DB \+ checkpoints) exists for resiliency and explicit manual resume, not for asynchronous queueing.

* If the process crashes or is killed, jobs remain in `failed` or `cancelled` and are only resumed when the user runs `mcoda job resume` (or a command‑specific `--resume`).

## **20\. Security & Secrets** {#20.-security-&-secrets}

Security in mcoda is centered on **DB‑only encrypted secrets**, strict separation between **global** and **workspace** state, and aggressive **redaction** of anything that might contain credentials or sensitive payloads. mcoda never uses OS‑level keychains; the SQLite databases and a small amount of key material under `~/.mcoda/` are the only persistent secret stores.

---

### **20.1 Credential Storage (global vs workspace DB)** {#20.1-credential-storage-(global-vs-workspace-db)}

mcoda maintains two SQLite databases:

* **Global DB**: `~/.mcoda/mcoda.db`

* **Workspace DB**: `<workspace>/.mcoda/mcoda.db`

The split is a hard security boundary:

* **Global DB (`~/.mcoda/mcoda.db`) – *secrets allowed***

  * Holds:

    * Agent registry (`agents`, `agent_capabilities`, `agent_prompts`).

    * Provider/model catalog.

    * Encrypted credentials and auth records (`credentials`, `agent_auth`‑style tables).

    * Global defaults, telemetry aggregates, velocity baselines.

  * **All long‑lived secrets live here**, never in workspace DBs:

    * LLM/API keys (OpenAI, Anthropic, Ollama, etc.).

    * docdex tokens.

    * VCS/issue tracker tokens (GitHub/GitLab/Jira/Linear).

    * QA / external‑integration credentials.

* **Workspace DB (`<workspace>/.mcoda/mcoda.db`) – *no credentials***

  * Holds:

    * Projects, epics, user stories, tasks.

    * Task dependencies and status history.

    * `task_runs` / `command_runs`, `task_logs`, `task_comments`.

    * `task_qa_runs` / QA metadata.

    * Per‑action `token_usage` for that workspace.

    * Workspace agent overrides and routing defaults.

  * **Must never contain** API keys, OAuth tokens, or other cross‑workspace secrets.

The `<workspace>/.mcoda/` directory is treated as **highly sensitive**:

* Contains the workspace DB, logs, job checkpoints, and doc/prompt artifacts.

* Is automatically added to `.gitignore` to prevent accidental commit.

* Is protected by normal OS file permissions; mcoda does not relax those.

Environment variables are allowed **only as bootstrap inputs** (e.g., first‑time `mcoda agent add`); once ingested they are immediately persisted into the encrypted global DB and no longer relied on.

---

### **20.2 DB‑Only Encrypted Secrets (no keychain)** {#20.2-db‑only-encrypted-secrets-(no-keychain)}

mcoda uses a **DB‑only secret model**: there is **no OS keychain integration** and no alternative persistent secret stores.

**Storage model**

* All secrets are stored as **encrypted blobs** in global DB tables such as `credentials` / `agent_auth`:

  * Columns conceptually include: `id`, `provider`, `name`, `method`, `encrypted_payload`, metadata (scopes, expiry), timestamps.

* The encryption is applied at the **application layer**:

  * Values are encrypted before they ever reach SQLite.

  * Decryption happens only in process, in memory, on demand.

**Key management**

* A local encryption key (or small keyset) is stored under `~/.mcoda/` (e.g., `~/.mcoda/key`), protected by OS user permissions.

* That key is never written into:

  * Workspace DBs,

  * Logs,

  * Agent prompts,

  * Version‑controlled files.

* **Key rotation** is an explicit maintenance flow:

  * Read all encrypted rows.

  * Decrypt with the old key.

  * Re‑encrypt with the new key and overwrite in place.

**Access rules**

* Only a narrow set of internal services may read decrypted secrets:

  * Agent adapter layer (LLM providers).

  * `DocdexClient`.

  * VCS / issue‑tracker clients.

  * QA runner integrations.

* Repository or API layers that expose “auth objects” must:

  * Redact secrets by default.

  * Require explicit `includeSecrets`‑style flags for privileged internal calls.

  * Never expose raw secret values to:

    * CLI/JSON output,

    * Agents or prompts,

    * Workspace DB.

**Non‑features (by design)**

* No macOS Keychain / Windows Credential Manager / `libsecret` integration.

* No long‑term storage in env vars, config files, or `.mcoda` workspace directories.

* No automatic migration from inline secrets; any such use must be explicit and is discouraged.

---

### **20.3 Redaction & Logging Rules (task runs, QA runs, token\_usage)** {#20.3-redaction-&-logging-rules-(task-runs,-qa-runs,-token_usage)}

Logging is designed to be **observable but not leaky**. All logs pass through a secrets‑aware redaction layer before they reach disk.

**Secret‑aware logger**

* When mcoda loads a credential, it may register:

  * The raw value (in memory only).

  * A deterministic fingerprint (e.g., `sha256` of the secret).

  * One or more labels (e.g., `"provider.openai.api_key"`).

* On log emission:

  * Any segment that matches a known secret or fingerprint is replaced with:

    * `***SECRET:provider.openai.api_key***` or similar.

  * Additional pattern detectors catch obvious token formats:

    * `sk-...` keys, JWT‑like `xxxxx.yyyyy.zzzzz`, long random hex/base64 strings in suspicious contexts.

Redaction is **always on**; there is no configuration to fully disable it. Even “debug” or “trace” logs remain redacted.

**Structured DB‑level logging**

mcoda records run history in structured tables, **never storing raw prompts or completions by default**:

* **Task / command runs**

  * `task_runs` / `command_runs` capture:

    * `command_name`, `job_id`, `task_id(s)`,

    * timestamps, status, error summaries,

    * branch/commit info and high‑level context (e.g., `blocked_reason`).

  * `task_logs` (or equivalent) record:

    * timestamped, leveled log entries,

    * source component (`agent`, `adapter`, `docdex`, `qa_runner`, etc.),

    * *redacted* message plus structured `details_json`.

* **QA runs**

  * `task_qa_runs` records:

    * profile/runner (`cli`, `chromium`, `maestro`, …),

    * raw outcome (`pass|fail|blocked|unclear`),

    * pointers to test logs/artifacts under `<workspace>/.mcoda/jobs/<job_id>/qa/...`,

    * any QA agent recommendation / notes (already redacted).

  * Serious QA failures can be mirrored into `task_comments` with type `qa_issue` or similar.

* **Token usage**

  * `token_usage` is **append‑only** and carries:

    * `workspace_id`, `job_id`, `command_name`, `agent_id`, `model_name`,

    * optional `project_id`/`epic_id`/`user_story_id`/`task_id`,

    * `tokens_prompt`, `tokens_completion`, `tokens_total`,

    * `cost_estimate` (if known), timestamps.

  * It deliberately does **not** store:

    * full prompts,

    * completions,

    * tool arguments or outputs, beyond small redacted summaries in `metadata_json`.

**On‑disk log files**

* Any textual logs under `<workspace>/.mcoda/logs` or job folders (e.g., `.mcoda/jobs/<job_id>/...`) are:

  * written only after redaction,

  * scoped to the current workspace,

  * not committed to VCS (they live under `.mcoda/`).

Optional “prompt capture” debugging modes must route through the same redaction middleware; raw, unredacted prompts/completions are never persisted automatically.

---

### **20.4 Threat Model Overview (DB‑only secrets, `.mcoda` folder, no keychain)** {#20.4-threat-model-overview-(db‑only-secrets,-.mcoda-folder,-no-keychain)}

mcoda’s threat model assumes a **single local OS user account** running mcoda, with LLM providers and docdex treated as untrusted remote services.

**Trust zones**

1. **Local workspace (highly trusted)**

   * Git checkout, code, tests.

   * Workspace `.mcoda/` directory:

     * workspace DB,

     * job checkpoints,

     * logs, doc and prompt artifacts.

   * Assumed to contain sensitive IP and possibly secrets in source (e.g., `.env` files) but mcoda:

     * never auto‑indexes obvious secret files (`.env`, keys),

     * never ships `.mcoda/` contents to any remote service.

2. **Local machine / global mcoda home (trusted but constrained)**

   * `~/.mcoda/`:

     * global `mcoda.db` (with encrypted credentials),

     * encryption key file,

     * global logs/telemetry and update metadata.

   * Protected purely by OS file permissions; there is **no OS keychain** in the loop.

   * A compromise of this directory plus the local key material is sufficient to decrypt stored credentials.

3. **Remote services (untrusted / semi‑trusted)**

   * LLM providers, docdex, VCS remotes, issue trackers, QA services.

   * mcoda assumes:

     * network traffic may be logged by providers,

     * data sent may be retained or used per their contracts.

   * Mitigations:

     * minimum necessary snippets of code/docs are sent,

     * no raw DB dumps or `.mcoda` contents,

     * optional redaction of known secret patterns from prompts.

**Key risks & mitigations**

1. **Local file leakage**

   * Risk: other local users reading `~/.mcoda/` or workspace `.mcoda/`.

   * Mitigations:

     * enforce standard user‑only permissions on these dirs,

     * encrypt all secret fields in global DB,

     * keep workspace DB free of credentials.

2. **Tool / agent misuse**

   * Risk: LLM‑driven tools executing dangerous shell commands or wide‑ranging Git operations.

   * Mitigations:

     * tool allowlists and per‑tool safety flags,

     * safe‑edit policies and diff size limits for `work-on-tasks`,

     * dry‑run and confirmation flows for high‑risk actions.

3. **Remote service compromise**

   * Risk: stolen tokens or hostile providers.

   * Mitigations:

     * least‑privilege tokens (repo/project‑scoped where possible),

     * support for revoking/rotating credentials centrally in the DB,

     * never sharing tokens with workspaces or logs.

4. **CI / shared environments**

   * Risk: secrets exposed via misconfigured CI logs or shared containers.

   * Mitigations:

     * secrets injected via CI secret stores or env vars only at runtime,

     * the same redaction pipeline is applied to CI logs,

     * no requirement to mount `~/.mcoda/` into CI; ephemeral credentials are supported.

**Out of scope (baseline)**

* Fully compromised OS / root access.

* Physical attackers with direct disk imaging.

* Malicious LLM / docdex providers ignoring their contracts.

Within these bounds, mcoda’s design aims to ensure that: (1) **all** secrets live only as encrypted blobs in the global DB, (2) per‑workspace `.mcoda/` directories are treated as sensitive but credential‑free, and (3) logs and telemetry for task runs, QA runs, and token usage remain useful for debugging and reporting without ever exposing secret material.

## 21\. Configuration, Workspaces & Extensibility {#21.-configuration,-workspaces-&-extensibility}

mcoda must be configurable but predictable: one global data root under `~/.mcoda`, multiple workspaces each with their own `<workspace>/.mcoda/`, a clear config precedence chain, and a pluggable, agent‑agnostic core that is driven by the OpenAPI contract.

---

### **21.1 Config Files & Environment Variables** {#21.1-config-files-&-environment-variables}

#### **21.1.1 Config layers & precedence** {#21.1.1-config-layers-&-precedence}

Configuration is layered; later sources override earlier ones for each setting:

1. **Built‑in defaults**

   * Hardcoded defaults for:

     * global DB path (`~/.mcoda/mcoda.db`),

     * default docdex base URL / timeouts,

     * baseline SP/hour rates (15 SP/h for implementation/review/QA),

     * telemetry budgets and log locations.

2. **Global config (file \+ DB)**

   * **File:** `~/.mcoda/config.json` (JSON, no comments).

   * **Global DB:** `~/.mcoda/mcoda.db`.

   * Used for machine‑level defaults: docdex base URL, default project keys, global budgets, SP/h baselines, update‑check behavior, cache/jobs paths, and default agent name.

   * API keys and tokens are **never** stored in `config.json`; they are stored **encrypted** in `~/.mcoda/mcoda.db` via `mcoda agent add`.

3. **Workspace config (file)**

   * **File:** `<workspace_root>/.mcoda/config.json`.

   * Overrides global config for that workspace only:

     * docdex project ID(s),

     * VCS settings (e.g. `baseBranch: "mcoda-dev"`, deterministic task branch pattern),

     * QA profiles,

     * command defaults (e.g. QA profile overrides, backlog filters).

4. **Environment variables (ephemeral overrides)**

   * Fast, per‑process overrides for CI and ad‑hoc runs (see 21.1.3).

   * **Not** used as the primary store for configuration or secrets. The durable source of truth is the global DB (`~/.mcoda/mcoda.db`) plus config files.

5. **CLI flags / programmatic overrides**

   * Highest priority for that invocation (`--agent`, `--workspace`, `--sp-per-hour`, `--profile`, `--jobs-dir`, etc.).

All commands resolve configuration through a single `ConfigService` using this precedence chain, so behavior is consistent across the CLI.

---

#### **21.1.2 Config file schema (v1)** {#21.1.2-config-file-schema-(v1)}

Config files are JSON (no comments) to align with OpenAPI tooling and schema validation.

**Global config (`~/.mcoda/config.json`) – example**

```json
{
  "db": {
    "path": "~/.mcoda/mcoda.db"
  },
  "docdex": {
    "baseUrl": "https://docdex.internal",
    "projectId": "platform-x",
    "timeoutMs": 20000
  },
  "velocity": {
    "implementationSpPerHourDefault": 15,
    "reviewSpPerHourDefault": 18,
    "qaSpPerHourDefault": 12
  },
  "telemetry": {
    "budgets": [
      {
        "scope": "project",
        "projectKey": "PLATFORM-X",
        "period": "week",
        "maxTokens": 400000,
        "maxCost": 30
      }
    ]
  },
  "agents": {
    "defaultName": "openai"
  },
  "updates": {
    "checkOnManualRun": true,
    "channel": "stable"
  },
  "paths": {
    "cacheDir": "~/.mcoda/cache",
    "jobsDir": ".mcoda/jobs"
  }
}
```

Key properties:

* `db.path` points at the **global DB** (`~/.mcoda/mcoda.db`).

* `velocity.*Default` expresses the **baseline** SP/h; actual values evolve based on recent task histories (Section 18).

* `updates.*` governs opt‑in update checks and the release channel (e.g. `stable`).

* `paths.jobsDir` is relative to each workspace root and normally resolves to `<workspace>/.mcoda/jobs`.

**Workspace config (`<workspace>/.mcoda/config.json`) – example**

```json
{
  "docdex": {
    "projectId": "platform-x-service-a"
  },
  "vcs": {
    "baseBranch": "mcoda-dev",
    "taskBranchPattern": "mcoda/{projectKey}/{taskKey}-{slugTitle}"
  },
  "qaProfiles": [
    {
      "name": "unit",
      "testCommand": "npm test -- --runTestsByPath",
      "default": true,
      "matcher": { "task_types": ["dev"] }
    },
    {
      "name": "integration",
      "testCommand": "npm run e2e",
      "matcher": { "tags": ["integration"] }
    },
    {
      "name": "mobile-acceptance",
      "testCommand": "mcoda-qa-maestro run ./flows",
      "matcher": { "tags": ["mobile"] }
    }
  ]
}
```

Workspace config:

* Overrides **docdex project** and QA behavior without changing global defaults.

* Defines the deterministic **task branch naming pattern** used by `work-on-tasks` (must include `mcoda` and be stable across reruns).

* Must not contain secrets; these live only in the encrypted tables of `~/.mcoda/mcoda.db`.

All config schemas are versioned implicitly by OpenAPI; the config loader validates keys/types and surfaces clear errors on invalid or unknown fields.

---

#### **21.1.3 Environment variables** {#21.1.3-environment-variables}

Environment variables provide **fast overrides**, primarily for CI and temporary runs; they are not the primary configuration or secret store.

Supported variables include:

* `MCODA_CONFIG` – path to a specific global config file (overrides the default `~/.mcoda/config.json`).

* `MCODA_DB_PATH` – overrides `db.path` for this process.

* `MCODA_WORKSPACE` – overrides workspace resolution (path or logical ID).

* `MCODA_AGENT` – default agent alias for this process (if no `--agent` and no workspace default).

* `MCODA_DOCDEX_BASE_URL`, `MCODA_DOCDEX_PROJECT_ID` – override docdex routing for this run.

* `MCODA_LOG_LEVEL` – logging verbosity.

* `MCODA_JOBS_DIR`, `MCODA_CACHE_DIR` – override job and cache directories (useful in CI).

* `MCODA_TOKEN_BUDGETS` – JSON string to override telemetry budgets for advanced automation.

* Standard network envs: `HTTP_PROXY`, `HTTPS_PROXY`, `SSL_CERT_FILE` (applied to docdex/LLM/VCS HTTP clients).

Rules:

* Secrets (provider API keys, docdex keys, etc.) may be supplied via env *inputs* in CI or bootstrap flows, but persistent storage is always in the encrypted tables of `~/.mcoda/mcoda.db`.

* The runtime never silently persists env‑provided secrets into the DB; users must explicitly run `mcoda agent add` or equivalent flows.

* For any given setting, the final value is resolved as:

   `CLI flag / request field > environment variable > workspace config > global config > built‑in default`.

---

### **21.2 Workspace Resolution & Multi‑workspace Support** {#21.2-workspace-resolution-&-multi‑workspace-support}

Workspaces are the primary unit of organization. A workspace corresponds to a directory tree rooted at a VCS checkout (typically a Git repo) and has its own `<workspace>/.mcoda/` folder containing workspace‑local DB, config and runtime artifacts.

The system maintains **two SQLite databases**:

* **Global DB:** `~/.mcoda/mcoda.db` – global configuration, agent registry, encrypted credentials, global usage aggregates and defaults.

* **Workspace DB:** `<workspace>/.mcoda/mcoda.db` – workspace‑scoped projects, epics, stories, tasks, runs, logs, comments, and per‑action token usage.

The workspace `.mcoda` folder is created on first use and **must be added to the workspace’s `.gitignore`**; all runtime artifacts (DB, jobs, logs, generated docs, local prompts, caches) are treated as implementation details and must not be committed.

---

#### **21.2.1 Workspace identity & layout** {#21.2.1-workspace-identity-&-layout}

Each workspace has:

* A **root directory** (where `.mcoda/` lives).

* A **stable workspace ID** (usually a UUID).

* Optional metadata (name, description).

`<workspace>/.mcoda/` typically contains:

* `mcoda.db` – workspace DB.

* `config.json` – workspace config (if present).

* `workspace.json` – identity and metadata (ID, name, createdAt).

* `jobs/` – per‑job checkpoint and logs.

* `logs/` – workspace‑scoped logs.

* `prompts/` – workspace‑specific prompt overrides (optional).

The workspace ID is used in the **global DB** to scope routing rules and defaults (e.g. `workspace_defaults.workspace_id`, `routing_rules.workspace_id`), with a `__GLOBAL__` sentinel representing machine‑wide defaults.

When a workspace is initialized, mcoda:

1. Ensures `<workspace>/.mcoda/` exists.

2. Creates `workspace.json` if missing.

3. Ensures `.mcoda` is present in `.gitignore` at the repo root (appending if needed).

---

#### **21.2.2 Workspace resolution algorithm** {#21.2.2-workspace-resolution-algorithm}

The `WorkspaceResolver` implements:

```ts
resolveWorkspace({ cwd, explicitWorkspace?: string }): WorkspaceContext
```

Algorithm:

1. **If `explicitWorkspace` is provided**

   * If it looks like a path:

     * Resolve the path.

     * Search upward for `.mcoda/workspace.json`.

     * If found, load and return it.

     * If not found, treat that path as workspace root, create `.mcoda/` and a fresh `workspace.json`.

   * If it looks like an ID:

     * Look up a known workspace registry (future enhancement) or error if unknown.

2. **Else (CLI based on `cwd`)**

   * Walk upward from `cwd`:

     * if `.mcoda/workspace.json` is found → load & return.

   * If none found:

     * If a VCS root (`.git`) exists above:

       * treat the VCS root as workspace root, create `.mcoda` and `workspace.json` there if needed.

     * Else:

       * treat current directory as workspace root and create `.mcoda` there if needed.

3. **WorkspaceContext**

```ts
interface WorkspaceContext {
  id: string;        // workspace_id
  rootDir: string;
  configPath: string; // <root>/.mcoda/config.json (if present)
  jobsDir: string;    // default <root>/.mcoda/jobs or override
  cacheDir: string;   // global or workspace-specific cache
  workspaceDbPath: string; // <root>/.mcoda/mcoda.db
  globalDbPath: string;    // ~/.mcoda/mcoda.db
}
```

This context is passed into the config, DB, routing and job services so that each command consistently uses the same workspace and DB locations.

---

#### **21.2.3 Multi‑workspace behavior** {#21.2.3-multi‑workspace-behavior}

Key properties:

* **Two‑tier DB isolation**

  * Global DB (`~/.mcoda/mcoda.db`) holds **only** global configuration, agents, credentials and aggregate telemetry; it must never contain workspace‑level task state.

  * Workspace DB (`<workspace>/.mcoda/mcoda.db`) holds **only** workspace tasks, runs/logs, comments and token usage; it must never contain global credentials or cross‑workspace config.

* **Independent defaults & routing per workspace**

  * Each workspace has its own defaults and routing rules scoped by `workspace_id`, with `__GLOBAL__` as fallback.

* **Command behavior**

  * All task‑oriented commands (`create-tasks`, `refine-tasks`, `work-on-tasks`, `code-review`, `qa-tasks`) first resolve the workspace and then operate against the corresponding workspace DB.

  * Agent selection uses the standard chain: `--agent` override → workspace default → global default; any failure to resolve an eligible agent results in a hard error, not a silent fallback.

* **Multi‑repo / mono‑repo setups**

  * Multiple repos can share a single workspace if `MCODA_WORKSPACE` points at a higher‑level directory.

  * Large mono‑repos can host multiple nested workspaces; the resolver always chooses the **nearest** `.mcoda/workspace.json` above `cwd`.

---

### **21.3 Plugin & Adapter Extensions** {#21.3-plugin-&-adapter-extensions}

mcoda is explicitly agent / model / adapter agnostic. Extensibility is provided by:

* **Agent adapters** (LLM and tool providers).

* **QA adapters** (e.g. Chromium, Maestro).

* **Doc providers** (docdex; additional providers are future‑compatible but must follow the same OpenAPI \+ docdex model).

OpenAPI is the **single extension contract**: commands, job types, DB tables and adapter capabilities are all described via OpenAPI metadata (`x-mcoda-*` extensions).

---

#### **21.3.1 Adapter & provider extensions** {#21.3.1-adapter-&-provider-extensions}

Adapter architecture:

* mcoda uses an `AgentAdapter` interface with operations like `ensureInstalled`, `ensureAuthed`, `ping`, `listModels`, `invoke`, `invokeStream`, `capabilities`.

* Built‑in adapters (implemented under `@mcoda/agents`) cover:

  * LLM providers (OpenAI, Anthropic, Gemini, Ollama, etc.).

  * Non‑LLM tools such as browser automation (Chromium) and mobile test runners (Maestro).

External adapters:

* Shipped as npm packages or local modules that implement the adapter interface.

* Registered via config, for example:

```json
{
  "plugins": {
    "adapters": [
      {
        "name": "my-company-llm",
        "module": "mcoda-adapter-my-company",
        "factoryExport": "createAdapter"
      }
    ]
  }
}
```

At startup, adapter modules are loaded, validated against the OpenAPI‑defined capability schema, and registered in the adapter registry; no core code changes are needed to add a new provider.

---

#### **21.3.2 QA and docdex extensions** {#21.3.2-qa-and-docdex-extensions}

**QA adapters**

* QA tools (Chromium, Maestro, etc.) are exposed via QA‑oriented adapters that implement a standard interface (e.g. `runScenario`, `collectArtifacts`, `capabilities`).

* QA adapters are configured per workspace via `qaProfiles` in `.mcoda/config.json` and discovered either as built‑ins or via plugins.

**docdex integration**

* docdex is the **only** supported doc provider in v0.3; local indexers are explicitly out of scope.

* Future doc providers must implement a `DocContextProvider` interface but still respect the “remote service” model—no ad‑hoc local embeddings or indexes.

For both QA and doc providers, OpenAPI defines:

* Operation shapes (inputs/outputs).

* Required capabilities and permissions.

* How token usage and command runs are recorded (e.g. `x-mcoda-job-type`, `x-mcoda-cli`).

---

#### **21.3.3 Command & feature extension points (v1 scope)** {#21.3.3-command-&-feature-extension-points-(v1-scope)}

v1 of mcoda does **not** allow arbitrary third‑party commands to directly extend the CLI surface, but it does support:

* **Configuration‑driven extensions**

  * QA profiles (`qaProfiles`) to add new test runners without code changes.

  * Telemetry budgets (`telemetry.budgets`) to tune token usage policies.

* **Adapter plugins**

  * New providers, QA tools, or doc providers can be added via adapter plugins as described above; core commands remain unchanged and drive everything through the OpenAPI‑defined interfaces.

* **Future command plugins (reserved)**

  * The SDS reserves the possibility of “command descriptors” that declare CLI name, flags and backing OpenAPI operations. These would be discovered and mounted by the CLI using the same OpenAPI client as built‑in commands.

Plugins run in‑process but are explicitly loaded, declare their capabilities and (in future) permissions; misbehaving plugins can be disabled per workspace or globally without affecting core functionality.

22. Implementation Plan & Milestones

---

This section defines a greenfield delivery plan for mcoda, from an empty repository to a mature, multi‑agent, QA‑aware CLI shipped as an npm package. Phases are incremental and shippable; later phases build strictly on earlier ones without changing core invariants (OpenAPI as source of truth, DB‑driven state, .mcoda layout, global vs workspace DBs).

### **22.1 Phase Breakdown (MVP → Parity → Advanced Features)** {#22.1-phase-breakdown-(mvp-→-parity-→-advanced-features)}

We structure delivery into a small Phase 0 plus three major phases:

* **Phase 0 – Foundations & Skeleton**  
   Repo, DB, config, OpenAPI, global/workspace layout, secrets, prompts, and basic agent wiring.

* **Phase 1 – MVP (single project, single agent)**  
   End‑to‑end task creation \+ implementation with persisted token usage and jobs.

* **Phase 2 – Full Workflow & Productization**  
   Complete create → refine → work → review → QA pipeline, comments/logs, dependency ordering, prompts, update flow.

* **Phase 3 – Advanced Features & Optimization**  
   Learned SP/hour, deeper telemetry, advanced QA, routing, and hardened npm distribution.

#### **22.1.1 Phase 0 – Foundations & Skeleton** {#22.1.1-phase-0-–-foundations-&-skeleton}

**Scope**

* **Repo & project skeleton**

  * TypeScript monorepo layout (CLI \+ library).

  * Core folder structure for:

    * `cli/` – commands and argument parsing.

    * `core/` – command orchestration, job engine, SP/hour calculations, update checks.

    * `db/` – SQLite wrappers, migrations, repositories.

    * `agents/` – global agent registry, adapters, AgentService abstraction.

    * `integrations/` – docdex, VCS, QA adapters, issue trackers.

    * `config/` – global vs workspace config resolution.

  * CI pipeline wired to:

    * run lint \+ unit tests on every push,

    * build the CLI,

    * on `v*` tags, run an **npm packaging job** (`npm pack`, publish step in **dry‑run** mode initially).

* **Global & workspace storage**

  * Establish `~/.mcoda/` as the **global root**:

    * `~/.mcoda/mcoda.db` – **single global SQLite DB** for agents, credentials, global defaults, routing rules, releases metadata.

    * `~/.mcoda/logs/` – optional global logs.

    * `~/.mcoda/releases.json` (or similar) – release metadata consumed by update checks.

  * Workspace bootstrap:

    * On first run in a repo, create `<repo>/.mcoda/`.

    * Append `.mcoda/` to `.gitignore` if missing.

    * Create a workspace config stub, e.g. `<repo>/.mcoda/config.json`.

    * Create a **workspace SQLite DB** at `<repo>/.mcoda/mcoda.db` for **local project/task state only**.

* **DB & migration scaffolding**

  * Shared SQLite wrapper with:

    * migration runner,

    * PRAGMA configuration (foreign keys on, WAL mode, etc.),

    * basic health checks.

  * Initial migrations:

    * **Global DB (`~/.mcoda/mcoda.db`)**

      * `agents`, `agent_auth`, `agent_models`,

      * `workspace_defaults`, `routing_rules`,

      * optional global telemetry tables if needed.

    * **Workspace DB (`<repo>/.mcoda/mcoda.db`)**

      * `projects`, `epics`, `user_stories`, `tasks`,

      * `jobs`,

      * `token_usage`,

      * `task_logs` (per command run, including failures),

      * `task_comments` (agent/human comments attached to tasks, including severity/path).

      * Any required linking fields: `workspace_id`, `project_id`, `task_id`, `command_name`, etc.

* **Secrets & security foundation**

  * Design and implement a **SecretsService**:

    * Secrets are stored **only** in encrypted columns in `agent_auth` (and similar global tables).

    * No OS keychain usage at all.

    * Secrets never read from or written to config files.

    * Environment variables only allowed as **short‑lived injection mechanisms** (e.g. CI); persisted storage always in encrypted DB columns.

  * File permissions:

    * `~/.mcoda/` and `~/.mcoda/mcoda.db` created with user‑only permissions by default.

* **OpenAPI baseline**

  * Initial spec (`openapi/mcoda.yaml`) covering:

    * Agents, Projects, Epics, UserStories, Tasks, Jobs, TokenUsage,

    * minimal config and telemetry endpoints,

    * basic command/run resources (e.g. `jobs`, `task_logs`).

  * Codegen → TypeScript client & DTOs wired into CLI and core runtime.

  * Initial CI checks:

    * spec validation,

    * generated client compilation.

* **Multi‑agent core (skeleton)**

  * Integrate adapter layer with:

    * global agents (scoped to `__GLOBAL__`),

    * workspace defaults via `workspace_defaults` referencing global agents.

  * `AgentService` abstraction with:

    * `invoke`, `listModels`, `ping`,

    * simple health status and capability metadata.

* **Prompt loading foundation**

  * Establish prompt layout and loader:

    * per‑agent **job description** prompt file,

    * per‑agent **character** prompt file,

    * per‑command prompt snippets (e.g. `create-tasks`, `refine-tasks`, `work-on-tasks`, `code-review`, `qa-tasks`, SDS/docs flows).

  * Resolution rules:

    * global prompt root: `~/.mcoda/prompts/`,

    * workspace overrides: `<repo>/.mcoda/prompts/`,

    * deterministic search order: workspace → global → built‑in defaults.

* **Minimal CLI surface**

  * `mcoda --help`, `mcoda --version`, diagnostics.

  * Agent commands (skeleton):

    * `mcoda agent add`,

    * `mcoda agent list`,

    * `mcoda agent use` (workspace default).

  * **`mcoda test-agent <name>`**:

    * loads agent credentials from encrypted DB,

    * sends a trivial prompt (“What is 2+2?”),

    * reports connectivity, latency, and basic model info.

**Exit criteria (Phase 0\)**

* `mcoda --help` works and shows core commands (some may be “not implemented yet”).

* Running migrations on a fresh checkout produces:

  * a valid `~/.mcoda/mcoda.db` with global tables, and

  * a valid `<repo>/.mcoda/mcoda.db` for a sample workspace.

* At least one real agent adapter (e.g. OpenAI) can be:

  * registered via `mcoda agent add`,

  * stored encrypted in `agent_auth`,

  * successfully pinged via `mcoda test-agent`.

* CI builds the CLI and performs an npm packaging dry‑run on `v*` tags.

#### **22.1.2 Phase 1 – MVP (Self‑hosted Task System, Single Agent)** {#22.1.2-phase-1-–-mvp-(self‑hosted-task-system,-single-agent)}

**Goal**

Provide an end‑to‑end flow for a single agent and single project/workspace, with docdex integration, persisted token usage, jobs/checkpoints, and per‑run logs, but without the full review/QA/multi‑agent feature set.

**Scope**

* **Core domain \+ DB (MVP)**

  * Workspace DB (`<repo>/.mcoda/mcoda.db`) includes:

    * `projects`, `epics`, `user_stories`, `tasks`,

    * `jobs`,

    * `token_usage`,

    * `task_logs` (per command run, including failures),

    * minimal `task_comments` schema (task‑scoped comments, even before full code review/QA exist).

  * Basic task state machine, including `ready_to_review` and `ready_to_qa`.

  * All rows linked to `workspace_id` and `project_id`.

* **Docdex integration**

  * Configurable docdex base URL and project ID via config.

  * Typed client for:

    * fetching RFP/PDR/SDS fragments,

    * retrieving per‑task context.

  * Simple in‑process caching to avoid repeated docdex calls within a single job.

* **Commands (MVP subset)**

  * `mcoda create-tasks`

    * Inputs: RFP \+ optional PDR/SDS identifiers (via docdex).

    * Output: epics, user stories, tasks with story point estimates persisted.

    * Uses:

      * per‑command prompts \+ agent job/character prompts,

      * docdex context assembly,

      * `token_usage` instrumentation.

  * `mcoda work-on-tasks` (minimal)

    * Selects tasks in `not_started` or `in_progress`.

    * Creates/checks out **deterministic per‑task branches** (including “mcoda” in the name).

    * Applies small, targeted patches from the agent.

    * Transitions `in_progress → ready_to_review` on success.

    * Writes detailed entries to `task_logs` for each run.

  * `mcoda backlog`

    * Basic SP summaries per project/epic/story.

    * Simple filters by status/epic/story.

  * Agent management (single‑agent, global)

    * `mcoda agent add <name>`: prompts for API key, stores encrypted in global DB.

    * `mcoda agent list`, `mcoda agent auth-status`, `mcoda agent use` (workspace default).

    * `mcoda test-agent <name>` fully wired through SecretsService and adapter.

* **Token telemetry (basic)**

  * `token_usage` rows per LLM action with:

    * `command_name`, `job_id`, `task_id`, `workspace_id`, `project_id`, `agent_id`, `model`,

    * prompt/completion/total token counts and derived cost.

  * `mcoda tokens --project ... --group-by command` for quick inspection.

* **Jobs & resumability (basic)**

  * `jobs` table \+ checkpoint files under `<repo>/.mcoda/jobs/<job_id>/...`.

  * `create-tasks` and `work-on-tasks` run as jobs with:

    * last processed epic/story/task index in the checkpoint.

  * `mcoda job list`, `mcoda job inspect`, `mcoda job resume` (simple flows).

**Exit criteria (Phase 1\)**

For a single real project:

* `mcoda create-tasks` produces a usable backlog (epics/stories/tasks with SP).

* `mcoda work-on-tasks`:

  * creates deterministic `mcoda-...` branches,

  * modifies the repo safely,

  * moves tasks to `ready_to_review`.

* `mcoda backlog` reports SP totals correctly.

* `mcoda tokens` shows token usage per command.

* Killing `create-tasks` mid‑run and resuming via `mcoda job resume` completes without duplication or corruption.

#### **22.1.3 Phase 2 – Full Workflow & Productization** {#22.1.3-phase-2-–-full-workflow-&-productization}

**Goal**

Deliver the full mcoda pipeline (create → refine → work → review → QA), structured comments and logs, dependency‑aware task ordering, prompt discipline across commands, and a usable update flow, making mcoda a production‑ready CLI for real teams.

**Scope**

* **Command coverage & workflows**

  * `mcoda refine-tasks`

    * Enrichment, splitting/merging, tagging, SP adjustments.

    * Uses command‑specific prompts and docdex context.

    * Can read/write `task_comments` to capture clarifications or refinements.

  * `mcoda work-on-tasks` (full workflow)

    * Workflow steps:

      * load agent \+ prompts (job description \+ character \+ command‑specific),

      * commit or stash dirty repo if necessary,

      * checkout `mcoda-dev` base branch (configurable),

      * checkout or create deterministic task branch (`mcoda/<task-key-or-id>...`),

      * apply code and documentation changes,

      * optionally run lightweight local tests,

      * commit changes on the task branch,

      * push task branch to remote,

      * merge into `mcoda-dev` on success,

      * push `mcoda-dev` to remote,

      * log the entire run into `task_logs` (including VCS actions and errors).

    * Deterministic branch naming per task so re‑runs reuse the same branch.

  * `mcoda code-review`

    * Ingests diffs per task/branch.

    * Uses docdex \+ SDS context \+ task history.

    * Writes structured review comments into `task_comments`:

      * per task,

      * per file/path,

      * with severity and reviewer (agent/human).

    * Transitions `ready_to_review → ready_to_qa` or reopens tasks to `in_progress`.

  * `mcoda qa-tasks`

    * Uses QA profiles and QA adapters (e.g. Chromium, Maestro) configured per workspace.

    * An agent orchestrates:

      * choosing QA profile,

      * running QA tools,

      * interpreting logs/results,

      * writing QA outcomes into both `task_comments` and `task_logs`.

    * Transitions `ready_to_qa → completed` or reopens/blocks tasks.

  * `mcoda estimate`

    * Uses story points \+ SP/hour baselines,

    * starts logging per‑stage throughput (implementation/review/QA) from history (still baseline‑driven in this phase).

  * Backlog & dependency‑aware ordering

    * Either via flags on `mcoda backlog` or a dedicated `mcoda order-tasks` / `mcoda tasks order-by-dependencies` command:

      * reorders tasks using dependency graph,

      * prioritizes tasks that are most depended on.

  * Task inspection

    * `mcoda task-detail` / `mcoda task show <task-key>`:

      * prints full task metadata, hierarchy, state,

      * associated comments and logs,

      * branch/PR mapping (where configured).

* **Multi‑agent support**

  * Full integration with global registry & routing:

    * workspace defaults reference **global** agents only,

    * `--agent` overrides respected everywhere.

  * Health‑ and capability‑aware routing (e.g. choose cheaper models for backlog/estimate).

* **Prompt discipline**

  * Systematic prompts for:

    * each command (create/refine/work/review/qa),

    * each agent’s job description and character.

  * Prompts checked into well‑known locations:

    * global under `~/.mcoda/prompts/`,

    * optional overrides under `<repo>/.mcoda/prompts/`,

    * referenced by jobs and reused across runs.

* **Jobs & checkpointing (full)**

  * All long‑running commands:

    * `create-tasks`, `refine-tasks`, `work-on-tasks`, `code-review`, `qa-tasks`, and documentation generation flows:

      * record progress via jobs \+ disk checkpoints,

      * emit `task_logs` entries per command run,

      * can be resumed cleanly from partial runs.

* **Update flow (baseline)**

  * On manual CLI runs:

    * optional “check for newer version” using `~/.mcoda/releases.json` or equivalent,

    * prompt user when an update is available.

  * `mcoda update`:

    * runs an npm‑based self‑update (`npm install -g mcoda@latest` equivalent, or prints the command),

    * records last update check time in global state.

**Exit criteria (Phase 2\)**

* Real projects can run the full pipeline:

  * `create-tasks → refine-tasks → work-on-tasks → code-review → qa-tasks`,

  * with code & docs updated safely via deterministic mcoda branches.

* `task_comments` contains structured review and QA comments, linked to tasks and files.

* `task_logs` provides enough history for agents and humans to understand previous runs on re‑runs.

* Update checks and `mcoda update` work reliably on the primary environments (Node LTS, Linux/macOS).

* Dependency‑aware ordering and task detail commands are usable on non‑trivial backlogs.

#### **22.1.4 Phase 3 – Advanced Features & Optimization** {#22.1.4-phase-3-–-advanced-features-&-optimization}

**Goal**

Leverage telemetry, dependency data, and multi‑agent features to optimize throughput, cost, and experience, while hardening npm distribution and update flows.

**Scope (not all required for first GA)**

* **Learned velocities & SP/hour refinement**

  * Replace static 15 SP/hour baselines with empirically learned SP/hour per stage and per command:

    * maintain sliding windows (e.g. last 10/20/50 completed tasks) per:

      * implementation (`work-on-tasks`),

      * review (`code-review`),

      * QA (`qa-tasks`).

  * Integrate learned values into:

    * `mcoda estimate`,

    * backlog views,

    * dashboards/JSON APIs.

* **Deeper telemetry**

  * Queryable dashboards and CLI APIs for:

    * token usage per command/agent/model,

    * SP throughput per stage,

    * failure rates by command/agent.

  * CLI/JSON outputs that answer:

    * “Which agent/model is best for this job type?”,

    * “What are we spending per epic/project per month?”.

* **Advanced QA & extensions**

  * Richer orchestration of QA extensions:

    * multi‑step browser flows,

    * multi‑device mobile flows (e.g. Maestro).

  * Agent guidance for:

    * choosing QA profiles and extensions,

    * capturing artifacts (screenshots, videos, logs),

    * attaching artifacts to tasks and comments.

* **Routing & plugins**

  * Router rules \+ `--explain-routing` surfaces.

  * Optional plugin/adaptor extensions driven from OpenAPI:

    * additional providers,

    * optional command plugins using the core client.

* **Update & distribution improvements**

  * Multiple release channels (e.g. stable, beta).

  * Hardened CI for distribution:

    * **automated npm publish on `v*` tags** with pre‑publish e2e gates,

    * smoke tests of `mcoda update` flows across supported OSes.

**Exit criteria (Phase 3\)**

* Estimates reliably reflect recent throughput (learned SP/hour).

* Telemetry and routing can answer key optimization questions for real workloads.

* Advanced QA flows (browser/mobile) run stably under real‑world usage.

* npm publish \+ `mcoda update` flows are stable across the supported CI matrix.

---

### **22.2 Risk Analysis & Mitigation Strategies** {#22.2-risk-analysis-&-mitigation-strategies}

#### **22.2.1 Technical risks** {#22.2.1-technical-risks}

**OpenAPI ↔ code drift**

* **Risk**: OpenAPI spec becomes outdated; code diverges; commands behave differently than documented.

* **Mitigations**:

  * OpenAPI → generated TS types for all DTOs; no hand‑rolled DTOs.

  * Single shared client library used by CLI and services.

  * CI:

    * fails on schema change without regenerated client,

    * enforces “spec‑first” workflow: change OpenAPI, regenerate, then implement.

**DB migrations & data loss (global vs workspace)**

* **Risk**: schema evolution across mcoda versions breaks existing data or causes global/workspace DB desync.

* **Mitigations**:

  * Versioned migrations tested using fixture DBs (global and workspace):

    * old fixture → migrate → validate invariants.

  * `db-validate` style checks in CI and optional CLI:

    * foreign key checks,

    * schema version consistency between OpenAPI and DB,

    * presence of critical tables (`tasks`, `token_usage`, `task_logs`, `task_comments`).

  * Clear backup guidance on schema upgrades (CLI prints recommendation on breaking changes).

**Job checkpoint corruption**

* **Risk**: partially written checkpoints make `mcoda job resume` fail or misbehave.

* **Mitigations**:

  * Always write checkpoints to `checkpoint.json.tmp` then atomic rename.

  * On resume, validate: `checkpoint_version`, `job_id`, `job_type`, `project_id`, `workspace_id`; fall back to partial restart if mismatch.

  * Jobs remain idempotent at epic/story/task boundaries.

**docdex dependency**

* **Risk**: docdex downtime blocks task/doc flows.

* **Mitigations**:

  * Clear error codes and messages when docdex is unreachable.

  * Optional explicit “reduced context” mode (flag) that allows degraded operation and emits strong warnings.

  * Short‑term caching for docdex snippets with TTL to reduce repeated calls.

**Multi‑agent & routing complexity**

* **Risk**: routing becomes opaque; misconfigurations cause unexpected agent selection.

* **Mitigations**:

  * `--agent` always overrides routing.

  * `--explain-routing` dry‑run mode to inspect routing decisions.

  * Simple defaults in earlier phases (single default agent per workspace) before enabling complex rules.

**Update & distribution issues (npm)**

* **Risk**: broken releases published to npm; `mcoda update` upgrades users to unusable versions.

* **Mitigations**:

  * Pre‑publish e2e test suite on `v*` tags (CLI, DB migrations, basic docdex/agent flows).

  * Staged channels (beta vs stable); `mcoda update` can target stable by default.

  * Ability to pin mcoda version in automation (e.g. via shell wrappers or CI images) while updates are validated.

#### **22.2.2 Product & UX risks** {#22.2.2-product-&-ux-risks}

**Overloaded CLI surface**

* **Risk**: too many commands/flags (`create-tasks`, `refine-tasks`, `work-on-tasks`, `code-review`, `qa-tasks`, tokens, telemetry, jobs, agents, update, etc.) overwhelm users.

* **Mitigations**:

  * Keep command names minimal and stable; prefer subcommands over new verbs.

  * Strong `--help` output with concrete examples per command.

  * Good defaults; flags used only when necessary.

  * Group advanced features in namespaces (e.g. `mcoda telemetry ...`).

**User confusion around pipeline states**

* **Risk**: users do not fully understand the pipeline (`not_started` → `in_progress` → `ready_to_review` → `ready_to_qa` → `completed`/`blocked`), leading to misuse of commands.

* **Mitigations**:

  * Clear pipeline diagrams in docs and SDS.

  * `mcoda backlog` and `mcoda estimate` show counts per state bucket.

  * `mcoda task-detail` prints state history and which command owns which transitions.

#### **22.2.3 Security & secrets risks** {#22.2.3-security-&-secrets-risks}

**Credential leakage**

* **Risk**: logs, checkpoints, or prompts accidentally contain API keys, access tokens, or other secrets.

* **Mitigations**:

  * Central redaction layer for logs and telemetry (field‑level masking for anything that looks like a key/token).

  * No prompts or completions stored in DB; telemetry stores only:

    * usage counts,

    * IDs (jobs, tasks, agents, models),

    * high‑level error codes.

  * Structured logging only; free‑form text minimized and passed through redaction.

**Single‑store secrets (DB‑only)**

* **Risk**: using `~/.mcoda/mcoda.db` as the only persistent store for secrets creates a high‑value file.

* **Mitigations**:

  * Secrets stored only in dedicated **encrypted** columns in `agent_auth` (and similar tables); never in config files or environment variables.

  * Clear separation between:

    * secret columns,

    * non‑secret metadata,  
       enforced at schema and type‑level.

  * Filesystem permissions:

    * `~/.mcoda/` and `mcoda.db` created with user‑only permissions.

    * Docs instruct users to treat this path as sensitive.

  * Rotation & revocation flows:

    * `mcoda agent remove` / re‑add,

    * status transitions for revoked/expired credentials,

    * best‑effort secure deletion at DB level (overwriting secret columns on revoke).

**No keychain / environment fallback**

* **Risk**: without OS keychains, encryption and lifecycle rules are entirely mcoda’s responsibility; users might try to keep keys in env vars or scripts.

* **Mitigations**:

  * No OS keychain integration at all; mcoda never attempts to read/write system keychains.

  * `mcoda agent add`:

    * encourages interactive entry of secrets,

    * if a key is supplied via env var/flag, mcoda warns and still stores it only in the encrypted DB column.

  * Tests and tooling explicitly avoid env‑var‑based secret storage except in controlled CI smoke tests.

  * Documentation:

    * clearly states that the only supported persistent secret store is encrypted data in `mcoda.db`,

    * recommends short‑lived keys and regular rotation.

#### **22.2.4 Performance & cost risks** {#22.2.4-performance-&-cost-risks}

**Unexpected token bills**

* **Risk**: complex flows (e.g. SDS regeneration, large backlogs) trigger too many LLM calls.

* **Mitigations**:

  * Token budgets per project/workspace with warning thresholds.

  * `mcoda tokens` grouped by command/model/agent for visibility.

  * Configurable “plan vs apply” modes (dry runs, smaller batches, sampling).

**Long‑running jobs blocking developer loops**

* **Risk**: large jobs (e.g. whole‑project QA) run too long or hang.

* **Mitigations**:

  * Hard per‑call timeouts and overall job timeouts.

  * Checkpointing & `mcoda job resume` for safe restarts.

  * `--limit` flags (e.g. max tasks per run) on long‑running commands.

**QA adapter overhead**

* **Risk**: external QA tools (Chromium, Maestro) are slow or flaky, impacting usability.

* **Mitigations**:

  * Separate QA profiles with clear cost/performance expectations.

  * Ability to run QA in smaller batches or manual mode.

  * Graceful fallbacks when QA adapters are unavailable (logging and explicit errors rather than silent failure).

---

### **22.3 Testing Strategy & CI Matrix** {#22.3-testing-strategy-&-ci-matrix}

#### **22.3.1 Test layers** {#22.3.1-test-layers}

**Unit tests**

* Pure TypeScript modules, including:

  * DB repositories & query builders (workspace \+ global DBs):

    * `tasks`, `jobs`, `token_usage`, `task_logs`, `task_comments`,

    * `agents`, `agent_auth`, `workspace_defaults`, `routing_rules`.

  * Task state machine transitions and dependency‑ordering logic.

  * Routing & capability checks in the agent layer.

  * Config & workspace resolution (`~/.mcoda` vs `<repo>/.mcoda`).

  * SecretsService:

    * encryption/decryption round‑trip,

    * guarantees that secrets do not appear in logs or telemetry.

  * Prompt loader:

    * global vs workspace resolution precedence,

    * missing/invalid prompt handling.

  * Branch naming helpers for deterministic `mcoda/...` branches.

**Contract & schema tests**

* OpenAPI schema vs generated TS:

  * validate spec via OpenAPI tools,

  * snapshot TS types for request/response DTOs.

* DB migrations:

  * for both global and workspace DBs:

    * fixture DB → migrate → `PRAGMA foreign_key_check`,

    * invariant checks (presence of `token_usage`, `task_logs`, `task_comments`, etc.).

  * Ensure global/workspace schemas align with OpenAPI’s schema definitions.

**Integration tests**

* SQLite against real temp files (global \+ workspace).

* Multi‑agent stub providers:

  * deterministic adapters simulating LLM calls for different models.

* docdex stubs:

  * simulate RFP/PDR/SDS searches and responses.

* QA adapter stubs:

  * fake Chromium/Maestro adapters to test `qa-tasks` orchestration and error handling.

* Integration flows for:

  * `create-tasks`, `refine-tasks`, `work-on-tasks`, `code-review`, `qa-tasks` using stubs,

  * `task_comments` and `task_logs` written correctly per run,

  * update metadata read from `~/.mcoda/releases.json`.

**End‑to‑end CLI tests**

* Spawn `mcoda` in a temp workspace:

  * initialize workspace (`.mcoda` creation, `.gitignore` updates),

  * configure stub agent via `mcoda agent add/use/test-agent`.

* Run full pipelines:

  * `create-tasks → refine-tasks → work-on-tasks → code-review → qa-tasks`,

  * verify:

    * workspace DB state (tasks, jobs, token\_usage, task\_comments, task\_logs),

    * git branch behavior (deterministic `mcoda/...` branches),

    * state transitions.

* Crash/resume tests:

  * simulate failure mid‑job,

  * validate `mcoda job resume` completes without duplication.

* Update flow tests (where feasible):

  * exercise “check for newer version” logic against a local `releases.json`,

  * verify `mcoda update` prints or executes the expected npm command in a controlled environment.

**Non‑functional tests**

* Performance:

  * seed DB with hundreds/thousands of tasks,

  * ensure backlog/estimate/tokens queries complete under target latency.

* Telemetry:

  * ensure every agent call generates `token_usage` rows with correct attribution.

* Memory footprint:

  * spot‑check long jobs for leaks (especially QA flows using external tools).

#### **22.3.2 CI matrix** {#22.3.2-ci-matrix}

**Platforms**

* OS:

  * Linux (primary, required for all jobs),

  * macOS (recommended; required for at least smoke \+ e2e),

  * Windows (optional; at minimum run a small smoke suite).

* Node:

  * LTS (e.g. 20.x) – required, full test suite,

  * latest stable (e.g. 22.x) – smoke tests.

**Job layout**

* `lint+typecheck`

  * ESLint, formatting, TypeScript type‑checking.

* `unit`

  * All unit tests (no network, no external tools).

* `integration`

  * DB \+ adapter stubs \+ docdex/QA stubs.

* `e2e-cli`

  * Limited but representative scenarios:

    * workspace bootstrap,

    * create/refine/work/review/qa pipeline,

    * jobs \+ resume,

    * token/telemetry commands.

  * Run on main branch and PRs labeled `e2e`.

* `package` / `publish-dry-run`

  * On main and `v*` tags:

    * build CLI,

    * run `npm pack`,

    * on `v*` tags, run **gated** `npm publish` (actual publish only after all tests pass).

* `optional-live-smoke`

  * Only when explicit env vars (e.g. `MCODA_LIVE_OPENAI_KEY`, docdex test URL) are set:

    * smoke tests against real providers and QA tools,

    * sanity check `mcoda update` in a controlled environment.

  * Never required for PR merge.

**Artifacts**

* Sample `mcoda.db` (global \+ workspace) after migration tests.

* Logs for job/resume failures and QA runs (for debugging).

* Packaged artifacts (`.tgz` from `npm pack`) for inspection or manual installation during review.

* Implementation Plan & Milestones

---

This section defines a greenfield delivery plan for mcoda, from an empty repository to a mature, multi‑agent, QA‑aware CLI shipped as an npm package. Phases are incremental and shippable; later phases build strictly on earlier ones without changing core invariants (OpenAPI as source of truth, DB‑driven state, .mcoda layout, global vs workspace DBs).

### **22.1 Phase Breakdown (MVP → Parity → Advanced Features)** {#22.1-phase-breakdown-(mvp-→-parity-→-advanced-features)-1}

We structure delivery into a small Phase 0 plus three major phases:

* **Phase 0 – Foundations & Skeleton**  
   Repo, DB, config, OpenAPI, global/workspace layout, secrets, prompts, and basic agent wiring.

* **Phase 1 – MVP (single project, single agent)**  
   End‑to‑end task creation \+ implementation with persisted token usage and jobs.

* **Phase 2 – Full Workflow & Productization**  
   Complete create → refine → work → review → QA pipeline, comments/logs, dependency ordering, prompts, update flow.

* **Phase 3 – Advanced Features & Optimization**  
   Learned SP/hour, deeper telemetry, advanced QA, routing, and hardened npm distribution.

#### **22.1.1 Phase 0 – Foundations & Skeleton** {#22.1.1-phase-0-–-foundations-&-skeleton-1}

**Scope**

* **Repo & project skeleton**

  * TypeScript monorepo layout (CLI \+ library).

  * Core folder structure for:

    * `cli/` – commands and argument parsing.

    * `core/` – command orchestration, job engine, SP/hour calculations, update checks.

    * `db/` – SQLite wrappers, migrations, repositories.

    * `agents/` – global agent registry, adapters, AgentService abstraction.

    * `integrations/` – docdex, VCS, QA adapters, issue trackers.

    * `config/` – global vs workspace config resolution.

  * CI pipeline wired to:

    * run lint \+ unit tests on every push,

    * build the CLI,

    * on `v*` tags, run an **npm packaging job** (`npm pack`, publish step in **dry‑run** mode initially).

* **Global & workspace storage**

  * Establish `~/.mcoda/` as the **global root**:

    * `~/.mcoda/mcoda.db` – **single global SQLite DB** for agents, credentials, global defaults, routing rules, releases metadata.

    * `~/.mcoda/logs/` – optional global logs.

    * `~/.mcoda/releases.json` (or similar) – release metadata consumed by update checks.

  * Workspace bootstrap:

    * On first run in a repo, create `<repo>/.mcoda/`.

    * Append `.mcoda/` to `.gitignore` if missing.

    * Create a workspace config stub, e.g. `<repo>/.mcoda/config.json`.

    * Create a **workspace SQLite DB** at `<repo>/.mcoda/mcoda.db` for **local project/task state only**.

* **DB & migration scaffolding**

  * Shared SQLite wrapper with:

    * migration runner,

    * PRAGMA configuration (foreign keys on, WAL mode, etc.),

    * basic health checks.

  * Initial migrations:

    * **Global DB (`~/.mcoda/mcoda.db`)**

      * `agents`, `agent_auth`, `agent_models`,

      * `workspace_defaults`, `routing_rules`,

      * optional global telemetry tables if needed.

    * **Workspace DB (`<repo>/.mcoda/mcoda.db`)**

      * `projects`, `epics`, `user_stories`, `tasks`,

      * `jobs`,

      * `token_usage`,

      * `task_logs` (per command run, including failures),

      * `task_comments` (agent/human comments attached to tasks, including severity/path).

      * Any required linking fields: `workspace_id`, `project_id`, `task_id`, `command_name`, etc.

* **Secrets & security foundation**

  * Design and implement a **SecretsService**:

    * Secrets are stored **only** in encrypted columns in `agent_auth` (and similar global tables).

    * No OS keychain usage at all.

    * Secrets never read from or written to config files.

    * Environment variables only allowed as **short‑lived injection mechanisms** (e.g. CI); persisted storage always in encrypted DB columns.

  * File permissions:

    * `~/.mcoda/` and `~/.mcoda/mcoda.db` created with user‑only permissions by default.

* **OpenAPI baseline**

  * Initial spec (`openapi/mcoda.yaml`) covering:

    * Agents, Projects, Epics, UserStories, Tasks, Jobs, TokenUsage,

    * minimal config and telemetry endpoints,

    * basic command/run resources (e.g. `jobs`, `task_logs`).

  * Codegen → TypeScript client & DTOs wired into CLI and core runtime.

  * Initial CI checks:

    * spec validation,

    * generated client compilation.

* **Multi‑agent core (skeleton)**

  * Integrate adapter layer with:

    * global agents (scoped to `__GLOBAL__`),

    * workspace defaults via `workspace_defaults` referencing global agents.

  * `AgentService` abstraction with:

    * `invoke`, `listModels`, `ping`,

    * simple health status and capability metadata.

* **Prompt loading foundation**

  * Establish prompt layout and loader:

    * per‑agent **job description** prompt file,

    * per‑agent **character** prompt file,

    * per‑command prompt snippets (e.g. `create-tasks`, `refine-tasks`, `work-on-tasks`, `code-review`, `qa-tasks`, SDS/docs flows).

  * Resolution rules:

    * global prompt root: `~/.mcoda/prompts/`,

    * workspace overrides: `<repo>/.mcoda/prompts/`,

    * deterministic search order: workspace → global → built‑in defaults.

* **Minimal CLI surface**

  * `mcoda --help`, `mcoda --version`, diagnostics.

  * Agent commands (skeleton):

    * `mcoda agent add`,

    * `mcoda agent list`,

    * `mcoda agent use` (workspace default).

  * **`mcoda test-agent <name>`**:

    * loads agent credentials from encrypted DB,

    * sends a trivial prompt (“What is 2+2?”),

    * reports connectivity, latency, and basic model info.

**Exit criteria (Phase 0\)**

* `mcoda --help` works and shows core commands (some may be “not implemented yet”).

* Running migrations on a fresh checkout produces:

  * a valid `~/.mcoda/mcoda.db` with global tables, and

  * a valid `<repo>/.mcoda/mcoda.db` for a sample workspace.

* At least one real agent adapter (e.g. OpenAI) can be:

  * registered via `mcoda agent add`,

  * stored encrypted in `agent_auth`,

  * successfully pinged via `mcoda test-agent`.

* CI builds the CLI and performs an npm packaging dry‑run on `v*` tags.

#### **22.1.2 Phase 1 – MVP (Self‑hosted Task System, Single Agent)** {#22.1.2-phase-1-–-mvp-(self‑hosted-task-system,-single-agent)-1}

**Goal**

Provide an end‑to‑end flow for a single agent and single project/workspace, with docdex integration, persisted token usage, jobs/checkpoints, and per‑run logs, but without the full review/QA/multi‑agent feature set.

**Scope**

* **Core domain \+ DB (MVP)**

  * Workspace DB (`<repo>/.mcoda/mcoda.db`) includes:

    * `projects`, `epics`, `user_stories`, `tasks`,

    * `jobs`,

    * `token_usage`,

    * `task_logs` (per command run, including failures),

    * minimal `task_comments` schema (task‑scoped comments, even before full code review/QA exist).

  * Basic task state machine, including `ready_to_review` and `ready_to_qa`.

  * All rows linked to `workspace_id` and `project_id`.

* **Docdex integration**

  * Configurable docdex base URL and project ID via config.

  * Typed client for:

    * fetching RFP/PDR/SDS fragments,

    * retrieving per‑task context.

  * Simple in‑process caching to avoid repeated docdex calls within a single job.

* **Commands (MVP subset)**

  * `mcoda create-tasks`

    * Inputs: RFP \+ optional PDR/SDS identifiers (via docdex).

    * Output: epics, user stories, tasks with story point estimates persisted.

    * Uses:

      * per‑command prompts \+ agent job/character prompts,

      * docdex context assembly,

      * `token_usage` instrumentation.

  * `mcoda work-on-tasks` (minimal)

    * Selects tasks in `not_started` or `in_progress`.

    * Creates/checks out **deterministic per‑task branches** (including “mcoda” in the name).

    * Applies small, targeted patches from the agent.

    * Transitions `in_progress → ready_to_review` on success.

    * Writes detailed entries to `task_logs` for each run.

  * `mcoda backlog`

    * Basic SP summaries per project/epic/story.

    * Simple filters by status/epic/story.

  * Agent management (single‑agent, global)

    * `mcoda agent add <name>`: prompts for API key, stores encrypted in global DB.

    * `mcoda agent list`, `mcoda agent auth-status`, `mcoda agent use` (workspace default).

    * `mcoda test-agent <name>` fully wired through SecretsService and adapter.

* **Token telemetry (basic)**

  * `token_usage` rows per LLM action with:

    * `command_name`, `job_id`, `task_id`, `workspace_id`, `project_id`, `agent_id`, `model`,

    * prompt/completion/total token counts and derived cost.

  * `mcoda tokens --project ... --group-by command` for quick inspection.

* **Jobs & resumability (basic)**

  * `jobs` table \+ checkpoint files under `<repo>/.mcoda/jobs/<job_id>/...`.

  * `create-tasks` and `work-on-tasks` run as jobs with:

    * last processed epic/story/task index in the checkpoint.

  * `mcoda job list`, `mcoda job inspect`, `mcoda job resume` (simple flows).

**Exit criteria (Phase 1\)**

For a single real project:

* `mcoda create-tasks` produces a usable backlog (epics/stories/tasks with SP).

* `mcoda work-on-tasks`:

  * creates deterministic `mcoda-...` branches,

  * modifies the repo safely,

  * moves tasks to `ready_to_review`.

* `mcoda backlog` reports SP totals correctly.

* `mcoda tokens` shows token usage per command.

* Killing `create-tasks` mid‑run and resuming via `mcoda job resume` completes without duplication or corruption.

#### **22.1.3 Phase 2 – Full Workflow & Productization** {#22.1.3-phase-2-–-full-workflow-&-productization-1}

**Goal**

Deliver the full mcoda pipeline (create → refine → work → review → QA), structured comments and logs, dependency‑aware task ordering, prompt discipline across commands, and a usable update flow, making mcoda a production‑ready CLI for real teams.

**Scope**

* **Command coverage & workflows**

  * `mcoda refine-tasks`

    * Enrichment, splitting/merging, tagging, SP adjustments.

    * Uses command‑specific prompts and docdex context.

    * Can read/write `task_comments` to capture clarifications or refinements.

  * `mcoda work-on-tasks` (full workflow)

    * Workflow steps:

      * load agent \+ prompts (job description \+ character \+ command‑specific),

      * commit or stash dirty repo if necessary,

      * checkout `mcoda-dev` base branch (configurable),

      * checkout or create deterministic task branch (`mcoda/<task-key-or-id>...`),

      * apply code and documentation changes,

      * optionally run lightweight local tests,

      * commit changes on the task branch,

      * push task branch to remote,

      * merge into `mcoda-dev` on success,

      * push `mcoda-dev` to remote,

      * log the entire run into `task_logs` (including VCS actions and errors).

    * Deterministic branch naming per task so re‑runs reuse the same branch.

  * `mcoda code-review`

    * Ingests diffs per task/branch.

    * Uses docdex \+ SDS context \+ task history.

    * Writes structured review comments into `task_comments`:

      * per task,

      * per file/path,

      * with severity and reviewer (agent/human).

    * Transitions `ready_to_review → ready_to_qa` or reopens tasks to `in_progress`.

  * `mcoda qa-tasks`

    * Uses QA profiles and QA adapters (e.g. Chromium, Maestro) configured per workspace.

    * An agent orchestrates:

      * choosing QA profile,

      * running QA tools,

      * interpreting logs/results,

      * writing QA outcomes into both `task_comments` and `task_logs`.

    * Transitions `ready_to_qa → completed` or reopens/blocks tasks.

  * `mcoda estimate`

    * Uses story points \+ SP/hour baselines,

    * starts logging per‑stage throughput (implementation/review/QA) from history (still baseline‑driven in this phase).

  * Backlog & dependency‑aware ordering

    * Either via flags on `mcoda backlog` or a dedicated `mcoda order-tasks` / `mcoda tasks order-by-dependencies` command:

      * reorders tasks using dependency graph,

      * prioritizes tasks that are most depended on.

  * Task inspection

    * `mcoda task-detail` / `mcoda task show <task-key>`:

      * prints full task metadata, hierarchy, state,

      * associated comments and logs,

      * branch/PR mapping (where configured).

* **Multi‑agent support**

  * Full integration with global registry & routing:

    * workspace defaults reference **global** agents only,

    * `--agent` overrides respected everywhere.

  * Health‑ and capability‑aware routing (e.g. choose cheaper models for backlog/estimate).

* **Prompt discipline**

  * Systematic prompts for:

    * each command (create/refine/work/review/qa),

    * each agent’s job description and character.

  * Prompts checked into well‑known locations:

    * global under `~/.mcoda/prompts/`,

    * optional overrides under `<repo>/.mcoda/prompts/`,

    * referenced by jobs and reused across runs.

* **Jobs & checkpointing (full)**

  * All long‑running commands:

    * `create-tasks`, `refine-tasks`, `work-on-tasks`, `code-review`, `qa-tasks`, and documentation generation flows:

      * record progress via jobs \+ disk checkpoints,

      * emit `task_logs` entries per command run,

      * can be resumed cleanly from partial runs.

* **Update flow (baseline)**

  * On manual CLI runs:

    * optional “check for newer version” using `~/.mcoda/releases.json` or equivalent,

    * prompt user when an update is available.

  * `mcoda update`:

    * runs an npm‑based self‑update (`npm install -g mcoda@latest` equivalent, or prints the command),

    * records last update check time in global state.

**Exit criteria (Phase 2\)**

* Real projects can run the full pipeline:

  * `create-tasks → refine-tasks → work-on-tasks → code-review → qa-tasks`,

  * with code & docs updated safely via deterministic mcoda branches.

* `task_comments` contains structured review and QA comments, linked to tasks and files.

* `task_logs` provides enough history for agents and humans to understand previous runs on re‑runs.

* Update checks and `mcoda update` work reliably on the primary environments (Node LTS, Linux/macOS).

* Dependency‑aware ordering and task detail commands are usable on non‑trivial backlogs.

#### **22.1.4 Phase 3 – Advanced Features & Optimization** {#22.1.4-phase-3-–-advanced-features-&-optimization-1}

**Goal**

Leverage telemetry, dependency data, and multi‑agent features to optimize throughput, cost, and experience, while hardening npm distribution and update flows.

**Scope (not all required for first GA)**

* **Learned velocities & SP/hour refinement**

  * Replace static 15 SP/hour baselines with empirically learned SP/hour per stage and per command:

    * maintain sliding windows (e.g. last 10/20/50 completed tasks) per:

      * implementation (`work-on-tasks`),

      * review (`code-review`),

      * QA (`qa-tasks`).

  * Integrate learned values into:

    * `mcoda estimate`,

    * backlog views,

    * dashboards/JSON APIs.

* **Deeper telemetry**

  * Queryable dashboards and CLI APIs for:

    * token usage per command/agent/model,

    * SP throughput per stage,

    * failure rates by command/agent.

  * CLI/JSON outputs that answer:

    * “Which agent/model is best for this job type?”,

    * “What are we spending per epic/project per month?”.

* **Advanced QA & extensions**

  * Richer orchestration of QA extensions:

    * multi‑step browser flows,

    * multi‑device mobile flows (e.g. Maestro).

  * Agent guidance for:

    * choosing QA profiles and extensions,

    * capturing artifacts (screenshots, videos, logs),

    * attaching artifacts to tasks and comments.

* **Routing & plugins**

  * Router rules \+ `--explain-routing` surfaces.

  * Optional plugin/adaptor extensions driven from OpenAPI:

    * additional providers,

    * optional command plugins using the core client.

* **Update & distribution improvements**

  * Multiple release channels (e.g. stable, beta).

  * Hardened CI for distribution:

    * **automated npm publish on `v*` tags** with pre‑publish e2e gates,

    * smoke tests of `mcoda update` flows across supported OSes.

**Exit criteria (Phase 3\)**

* Estimates reliably reflect recent throughput (learned SP/hour).

* Telemetry and routing can answer key optimization questions for real workloads.

* Advanced QA flows (browser/mobile) run stably under real‑world usage.

* npm publish \+ `mcoda update` flows are stable across the supported CI matrix.

---

### **22.2 Risk Analysis & Mitigation Strategies** {#22.2-risk-analysis-&-mitigation-strategies-1}

#### **22.2.1 Technical risks** {#22.2.1-technical-risks-1}

**OpenAPI ↔ code drift**

* **Risk**: OpenAPI spec becomes outdated; code diverges; commands behave differently than documented.

* **Mitigations**:

  * OpenAPI → generated TS types for all DTOs; no hand‑rolled DTOs.

  * Single shared client library used by CLI and services.

  * CI:

    * fails on schema change without regenerated client,

    * enforces “spec‑first” workflow: change OpenAPI, regenerate, then implement.

**DB migrations & data loss (global vs workspace)**

* **Risk**: schema evolution across mcoda versions breaks existing data or causes global/workspace DB desync.

* **Mitigations**:

  * Versioned migrations tested using fixture DBs (global and workspace):

    * old fixture → migrate → validate invariants.

  * `db-validate` style checks in CI and optional CLI:

    * foreign key checks,

    * schema version consistency between OpenAPI and DB,

    * presence of critical tables (`tasks`, `token_usage`, `task_logs`, `task_comments`).

  * Clear backup guidance on schema upgrades (CLI prints recommendation on breaking changes).

**Job checkpoint corruption**

* **Risk**: partially written checkpoints make `mcoda job resume` fail or misbehave.

* **Mitigations**:

  * Always write checkpoints to `checkpoint.json.tmp` then atomic rename.

  * On resume, validate: `checkpoint_version`, `job_id`, `job_type`, `project_id`, `workspace_id`; fall back to partial restart if mismatch.

  * Jobs remain idempotent at epic/story/task boundaries.

**docdex dependency**

* **Risk**: docdex downtime blocks task/doc flows.

* **Mitigations**:

  * Clear error codes and messages when docdex is unreachable.

  * Optional explicit “reduced context” mode (flag) that allows degraded operation and emits strong warnings.

  * Short‑term caching for docdex snippets with TTL to reduce repeated calls.

**Multi‑agent & routing complexity**

* **Risk**: routing becomes opaque; misconfigurations cause unexpected agent selection.

* **Mitigations**:

  * `--agent` always overrides routing.

  * `--explain-routing` dry‑run mode to inspect routing decisions.

  * Simple defaults in earlier phases (single default agent per workspace) before enabling complex rules.

**Update & distribution issues (npm)**

* **Risk**: broken releases published to npm; `mcoda update` upgrades users to unusable versions.

* **Mitigations**:

  * Pre‑publish e2e test suite on `v*` tags (CLI, DB migrations, basic docdex/agent flows).

  * Staged channels (beta vs stable); `mcoda update` can target stable by default.

  * Ability to pin mcoda version in automation (e.g. via shell wrappers or CI images) while updates are validated.

#### **22.2.2 Product & UX risks** {#22.2.2-product-&-ux-risks-1}

**Overloaded CLI surface**

* **Risk**: too many commands/flags (`create-tasks`, `refine-tasks`, `work-on-tasks`, `code-review`, `qa-tasks`, tokens, telemetry, jobs, agents, update, etc.) overwhelm users.

* **Mitigations**:

  * Keep command names minimal and stable; prefer subcommands over new verbs.

  * Strong `--help` output with concrete examples per command.

  * Good defaults; flags used only when necessary.

  * Group advanced features in namespaces (e.g. `mcoda telemetry ...`).

**User confusion around pipeline states**

* **Risk**: users do not fully understand the pipeline (`not_started` → `in_progress` → `ready_to_review` → `ready_to_qa` → `completed`/`blocked`), leading to misuse of commands.

* **Mitigations**:

  * Clear pipeline diagrams in docs and SDS.

  * `mcoda backlog` and `mcoda estimate` show counts per state bucket.

  * `mcoda task-detail` prints state history and which command owns which transitions.

#### **22.2.3 Security & secrets risks** {#22.2.3-security-&-secrets-risks-1}

**Credential leakage**

* **Risk**: logs, checkpoints, or prompts accidentally contain API keys, access tokens, or other secrets.

* **Mitigations**:

  * Central redaction layer for logs and telemetry (field‑level masking for anything that looks like a key/token).

  * No prompts or completions stored in DB; telemetry stores only:

    * usage counts,

    * IDs (jobs, tasks, agents, models),

    * high‑level error codes.

  * Structured logging only; free‑form text minimized and passed through redaction.

**Single‑store secrets (DB‑only)**

* **Risk**: using `~/.mcoda/mcoda.db` as the only persistent store for secrets creates a high‑value file.

* **Mitigations**:

  * Secrets stored only in dedicated **encrypted** columns in `agent_auth` (and similar tables); never in config files or environment variables.

  * Clear separation between:

    * secret columns,

    * non‑secret metadata,  
       enforced at schema and type‑level.

  * Filesystem permissions:

    * `~/.mcoda/` and `mcoda.db` created with user‑only permissions.

    * Docs instruct users to treat this path as sensitive.

  * Rotation & revocation flows:

    * `mcoda agent remove` / re‑add,

    * status transitions for revoked/expired credentials,

    * best‑effort secure deletion at DB level (overwriting secret columns on revoke).

**No keychain / environment fallback**

* **Risk**: without OS keychains, encryption and lifecycle rules are entirely mcoda’s responsibility; users might try to keep keys in env vars or scripts.

* **Mitigations**:

  * No OS keychain integration at all; mcoda never attempts to read/write system keychains.

  * `mcoda agent add`:

    * encourages interactive entry of secrets,

    * if a key is supplied via env var/flag, mcoda warns and still stores it only in the encrypted DB column.

  * Tests and tooling explicitly avoid env‑var‑based secret storage except in controlled CI smoke tests.

  * Documentation:

    * clearly states that the only supported persistent secret store is encrypted data in `mcoda.db`,

    * recommends short‑lived keys and regular rotation.

#### **22.2.4 Performance & cost risks** {#22.2.4-performance-&-cost-risks-1}

**Unexpected token bills**

* **Risk**: complex flows (e.g. SDS regeneration, large backlogs) trigger too many LLM calls.

* **Mitigations**:

  * Token budgets per project/workspace with warning thresholds.

  * `mcoda tokens` grouped by command/model/agent for visibility.

  * Configurable “plan vs apply” modes (dry runs, smaller batches, sampling).

**Long‑running jobs blocking developer loops**

* **Risk**: large jobs (e.g. whole‑project QA) run too long or hang.

* **Mitigations**:

  * Hard per‑call timeouts and overall job timeouts.

  * Checkpointing & `mcoda job resume` for safe restarts.

  * `--limit` flags (e.g. max tasks per run) on long‑running commands.

**QA adapter overhead**

* **Risk**: external QA tools (Chromium, Maestro) are slow or flaky, impacting usability.

* **Mitigations**:

  * Separate QA profiles with clear cost/performance expectations.

  * Ability to run QA in smaller batches or manual mode.

  * Graceful fallbacks when QA adapters are unavailable (logging and explicit errors rather than silent failure).

---

### **22.3 Testing Strategy & CI Matrix** {#22.3-testing-strategy-&-ci-matrix-1}

#### **22.3.1 Test layers** {#22.3.1-test-layers-1}

**Unit tests**

* Pure TypeScript modules, including:

  * DB repositories & query builders (workspace \+ global DBs):

    * `tasks`, `jobs`, `token_usage`, `task_logs`, `task_comments`,

    * `agents`, `agent_auth`, `workspace_defaults`, `routing_rules`.

  * Task state machine transitions and dependency‑ordering logic.

  * Routing & capability checks in the agent layer.

  * Config & workspace resolution (`~/.mcoda` vs `<repo>/.mcoda`).

  * SecretsService:

    * encryption/decryption round‑trip,

    * guarantees that secrets do not appear in logs or telemetry.

  * Prompt loader:

    * global vs workspace resolution precedence,

    * missing/invalid prompt handling.

  * Branch naming helpers for deterministic `mcoda/...` branches.

**Contract & schema tests**

* OpenAPI schema vs generated TS:

  * validate spec via OpenAPI tools,

  * snapshot TS types for request/response DTOs.

* DB migrations:

  * for both global and workspace DBs:

    * fixture DB → migrate → `PRAGMA foreign_key_check`,

    * invariant checks (presence of `token_usage`, `task_logs`, `task_comments`, etc.).

  * Ensure global/workspace schemas align with OpenAPI’s schema definitions.

**Integration tests**

* SQLite against real temp files (global \+ workspace).

* Multi‑agent stub providers:

  * deterministic adapters simulating LLM calls for different models.

* docdex stubs:

  * simulate RFP/PDR/SDS searches and responses.

* QA adapter stubs:

  * fake Chromium/Maestro adapters to test `qa-tasks` orchestration and error handling.

* Integration flows for:

  * `create-tasks`, `refine-tasks`, `work-on-tasks`, `code-review`, `qa-tasks` using stubs,

  * `task_comments` and `task_logs` written correctly per run,

  * update metadata read from `~/.mcoda/releases.json`.

**End‑to‑end CLI tests**

* Spawn `mcoda` in a temp workspace:

  * initialize workspace (`.mcoda` creation, `.gitignore` updates),

  * configure stub agent via `mcoda agent add/use/test-agent`.

* Run full pipelines:

  * `create-tasks → refine-tasks → work-on-tasks → code-review → qa-tasks`,

  * verify:

    * workspace DB state (tasks, jobs, token\_usage, task\_comments, task\_logs),

    * git branch behavior (deterministic `mcoda/...` branches),

    * state transitions.

* Crash/resume tests:

  * simulate failure mid‑job,

  * validate `mcoda job resume` completes without duplication.

* Update flow tests (where feasible):

  * exercise “check for newer version” logic against a local `releases.json`,

  * verify `mcoda update` prints or executes the expected npm command in a controlled environment.

**Non‑functional tests**

* Performance:

  * seed DB with hundreds/thousands of tasks,

  * ensure backlog/estimate/tokens queries complete under target latency.

* Telemetry:

  * ensure every agent call generates `token_usage` rows with correct attribution.

* Memory footprint:

  * spot‑check long jobs for leaks (especially QA flows using external tools).

#### **22.3.2 CI matrix** {#22.3.2-ci-matrix-1}

**Platforms**

* OS:

  * Linux (primary, required for all jobs),

  * macOS (recommended; required for at least smoke \+ e2e),

  * Windows (optional; at minimum run a small smoke suite).

* Node:

  * LTS (e.g. 20.x) – required, full test suite,

  * latest stable (e.g. 22.x) – smoke tests.

**Job layout**

* `lint+typecheck`

  * ESLint, formatting, TypeScript type‑checking.

* `unit`

  * All unit tests (no network, no external tools).

* `integration`

  * DB \+ adapter stubs \+ docdex/QA stubs.

* `e2e-cli`

  * Limited but representative scenarios:

    * workspace bootstrap,

    * create/refine/work/review/qa pipeline,

    * jobs \+ resume,

    * token/telemetry commands.

  * Run on main branch and PRs labeled `e2e`.

* `package` / `publish-dry-run`

  * On main and `v*` tags:

    * build CLI,

    * run `npm pack`,

    * on `v*` tags, run **gated** `npm publish` (actual publish only after all tests pass).

* `optional-live-smoke`

  * Only when explicit env vars (e.g. `MCODA_LIVE_OPENAI_KEY`, docdex test URL) are set:

    * smoke tests against real providers and QA tools,

    * sanity check `mcoda update` in a controlled environment.

  * Never required for PR merge.

**Artifacts**

* Sample `mcoda.db` (global \+ workspace) after migration tests.

* Logs for job/resume failures and QA runs (for debugging).

* Packaged artifacts (`.tgz` from `npm pack`) for inspection or manual installation during review.

# 23\. Appendices {#23.-appendices}

## **23.1 Glossary** {#23.1-glossary}

**Agent**  
 Logical LLM or tool provider instance (for example, `"openai-prod"`). Backed by an adapter, auth config (stored encrypted in the global `~/.mcoda/mcoda.db`), and a model catalog.

**Adapter**  
 Implementation of the multi‑agent `AgentAdapter` interface (`ensureInstalled`, `ensureAuthed`, `ping`, `listModels`, `invoke`, `invokeStream`, `capabilities`). Adapters can represent LLM providers (OpenAI, Anthropic, etc.) or non‑LLM tools (Chromium, Maestro, custom QA tools).

**Agent Model**  
 A single model under an agent (for example, `gpt-4.1`, `claude-3-opus`). Stored in global registry tables with capability metadata (context window, tool‑calling support, modalities).

**Agent Registry**  
 Global‑only set of DB tables in `~/.mcoda/mcoda.db` (for example, `agents`, `agent_auth`, `agent_models`, `agent_health`, `agent_installers`, `agent_aliases`). Manages agents, encrypted auth, install state, health, and aliases. Workspaces reference these records; there are **no** agent tables in workspace DBs.

**Workspace**  
 Logical project context rooted at a directory that contains a `.mcoda/` folder. Each workspace has:

* A workspace‑local DB at `<repo>/.mcoda/mcoda.db` (tasks, jobs, token\_usage, task\_comments, task\_runs, command\_runs, logs).

* Local config (`.mcoda/config.json`), prompts, and job checkpoints.

* An identity used by global services (for example, workspace defaults in the global DB).

**Workspace Default Agent**  
 Agent selected for a workspace when no `--agent` flag is given. Implemented as a mapping from workspace → global agent in the global `~/.mcoda/mcoda.db` (for example, `workspace_defaults` table).

**Routing Rule**  
 Config row in a global `routing_rules` table describing preferences for certain job types (for example, “code jobs → agent X”). Ordered by priority and scoped either to a workspace or to the global sentinel (for example, `workspace_id = '__GLOBAL__'`).

**Job**  
 Long‑running operation tracked in the **workspace** DB (for example, `task_creation`, `task_refinement`, `work`, `review`, `qa`, `doc_generation`, `openapi_change`). Has state (`pending`, `running`, `completed`, `failed`, `cancelled`), progress, checkpoint path under `.mcoda/jobs/`, and references to project/epic/story/task where applicable.

**Checkpoint**  
 Disk JSON file under `.mcoda/jobs/<job_id>/checkpoint.json` capturing resumable state for a job (stage, units processed, command‑specific data). Used by `mcoda job resume` and command‑level resume flows.

**Project**  
 Top‑level product/application container (stored in `projects` table). Owns epics, user stories, tasks, and configuration such as docdex project IDs and VCS metadata.

**Epic**  
 High‑level feature grouping (stored in `epics`). Typically derived from RFP/PDR/SDS via `create-tasks`. Aggregates user stories and tasks, with denormalized SP totals.

**User Story**  
 Customer‑ or developer‑facing slice of functionality (stored in `user_stories`). Owned by an epic; decomposed into tasks; carries acceptance criteria.

**Task**  
 Smallest unit of work that mcoda operates on (stored in `tasks`). Has:

* Type: `dev | docs | review | qa | research | infrastructure`.

* Status state machine (see below).

* Story points (SP).

* Links to project/epic/story.

* VCS references (branch, commit).

* Optional issue‑tracker and docdex references.

**Task State Machine**  
 Explicit transitions enforced by mcoda:

* `not_started → in_progress` (work begins).

* `in_progress → ready_to_review` (via `work-on-tasks`).

* `ready_to_review → ready_to_qa` (via `code-review`).

* `ready_to_qa → completed` (via `qa-tasks` on success).

* Transitions to/from `blocked` and re‑opening to `in_progress` as defined in sections 10 and 16\.

**Story Points (SP)**  
 Relative effort estimate per task (`tasks.story_points`). Used together with SP/hour velocity to forecast durations (via `backlog` and `estimate`).

**Velocity**  
 Throughput in SP/hour for implementation, review, and QA. Initial baseline is **15 SP/hour** (per command type), but effective velocity gradually adapts using sliding‑window SP/hour metrics derived from recent task completions (for example, last 10/20/50 tasks per command).

**Task Comment**  
 Structured comment attached to a task (stored in `task_comments`). Used by agents and humans to record code review feedback, QA findings, and free‑form notes. Includes author (agent or human), timestamp, category, and optional linkage to files/lines.

**Task Run**  
 A single execution of a task‑oriented command (for example, one run of `work-on-tasks` on a specific task or batch), stored in `task_runs`. Captures start/end times, outcome, links to `command_runs`, and log references.

**Command Run**  
 Normalized record per CLI command execution (stored in `command_runs`). Contains command name, arguments snapshot, workspace, job id (if any), exit code, and references to aggregated logs and token\_usage.

**Token Usage**  
 Per‑invocation accounting row in `token_usage` (workspace DB). Records:

* Command name and phase (for example, `"work-on-tasks" / "plan"`).

* Agent id, model name.

* Job id, optional task id and project id.

* Token counts (prompt, completion, total) and cost estimates.

* Timestamps and optional OpenAPI operation id.

Used for telemetry, budgeting, and SP/hour learning.

**Telemetry**  
 Aggregations and reporting over `token_usage`, jobs, and command\_runs. Underpins `mcoda tokens` and the `mcoda telemetry ...` namespace, as well as parts of `mcoda estimate`.

**QA Profile**  
 Config entry describing how to run tests (command, working directory, env, matchers). Chosen by `qa-tasks` based on task type/tags or explicit `--profile` and may invoke tools such as Chromium or Maestro.

**Invocation**  
 Single agent call via the multi‑agent core (`invoke` or `invokeStream`). Identified by an internal `invocation_id` and associated with a `token_usage` row (command, job, task, agent, model, tokens, latency, and normalized error info).

**Docdex**  
 External documentation retrieval service; the only documentation index. mcoda never maintains a local index: all SDS/PDR/RFP/doc flows rely on docdex.

**RFP / PDR / SDS**

* **RFP**: Request for Proposal — high‑level requirements.

* **PDR**: Product Design/Definition Review — product‑level design.

* **SDS**: System Design Specification — technical design & API; mcoda treats the SDS \+ OpenAPI as core design artifacts.

**OpenAPI Spec**  
 Single source of truth for mcoda’s API shapes (`openapi/mcoda.yaml`). Drives:

* TypeScript DTOs and API/client code.

* DB schema & migrations (indirectly, via mapping).

* CLI request/response contracts.

* Documentation fragments (for example, this SDS, PDR).

## **23.2 Example Configs & Workflows** {#23.2-example-configs-&-workflows}

23.2.1 Example global config (`~/.mcoda/config.json`)

Global config is stored under `~/.mcoda/config.json` (not in XDG or platform‑specific config directories). It configures machine‑level defaults and paths; **API keys are never stored here**.

```json
{
  "db": {
    "path": "~/.mcoda/mcoda.db"
  },

  "docdex": {
    "baseUrl": "https://docdex.internal/",
    "projectId": "platform-x",
    "timeoutMs": 20000
  },

  "velocity": {
    "implementationSpPerHourDefault": 15,
    "reviewSpPerHourDefault": 18,
    "qaSpPerHourDefault": 12
  },

  "telemetry": {
    "budgets": [
      {
        "scope": "project",
        "projectKey": "PLATFORM-X",
        "period": "week",
        "maxTokens": 400000,
        "maxCost": 30
      }
    ]
  },

  "agents": {
    "defaultName": "openai"
  },

  "updates": {
    "checkOnManualRun": true,
    "channel": "stable"
  },

  "paths": {
    "cacheDir": "~/.mcoda/cache",
    "jobsDir": ".mcoda/jobs"
  }
}
```

**Notes**

* Global config lives at `~/.mcoda/config.json`.

* API keys and provider tokens are **added via** `mcoda agent add` and stored **only** (encrypted) in the global `mcoda.db`.

* Velocity settings are *defaults*; observed SP/hour is computed from real runs and can override these baselines in estimation logic.

* `updates.checkOnManualRun` controls whether mcoda checks for updates when the CLI is invoked interactively; `mcoda update` also exists as an explicit command.

23.2.2 Example workspace config (`<repo>/.mcoda/config.json`)

Workspace config customizes project‑specific settings for a single repo/workspace.

```json
{
  "docdex": {
    "projectId": "platform-x-service-a"
  },

  "vcs": {
    "baseBranch": "mcoda-dev",
    "taskBranchPattern": "feature/{projectKey}/{taskKey}-{slugTitle}"
  },

  "qaProfiles": [
    {
      "name": "unit",
      "testCommand": "npm test -- --runTestsByPath",
      "default": true,
      "matcher": { "task_types": ["dev"] }
    },
    {
      "name": "integration",
      "testCommand": "npm run e2e",
      "matcher": { "tags": ["integration"] }
    },
    {
      "name": "mobile-acceptance",
      "testCommand": "mcoda-qa-maestro run ./flows",
      "matcher": { "tags": ["mobile"] }
    }
  ]
}
```

**Notes**

* This file lives under the workspace root as `.mcoda/config.json`.

* `vcs.baseBranch` is where `work-on-tasks` first checks out (for example, `mcoda-dev`) before switching to per‑task branches.

* `taskBranchPattern` defines deterministic task branch names (for example, `feature/PLATFORM-X/MCODA-T123-fix-telemetry`), ensuring re‑runs reuse the same branch.

* QA profiles encapsulate how `qa-tasks` invokes extensions such as Chromium or Maestro (for example, `mobile-acceptance` for Maestro flows).

23.2.3 Typical “plan → build → review → QA” workflow

**Configure agent & workspace default**

One‑time global setup (stores key encrypted in `~/.mcoda/mcoda.db`):

```shell
mcoda agent add openai
```

Verify connectivity with the new **test‑agent** command:

```shell
mcoda test-agent openai
```

Inside a repo (workspace):

```shell
mcoda agent use openai   # set workspace default agent
```

**Create tasks from docs (RFP/PDR/SDS via docdex)**

```shell
mcoda create-tasks \
  --project PLATFORM-X \
  --rfp-id RFP-2025-01 \
  --pdr-id PDR-PLATFORM-X \
  --sds-id SDS-PLATFORM-X
```

**(Optional) Inspect and order tasks**

```shell
mcoda backlog --project PLATFORM-X --epic EP-API-GW
```

Dependency‑aware ordering (via dedicated command/flag):

```shell
mcoda backlog --project PLATFORM-X --epic EP-API-GW --order dependencies
# or:
mcoda order-tasks --project PLATFORM-X --epic EP-API-GW
```

Inspect a single task in detail (comments, deps, branches, logs):

```shell
mcoda task-detail --project PLATFORM-X --task MCODA-T123
# CLI may also expose aliases like `mcoda task show` / `mcoda task details`.
```

**Refine tasks (enrichment & splitting)**

```shell
mcoda refine-tasks --project PLATFORM-X --epic EP-API-GW
```

**Implementation**

```shell
mcoda work-on-tasks \
  --project PLATFORM-X \
  --epic EP-API-GW \
  --max-tasks 3
```

Under the hood, `work-on-tasks`:

* Loads the selected agent and its prompts (job description \+ character \+ command‑specific runbook).

* Stashes/commits dirty changes if needed.

* Checks out `mcoda-dev`, then the deterministic task branch (via `taskBranchPattern` and stored branch fields).

* Updates code and relevant docs.

* Commits and pushes the task branch.

* Merges into `mcoda-dev` on success and pushes it.

* Logs the run into `command_runs` and `task_runs`, and records per‑action `token_usage`.

**Code review**

```shell
mcoda code-review --project PLATFORM-X --epic EP-API-GW
```

The agent:

* Reviews diffs using SDS/docdex \+ OpenAPI context.

* Writes structured findings into `task_comments`.

* Moves tasks `ready_to_review → ready_to_qa` (approve) or `ready_to_review → in_progress` when changes are required.

**QA**

```shell
mcoda qa-tasks \
  --project PLATFORM-X \
  --epic EP-API-GW \
  --profile integration
```

The QA flow:

* Selects a QA profile (for example, `unit`, `integration`, `mobile-acceptance`).

* Invokes configured tools (for example, headless Chromium, Maestro).

* Logs results into `task_comments` and `task_runs` (including attachments/links).

* Transitions tasks `ready_to_qa → completed` on success or back to `in_progress`/`blocked` on failure.

**Backlog & estimates**

```shell
mcoda backlog  --project PLATFORM-X
mcoda estimate --project PLATFORM-X --epic EP-API-GW
```

*   
  `backlog` shows SP per status/state and can surface dependency ordering summaries.

* `estimate` uses 15 SP/hour as a starting point, then blends in rolling SP/hour metrics based on recent historical task completions (for example, last 20 tasks for implementation).

**Maintenance & updates**

```shell
mcoda update
```

*   
  Checks for available updates (respecting `updates.channel`) and prompts the user to apply.

* On acceptance, applies the update (for example, fetching the latest npm package) and records the event in telemetry/logs.

## **23.3 Sample OpenAPI Snippets** {#23.3-sample-openapi-snippets}

These examples are illustrative; the canonical spec lives in `openapi/mcoda.yaml` and must be treated as the single source of truth. Snippets highlight **token telemetry**, **task comments**, **test‑agent**, **dependency ordering**, and **update** operations.

### **23.3.1 Telemetry: token usage** {#23.3.1-telemetry:-token-usage}

```
components:
  schemas:
    TokenUsage:
      type: object
      required:
        - id
        - command_name
        - agent_id
        - model_name
        - tokens_prompt
        - tokens_completion
        - tokens_total
        - created_at
      properties:
        id:
          type: integer
        command_name:
          type: string
          description: CLI command, e.g. "work-on-tasks"
        phase:
          type: string
          nullable: true
          description: Optional phase label, e.g. "plan", "generate", "qa-run"
        agent_id:
          type: integer
        model_name:
          type: string
        project_id:
          type: integer
          nullable: true
        task_id:
          type: integer
          nullable: true
        job_id:
          type: integer
          nullable: true
        tokens_prompt:
          type: integer
        tokens_completion:
          type: integer
        tokens_total:
          type: integer
        cost:
          type: number
          nullable: true
        currency:
          type: string
          nullable: true
        created_at:
          type: string
          format: date-time

paths:
  /telemetry/tokens:
    get:
      tags: [Telemetry]
      operationId: getTokenUsage
      summary: "Aggregated token usage over token_usage rows"
      parameters:
        - in: query
          name: project_id
          schema: { type: integer }
        - in: query
          name: agent_id
          schema: { type: integer }
        - in: query
          name: command_name
          schema: { type: string }
        - in: query
          name: job_id
          schema: { type: integer }
        - in: query
          name: task_id
          schema: { type: integer }
        - in: query
          name: from
          schema: { type: string, format: date-time }
        - in: query
          name: to
          schema: { type: string, format: date-time }
        - in: query
          name: group_by
          schema:
            type: string
            enum: [command, agent, job, task, day]
      responses:
        '200':
          description: "Aggregated token usage"
          content:
            application/json:
              schema:
                type: array
                items:
                  $ref: '#/components/schemas/TokenUsageAggregate'
```

`mcoda tokens` / `mcoda telemetry tokens` call this endpoint with appropriate filters and grouping.

### **23.3.2 Tasks: comments** {#23.3.2-tasks:-comments}

```
components:
  schemas:
    TaskComment:
      type: object
      required: [id, task_id, author_type, author_name, body, created_at]
      properties:
        id:
          type: integer
        task_id:
          type: integer
        author_type:
          type: string
          enum: [human, agent]
        author_name:
          type: string
          description: "Display name or agent identifier"
        category:
          type: string
          nullable: true
          description: "Optional category, e.g. code_review, qa_result, note"
        body:
          type: string
        metadata:
          type: object
          additionalProperties: true
        created_at:
          type: string
          format: date-time

paths:
  /tasks/{taskId}/comments:
    get:
      tags: [Tasks]
      operationId: listTaskComments
      summary: "List comments for a task"
      parameters:
        - in: path
          name: taskId
          required: true
          schema: { type: integer }
      responses:
        '200':
          description: "Comments for the task"
          content:
            application/json:
              schema:
                type: array
                items:
                  $ref: '#/components/schemas/TaskComment'

    post:
      tags: [Tasks]
      operationId: createTaskComment
      summary: "Create a comment for a task"
      parameters:
        - in: path
          name: taskId
          required: true
          schema: { type: integer }
      requestBody:
        required: true
        content:
          application/json:
            schema:
              type: object
              required: [author_type, author_name, body]
              properties:
                author_type:
                  type: string
                  enum: [human, agent]
                author_name:
                  type: string
                category:
                  type: string
                  nullable: true
                body:
                  type: string
                metadata:
                  type: object
                  additionalProperties: true
      responses:
        '201':
          description: "Comment created"
          content:
            application/json:
              schema:
                $ref: '#/components/schemas/TaskComment'
```

`mcoda code-review` and `mcoda qa-tasks` use this API to write review/QA feedback into `task_comments`.

### **23.3.3 Agents: test‑agent** {#23.3.3-agents:-test‑agent}

```
paths:
  /agents/{agentId}/test:
    post:
      tags: [Agents]
      operationId: testAgent
      summary: "Simple connectivity and auth test for an agent"
      parameters:
        - in: path
          name: agentId
          required: true
          schema: { type: integer }
      requestBody:
        required: false
        content:
          application/json:
            schema:
              type: object
              properties:
                promptOverride:
                  type: string
                  description: "Optional override for the default test prompt"
      responses:
        '200':
          description: "Test result"
          content:
            application/json:
              schema:
                type: object
                properties:
                  ok:
                    type: boolean
                  answer:
                    type: string
                    description: "Agent's answer to a simple question (e.g. '4' for '2+2')"
                  latency_ms:
                    type: integer
                  error:
                    type: string
                    nullable: true
```

`mcoda test-agent <NAME>` resolves `agentId` and calls this endpoint with a deterministic prompt (for example, “What is 2+2?”) to validate connectivity, auth, and basic reasoning.

### **23.3.4 Tasks: dependency ordering** {#23.3.4-tasks:-dependency-ordering}

```
paths:
  /tasks/dependency-order:
    get:
      tags: [Tasks]
      operationId: getTasksOrderedByDependencies
      summary: "Return tasks ordered by dependency graph priority"
      parameters:
        - in: query
          name: project_key
          schema: { type: string }
        - in: query
          name: epic_key
          schema: { type: string, nullable: true }
        - in: query
          name: include_blocked
          schema:
            type: boolean
            default: false
      responses:
        '200':
          description: "Tasks ordered by dependency priority"
          content:
            application/json:
              schema:
                type: object
                properties:
                  order:
                    type: array
                    items:
                      $ref: '#/components/schemas/Task'
```

`mcoda order-tasks` (and `mcoda backlog --order dependencies`) call this endpoint to sort tasks so that the most depended‑on tasks are prioritized first in scheduling.

### **23.3.5 System: update check & apply** {#23.3.5-system:-update-check-&-apply}

```
components:
  schemas:
    UpdateInfo:
      type: object
      required: [currentVersion, latestVersion, updateAvailable, channel]
      properties:
        currentVersion:
          type: string
        latestVersion:
          type: string
        channel:
          type: string
          enum: [stable, beta, nightly]
        updateAvailable:
          type: boolean
        notes:
          type: string
          nullable: true

paths:
  /system/update:
    get:
      tags: [System]
      operationId: checkUpdate
      summary: "Check for available mcoda updates"
      parameters:
        - name: channel
          in: query
          required: false
          schema:
            type: string
            enum: [stable, beta, nightly]
      responses:
        '200':
          description: "Update information"
          content:
            application/json:
              schema:
                $ref: '#/components/schemas/UpdateInfo'

    post:
      tags: [System]
      operationId: applyUpdate
      summary: "Apply a pending mcoda update"
      requestBody:
        required: false
        content:
          application/json:
            schema:
              type: object
              properties:
                channel:
                  type: string
                  enum: [stable, beta]
                  description: "Optional override for the update channel"
      responses:
        '202':
          description: "Update started or completed"
          content:
            application/json:
              schema:
                type: object
                properties:
                  status:
                    type: string
                    enum: [started, already_up_to_date, completed]
                  logFile:
                    type: string
                    nullable: true
```

`mcoda update` first calls `GET /system/update` to display available updates, then (on user confirmation) calls `POST /system/update` to apply the update. Distribution is via npm; applying an update typically means installing the latest `mcoda` npm package for the configured channel.

## **23.4 References** {#23.4-references}

This SDS and `openapi/mcoda.yaml` are the **canonical** references for mcoda’s behavior, schemas, and commands. External materials are used only as supporting prior art or technology references.

**Core architecture & multi‑agent systems**

* Internal multi‑agent system documentation (for example, “Multi‑Agentic System v0.9.x”): reference for adapter interfaces, unified `InvokeRequest/InvokeResponse`, error normalization patterns, and health/routing ideas. Hybrid secret models and keychain usage in those docs are **not** adopted; mcoda uses DB‑only encrypted secrets.

* Historical gpt‑creator codebase and docs (if consulted) are treated purely as prior art for multi‑agent and task‑driven workflows. There is **no** migration path defined here; mcoda is a greenfield product with its own data model and commands.

**Documentation system**

* docdex product/docs — authoritative source for docdex query APIs, document identifiers, search parameters, and performance characteristics that inform mcoda’s SDS/PDR/OpenAPI doc flows.

**Datastore & runtime**

* SQLite documentation — reference for PRAGMAs (WAL, `secure_delete`, foreign key enforcement), transactions, and performance tuning for the global and workspace `mcoda.db` files.

* Node.js and TypeScript docs — runtime and language semantics for the mcoda CLI, core runtime, and integration layers.

**OpenAPI & tooling**

* OpenAPI Specification v3.1 — contract format for `openapi/mcoda.yaml`.

* OpenAPI tooling (for example, `openapi-generator`, `openapi-typescript`) — used to generate TS DTOs and clients from the canonical spec and to validate that code, SQL, and documentation stay aligned with the OpenAPI contract.

All of the above inform mcoda’s design, but **this** SDS and the mcoda OpenAPI spec remain the ultimate sources of truth for what mcoda must implement.
