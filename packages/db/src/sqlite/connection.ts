import { Database, open } from "sqlite";
import sqlite3 from "sqlite3";
import { PathHelper } from "@mcoda/shared";
import { Pragmas } from "./pragmas.js";
import path from "node:path";

export class Connection {
  constructor(private database: Database, public readonly dbPath: string) {}

  get db(): Database {
    return this.database;
  }

  static async open(dbPath: string): Promise<Connection> {
    await PathHelper.ensureDir(path.dirname(dbPath));
    const database = await open({
      filename: dbPath,
      driver: sqlite3.Database,
    });
    await Pragmas.apply(database);
    return new Connection(database, dbPath);
  }

  static async openGlobal(): Promise<Connection> {
    return this.open(PathHelper.getGlobalDbPath());
  }

  static async openWorkspace(cwd?: string): Promise<Connection> {
    return this.open(PathHelper.getWorkspaceDbPath(cwd));
  }

  async close(): Promise<void> {
    await this.database.close();
  }
}
