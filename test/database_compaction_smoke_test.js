#!/usr/bin/env node
'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'database-compaction-'));
process.env.MAIN_DB_FILE_PATH = path.join(tempDir, 'main.db');
process.env.SQLITE_BUSY_TIMEOUT_MS = '20';

const { MAIN_DB_FILE, openMainDatabase } = require('../database/sqlite_client');
const {
    compactDatabaseIfNeeded,
    _internal
} = require('../maintenance/database_compaction_service');

function run(db, sql, params = []) {
    return new Promise((resolve, reject) => {
        db.run(sql, params, function onRun(err) {
            if (err) return reject(err);
            resolve(this);
        });
    });
}

(async () => {
    const db = openMainDatabase();
    try {
        await run(db, 'CREATE TABLE payloads (id INTEGER PRIMARY KEY, payload TEXT NOT NULL)');
        await run(db, 'BEGIN');
        for (let i = 0; i < 600; i += 1) {
            await run(db, 'INSERT INTO payloads(payload) VALUES (?)', [`${i}:${'x'.repeat(12 * 1024)}`]);
        }
        await run(db, 'COMMIT');
        await run(db, 'DELETE FROM payloads WHERE id <= 550');
        await run(db, 'PRAGMA wal_checkpoint(TRUNCATE)');
    } finally {
        db.close();
    }

    const compacted = await compactDatabaseIfNeeded({
        database_name: 'main',
        file_path: MAIN_DB_FILE,
        open_database: openMainDatabase,
        force: true,
        busy_timeout_ms: 20
    });
    assert.strictEqual(compacted.status, 'compacted');
    assert(compacted.before.file_bytes > compacted.after.file_bytes);
    assert(compacted.freed_bytes > 0);

    const belowThreshold = await compactDatabaseIfNeeded({
        database_name: 'main',
        file_path: MAIN_DB_FILE,
        open_database: openMainDatabase,
        min_free_ratio: 1,
        min_free_bytes: Number.MAX_SAFE_INTEGER,
        busy_timeout_ms: 20
    });
    assert.strictEqual(belowThreshold.status, 'skipped');
    assert.strictEqual(belowThreshold.reason, 'below_threshold');

    const holder = openMainDatabase();
    try {
        await run(holder, 'BEGIN EXCLUSIVE');
        const busy = await compactDatabaseIfNeeded({
            database_name: 'main',
            file_path: MAIN_DB_FILE,
            open_database: openMainDatabase,
            force: true,
            busy_timeout_ms: 20
        });
        assert.strictEqual(busy.status, 'skipped');
        assert.strictEqual(busy.reason, 'database_busy');
    } finally {
        await run(holder, 'ROLLBACK').catch(() => {});
        holder.close();
    }

    assert.strictEqual(_internal.isBusyError({ code: 'SQLITE_BUSY' }), true);
    assert.strictEqual(_internal.isBusyError({ message: 'database is locked' }), true);
    assert.strictEqual(_internal.isBusyError(new Error('other')), false);
    assert.strictEqual(_internal.fileBytes(path.join(tempDir, 'missing.db')), 0);

    console.log(`[PASS] database_compaction_smoke_test temp_dir=${tempDir}`);
})().catch((err) => {
    console.error(`[FAIL] database_compaction_smoke_test: ${err.stack || err.message}`);
    process.exit(1);
});
