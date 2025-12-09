import sqlite3 from "sqlite3";
import deasync from "deasync";
const sync = (executor) => {
    let result;
    let error = null;
    let settled = false;
    executor((err, value) => {
        error = err;
        result = value;
        settled = true;
    });
    while (!settled) {
        deasync.runLoopOnce();
    }
    if (error)
        throw error;
    return result;
};
const isPlainObject = (value) => Boolean(value) && typeof value === "object" && !Array.isArray(value);
const normalizeParams = (params) => {
    if (params.length === 1 && isPlainObject(params[0])) {
        const original = params[0];
        const mapped = {};
        for (const [key, value] of Object.entries(original)) {
            if (key.startsWith("@") || key.startsWith(":") || key.startsWith("$")) {
                mapped[key] = value;
            }
            else {
                mapped[`@${key}`] = value;
            }
        }
        return [mapped];
    }
    return params;
};
class SyncStatement {
    constructor(stmt) {
        this.stmt = stmt;
    }
    run(...params) {
        const normalized = normalizeParams(params);
        try {
            return sync((cb) => {
                this.stmt.run(...normalized, function (err) {
                    cb(err, { lastInsertRowid: this.lastID ?? 0, changes: this.changes ?? 0 });
                });
            });
        }
        catch (error) {
            const details = { sql: this.stmt.sql, params: normalized };
            const message = `SQLite run failed${details.sql ? ` for "${details.sql}"` : ""}: ${JSON.stringify(details.params)}`;
            const suffix = error instanceof Error ? error.message : String(error);
            throw new Error(`${message}. Cause: ${suffix}`);
        }
    }
    get(...params) {
        const normalized = normalizeParams(params);
        return sync((cb) => {
            this.stmt.get(...normalized, (err, row) => cb(err, row));
        });
    }
    all(...params) {
        const normalized = normalizeParams(params);
        return sync((cb) => {
            this.stmt.all(...normalized, (err, rows) => cb(err, rows));
        });
    }
    finalize() {
        sync((cb) => this.stmt.finalize((err) => cb(err ?? null)));
    }
}
export default class Database {
    constructor(filename) {
        let created;
        let error = null;
        let settled = false;
        created = new sqlite3.Database(filename, (err) => {
            error = err;
            settled = true;
        });
        while (!settled) {
            deasync.runLoopOnce();
        }
        if (error)
            throw error;
        this.db = created;
    }
    prepare(sql) {
        return new SyncStatement(this.db.prepare(sql));
    }
    exec(sql) {
        sync((cb) => this.db.exec(sql, (err) => cb(err)));
    }
    pragma(sql) {
        const statement = sql.trim().toLowerCase().startsWith("pragma") ? sql : `PRAGMA ${sql}`;
        return sync((cb) => this.db.all(statement, (err, rows) => cb(err, rows)));
    }
    transaction(fn) {
        return ((...args) => {
            this.exec("BEGIN");
            try {
                const result = fn(...args);
                this.exec("COMMIT");
                return result;
            }
            catch (error) {
                this.exec("ROLLBACK");
                throw error;
            }
        });
    }
    close() {
        try {
            sync((cb) => this.db.close((err) => cb(err)));
        }
        catch (error) {
            if (!(error instanceof Error) || !error.message.includes("SQLITE_BUSY")) {
                throw error;
            }
        }
    }
}
