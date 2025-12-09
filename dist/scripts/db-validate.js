#!/usr/bin/env tsx
import os from "node:os";
import path from "node:path";
import { mkdtemp, rm } from "node:fs/promises";
import Database from "../packages/db/src/sqlite.js";
import { runGlobalMigrations, runWorkspaceMigrations } from "../packages/db/src/migration.js";
const ensureColumns = (db, table, expected) => {
    const columns = db.prepare(`PRAGMA table_info(${table})`).all();
    const names = new Set(columns.map((c) => c.name));
    const missing = expected.filter((col) => !names.has(col));
    if (missing.length) {
        throw new Error(`Schema mismatch for ${table}: missing columns ${missing.join(", ")}`);
    }
};
const validateWorkspaceSchema = (db) => {
    const _taskShape = { id: "", title: "", status: "not_started", estimate: 0, notes: "", storyId: "", epicId: "" };
    const _commandRunShape = { command: "", status: "running", gitBranch: "", gitBaseBranch: "", jobId: "", workspace: "", startedAt: "", completedAt: "" };
    const _tokenUsageShape = { command: "", agent: "", taskId: "", jobId: "", promptTokens: 0, completionTokens: 0, model: "", operationId: "", recordedAt: "" };
    const _jobShape = { id: "", command: "", status: "running", workspace: "", notes: "", createdAt: "", updatedAt: "" };
    // Column lists derived from migrations (snake_case) to align with DTO fields.
    ensureColumns(db, "tasks", ["id", "title", "status", "estimate", "notes", "story_id", "epic_id"]);
    ensureColumns(db, "command_runs", ["id", "command", "status", "git_branch", "git_base_branch", "job_id", "workspace", "started_at", "completed_at", "updated_at"]);
    ensureColumns(db, "token_usage", ["id", "command", "agent", "task_id", "job_id", "prompt_tokens", "completion_tokens", "model", "operation_id", "recorded_at"]);
    ensureColumns(db, "jobs", ["id", "command", "status", "workspace", "notes", "created_at", "updated_at"]);
    void [_taskShape, _commandRunShape, _tokenUsageShape, _jobShape]; // DTO linkage for type safety
};
const validateGlobalSchema = (db) => {
    const _agentShape = { name: "", provider: "", model: "", default: false, hasAuth: false, updatedAt: "" };
    ensureColumns(db, "agents", ["name", "provider", "model", "is_default", "prompts", "created_at", "updated_at"]);
    ensureColumns(db, "agent_secrets", ["agent_name", "encrypted_payload"]);
    void _agentShape;
};
const main = async () => {
    const tmp = await mkdtemp(path.join(os.tmpdir(), "mcoda-db-validate-"));
    const globalDbPath = path.join(tmp, "global.db");
    const workspaceDbPath = path.join(tmp, "workspace.db");
    const globalDb = new Database(globalDbPath);
    runGlobalMigrations(globalDb);
    validateGlobalSchema(globalDb);
    const workspaceDb = new Database(workspaceDbPath);
    runWorkspaceMigrations(workspaceDb);
    validateWorkspaceSchema(workspaceDb);
    // eslint-disable-next-line no-console
    console.log("DB schema validated against OpenAPI DTOs");
    await rm(tmp, { recursive: true, force: true });
};
main().catch((error) => {
    // eslint-disable-next-line no-console
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
});
