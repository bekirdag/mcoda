import { Connection } from "../../sqlite/connection.js";
import { WorkspaceMigrations } from "../../migrations/workspace/WorkspaceMigrations.js";
/**
 * Workspace repository placeholder. The focus of this task is on global agents,
 * but we keep a symmetric API for callers that need a workspace DB handle.
 */
export class WorkspaceRepository {
    constructor(db, connection) {
        this.db = db;
        this.connection = connection;
    }
    static async create(cwd) {
        const connection = await Connection.openWorkspace(cwd);
        await WorkspaceMigrations.run(connection.db);
        return new WorkspaceRepository(connection.db, connection);
    }
    async close() {
        if (this.connection) {
            await this.connection.close();
        }
    }
}
