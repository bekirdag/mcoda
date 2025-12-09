/**
 * Global database migrations for ~/.mcoda/mcoda.db.
 * Only includes tables required for the agent registry and routing defaults.
 */
export class GlobalMigrations {
    static async run(db) {
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
        updated_at TEXT NOT NULL,
        PRIMARY KEY (workspace_id, command_name)
      );
    `);
    }
}
