import { Database } from "sqlite";

/**
 * Workspace database migrations for the local `.mcoda/mcoda.db` file.
 * The schema matches the planning/task model defined in the SDS.
 */
export class WorkspaceMigrations {
  static async run(db: Database): Promise<void> {
    await db.exec(`
      PRAGMA foreign_keys = ON;

      -- Drop legacy placeholder tables so the new schema is applied consistently.
      DROP TABLE IF EXISTS job_checkpoints;
      DROP TABLE IF EXISTS jobs;
      DROP TABLE IF EXISTS command_runs;
      DROP TABLE IF EXISTS token_usage;
      DROP TABLE IF EXISTS task_dependencies;
      DROP TABLE IF EXISTS task_logs;
      DROP TABLE IF EXISTS task_runs;
      DROP TABLE IF EXISTS tasks;
      DROP TABLE IF EXISTS user_stories;
      DROP TABLE IF EXISTS epics;
      DROP TABLE IF EXISTS projects;

      CREATE TABLE projects (
        id TEXT PRIMARY KEY,
        key TEXT NOT NULL UNIQUE,
        name TEXT,
        description TEXT,
        metadata_json TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );

      CREATE TABLE epics (
        id TEXT PRIMARY KEY,
        project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
        key TEXT NOT NULL,
        title TEXT NOT NULL,
        description TEXT,
        story_points_total REAL,
        priority INTEGER,
        metadata_json TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        UNIQUE(project_id, key)
      );

      CREATE TABLE user_stories (
        id TEXT PRIMARY KEY,
        project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
        epic_id TEXT NOT NULL REFERENCES epics(id) ON DELETE CASCADE,
        key TEXT NOT NULL,
        title TEXT NOT NULL,
        description TEXT,
        acceptance_criteria TEXT,
        story_points_total REAL,
        priority INTEGER,
        metadata_json TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        UNIQUE(epic_id, key)
      );

      CREATE TABLE tasks (
        id TEXT PRIMARY KEY,
        project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
        epic_id TEXT NOT NULL REFERENCES epics(id) ON DELETE CASCADE,
        user_story_id TEXT NOT NULL REFERENCES user_stories(id) ON DELETE CASCADE,
        key TEXT NOT NULL,
        title TEXT NOT NULL,
        description TEXT,
        type TEXT,
        status TEXT NOT NULL,
        story_points REAL,
        priority INTEGER,
        assigned_agent_id TEXT,
        assignee_human TEXT,
        vcs_branch TEXT,
        vcs_base_branch TEXT,
        vcs_last_commit_sha TEXT,
        metadata_json TEXT,
        openapi_version_at_creation TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        UNIQUE(user_story_id, key)
      );

      CREATE TABLE task_dependencies (
        id TEXT PRIMARY KEY,
        task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
        depends_on_task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
        relation_type TEXT NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        UNIQUE(task_id, depends_on_task_id, relation_type)
      );

      CREATE TABLE jobs (
        id TEXT PRIMARY KEY,
        workspace_id TEXT NOT NULL,
        type TEXT NOT NULL,
        state TEXT NOT NULL,
        command_name TEXT,
        payload_json TEXT,
        total_items INTEGER,
        processed_items INTEGER,
        last_checkpoint TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        completed_at TEXT,
        error_summary TEXT
      );

      CREATE TABLE command_runs (
        id TEXT PRIMARY KEY,
        workspace_id TEXT NOT NULL,
        command_name TEXT NOT NULL,
        job_id TEXT REFERENCES jobs(id) ON DELETE SET NULL,
        task_ids_json TEXT,
        git_branch TEXT,
        git_base_branch TEXT,
        started_at TEXT NOT NULL,
        completed_at TEXT,
        status TEXT NOT NULL,
        error_summary TEXT,
        duration_seconds REAL,
        sp_processed REAL
      );

      CREATE TABLE task_runs (
        id TEXT PRIMARY KEY,
        task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
        command TEXT NOT NULL,
        job_id TEXT REFERENCES jobs(id) ON DELETE SET NULL,
        command_run_id TEXT REFERENCES command_runs(id) ON DELETE SET NULL,
        agent_id TEXT,
        status TEXT NOT NULL,
        started_at TEXT NOT NULL,
        finished_at TEXT,
        story_points_at_run REAL,
        sp_per_hour_effective REAL,
        git_branch TEXT,
        git_base_branch TEXT,
        git_commit_sha TEXT,
        run_context_json TEXT
      );

      CREATE TABLE task_logs (
        id TEXT PRIMARY KEY,
        task_run_id TEXT NOT NULL REFERENCES task_runs(id) ON DELETE CASCADE,
        sequence INTEGER NOT NULL,
        timestamp TEXT NOT NULL,
        level TEXT,
        source TEXT,
        message TEXT,
        details_json TEXT,
        UNIQUE(task_run_id, sequence)
      );

      CREATE TABLE task_revisions (
        id TEXT PRIMARY KEY,
        task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
        job_id TEXT,
        command_run_id TEXT,
        snapshot_before_json TEXT,
        snapshot_after_json TEXT,
        created_at TEXT NOT NULL
      );

      CREATE TABLE token_usage (
        id TEXT PRIMARY KEY,
        workspace_id TEXT NOT NULL,
        agent_id TEXT,
        model_name TEXT,
        job_id TEXT REFERENCES jobs(id) ON DELETE SET NULL,
        command_run_id TEXT REFERENCES command_runs(id) ON DELETE SET NULL,
        task_run_id TEXT REFERENCES task_runs(id) ON DELETE SET NULL,
        task_id TEXT REFERENCES tasks(id) ON DELETE SET NULL,
        project_id TEXT REFERENCES projects(id) ON DELETE SET NULL,
        epic_id TEXT REFERENCES epics(id) ON DELETE SET NULL,
        user_story_id TEXT REFERENCES user_stories(id) ON DELETE SET NULL,
        tokens_prompt INTEGER,
        tokens_completion INTEGER,
        tokens_total INTEGER,
        cost_estimate REAL,
        duration_seconds REAL,
        timestamp TEXT NOT NULL,
        metadata_json TEXT
      );
    `);
  }
}
