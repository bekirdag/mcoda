import { Database } from "sqlite";
/**
 * Workspace database migrations for `~/.mcoda/workspaces/<fingerprint>/mcoda.db`.
 * The schema matches the planning/task model defined in the SDS.
 */
export declare class WorkspaceMigrations {
    static run(db: Database): Promise<void>;
    private static ensureColumn;
}
//# sourceMappingURL=WorkspaceMigrations.d.ts.map