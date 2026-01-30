import { Database } from "sqlite";

/**
 * Global database migrations for ~/.mcoda/mcoda.db.
 * Only includes tables required for the agent registry and routing defaults.
 */
export class GlobalMigrations {
  static async run(db: Database): Promise<void> {
    const createSchema = async (): Promise<void> => {
      await db.exec(`
      CREATE TABLE IF NOT EXISTS agents (
        id TEXT PRIMARY KEY,
        slug TEXT UNIQUE NOT NULL,
        adapter TEXT NOT NULL,
        default_model TEXT,
        openai_compatible INTEGER,
        context_window INTEGER,
        max_output_tokens INTEGER,
        supports_tools INTEGER,
        rating INTEGER,
        reasoning_rating INTEGER,
        best_usage TEXT,
        cost_per_million REAL,
        max_complexity INTEGER,
        rating_samples INTEGER,
        rating_last_score REAL,
        rating_updated_at TEXT,
        complexity_samples INTEGER,
        complexity_updated_at TEXT,
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
        command_name TEXT,
        action TEXT,
        invocation_kind TEXT,
        provider TEXT,
        currency TEXT,
        tokens_prompt INTEGER,
        tokens_completion INTEGER,
        tokens_total INTEGER,
        tokens_cached INTEGER,
        tokens_cache_read INTEGER,
        tokens_cache_write INTEGER,
        cost_estimate REAL,
        duration_seconds REAL,
        duration_ms REAL,
        started_at TEXT,
        finished_at TEXT,
        timestamp TEXT NOT NULL,
        metadata_json TEXT
      );

      CREATE INDEX IF NOT EXISTS idx_token_usage_command_run_id ON token_usage(command_run_id);

      CREATE TABLE IF NOT EXISTS agent_run_ratings (
        id TEXT PRIMARY KEY,
        agent_id TEXT NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
        job_id TEXT,
        command_run_id TEXT,
        task_id TEXT,
        task_key TEXT,
        command_name TEXT,
        discipline TEXT,
        complexity INTEGER,
        quality_score REAL,
        tokens_total INTEGER,
        duration_seconds REAL,
        iterations INTEGER,
        total_cost REAL,
        run_score REAL,
        rating_version TEXT,
        raw_review_json TEXT,
        created_at TEXT NOT NULL
      );
    `);
    };

    await createSchema();

    let agentsInfo = await db.all<any[]>("PRAGMA table_info(agents)");
    const hasAgentId = agentsInfo.some((col) => col.name === "id");
    const hasAgentSlug = agentsInfo.some((col) => col.name === "slug");

    // If the agents table is from a legacy schema (name/provider/model), reset the global DB schema.
    if (!hasAgentId || !hasAgentSlug) {
      await db.exec(`
        DROP TABLE IF EXISTS agent_auth;
        DROP TABLE IF EXISTS agent_capabilities;
        DROP TABLE IF EXISTS agent_prompts;
        DROP TABLE IF EXISTS agent_health;
        DROP TABLE IF EXISTS agent_models;
        DROP TABLE IF EXISTS workspace_defaults;
        DROP TABLE IF EXISTS command_runs;
        DROP TABLE IF EXISTS token_usage;
        DROP TABLE IF EXISTS routing_rules;
        DROP TABLE IF EXISTS agent_secrets;
        DROP TABLE IF EXISTS releases;
        DROP TABLE IF EXISTS schema_migrations;
        DROP TABLE IF EXISTS agents;
      `);
      await createSchema();
    }

    agentsInfo = await db.all<any[]>("PRAGMA table_info(agents)");
    const hasAgentRating = agentsInfo.some((col) => col.name === "rating");
    const hasAgentReasoningRating = agentsInfo.some((col) => col.name === "reasoning_rating");
    const hasAgentBestUsage = agentsInfo.some((col) => col.name === "best_usage");
    const hasAgentCost = agentsInfo.some((col) => col.name === "cost_per_million");
    const hasAgentMaxComplexity = agentsInfo.some((col) => col.name === "max_complexity");
    const hasAgentOpenaiCompatible = agentsInfo.some((col) => col.name === "openai_compatible");
    const hasAgentContextWindow = agentsInfo.some((col) => col.name === "context_window");
    const hasAgentMaxOutputTokens = agentsInfo.some((col) => col.name === "max_output_tokens");
    const hasAgentSupportsTools = agentsInfo.some((col) => col.name === "supports_tools");
    const hasAgentRatingSamples = agentsInfo.some((col) => col.name === "rating_samples");
    const hasAgentRatingLastScore = agentsInfo.some((col) => col.name === "rating_last_score");
    const hasAgentRatingUpdatedAt = agentsInfo.some((col) => col.name === "rating_updated_at");
    const hasAgentComplexitySamples = agentsInfo.some((col) => col.name === "complexity_samples");
    const hasAgentComplexityUpdatedAt = agentsInfo.some((col) => col.name === "complexity_updated_at");
    if (!hasAgentRating) {
      await db.exec("ALTER TABLE agents ADD COLUMN rating INTEGER");
    }
    if (!hasAgentReasoningRating) {
      await db.exec("ALTER TABLE agents ADD COLUMN reasoning_rating INTEGER");
    }
    if (!hasAgentBestUsage) {
      await db.exec("ALTER TABLE agents ADD COLUMN best_usage TEXT");
    }
    if (!hasAgentCost) {
      await db.exec("ALTER TABLE agents ADD COLUMN cost_per_million REAL");
    }
    if (!hasAgentMaxComplexity) {
      await db.exec("ALTER TABLE agents ADD COLUMN max_complexity INTEGER");
    }
    if (!hasAgentOpenaiCompatible) {
      await db.exec("ALTER TABLE agents ADD COLUMN openai_compatible INTEGER");
    }
    if (!hasAgentContextWindow) {
      await db.exec("ALTER TABLE agents ADD COLUMN context_window INTEGER");
    }
    if (!hasAgentMaxOutputTokens) {
      await db.exec("ALTER TABLE agents ADD COLUMN max_output_tokens INTEGER");
    }
    if (!hasAgentSupportsTools) {
      await db.exec("ALTER TABLE agents ADD COLUMN supports_tools INTEGER");
    }
    if (!hasAgentRatingSamples) {
      await db.exec("ALTER TABLE agents ADD COLUMN rating_samples INTEGER");
    }
    if (!hasAgentRatingLastScore) {
      await db.exec("ALTER TABLE agents ADD COLUMN rating_last_score REAL");
    }
    if (!hasAgentRatingUpdatedAt) {
      await db.exec("ALTER TABLE agents ADD COLUMN rating_updated_at TEXT");
    }
    if (!hasAgentComplexitySamples) {
      await db.exec("ALTER TABLE agents ADD COLUMN complexity_samples INTEGER");
    }
    if (!hasAgentComplexityUpdatedAt) {
      await db.exec("ALTER TABLE agents ADD COLUMN complexity_updated_at TEXT");
    }

    await db.exec(`
      UPDATE agents
      SET openai_compatible = CASE
        WHEN adapter IN ('openai-api') THEN 1
        ELSE 0
      END
      WHERE openai_compatible IS NULL
    `);
    await db.exec(`
      UPDATE agents
      SET supports_tools = CASE
        WHEN adapter IN ('openai-api','openai-cli','codex-cli') THEN 1
        ELSE 0
      END
      WHERE supports_tools IS NULL
    `);
    await db.exec(`
      UPDATE agents
      SET context_window = COALESCE(context_window, 8192)
      WHERE context_window IS NULL
    `);
    await db.exec(`
      UPDATE agents
      SET max_output_tokens = COALESCE(max_output_tokens, 2048)
      WHERE max_output_tokens IS NULL
    `);

    const tokenUsageInfo = await db.all<any[]>("PRAGMA table_info(token_usage)");
    const tokenUsageColumns = new Set(tokenUsageInfo.map((col) => col.name));
    const ensureTokenUsageColumn = async (columnDef: string, name: string): Promise<void> => {
      if (tokenUsageColumns.has(name)) return;
      await db.exec(`ALTER TABLE token_usage ADD COLUMN ${columnDef}`);
    };
    await ensureTokenUsageColumn("command_name TEXT", "command_name");
    await ensureTokenUsageColumn("action TEXT", "action");
    await ensureTokenUsageColumn("invocation_kind TEXT", "invocation_kind");
    await ensureTokenUsageColumn("provider TEXT", "provider");
    await ensureTokenUsageColumn("currency TEXT", "currency");
    await ensureTokenUsageColumn("tokens_cached INTEGER", "tokens_cached");
    await ensureTokenUsageColumn("tokens_cache_read INTEGER", "tokens_cache_read");
    await ensureTokenUsageColumn("tokens_cache_write INTEGER", "tokens_cache_write");
    await ensureTokenUsageColumn("duration_ms REAL", "duration_ms");
    await ensureTokenUsageColumn("started_at TEXT", "started_at");
    await ensureTokenUsageColumn("finished_at TEXT", "finished_at");

    await db.exec(`
      UPDATE agents
      SET
        rating = COALESCE(
          rating,
          CASE
            WHEN lower(slug) = 'codex-deputy' THEN 9.2
            WHEN lower(slug) = 'gemini-junior' THEN 7.0
            WHEN lower(slug) = 'gemini-deep-read' THEN 9.9
            WHEN lower(slug) = 'codex-stabilizer' THEN 9.0
            WHEN lower(slug) = 'gemini-consultant' THEN 7.5
            WHEN lower(slug) = 'codex-test-lead' THEN 9.0
            WHEN lower(slug) = 'gemini-scribe' THEN 7.0
            WHEN lower(slug) = 'gemini-stable' THEN 9.8
            WHEN lower(slug) = 'glm-hotfix' THEN 9.0
            WHEN lower(slug) = 'gateway-router' THEN 10
            WHEN lower(slug) = 'codex-architect' THEN 10
            WHEN lower(slug) = 'glm-worker' THEN 9
            WHEN lower(slug) = 'gemini-architect' THEN 9
            WHEN lower(slug) = 'devstral-local' THEN 6
            WHEN lower(slug) = 'gpt-oss-qa' THEN 9
            WHEN lower(default_model) LIKE '%gpt-5.2-codex%' OR lower(slug) LIKE '%gpt-5.2-codex%' THEN 10
            WHEN lower(default_model) LIKE '%gpt-5.1-codex-max%' OR lower(slug) LIKE '%gpt-5.1-codex-max%' THEN 9
            WHEN lower(default_model) LIKE '%glm-4.7%' OR lower(slug) LIKE '%glm-4.7%' THEN 6
            WHEN lower(default_model) LIKE '%devstral-small-2%' OR lower(slug) LIKE '%devstral-small-2%' THEN 4
            WHEN lower(default_model) LIKE '%gpt-oss:20b%' OR lower(slug) LIKE '%gpt-oss:20b%' THEN 3
            WHEN lower(slug) LIKE '%codex%' OR lower(default_model) LIKE '%codex%' THEN 5
            WHEN lower(slug) LIKE '%gemini%' OR lower(default_model) LIKE '%gemini%' THEN 4
            WHEN lower(slug) LIKE '%glm%' OR lower(default_model) LIKE '%glm%' THEN 3
            WHEN lower(slug) LIKE '%devstral%' OR lower(default_model) LIKE '%devstral%' THEN 2
            WHEN lower(slug) LIKE '%ollama%' OR lower(adapter) LIKE 'ollama%' THEN 2
            WHEN lower(adapter) LIKE 'qa%' THEN 3
            ELSE 3
          END
        ),
        reasoning_rating = COALESCE(
          reasoning_rating,
          CASE
            WHEN lower(slug) = 'codex-deputy' THEN 8.9
            WHEN lower(slug) = 'gemini-junior' THEN 6.5
            WHEN lower(slug) = 'gemini-deep-read' THEN 9.0
            WHEN lower(slug) = 'codex-stabilizer' THEN 8.5
            WHEN lower(slug) = 'gemini-consultant' THEN 7.0
            WHEN lower(slug) = 'codex-test-lead' THEN 8.5
            WHEN lower(slug) = 'gemini-scribe' THEN 6.5
            WHEN lower(slug) = 'gemini-stable' THEN 8.8
            WHEN lower(slug) = 'glm-hotfix' THEN 8.5
            WHEN lower(slug) = 'gateway-router' THEN 10
            WHEN lower(slug) = 'codex-architect' THEN 10
            WHEN lower(slug) = 'glm-worker' THEN 9
            WHEN lower(slug) = 'gemini-architect' THEN 8
            WHEN lower(slug) = 'devstral-local' THEN 6
            WHEN lower(slug) = 'gpt-oss-qa' THEN 8
            WHEN lower(default_model) LIKE '%gpt-5.2-codex%' OR lower(slug) LIKE '%gpt-5.2-codex%' THEN 10
            WHEN lower(default_model) LIKE '%gpt-5.1-codex-max%' OR lower(slug) LIKE '%gpt-5.1-codex-max%' THEN 9
            WHEN lower(default_model) LIKE '%gemini-3-pro%' OR lower(slug) LIKE '%gemini-3-pro%' THEN 8
            WHEN lower(default_model) LIKE '%glm-4.7%' OR lower(slug) LIKE '%glm-4.7%' THEN 6
            WHEN lower(default_model) LIKE '%devstral-small-2%' OR lower(slug) LIKE '%devstral-small-2%' THEN 4
            WHEN lower(default_model) LIKE '%gpt-oss:20b%' OR lower(slug) LIKE '%gpt-oss:20b%' THEN 3
            WHEN lower(slug) LIKE '%codex%' OR lower(default_model) LIKE '%codex%' THEN 7
            WHEN lower(slug) LIKE '%gemini%' OR lower(default_model) LIKE '%gemini%' THEN 6
            WHEN lower(slug) LIKE '%glm%' OR lower(default_model) LIKE '%glm%' THEN 5
            WHEN lower(slug) LIKE '%devstral%' OR lower(default_model) LIKE '%devstral%' THEN 4
            WHEN lower(slug) LIKE '%ollama%' OR lower(adapter) LIKE 'ollama%' THEN 3
            WHEN lower(adapter) LIKE 'qa%' THEN 5
            ELSE 4
          END
        ),
        best_usage = COALESCE(
          best_usage,
          CASE
            WHEN lower(slug) = 'codex-deputy' THEN 'code_review_secondary'
            WHEN lower(slug) = 'gemini-junior' THEN 'log_analysis'
            WHEN lower(slug) = 'gemini-deep-read' THEN 'deep_research'
            WHEN lower(slug) = 'codex-stabilizer' THEN 'legacy_maintenance'
            WHEN lower(slug) = 'gemini-consultant' THEN 'alternative_solution_generation'
            WHEN lower(slug) = 'codex-test-lead' THEN 'test_strategy'
            WHEN lower(slug) = 'gemini-scribe' THEN 'doc_polish'
            WHEN lower(slug) = 'gemini-stable' THEN 'production_verification'
            WHEN lower(slug) = 'glm-hotfix' THEN 'rapid_prototyping'
            WHEN lower(slug) = 'gateway-router' THEN 'orchestration'
            WHEN lower(slug) = 'codex-architect' THEN 'architectural_design'
            WHEN lower(slug) = 'glm-worker' THEN 'code_write'
            WHEN lower(slug) = 'gemini-architect' THEN 'doc_generation'
            WHEN lower(slug) = 'devstral-local' THEN 'coding_light'
            WHEN lower(slug) = 'gpt-oss-qa' THEN 'qa_testing'
            WHEN lower(slug) LIKE '%devstral%' OR lower(default_model) LIKE '%devstral%' THEN 'coding'
            WHEN lower(slug) LIKE '%glm%' OR lower(default_model) LIKE '%glm%' THEN 'coding'
            WHEN lower(slug) LIKE '%codex%' OR lower(default_model) LIKE '%codex%' THEN 'code_write'
            WHEN lower(slug) LIKE '%gemini%' OR lower(default_model) LIKE '%gemini%' THEN 'ui_ux_docs'
            WHEN lower(adapter) LIKE 'qa%' THEN 'qa'
            WHEN lower(slug) LIKE '%ollama%' OR lower(adapter) LIKE 'ollama%' THEN 'coding'
            ELSE 'general'
          END
        ),
        cost_per_million = COALESCE(
          cost_per_million,
          CASE
            WHEN lower(slug) = 'codex-deputy' THEN 10.0
            WHEN lower(slug) = 'gemini-junior' THEN 2.5
            WHEN lower(slug) = 'gemini-deep-read' THEN 18.0
            WHEN lower(slug) = 'codex-stabilizer' THEN 10.0
            WHEN lower(slug) = 'gemini-consultant' THEN 15.0
            WHEN lower(slug) = 'codex-test-lead' THEN 10.0
            WHEN lower(slug) = 'gemini-scribe' THEN 2.5
            WHEN lower(slug) = 'gemini-stable' THEN 18.0
            WHEN lower(slug) = 'glm-hotfix' THEN 2.2
            WHEN lower(slug) = 'gemini-architect' THEN 3.0
            WHEN lower(slug) = 'gateway-router' THEN 14.0
            WHEN lower(slug) = 'codex-architect' THEN 14.0
            WHEN lower(slug) = 'glm-worker' THEN 2.2
            WHEN lower(slug) = 'devstral-local' THEN 0
            WHEN lower(slug) = 'gpt-oss-qa' THEN 0
            WHEN lower(adapter) LIKE 'ollama%' OR lower(adapter) = 'local-model' OR lower(adapter) = 'qa-cli' THEN 0
            WHEN lower(default_model) LIKE '%gpt-5.2%' OR lower(slug) LIKE '%gpt-5.2%' THEN 14.0
            WHEN lower(default_model) LIKE '%glm-4.7%' OR lower(slug) LIKE '%glm-4.7%' THEN 2.2
            WHEN lower(default_model) LIKE '%gpt-5.1%' AND (lower(default_model) LIKE '%codex%' OR lower(slug) LIKE '%codex%') THEN 10.0
            WHEN lower(default_model) LIKE '%gemini-3-pro%' OR lower(slug) LIKE '%gemini-3-pro%' THEN 18.0
            WHEN lower(default_model) LIKE '%devstral%' OR lower(slug) LIKE '%devstral%' THEN 0
            ELSE NULL
          END
        )
      WHERE rating IS NULL OR reasoning_rating IS NULL OR best_usage IS NULL OR cost_per_million IS NULL;
    `);

    await db.exec(`
      UPDATE agents
      SET
        max_complexity = COALESCE(max_complexity, 5),
        rating_samples = COALESCE(rating_samples, 0),
        rating_last_score = COALESCE(rating_last_score, rating),
        rating_updated_at = COALESCE(rating_updated_at, updated_at),
        complexity_samples = COALESCE(complexity_samples, 0),
        complexity_updated_at = COALESCE(complexity_updated_at, updated_at)
      WHERE max_complexity IS NULL
         OR rating_samples IS NULL
         OR rating_last_score IS NULL
         OR rating_updated_at IS NULL
         OR complexity_samples IS NULL
         OR complexity_updated_at IS NULL;
    `);

    const workspaceDefaultsInfo = await db.all<any[]>("PRAGMA table_info(workspace_defaults)");
    const hasWorkspaceId = workspaceDefaultsInfo.some((col) => col.name === "workspace_id");
    const hasWorkspace = workspaceDefaultsInfo.some((col) => col.name === "workspace");
    const hasQaProfile = workspaceDefaultsInfo.some((col) => col.name === "qa_profile");
    const hasDocdexScope = workspaceDefaultsInfo.some((col) => col.name === "docdex_scope");

    // Migrate legacy workspace_defaults schema: workspace -> workspace_id, default_agent -> agent_id, add command_name.
    if (!hasWorkspaceId) {
      if (hasWorkspace) {
        await db.exec("ALTER TABLE workspace_defaults RENAME TO workspace_defaults_legacy");
        await db.exec(`
          CREATE TABLE workspace_defaults (
            workspace_id TEXT NOT NULL,
            command_name TEXT NOT NULL,
            agent_id TEXT NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
            qa_profile TEXT,
            docdex_scope TEXT,
            updated_at TEXT NOT NULL,
            PRIMARY KEY (workspace_id, command_name)
          );
        `);
        const legacyRows = await db.all<any[]>(
          "SELECT workspace, default_agent, qa_profile, docdex_scope, updated_at FROM workspace_defaults_legacy",
        );
        for (const row of legacyRows) {
          await db.run(
            `INSERT OR IGNORE INTO workspace_defaults (workspace_id, command_name, agent_id, qa_profile, docdex_scope, updated_at)
             VALUES (?, ?, ?, ?, ?, ?)`,
            row.workspace,
            "default",
            row.default_agent,
            row.qa_profile ?? null,
            row.docdex_scope ?? null,
            row.updated_at ?? new Date().toISOString(),
          );
        }
        await db.exec("DROP TABLE workspace_defaults_legacy");
      } else {
        // If the table exists but has an unknown shape, reset to the expected schema.
        await db.exec("DROP TABLE IF EXISTS workspace_defaults");
        await db.exec(`
          CREATE TABLE IF NOT EXISTS workspace_defaults (
            workspace_id TEXT NOT NULL,
            command_name TEXT NOT NULL,
            agent_id TEXT NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
            qa_profile TEXT,
            docdex_scope TEXT,
            updated_at TEXT NOT NULL,
            PRIMARY KEY (workspace_id, command_name)
          );
        `);
      }
    } else {
      if (!hasQaProfile) {
        await db.exec("ALTER TABLE workspace_defaults ADD COLUMN qa_profile TEXT");
      }
      if (!hasDocdexScope) {
        await db.exec("ALTER TABLE workspace_defaults ADD COLUMN docdex_scope TEXT");
      }
    }

    const ensureCapabilities = async (slug: string, capabilities: string[]): Promise<void> => {
      const row = (await db.get("SELECT id FROM agents WHERE lower(slug) = ?", slug.toLowerCase())) as
        | { id: string }
        | undefined;
      if (!row?.id) return;
      for (const capability of capabilities) {
        await db.run("INSERT OR IGNORE INTO agent_capabilities (agent_id, capability) VALUES (?, ?)", row.id, capability);
      }
    };

    await ensureCapabilities("gateway-router", ["plan", "docdex_query"]);
  }
}
