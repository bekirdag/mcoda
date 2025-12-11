import { Database } from "sqlite";

/**
 * Global database migrations for ~/.mcoda/mcoda.db.
 * Only includes tables required for the agent registry and routing defaults.
 */
export class GlobalMigrations {
  static async run(db: Database): Promise<void> {
    await db.exec(`
      CREATE TABLE IF NOT EXISTS agents (
        id TEXT PRIMARY KEY,
        slug TEXT UNIQUE NOT NULL,
        adapter TEXT NOT NULL,
        default_model TEXT,
        config_json TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS agent_auth (
        agent_id TEXT PRIMARY KEY REFERENCES agents(id) ON DELETE CASCADE,
        encrypted_secret TEXT NOT NULL,
        last_verified_at TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS agent_capabilities (
        agent_id TEXT NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
        capability TEXT NOT NULL,
        PRIMARY KEY (agent_id, capability)
      );

      CREATE TABLE IF NOT EXISTS agent_prompts (
        agent_id TEXT PRIMARY KEY REFERENCES agents(id) ON DELETE CASCADE,
        job_prompt TEXT,
        character_prompt TEXT,
        command_prompts_json TEXT,
        job_path TEXT,
        character_path TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS agent_health (
        agent_id TEXT PRIMARY KEY REFERENCES agents(id) ON DELETE CASCADE,
        status TEXT NOT NULL,
        last_checked_at TEXT NOT NULL,
        latency_ms INTEGER,
        details_json TEXT
      );

      CREATE TABLE IF NOT EXISTS agent_models (
        agent_id TEXT NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
        model_name TEXT NOT NULL,
        is_default INTEGER DEFAULT 0,
        config_json TEXT,
        PRIMARY KEY (agent_id, model_name)
      );

      CREATE TABLE IF NOT EXISTS workspace_defaults (
        workspace_id TEXT NOT NULL,
        command_name TEXT NOT NULL,
        agent_id TEXT NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
        qa_profile TEXT,
        docdex_scope TEXT,
        updated_at TEXT NOT NULL,
        PRIMARY KEY (workspace_id, command_name)
      );

      CREATE TABLE IF NOT EXISTS command_runs (
        id TEXT PRIMARY KEY,
        command_name TEXT NOT NULL,
        started_at TEXT NOT NULL,
        completed_at TEXT,
        status TEXT NOT NULL,
        exit_code INTEGER,
        error_summary TEXT,
        payload_json TEXT,
        result_json TEXT
      );

      CREATE TABLE IF NOT EXISTS token_usage (
        id TEXT PRIMARY KEY,
        agent_id TEXT REFERENCES agents(id) ON DELETE SET NULL,
        command_run_id TEXT REFERENCES command_runs(id) ON DELETE SET NULL,
        model_name TEXT,
        tokens_prompt INTEGER,
        tokens_completion INTEGER,
        tokens_total INTEGER,
        cost_estimate REAL,
        duration_seconds REAL,
        timestamp TEXT NOT NULL,
        metadata_json TEXT
      );

      CREATE INDEX IF NOT EXISTS idx_token_usage_command_run_id ON token_usage(command_run_id);
    `);

    const workspaceDefaultsInfo = await db.all<any[]>("PRAGMA table_info(workspace_defaults)");
    const hasQaProfile = workspaceDefaultsInfo.some((col) => col.name === "qa_profile");
    const hasDocdexScope = workspaceDefaultsInfo.some((col) => col.name === "docdex_scope");
    if (!hasQaProfile) {
      await db.exec("ALTER TABLE workspace_defaults ADD COLUMN qa_profile TEXT");
    }
    if (!hasDocdexScope) {
      await db.exec("ALTER TABLE workspace_defaults ADD COLUMN docdex_scope TEXT");
    }
  }
}
