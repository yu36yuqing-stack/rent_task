const fs = require('fs');
const path = require('path');
const { openMainDatabase } = require('./sqlite_client');
const {
    initSchemaMigrationDb,
    listAppliedSchemaMigrations
} = require('./schema_migration_db');

const MIGRATIONS_DIR = path.join(__dirname, 'migrations');

function run(db, sql, params = []) {
    return new Promise((resolve, reject) => {
        db.run(sql, params, function onRun(err) {
            if (err) return reject(err);
            resolve(this);
        });
    });
}

function get(db, sql, params = []) {
    return new Promise((resolve, reject) => {
        db.get(sql, params, (err, row) => {
            if (err) return reject(err);
            resolve(row || null);
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

function loadRegisteredMigrations() {
    if (!fs.existsSync(MIGRATIONS_DIR)) return [];
    const files = fs.readdirSync(MIGRATIONS_DIR)
        .filter((name) => name.endsWith('.js'))
        .sort();
    const migrations = files.map((name) => {
        const fullPath = path.join(MIGRATIONS_DIR, name);
        const mod = require(fullPath);
        if (!mod || typeof mod !== 'object') throw new Error(`migration invalid: ${name}`);
        if (!String(mod.version || '').trim()) throw new Error(`migration version missing: ${name}`);
        if (!String(mod.name || '').trim()) throw new Error(`migration name missing: ${name}`);
        if (typeof mod.up !== 'function') throw new Error(`migration up() missing: ${name}`);
        return {
            ...mod,
            version: String(mod.version).trim(),
            name: String(mod.name).trim(),
            filename: name
        };
    });
    const versionSet = new Set();
    for (const migration of migrations) {
        if (versionSet.has(migration.version)) {
            throw new Error(`duplicate migration version: ${migration.version}`);
        }
        versionSet.add(migration.version);
    }
    return migrations.sort((a, b) => a.version.localeCompare(b.version));
}

async function listPendingMigrations() {
    await initSchemaMigrationDb();
    const applied = await listAppliedSchemaMigrations();
    const appliedSet = new Set(applied.map((row) => String(row.version || '').trim()));
    return loadRegisteredMigrations().filter((migration) => !appliedSet.has(migration.version));
}

async function runPendingMigrations(options = {}) {
    const logger = options.logger && typeof options.logger.log === 'function' ? options.logger : console;
    await initSchemaMigrationDb();
    const pending = await listPendingMigrations();
    const summary = {
        total_registered: loadRegisteredMigrations().length,
        pending_before: pending.length,
        applied: []
    };
    for (const migration of pending) {
        logger.log(`[Migration] applying version=${migration.version} name=${migration.name}`);
        const db = openMainDatabase();
        try {
            await run(db, 'BEGIN IMMEDIATE');
            await migration.up({
                db,
                run,
                get,
                all
            });
            await run(db, `
                INSERT OR IGNORE INTO schema_migration
                (version, name, create_date, modify_date, is_deleted, desc)
                VALUES (?, ?, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP, 0, ?)
            `, [migration.version, migration.name, String(migration.desc || migration.filename || '')]);
            await run(db, 'COMMIT');
        } catch (err) {
            await run(db, 'ROLLBACK').catch(() => {});
            throw new Error(`migration_failed version=${migration.version} name=${migration.name}: ${String(err && err.message ? err.message : err)}`);
        } finally {
            db.close();
        }
        summary.applied.push({
            version: migration.version,
            name: migration.name
        });
    }
    summary.pending_after = (await listPendingMigrations()).length;
    return summary;
}

async function assertNoPendingMigrations() {
    const pending = await listPendingMigrations();
    if (pending.length <= 0) return { ok: true, pending: [] };
    const versions = pending.map((migration) => `${migration.version}:${migration.name}`);
    throw new Error(`pending migrations: ${versions.join(', ')}`);
}

let ensureMigrationsReadyPromise = null;

async function ensureMigrationsReady(options = {}) {
    if (ensureMigrationsReadyPromise) return ensureMigrationsReadyPromise;
    ensureMigrationsReadyPromise = runPendingMigrations(options).catch((err) => {
        ensureMigrationsReadyPromise = null;
        throw err;
    });
    return ensureMigrationsReadyPromise;
}

module.exports = {
    MIGRATIONS_DIR,
    loadRegisteredMigrations,
    listPendingMigrations,
    runPendingMigrations,
    assertNoPendingMigrations,
    ensureMigrationsReady
};
