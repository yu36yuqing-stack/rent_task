'use strict';

const { openPriceDatabase } = require('./sqlite_client');
const { normalizePriceLadderCountMode } = require('../common/price_ladder_count_mode');

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

function toConfig(row = {}, userId = 0) {
    return {
        id: Number(row.id || 0),
        user_id: Number(row.user_id || userId || 0),
        enabled: Number(row.enabled || 0) === 1,
        count_mode: normalizePriceLadderCountMode(row.count_mode),
        reconcile_required: Number(row.reconcile_required || 0) === 1,
        reconcile_reason: String(row.reconcile_reason || '').trim(),
        version: Number(row.version || 0),
        create_date: String(row.create_date || '').trim(),
        modify_date: String(row.modify_date || '').trim(),
        is_deleted: Number(row.is_deleted || 0),
        desc: String(row.desc || '').trim()
    };
}

async function initPriceLadderFeatureConfigDb() {
    const db = openPriceDatabase();
    try {
        await run(db, 'BEGIN IMMEDIATE');
        await run(db, `
            CREATE TABLE IF NOT EXISTS price_ladder_feature_config (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                user_id INTEGER NOT NULL,
                enabled INTEGER NOT NULL DEFAULT 0,
                count_mode TEXT NOT NULL DEFAULT 'rolling_24h',
                reconcile_required INTEGER NOT NULL DEFAULT 0,
                reconcile_reason TEXT NOT NULL DEFAULT '',
                version INTEGER NOT NULL DEFAULT 1,
                create_date TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
                modify_date TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
                is_deleted INTEGER NOT NULL DEFAULT 0,
                desc TEXT NOT NULL DEFAULT ''
            )
        `);
        const columns = await all(db, 'PRAGMA table_info(price_ladder_feature_config)');
        if (!columns.some((column) => column.name === 'count_mode')) {
            await run(db, "ALTER TABLE price_ladder_feature_config ADD COLUMN count_mode TEXT NOT NULL DEFAULT 'rolling_24h'");
        }
        if (!columns.some((column) => column.name === 'reconcile_reason')) {
            await run(db, "ALTER TABLE price_ladder_feature_config ADD COLUMN reconcile_reason TEXT NOT NULL DEFAULT ''");
        }
        await run(db, `
            CREATE UNIQUE INDEX IF NOT EXISTS uq_price_ladder_feature_config_alive
            ON price_ladder_feature_config(user_id)
            WHERE is_deleted = 0
        `);
        await run(db, 'COMMIT');
    } catch (err) {
        await run(db, 'ROLLBACK').catch(() => {});
        throw err;
    } finally {
        db.close();
    }
}

async function getPriceLadderFeatureConfig(userId) {
    await initPriceLadderFeatureConfigDb();
    const uid = Number(userId || 0);
    if (!uid) throw new Error('user_id 不合法');
    const db = openPriceDatabase();
    try {
        const row = await get(db, `
            SELECT *
            FROM price_ladder_feature_config
            WHERE user_id = ? AND is_deleted = 0
            LIMIT 1
        `, [uid]);
        return toConfig(row || {}, uid);
    } finally {
        db.close();
    }
}

async function setPriceLadderFeatureEnabled(userId, enabled, options = {}) {
    await initPriceLadderFeatureConfigDb();
    const uid = Number(userId || 0);
    const nextEnabled = Boolean(enabled);
    const requestedCountMode = options.count_mode === undefined
        ? undefined
        : normalizePriceLadderCountMode(options.count_mode);
    const expectedVersion = options.expected_version == null || options.expected_version === ''
        ? null
        : Number(options.expected_version);
    if (!uid) throw new Error('user_id 不合法');
    if (expectedVersion !== null && (!Number.isInteger(expectedVersion) || expectedVersion < 0)) {
        throw new Error('expected_version 不合法');
    }
    const db = openPriceDatabase();
    try {
        await run(db, 'BEGIN IMMEDIATE');
        const current = await get(db, `
            SELECT *
            FROM price_ladder_feature_config
            WHERE user_id = ? AND is_deleted = 0
            LIMIT 1
        `, [uid]);
        const currentVersion = Number(current && current.version || 0);
        const currentCountMode = normalizePriceLadderCountMode(current && current.count_mode);
        const nextCountMode = requestedCountMode === undefined ? currentCountMode : requestedCountMode;
        if (expectedVersion !== null && expectedVersion !== currentVersion) {
            const err = new Error('开关状态已变化，请刷新后重试');
            err.code = 'PRICE_LADDER_VERSION_CONFLICT';
            throw err;
        }
        const now = nowText();
        if (!current) {
            await run(db, `
                INSERT INTO price_ladder_feature_config
                (user_id, enabled, count_mode, reconcile_required, reconcile_reason, version, create_date, modify_date, is_deleted, desc)
                VALUES (?, ?, ?, ?, ?, 1, ?, ?, 0, ?)
            `, [uid, nextEnabled ? 1 : 0, nextCountMode, nextEnabled ? 1 : 0, nextEnabled ? 'feature_enabled' : '', now, now, String(options.desc || '').trim()]);
        } else {
            const wasEnabled = Number(current.enabled || 0) === 1;
            const reconcileRequired = nextEnabled
                ? (!wasEnabled || currentCountMode !== nextCountMode || Number(current.reconcile_required || 0) === 1 ? 1 : 0)
                : 0;
            const pendingReason = String(current.reconcile_reason || '').trim() || 'feature_enabled';
            const reconcileReason = !reconcileRequired ? ''
                : !wasEnabled ? 'feature_enabled'
                    : Number(current.reconcile_required || 0) === 1 ? pendingReason : 'count_mode_changed';
            await run(db, `
                UPDATE price_ladder_feature_config
                SET enabled = ?, count_mode = ?, reconcile_required = ?, reconcile_reason = ?, version = version + 1,
                    modify_date = ?, desc = ?
                WHERE id = ?
            `, [nextEnabled ? 1 : 0, nextCountMode, reconcileRequired, reconcileReason, now, String(options.desc || '').trim(), Number(current.id)]);
        }
        const saved = await get(db, `
            SELECT *
            FROM price_ladder_feature_config
            WHERE user_id = ? AND is_deleted = 0
            LIMIT 1
        `, [uid]);
        await run(db, 'COMMIT');
        return toConfig(saved || {}, uid);
    } catch (err) {
        await run(db, 'ROLLBACK').catch(() => {});
        throw err;
    } finally {
        db.close();
    }
}

async function markPriceLadderFeatureReconciled(userId, expectedVersion) {
    await initPriceLadderFeatureConfigDb();
    const uid = Number(userId || 0);
    const version = Number(expectedVersion || 0);
    if (!uid || !version) return false;
    const db = openPriceDatabase();
    try {
        const result = await run(db, `
            UPDATE price_ladder_feature_config
            SET reconcile_required = 0, reconcile_reason = '', modify_date = ?, desc = ?
            WHERE user_id = ? AND enabled = 1 AND version = ? AND is_deleted = 0
        `, [nowText(), 'feature activation reconciliation completed', uid, version]);
        return Number(result.changes || 0) > 0;
    } finally {
        db.close();
    }
}

module.exports = {
    initPriceLadderFeatureConfigDb,
    getPriceLadderFeatureConfig,
    setPriceLadderFeatureEnabled,
    markPriceLadderFeatureReconciled,
    _internal: { nowText, toConfig, run, get, all }
};
