export class Pragmas {
    static async apply(db) {
        await db.exec("PRAGMA foreign_keys = ON;");
        await db.exec("PRAGMA journal_mode = WAL;");
        await db.exec("PRAGMA synchronous = NORMAL;");
        await db.exec("PRAGMA busy_timeout = 30000;");
    }
}
