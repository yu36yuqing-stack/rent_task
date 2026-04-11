const { openMainDatabase } = require('./sqlite_client');

function nowText() {
    const d = new Date();
    const p = (n) => String(n).padStart(2, '0');
    return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
}

function run(db, sql, params = []) {
    return new Promise((resolve, reject) => {
        db.run(sql, params, function onRun(err) {
            if (err) return reject(err);
            resolve(this);
        });
    });
}

function all(db, sql, params = []) {
    return new Promise((resolve, reject) => {
        db.all(sql, params, (err, rows) => {
            if (err) return reject(err);
            resolve(rows || []);
        });
    });
}

async function initSchemaMigrationDb() {
    const db = openMainDatabase();
    try {
        await run(db, `
            CREATE TABLE IF NOT EXISTS schema_migration (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                version TEXT NOT NULL DEFAULT '',
                name TEXT NOT NULL DEFAULT '',
                create_date TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
                modify_date TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
                is_deleted INTEGER NOT NULL DEFAULT 0,
                desc TEXT NOT NULL DEFAULT ''
            )
        `);
        await run(db, `
            CREATE UNIQUE INDEX IF NOT EXISTS uq_schema_migration_alive
            ON schema_migration(version, is_deleted)
        `);
    } finally {
        db.close();
    }
}

async function listAppliedSchemaMigrations() {
    await initSchemaMigrationDb();
    const db = openMainDatabase();
    try {
        return await all(db, `
            SELECT version, name, create_date, modify_date, desc
            FROM schema_migration
            WHERE is_deleted = 0
            ORDER BY version ASC, id ASC
        `);
    } finally {
        db.close();
    }
}

async function markSchemaMigrationApplied(version, name, desc = '') {
    await initSchemaMigrationDb();
    const db = openMainDatabase();
    try {
        await run(db, `
            INSERT OR IGNORE INTO schema_migration
            (version, name, create_date, modify_date, is_deleted, desc)
            VALUES (?, ?, ?, ?, 0, ?)
        `, [String(version || ''), String(name || ''), nowText(), nowText(), String(desc || '')]);
    } finally {
        db.close();
    }
}

module.exports = {
    initSchemaMigrationDb,
    listAppliedSchemaMigrations,
    markSchemaMigrationApplied
};
