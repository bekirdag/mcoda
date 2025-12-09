export class Pragmas {
    static async apply(db) {
        await db.exec("PRAGMA foreign_keys = ON;");
        await db.exec("PRAGMA journal_mode = WAL;");
    }
}
