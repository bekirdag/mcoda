/**
 * Placeholder workspace migrations. For this task we only need workspace DB
 * path helpers, but providing a hook keeps the API symmetrical.
 */
export class WorkspaceMigrations {
    static async run(_db) {
        // No-op for now; workspace schemas are defined in other tasks.
    }
}
