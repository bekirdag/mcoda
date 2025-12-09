import { open } from "sqlite";
import sqlite3 from "sqlite3";
import { PathHelper } from "@mcoda/shared";
import { Pragmas } from "./pragmas.js";
import path from "node:path";
export class Connection {
    constructor(database) {
        this.database = database;
    }
    get db() {
        return this.database;
    }
    static async open(dbPath) {
        await PathHelper.ensureDir(path.dirname(dbPath));
        const database = await open({
            filename: dbPath,
            driver: sqlite3.Database,
        });
        await Pragmas.apply(database);
        return new Connection(database);
    }
    static async openGlobal() {
        return this.open(PathHelper.getGlobalDbPath());
    }
    static async openWorkspace(cwd) {
        return this.open(PathHelper.getWorkspaceDbPath(cwd));
    }
    async close() {
        await this.database.close();
    }
}
