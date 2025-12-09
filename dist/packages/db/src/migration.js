import { access, mkdir, readFile, writeFile } from "node:fs/promises";
import { constants } from "node:fs";
import { randomUUID } from "node:crypto";
import os from "node:os";
import path from "node:path";
const INTEGRATION_BRANCH = "mcoda-dev";
const TASK_BRANCH_PREFIX = "mcoda/task";
const MIGRATIONS_TABLE = "schema_migrations";
const fileExists = async (filePath) => {
    try {
        await access(filePath, constants.F_OK);
        return true;
    }
    catch {
        return false;
    }
};
const sanitizeBranchSegment = (value) => value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-+|-+$/g, "");
export const deriveTaskBranchName = (taskId, options = {}) => {
    if (options.reuseBranch) {
        return options.reuseBranch;
    }
    const base = sanitizeBranchSegment(String(taskId));
    const extra = options.slug ? sanitizeBranchSegment(options.slug) : "";
    const suffix = extra.length > 0 ? [base, extra].filter(Boolean).join("-") : base.length > 0 ? base : "";
    const finalSuffix = suffix.length > 0 ? suffix : "unknown";
    return `${TASK_BRANCH_PREFIX}/${finalSuffix}`;
};
export const getWorkspaceLayout = (workspaceRoot) => {
    const root = path.join(workspaceRoot, ".mcoda");
    return {
        root,
        dbPath: path.join(root, "mcoda.db"),
        jobsDir: path.join(root, "jobs"),
        docsDir: path.join(root, "docs"),
        promptsDir: path.join(root, "prompts"),
        workspaceFile: path.join(root, "workspace.json"),
        configFiles: [path.join(root, "config.json")],
        gitignorePath: path.join(workspaceRoot, ".gitignore"),
    };
};
export const getGlobalLayout = (homeDir = os.homedir()) => {
    const root = path.join(homeDir, ".mcoda");
    return {
        root,
        dbPath: path.join(root, "mcoda.db"),
        agentsDir: path.join(root, "agents"),
        releasesFile: path.join(root, "releases.json"),
    };
};
export const getLayoutManifest = (workspaceRoot, homeDir = os.homedir()) => ({
    global: getGlobalLayout(homeDir),
    workspace: getWorkspaceLayout(workspaceRoot),
    integrationBranch: INTEGRATION_BRANCH,
    taskBranchPrefix: TASK_BRANCH_PREFIX,
});
const ensureGitignoreHasMcoda = async (gitignorePath) => {
    const gitignoreExists = await fileExists(gitignorePath);
    const entry = ".mcoda/";
    if (!gitignoreExists) {
        await writeFile(gitignorePath, `${entry}\n`, "utf8");
        return true;
    }
    const content = await readFile(gitignorePath, "utf8");
    const lines = content.split(/\r?\n/);
    const alreadyPresent = lines.some((line) => {
        const trimmed = line.trim();
        return trimmed === ".mcoda" || trimmed === entry;
    });
    if (alreadyPresent) {
        return false;
    }
    const needsNewline = content.length > 0 && !content.endsWith("\n");
    const updated = `${content}${needsNewline ? "\n" : ""}${entry}\n`;
    await writeFile(gitignorePath, updated, "utf8");
    return true;
};
const ensureDir = async (dirPath, createdPaths) => {
    const exists = await fileExists(dirPath);
    if (!exists) {
        await mkdir(dirPath, { recursive: true });
        createdPaths.push(dirPath);
    }
};
const ensureWorkspaceIdentity = async (layout) => {
    const now = new Date().toISOString();
    const fallback = {
        id: randomUUID(),
        name: path.basename(path.dirname(layout.root)),
        createdAt: now,
    };
    if (await fileExists(layout.workspaceFile)) {
        try {
            const raw = await readFile(layout.workspaceFile, "utf8");
            const parsed = JSON.parse(raw);
            if (parsed && typeof parsed.id === "string" && parsed.id.trim().length > 0) {
                const identity = {
                    id: parsed.id.trim(),
                    name: parsed.name ?? fallback.name,
                    description: parsed.description,
                    createdAt: parsed.createdAt ?? now,
                    updatedAt: parsed.updatedAt,
                };
                if (!parsed.name || !parsed.createdAt) {
                    await writeFile(layout.workspaceFile, JSON.stringify(identity, null, 2), "utf8");
                }
                return identity;
            }
        }
        catch {
            // fall through to regenerate identity
        }
    }
    await writeFile(layout.workspaceFile, JSON.stringify(fallback, null, 2), "utf8");
    return fallback;
};
export const ensureWorkspaceBootstrap = async (workspaceRoot) => {
    const layout = getWorkspaceLayout(workspaceRoot);
    const createdPaths = [];
    await ensureDir(layout.root, createdPaths);
    await ensureDir(layout.jobsDir, createdPaths);
    await ensureDir(layout.docsDir, createdPaths);
    await ensureDir(layout.promptsDir, createdPaths);
    const identity = await ensureWorkspaceIdentity(layout);
    const gitignoreUpdated = await ensureGitignoreHasMcoda(layout.gitignorePath);
    return {
        workspaceRoot,
        createdPaths,
        gitignoreUpdated,
        gitignorePath: layout.gitignorePath,
        identity,
    };
};
const ensureMigrationsTable = (db) => {
    db.exec(`
    CREATE TABLE IF NOT EXISTS ${MIGRATIONS_TABLE} (
      id INTEGER PRIMARY KEY,
      name TEXT NOT NULL,
      applied_at TEXT NOT NULL
    );
  `);
};
const currentVersion = (db) => {
    ensureMigrationsTable(db);
    const row = db.prepare(`SELECT MAX(id) as version FROM ${MIGRATIONS_TABLE}`).get();
    return row.version ?? 0;
};
const recordMigration = (db, migration) => {
    db.prepare(`INSERT INTO ${MIGRATIONS_TABLE} (id, name, applied_at) VALUES (?, ?, ?)`).run(migration.id, migration.name, new Date().toISOString());
};
const addColumnIfMissing = (db, table, column, definition) => {
    const info = db.prepare(`PRAGMA table_info(${table})`).all();
    const exists = info.some((row) => row.name === column);
    if (!exists) {
        db.exec(`ALTER TABLE ${table} ADD COLUMN ${definition}`);
    }
};
const applyMigrations = (db, migrations, scope) => {
    ensureMigrationsTable(db);
    const version = currentVersion(db);
    const pending = migrations.filter((m) => m.id > version).sort((a, b) => a.id - b.id);
    for (const migration of pending) {
        const tx = db.transaction(() => {
            migration.up(db);
            recordMigration(db, migration);
        });
        tx();
        // eslint-disable-next-line no-console
        console.log(`[migrations:${scope}] applied ${migration.id} ${migration.name}`);
    }
};
// Global migrations (agent registry, capabilities, releases metadata).
export const globalMigrations = [
    {
        id: 1,
        name: "global_agents_and_secrets",
        up: (db) => {
            db.exec(`
        CREATE TABLE IF NOT EXISTS agents (
          name TEXT PRIMARY KEY,
          provider TEXT NOT NULL,
          model TEXT NOT NULL,
          is_default INTEGER NOT NULL DEFAULT 0,
          prompts TEXT,
          created_at TEXT NOT NULL,
          updated_at TEXT NOT NULL
        );
        CREATE TABLE IF NOT EXISTS agent_secrets (
          agent_name TEXT PRIMARY KEY,
          encrypted_payload TEXT NOT NULL,
          FOREIGN KEY(agent_name) REFERENCES agents(name) ON DELETE CASCADE
        );
      `);
        },
    },
    {
        id: 2,
        name: "global_capabilities_and_defaults",
        up: (db) => {
            db.exec(`
        CREATE TABLE IF NOT EXISTS agent_capabilities (
          agent_name TEXT NOT NULL,
          capability TEXT NOT NULL,
          PRIMARY KEY(agent_name, capability),
          FOREIGN KEY(agent_name) REFERENCES agents(name) ON DELETE CASCADE
        );
        CREATE TABLE IF NOT EXISTS workspace_defaults (
          workspace TEXT PRIMARY KEY,
          default_agent TEXT,
          updated_at TEXT NOT NULL
        );
        CREATE TABLE IF NOT EXISTS releases (
          version TEXT PRIMARY KEY,
          channel TEXT,
          published_at TEXT,
          notes TEXT
        );
      `);
        },
    },
    {
        id: 3,
        name: "agent_prompts_health_routing",
        up: (db) => {
            db.exec(`
        CREATE TABLE IF NOT EXISTS agent_prompts (
          agent_name TEXT NOT NULL,
          kind TEXT NOT NULL,
          command TEXT,
          path TEXT NOT NULL,
          created_at TEXT NOT NULL,
          updated_at TEXT NOT NULL,
          PRIMARY KEY(agent_name, kind, command),
          FOREIGN KEY(agent_name) REFERENCES agents(name) ON DELETE CASCADE
        );
        CREATE TABLE IF NOT EXISTS agent_health (
          agent_name TEXT PRIMARY KEY,
          status TEXT NOT NULL,
          latency_ms INTEGER,
          details_json TEXT,
          checked_at TEXT NOT NULL,
          created_at TEXT NOT NULL,
          FOREIGN KEY(agent_name) REFERENCES agents(name) ON DELETE CASCADE
        );
        CREATE TABLE IF NOT EXISTS routing_rules (
          workspace TEXT NOT NULL,
          command TEXT NOT NULL,
          agent TEXT NOT NULL,
          notes TEXT,
          updated_at TEXT NOT NULL,
          PRIMARY KEY(workspace, command),
          FOREIGN KEY(agent) REFERENCES agents(name) ON DELETE CASCADE
        );
      `);
        },
    },
];
// Workspace migrations (tasks hierarchy, comments, logs, enriched run logging).
export const workspaceMigrations = [
    {
        id: 1,
        name: "workspace_base",
        up: (db) => {
            db.exec(`
        CREATE TABLE IF NOT EXISTS command_runs (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          command TEXT NOT NULL,
          job_id TEXT,
          status TEXT NOT NULL,
          output_path TEXT,
          workspace TEXT,
          updated_at TEXT NOT NULL
        );
        CREATE TABLE IF NOT EXISTS task_runs (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          task_id TEXT NOT NULL,
          command TEXT NOT NULL,
          status TEXT NOT NULL,
          story_points INTEGER,
          duration_seconds INTEGER,
          workspace TEXT,
          job_id TEXT,
          notes TEXT,
          created_at TEXT NOT NULL
        );
        CREATE TABLE IF NOT EXISTS token_usage (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          command TEXT,
          agent TEXT,
          workspace TEXT,
          task_id TEXT,
          job_id TEXT,
          prompt_tokens INTEGER NOT NULL DEFAULT 0,
          completion_tokens INTEGER NOT NULL DEFAULT 0,
          recorded_at TEXT NOT NULL
        );
        CREATE TABLE IF NOT EXISTS jobs (
          id TEXT PRIMARY KEY,
          command TEXT NOT NULL,
          status TEXT NOT NULL,
          workspace TEXT,
          notes TEXT,
          created_at TEXT NOT NULL,
          updated_at TEXT NOT NULL
        );
      `);
        },
    },
    {
        id: 2,
        name: "tasks_hierarchy",
        up: (db) => {
            db.exec(`
        CREATE TABLE IF NOT EXISTS epics (
          id TEXT PRIMARY KEY,
          title TEXT NOT NULL,
          status TEXT NOT NULL,
          created_at TEXT NOT NULL,
          updated_at TEXT NOT NULL
        );
        CREATE TABLE IF NOT EXISTS user_stories (
          id TEXT PRIMARY KEY,
          epic_id TEXT NOT NULL,
          title TEXT NOT NULL,
          status TEXT NOT NULL,
          created_at TEXT NOT NULL,
          updated_at TEXT NOT NULL,
          FOREIGN KEY(epic_id) REFERENCES epics(id)
        );
        CREATE TABLE IF NOT EXISTS tasks (
          id TEXT PRIMARY KEY,
          story_id TEXT NOT NULL,
          epic_id TEXT,
          title TEXT NOT NULL,
          status TEXT NOT NULL,
          estimate INTEGER,
          notes TEXT,
          assignee TEXT,
          created_at TEXT NOT NULL,
          updated_at TEXT NOT NULL,
          FOREIGN KEY(story_id) REFERENCES user_stories(id)
        );
        CREATE TABLE IF NOT EXISTS task_dependencies (
          from_task_id TEXT NOT NULL,
          to_task_id TEXT NOT NULL,
          PRIMARY KEY(from_task_id, to_task_id),
          FOREIGN KEY(from_task_id) REFERENCES tasks(id),
          FOREIGN KEY(to_task_id) REFERENCES tasks(id)
        );
      `);
        },
    },
    {
        id: 3,
        name: "task_comments",
        up: (db) => {
            db.exec(`
        CREATE TABLE IF NOT EXISTS task_comments (
          id TEXT PRIMARY KEY,
          task_id TEXT NOT NULL,
          author_type TEXT NOT NULL,
          agent_id TEXT,
          command TEXT,
          category TEXT,
          body TEXT NOT NULL,
          created_at TEXT NOT NULL,
          resolved_at TEXT,
          FOREIGN KEY(task_id) REFERENCES tasks(id)
        );
      `);
        },
    },
    {
        id: 4,
        name: "task_run_logs",
        up: (db) => {
            db.exec(`
        CREATE TABLE IF NOT EXISTS task_run_logs (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          command_run_id INTEGER,
          task_id TEXT,
          phase TEXT,
          status TEXT,
          details_json TEXT,
          created_at TEXT NOT NULL,
          FOREIGN KEY(command_run_id) REFERENCES command_runs(id),
          FOREIGN KEY(task_id) REFERENCES tasks(id)
        );
      `);
        },
    },
    {
        id: 5,
        name: "command_runs_enriched",
        up: (db) => {
            addColumnIfMissing(db, "command_runs", "git_branch", "git_branch TEXT");
            addColumnIfMissing(db, "command_runs", "git_base_branch", "git_base_branch TEXT");
            addColumnIfMissing(db, "command_runs", "agent", "agent TEXT");
            addColumnIfMissing(db, "command_runs", "started_at", "started_at TEXT");
            addColumnIfMissing(db, "command_runs", "completed_at", "completed_at TEXT");
            addColumnIfMissing(db, "command_runs", "summary", "summary TEXT");
        },
    },
    {
        id: 6,
        name: "token_usage_enriched",
        up: (db) => {
            addColumnIfMissing(db, "token_usage", "operation_id", "operation_id TEXT");
            addColumnIfMissing(db, "token_usage", "action", "action TEXT");
            addColumnIfMissing(db, "token_usage", "model", "model TEXT");
            addColumnIfMissing(db, "token_usage", "cost_estimate", "cost_estimate REAL");
        },
    },
    {
        id: 7,
        name: "token_usage_run_links",
        up: (db) => {
            addColumnIfMissing(db, "token_usage", "command_run_id", "command_run_id INTEGER");
            addColumnIfMissing(db, "token_usage", "task_run_id", "task_run_id INTEGER");
        },
    },
    {
        id: 8,
        name: "jobs_section19_alignment",
        up: (db) => {
            addColumnIfMissing(db, "jobs", "type", "type TEXT");
            addColumnIfMissing(db, "jobs", "command_name", "command_name TEXT");
            addColumnIfMissing(db, "jobs", "workspace_id", "workspace_id TEXT");
            addColumnIfMissing(db, "jobs", "project_id", "project_id TEXT");
            addColumnIfMissing(db, "jobs", "epic_id", "epic_id TEXT");
            addColumnIfMissing(db, "jobs", "user_story_id", "user_story_id TEXT");
            addColumnIfMissing(db, "jobs", "task_id", "task_id TEXT");
            addColumnIfMissing(db, "jobs", "agent_id", "agent_id TEXT");
            addColumnIfMissing(db, "jobs", "job_state", "job_state TEXT");
            addColumnIfMissing(db, "jobs", "job_state_detail", "job_state_detail TEXT");
            addColumnIfMissing(db, "jobs", "total_units", "total_units INTEGER");
            addColumnIfMissing(db, "jobs", "completed_units", "completed_units INTEGER");
            addColumnIfMissing(db, "jobs", "payload_json", "payload_json TEXT");
            addColumnIfMissing(db, "jobs", "result_json", "result_json TEXT");
            addColumnIfMissing(db, "jobs", "error_code", "error_code TEXT");
            addColumnIfMissing(db, "jobs", "error_message", "error_message TEXT");
            addColumnIfMissing(db, "jobs", "resume_supported", "resume_supported INTEGER DEFAULT 1");
            addColumnIfMissing(db, "jobs", "checkpoint_path", "checkpoint_path TEXT");
            addColumnIfMissing(db, "jobs", "started_at", "started_at TEXT");
            addColumnIfMissing(db, "jobs", "last_checkpoint_at", "last_checkpoint_at TEXT");
            addColumnIfMissing(db, "jobs", "completed_at", "completed_at TEXT");
            addColumnIfMissing(db, "jobs", "row_version", "row_version INTEGER NOT NULL DEFAULT 0");
            db.exec(`
        UPDATE jobs
        SET job_state = COALESCE(job_state, status),
            command_name = COALESCE(command_name, command),
            workspace_id = COALESCE(workspace_id, workspace),
            resume_supported = COALESCE(resume_supported, 1),
            row_version = COALESCE(row_version, 0);
      `);
        },
    },
    {
        id: 9,
        name: "tasks_epic_id_column",
        up: (db) => {
            addColumnIfMissing(db, "tasks", "epic_id", "epic_id TEXT");
        },
    },
];
export const runGlobalMigrations = (db) => {
    applyMigrations(db, globalMigrations, "global");
};
export const runWorkspaceMigrations = (db) => {
    applyMigrations(db, workspaceMigrations, "workspace");
};
