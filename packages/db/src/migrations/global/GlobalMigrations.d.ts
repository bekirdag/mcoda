import { Database } from "sqlite";
/**
 * Global database migrations for ~/.mcoda/mcoda.db.
 * Only includes tables required for the agent registry and routing defaults.
 */
export declare class GlobalMigrations {
    static run(db: Database): Promise<void>;
}
//# sourceMappingURL=GlobalMigrations.d.ts.map