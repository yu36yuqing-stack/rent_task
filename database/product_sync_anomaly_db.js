const { openDatabase } = require('./sqlite_client');

const VALID_PLATFORMS = new Set(['uuzuhao', 'uhaozu', 'zuhaowang']);

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

function parseJsonText(raw, fallback) {
    try {
        return JSON.parse(String(raw || ''));
    } catch {
        return fallback;
    }
}

function rowToAnomaly(row = {}) {
    return {
        id: Number(row.id || 0),
        user_id: Number(row.user_id || 0),
        platform: String(row.platform || '').trim(),
        expected_count: Number(row.expected_count || 0),
        pulled_count: Number(row.pulled_count || 0),
        missing_count: Number(row.missing_count || 0),
        missing_accounts: parseJsonText(row.missing_accounts_json, []),
        sample_missing_text: String(row.sample_missing_text || '').trim(),
        status: String(row.status || 'open').trim() || 'open',
        first_seen_at: String(row.first_seen_at || '').trim(),
        last_seen_at: String(row.last_seen_at || '').trim(),
        resolved_at: String(row.resolved_at || '').trim(),
        create_date: String(row.create_date || '').trim(),
        modify_date: String(row.modify_date || '').trim(),
        is_deleted: Number(row.is_deleted || 0),
        desc: String(row.desc || '').trim()
    };
}

async function initProductSyncAnomalyDb() {
    const db = openDatabase();
    try {
        await run(db, `
            CREATE TABLE IF NOT EXISTS product_sync_anomaly (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                user_id INTEGER NOT NULL,
                platform TEXT NOT NULL,
                expected_count INTEGER NOT NULL DEFAULT 0,
                pulled_count INTEGER NOT NULL DEFAULT 0,
                missing_count INTEGER NOT NULL DEFAULT 0,
                missing_accounts_json TEXT NOT NULL DEFAULT '[]',
                sample_missing_text TEXT NOT NULL DEFAULT '',
                status TEXT NOT NULL DEFAULT 'open',
                first_seen_at TEXT NOT NULL DEFAULT '',
                last_seen_at TEXT NOT NULL DEFAULT '',
                resolved_at TEXT NOT NULL DEFAULT '',
                create_date TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
                modify_date TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
                is_deleted INTEGER NOT NULL DEFAULT 0,
                desc TEXT NOT NULL DEFAULT ''
            )
        `);
        await run(db, `
            CREATE INDEX IF NOT EXISTS idx_product_sync_anomaly_user_status
            ON product_sync_anomaly(user_id, status, is_deleted)
        `);
        await run(db, `
            CREATE INDEX IF NOT EXISTS idx_product_sync_anomaly_platform
            ON product_sync_anomaly(user_id, platform, status, is_deleted)
        `);
    } finally {
        db.close();
    }
}

async function getOpenProductSyncAnomaly(userId, platform) {
    await initProductSyncAnomalyDb();
    const uid = Number(userId || 0);
    const pf = String(platform || '').trim();
    if (!uid || !VALID_PLATFORMS.has(pf)) return null;
    const db = openDatabase();
    try {
        const row = await get(db, `
            SELECT *
            FROM product_sync_anomaly
            WHERE user_id = ? AND platform = ? AND status = 'open' AND is_deleted = 0
            ORDER BY id DESC
            LIMIT 1
        `, [uid, pf]);
        return row ? rowToAnomaly(row) : null;
    } finally {
        db.close();
    }
}

async function upsertOpenProductSyncAnomaly(userId, platform, payload = {}) {
    await initProductSyncAnomalyDb();
    const uid = Number(userId || 0);
    const pf = String(platform || '').trim();
    if (!uid) throw new Error('user_id 不合法');
    if (!VALID_PLATFORMS.has(pf)) throw new Error(`platform 不支持: ${platform}`);

    const expectedCount = Math.max(0, Number(payload.expected_count || 0));
    const pulledCount = Math.max(0, Number(payload.pulled_count || 0));
    const missingAccounts = Array.isArray(payload.missing_accounts) ? payload.missing_accounts : [];
    const missingCount = Math.max(0, Number(payload.missing_count || missingAccounts.length));
    const sampleMissingText = String(payload.sample_missing_text || '').trim();
    const desc = String(payload.desc || '').trim();
    const now = nowText();

    const db = openDatabase();
    try {
        const existing = await get(db, `
            SELECT id, first_seen_at
            FROM product_sync_anomaly
            WHERE user_id = ? AND platform = ? AND status = 'open' AND is_deleted = 0
            ORDER BY id DESC
            LIMIT 1
        `, [uid, pf]);
        if (existing) {
            await run(db, `
                UPDATE product_sync_anomaly
                SET expected_count = ?, pulled_count = ?, missing_count = ?,
                    missing_accounts_json = ?, sample_missing_text = ?,
                    last_seen_at = ?, modify_date = ?, desc = ?
                WHERE id = ?
            `, [
                expectedCount,
                pulledCount,
                missingCount,
                JSON.stringify(missingAccounts),
                sampleMissingText,
                now,
                now,
                desc,
                Number(existing.id)
            ]);
            const row = await get(db, `SELECT * FROM product_sync_anomaly WHERE id = ?`, [Number(existing.id)]);
            return rowToAnomaly(row || {});
        }

        const ret = await run(db, `
            INSERT INTO product_sync_anomaly (
                user_id, platform, expected_count, pulled_count, missing_count,
                missing_accounts_json, sample_missing_text, status,
                first_seen_at, last_seen_at, resolved_at,
                create_date, modify_date, is_deleted, desc
            ) VALUES (?, ?, ?, ?, ?, ?, ?, 'open', ?, ?, '', ?, ?, 0, ?)
        `, [
            uid,
            pf,
            expectedCount,
            pulledCount,
            missingCount,
            JSON.stringify(missingAccounts),
            sampleMissingText,
            now,
            now,
            now,
            now,
            desc
        ]);
        const row = await get(db, `SELECT * FROM product_sync_anomaly WHERE id = ?`, [Number(ret.lastID)]);
        return rowToAnomaly(row || {});
    } finally {
        db.close();
    }
}

async function resolveOpenProductSyncAnomaly(userId, platform, options = {}) {
    await initProductSyncAnomalyDb();
    const uid = Number(userId || 0);
    const pf = String(platform || '').trim();
    if (!uid || !VALID_PLATFORMS.has(pf)) return 0;
    const now = nowText();
    const desc = String(options.desc || '').trim();
    const db = openDatabase();
    try {
        const ret = await run(db, `
            UPDATE product_sync_anomaly
            SET status = 'resolved', resolved_at = ?, last_seen_at = ?, modify_date = ?, desc = ?
            WHERE user_id = ? AND platform = ? AND status = 'open' AND is_deleted = 0
        `, [now, now, now, desc, uid, pf]);
        return Number(ret.changes || 0);
    } finally {
        db.close();
    }
}

async function listOpenProductSyncAnomaliesByUser(userId) {
    await initProductSyncAnomalyDb();
    const uid = Number(userId || 0);
    if (!uid) return [];
    const db = openDatabase();
    try {
        const rows = await all(db, `
            SELECT *
            FROM product_sync_anomaly
            WHERE user_id = ? AND status = 'open' AND is_deleted = 0
            ORDER BY modify_date DESC, id DESC
        `, [uid]);
        return rows.map(rowToAnomaly);
    } finally {
        db.close();
    }
}

module.exports = {
    initProductSyncAnomalyDb,
    getOpenProductSyncAnomaly,
    upsertOpenProductSyncAnomaly,
    resolveOpenProductSyncAnomaly,
    listOpenProductSyncAnomaliesByUser
};
