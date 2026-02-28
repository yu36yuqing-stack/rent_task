const { openDatabase } = require('./sqlite_client');

const STATUS_OPEN = 'open';
const STATUS_RESOLVED = 'resolved';
const STATUS_IGNORED = 'ignored';

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

async function initProdRiskEventDb() {
    const db = openDatabase();
    try {
        await run(db, `
            CREATE TABLE IF NOT EXISTS prod_risk_event (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                user_id INTEGER NOT NULL,
                game_account TEXT NOT NULL DEFAULT '',
                risk_type TEXT NOT NULL DEFAULT '',
                risk_level TEXT NOT NULL DEFAULT 'medium',
                status TEXT NOT NULL DEFAULT 'open',
                hit_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
                resolved_at TEXT NOT NULL DEFAULT '',
                snapshot TEXT NOT NULL DEFAULT '{}',
                create_date TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
                modify_date TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
                is_deleted INTEGER NOT NULL DEFAULT 0,
                desc TEXT NOT NULL DEFAULT ''
            )
        `);
        // 历史约束会限制同账号同风险类型只能有一条 resolved/ignored 记录，
        // 新模型要求“每次事件独立”，仅限制 open 态唯一。
        await run(db, `DROP INDEX IF EXISTS uq_prod_risk_event_alive`);
        // 迁移兜底：清理历史重复 open，保留最新一条，避免唯一索引创建失败。
        await run(db, `
            UPDATE prod_risk_event
            SET status = 'ignored',
                resolved_at = CASE WHEN TRIM(COALESCE(resolved_at, '')) = '' THEN modify_date ELSE resolved_at END,
                modify_date = CURRENT_TIMESTAMP,
                desc = CASE
                    WHEN TRIM(COALESCE(desc, '')) = '' THEN 'auto dedup before open-unique index'
                    ELSE desc || ';auto dedup before open-unique index'
                END
            WHERE id IN (
                SELECT p1.id
                FROM prod_risk_event p1
                JOIN prod_risk_event p2
                  ON p1.user_id = p2.user_id
                 AND p1.game_account = p2.game_account
                 AND p1.risk_type = p2.risk_type
                 AND p1.status = 'open'
                 AND p2.status = 'open'
                 AND p1.is_deleted = 0
                 AND p2.is_deleted = 0
                 AND p1.id < p2.id
            )
        `);
        await run(db, `
            CREATE UNIQUE INDEX IF NOT EXISTS uq_prod_risk_event_open_alive
            ON prod_risk_event(user_id, game_account, risk_type)
            WHERE is_deleted = 0 AND status = 'open'
        `);
        await run(db, `
            CREATE INDEX IF NOT EXISTS idx_prod_risk_event_user_alive
            ON prod_risk_event(user_id, status, modify_date, is_deleted)
        `);
    } finally {
        db.close();
    }
}

function safeJsonText(v) {
    try { return JSON.stringify(v || {}); } catch { return '{}'; }
}

function safeJsonObject(v) {
    if (!v) return {};
    if (typeof v === 'object' && !Array.isArray(v)) return v;
    try {
        const parsed = JSON.parse(String(v));
        if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) return parsed;
        return {};
    } catch {
        return {};
    }
}

function normalizeLatestOrder(input) {
    const src = input && typeof input === 'object' ? input : {};
    return {
        order_no: String(src.order_no || '').trim(),
        end_time: String(src.end_time || '').trim()
    };
}

function normalizeSnapshot(input, now) {
    const out = safeJsonObject(input);
    out.latest_order = normalizeLatestOrder(out.latest_order);
    if (!String(out.hit_at || '').trim()) out.hit_at = String(now || '').trim();
    if (!String(out.first_hit_at || '').trim()) out.first_hit_at = String(out.hit_at || '').trim();
    return out;
}

function mergeSnapshotForOpenEvent(oldSnapshotRaw, nextSnapshotRaw, now) {
    const oldSnapshot = normalizeSnapshot(oldSnapshotRaw, now);
    const nextSnapshot = normalizeSnapshot(nextSnapshotRaw, now);

    // 事件 open 周期内，订单末次结束时间按首次命中快照冻结。
    const oldLatest = normalizeLatestOrder(oldSnapshot.latest_order);
    const hasOldLatest = Boolean(oldLatest.order_no || oldLatest.end_time);
    nextSnapshot.latest_order = hasOldLatest
        ? oldLatest
        : normalizeLatestOrder(nextSnapshot.latest_order);

    if (String(oldSnapshot.first_hit_at || '').trim()) {
        nextSnapshot.first_hit_at = String(oldSnapshot.first_hit_at || '').trim();
    }
    if (String(oldSnapshot.hit_at || '').trim()) {
        nextSnapshot.hit_at = String(oldSnapshot.hit_at || '').trim();
    }
    return nextSnapshot;
}

async function upsertOpenRiskEvent(userId, gameAccount, riskType, options = {}) {
    await initProdRiskEventDb();
    const uid = Number(userId || 0);
    const acc = String(gameAccount || '').trim();
    const type = String(riskType || '').trim();
    if (!uid) throw new Error('user_id 不合法');
    if (!acc) throw new Error('game_account 不能为空');
    if (!type) throw new Error('risk_type 不能为空');

    const level = String(options.risk_level || 'medium').trim() || 'medium';
    const desc = String(options.desc || '').trim();
    const now = nowText();

    const db = openDatabase();
    try {
        const old = await get(db, `
            SELECT id, snapshot
            FROM prod_risk_event
            WHERE user_id = ?
              AND game_account = ?
              AND risk_type = ?
              AND status = ?
              AND is_deleted = 0
            LIMIT 1
        `, [uid, acc, type, STATUS_OPEN]);
        if (!old) {
            const snapshot = safeJsonText(normalizeSnapshot(options.snapshot, now));
            const ret = await run(db, `
                INSERT INTO prod_risk_event
                (user_id, game_account, risk_type, risk_level, status, hit_at, resolved_at, snapshot, create_date, modify_date, is_deleted, desc)
                VALUES (?, ?, ?, ?, ?, ?, '', ?, ?, ?, 0, ?)
            `, [uid, acc, type, level, STATUS_OPEN, now, snapshot, now, now, desc]);
            return { id: Number(ret.lastID || 0), inserted: true };
        }
        const snapshot = safeJsonText(mergeSnapshotForOpenEvent(old.snapshot, options.snapshot, now));
        await run(db, `
            UPDATE prod_risk_event
            SET risk_level = ?,
                snapshot = ?,
                modify_date = ?,
                desc = ?
            WHERE id = ?
        `, [level, snapshot, now, desc, Number(old.id || 0)]);
        return { id: Number(old.id || 0), inserted: false };
    } finally {
        db.close();
    }
}

async function resolveOpenRiskEvent(userId, gameAccount, riskType, options = {}) {
    await initProdRiskEventDb();
    const uid = Number(userId || 0);
    const acc = String(gameAccount || '').trim();
    const type = String(riskType || '').trim();
    if (!uid || !acc || !type) return false;
    const now = nowText();
    const status = String(options.status || STATUS_RESOLVED).trim() || STATUS_RESOLVED;
    const desc = String(options.desc || '').trim();
    const db = openDatabase();
    try {
        const ret = await run(db, `
            UPDATE prod_risk_event
            SET status = ?,
                resolved_at = ?,
                modify_date = ?,
                desc = CASE WHEN ? <> '' THEN ? ELSE desc END
            WHERE user_id = ?
              AND game_account = ?
              AND risk_type = ?
              AND status = ?
              AND is_deleted = 0
        `, [status, now, now, desc, desc, uid, acc, type, STATUS_OPEN]);
        return Number(ret.changes || 0) > 0;
    } finally {
        db.close();
    }
}

async function resolveRiskEventById(eventId, options = {}) {
    await initProdRiskEventDb();
    const id = Number(eventId || 0);
    if (!id) return false;
    const now = nowText();
    const status = String(options.status || STATUS_RESOLVED).trim() || STATUS_RESOLVED;
    const desc = String(options.desc || '').trim();
    const db = openDatabase();
    try {
        const ret = await run(db, `
            UPDATE prod_risk_event
            SET status = ?,
                resolved_at = ?,
                modify_date = ?,
                desc = CASE WHEN ? <> '' THEN ? ELSE desc END
            WHERE id = ?
              AND is_deleted = 0
              AND status = ?
        `, [status, now, now, desc, desc, id, STATUS_OPEN]);
        return Number(ret.changes || 0) > 0;
    } finally {
        db.close();
    }
}

async function listRiskEventsByUser(userId, options = {}) {
    await initProdRiskEventDb();
    const uid = Number(userId || 0);
    if (!uid) return { total: 0, list: [] };
    const page = Math.max(1, Number(options.page || 1));
    const pageSize = Math.min(100, Math.max(1, Number(options.page_size || options.pageSize || 20)));
    const status = String(options.status || '').trim();
    const riskType = String(options.risk_type || options.riskType || '').trim();
    const where = ['user_id = ?', 'is_deleted = 0'];
    const params = [uid];
    if (status) {
        where.push('status = ?');
        params.push(status);
    }
    if (riskType) {
        where.push('risk_type = ?');
        params.push(riskType);
    }
    const whereSql = where.join(' AND ');
    const offset = (page - 1) * pageSize;

    const db = openDatabase();
    try {
        const totalRow = await get(db, `
            SELECT COUNT(*) AS total
            FROM prod_risk_event
            WHERE ${whereSql}
        `, params);
        const rows = await all(db, `
            SELECT
              id, user_id, game_account, risk_type, risk_level, status,
              hit_at, resolved_at, snapshot, create_date, modify_date, desc
            FROM prod_risk_event
            WHERE ${whereSql}
            ORDER BY datetime(modify_date) DESC, id DESC
            LIMIT ? OFFSET ?
        `, [...params, pageSize, offset]);
        return {
            total: Number((totalRow && totalRow.total) || 0),
            list: rows.map((r) => ({
                id: Number(r.id || 0),
                user_id: Number(r.user_id || 0),
                game_account: String(r.game_account || '').trim(),
                risk_type: String(r.risk_type || '').trim(),
                risk_level: String(r.risk_level || '').trim(),
                status: String(r.status || '').trim(),
                hit_at: String(r.hit_at || '').trim(),
                resolved_at: String(r.resolved_at || '').trim(),
                snapshot: String(r.snapshot || '').trim(),
                create_date: String(r.create_date || '').trim(),
                modify_date: String(r.modify_date || '').trim(),
                desc: String(r.desc || '').trim()
            }))
        };
    } finally {
        db.close();
    }
}

module.exports = {
    STATUS_OPEN,
    STATUS_RESOLVED,
    STATUS_IGNORED,
    initProdRiskEventDb,
    upsertOpenRiskEvent,
    resolveOpenRiskEvent,
    resolveRiskEventById,
    listRiskEventsByUser
};
