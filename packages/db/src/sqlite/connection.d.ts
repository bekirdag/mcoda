import { Database } from "sqlite";
export declare class Connection {
    private database;
    constructor(database: Database);
    get db(): Database;
    static open(dbPath: string): Promise<Connection>;
    static openGlobal(): Promise<Connection>;
    static openWorkspace(cwd?: string): Promise<Connection>;
    close(): Promise<void>;
}
//# sourceMappingURL=connection.d.ts.map