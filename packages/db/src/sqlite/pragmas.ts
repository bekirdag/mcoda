import { Database } from "sqlite";

export class Pragmas {
  static async apply(db: Database): Promise<void> {
    await db.exec("PRAGMA foreign_keys = ON;");
    await db.exec("PRAGMA journal_mode = WAL;");
  }
}
