import { Database } from "sqlite";
import { Connection } from "../../sqlite/connection.js";
/**
 * Workspace repository placeholder. The focus of this task is on global agents,
 * but we keep a symmetric API for callers that need a workspace DB handle.
 */
export declare class WorkspaceRepository {
    private db;
    private connection?;
    constructor(db: Database, connection?: Connection | undefined);
    static create(cwd?: string): Promise<WorkspaceRepository>;
    close(): Promise<void>;
}
//# sourceMappingURL=WorkspaceRepository.d.ts.map