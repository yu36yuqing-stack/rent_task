'use strict';

const fs = require('fs');

const DEFAULT_MIN_FREE_RATIO = 0.25;
const DEFAULT_MIN_FREE_BYTES = 8 * 1024 * 1024;
const DEFAULT_BUSY_TIMEOUT_MS = 1500;

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

function fileBytes(filePath) {
    try {
        return Math.max(0, Number(fs.statSync(filePath).size || 0));
    } catch {
        return 0;
    }
}

function isBusyError(err) {
    const code = String(err && err.code || '').toUpperCase();
    const message = String(err && err.message || '').toLowerCase();
    return code === 'SQLITE_BUSY'
        || code === 'SQLITE_LOCKED'
        || message.includes('database is locked')
        || message.includes('database is busy');
}

async function inspectDatabaseSpace(db, filePath) {
    const pageCountRow = await get(db, 'PRAGMA page_count');
    const freeCountRow = await get(db, 'PRAGMA freelist_count');
    const pageSizeRow = await get(db, 'PRAGMA page_size');
    const pageCount = Math.max(0, Number(pageCountRow && pageCountRow.page_count || 0));
    const freePages = Math.max(0, Number(freeCountRow && freeCountRow.freelist_count || 0));
    const pageSize = Math.max(0, Number(pageSizeRow && pageSizeRow.page_size || 0));
    return {
        page_count: pageCount,
        free_pages: freePages,
        page_size: pageSize,
        free_ratio: pageCount > 0 ? freePages / pageCount : 0,
        free_bytes: freePages * pageSize,
        file_bytes: fileBytes(filePath)
    };
}

async function compactDatabaseIfNeeded(options = {}) {
    const databaseName = String(options.database_name || options.databaseName || '').trim() || 'sqlite';
    const filePath = String(options.file_path || options.filePath || '').trim();
    const openDatabase = options.open_database || options.openDatabase;
    if (!filePath) throw new Error('file_path 不能为空');
    if (typeof openDatabase !== 'function') throw new Error('open_database 不能为空');

    const minFreeRatio = Math.max(0, Math.min(1, Number(
        options.min_free_ratio ?? options.minFreeRatio ?? DEFAULT_MIN_FREE_RATIO
    )));
    const minFreeBytes = Math.max(0, Number(
        options.min_free_bytes ?? options.minFreeBytes ?? DEFAULT_MIN_FREE_BYTES
    ));
    const busyTimeoutMs = Math.max(0, Number(
        options.busy_timeout_ms ?? options.busyTimeoutMs ?? DEFAULT_BUSY_TIMEOUT_MS
    ));
    const force = options.force === true;
    const db = openDatabase();
    let before = null;
    try {
        await run(db, `PRAGMA busy_timeout=${Math.floor(busyTimeoutMs)}`);
        before = await inspectDatabaseSpace(db, filePath);
        if (!force && (before.free_ratio < minFreeRatio || before.free_bytes < minFreeBytes)) {
            return {
                database_name: databaseName,
                file_path: filePath,
                status: 'skipped',
                reason: 'below_threshold',
                threshold_ratio: minFreeRatio,
                threshold_bytes: minFreeBytes,
                before,
                after: before,
                freed_bytes: 0
            };
        }

        const startedAt = Date.now();
        await run(db, 'PRAGMA wal_checkpoint(TRUNCATE)');
        await run(db, 'VACUUM');
        await run(db, 'PRAGMA wal_checkpoint(TRUNCATE)');
        const after = await inspectDatabaseSpace(db, filePath);
        return {
            database_name: databaseName,
            file_path: filePath,
            status: 'compacted',
            reason: force ? 'forced' : 'threshold_reached',
            threshold_ratio: minFreeRatio,
            threshold_bytes: minFreeBytes,
            duration_ms: Date.now() - startedAt,
            before,
            after,
            freed_bytes: Math.max(0, before.file_bytes - after.file_bytes)
        };
    } catch (err) {
        if (!isBusyError(err)) throw err;
        return {
            database_name: databaseName,
            file_path: filePath,
            status: 'skipped',
            reason: 'database_busy',
            threshold_ratio: minFreeRatio,
            threshold_bytes: minFreeBytes,
            before: before || null,
            after: before || null,
            freed_bytes: 0,
            error_message: String(err && err.message ? err.message : err)
        };
    } finally {
        db.close();
    }
}

module.exports = {
    DEFAULT_MIN_FREE_RATIO,
    DEFAULT_MIN_FREE_BYTES,
    DEFAULT_BUSY_TIMEOUT_MS,
    inspectDatabaseSpace,
    compactDatabaseIfNeeded,
    _internal: {
        fileBytes,
        isBusyError
    }
};
