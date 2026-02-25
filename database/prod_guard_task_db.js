const { openDatabase } = require('./sqlite_client');

const TASK_STATUS_PENDING = 'pending';
const TASK_STATUS_WATCHING = 'watching';
const TASK_STATUS_DONE = 'done';
const TASK_STATUS_FAILED = 'failed';

function nowSec() {
    return Math.floor(Date.now() / 1000);
}

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

async function ensureColumn(db, table, column, ddl) {
    const rows = await all(db, `PRAGMA table_info("${table}")`);
    const has = rows.some((r) => String(r.name || '').trim() === String(column || '').trim());
    if (has) return;
    await run(db, `ALTER TABLE "${table}" ADD COLUMN ${ddl}`);
}

async function initProdGuardTaskDb() {
    const db = openDatabase();
    try {
        await run(db, `
            CREATE TABLE IF NOT EXISTS prod_guard_task (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                user_id INTEGER NOT NULL,
                game_account TEXT NOT NULL DEFAULT '',
                risk_type TEXT NOT NULL DEFAULT '',
                task_type TEXT NOT NULL DEFAULT '',
                status TEXT NOT NULL DEFAULT 'pending',
                event_id INTEGER NOT NULL DEFAULT 0,
                next_check_at INTEGER NOT NULL DEFAULT 0,
                last_online_tag TEXT NOT NULL DEFAULT '',
                blacklist_applied INTEGER NOT NULL DEFAULT 0,
                forbidden_applied INTEGER NOT NULL DEFAULT 0,
                retry_count INTEGER NOT NULL DEFAULT 0,
                max_retry INTEGER NOT NULL DEFAULT 5,
                probe_loop_count INTEGER NOT NULL DEFAULT 0,
                last_error TEXT NOT NULL DEFAULT '',
                forbidden_on_at TEXT NOT NULL DEFAULT '',
                forbidden_off_at TEXT NOT NULL DEFAULT '',
                finished_at TEXT NOT NULL DEFAULT '',
                create_date TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
                modify_date TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
                is_deleted INTEGER NOT NULL DEFAULT 0,
                desc TEXT NOT NULL DEFAULT ''
            )
        `);
        await run(db, `
            CREATE UNIQUE INDEX IF NOT EXISTS uq_prod_guard_task_alive
            ON prod_guard_task(user_id, game_account, task_type, is_deleted)
        `);
        await run(db, `
            CREATE INDEX IF NOT EXISTS idx_prod_guard_task_due
            ON prod_guard_task(status, next_check_at, is_deleted)
        `);
        await run(db, `
            CREATE INDEX IF NOT EXISTS idx_prod_guard_task_user
            ON prod_guard_task(user_id, modify_date, is_deleted)
        `);
        await ensureColumn(db, 'prod_guard_task', 'probe_loop_count', 'probe_loop_count INTEGER NOT NULL DEFAULT 0');
        await ensureColumn(db, 'prod_guard_task', 'forbidden_on_at', 'forbidden_on_at TEXT NOT NULL DEFAULT \'\'');
        await ensureColumn(db, 'prod_guard_task', 'forbidden_off_at', 'forbidden_off_at TEXT NOT NULL DEFAULT \'\'');
    } finally {
        db.close();
    }
}

async function upsertGuardTask(input = {}, options = {}) {
    await initProdGuardTaskDb();
    const uid = Number(input.user_id || 0);
    const acc = String(input.game_account || '').trim();
    const riskType = String(input.risk_type || '').trim();
    const taskType = String(input.task_type || '').trim();
    if (!uid) throw new Error('user_id 不合法');
    if (!acc) throw new Error('game_account 不能为空');
    if (!riskType) throw new Error('risk_type 不能为空');
    if (!taskType) throw new Error('task_type 不能为空');
    const now = nowText();
    const nextCheckAt = Math.max(0, Number(input.next_check_at || nowSec()));
    const eventId = Math.max(0, Number(input.event_id || 0));
    const status = String(input.status || TASK_STATUS_PENDING).trim() || TASK_STATUS_PENDING;
    const maxRetry = Math.max(1, Number(input.max_retry || 5));
    const desc = String(options.desc || input.desc || '').trim();

    const db = openDatabase();
    try {
        const old = await get(db, `
            SELECT id, retry_count
            FROM prod_guard_task
            WHERE user_id = ? AND game_account = ? AND task_type = ? AND is_deleted = 0
            LIMIT 1
        `, [uid, acc, taskType]);
        if (!old) {
            const ret = await run(db, `
                INSERT INTO prod_guard_task
                (user_id, game_account, risk_type, task_type, status, event_id, next_check_at, last_online_tag,
                 blacklist_applied, forbidden_applied, retry_count, max_retry, probe_loop_count,
                 last_error, forbidden_on_at, forbidden_off_at, finished_at, create_date, modify_date, is_deleted, desc)
                VALUES (?, ?, ?, ?, ?, ?, ?, '', 0, 0, 0, ?, 0, '', '', '', '', ?, ?, 0, ?)
            `, [uid, acc, riskType, taskType, status, eventId, nextCheckAt, maxRetry, now, now, desc]);
            return { id: Number(ret.lastID || 0), inserted: true };
        }
        await run(db, `
            UPDATE prod_guard_task
            SET risk_type = ?,
                status = ?,
                event_id = CASE WHEN ? > 0 THEN ? ELSE event_id END,
                next_check_at = ?,
                last_error = '',
                finished_at = CASE WHEN ? IN (?, ?) THEN ? ELSE '' END,
                modify_date = ?,
                desc = CASE WHEN ? <> '' THEN ? ELSE desc END
            WHERE id = ?
        `, [
            riskType,
            status,
            eventId, eventId,
            nextCheckAt,
            status, TASK_STATUS_DONE, TASK_STATUS_FAILED, now,
            now,
            desc, desc,
            Number(old.id || 0)
        ]);
        return { id: Number(old.id || 0), inserted: false };
    } finally {
        db.close();
    }
}

async function listDueGuardTasks(options = {}) {
    await initProdGuardTaskDb();
    const limit = Math.max(1, Math.min(200, Number(options.limit || 50)));
    const dueSec = Math.max(0, Number(options.due_sec || nowSec()));
    const db = openDatabase();
    try {
        const rows = await all(db, `
            SELECT
              id, user_id, game_account, risk_type, task_type, status, event_id,
              next_check_at, last_online_tag, blacklist_applied, forbidden_applied,
              retry_count, max_retry, probe_loop_count, last_error, forbidden_on_at, forbidden_off_at,
              finished_at, create_date, modify_date, desc
            FROM prod_guard_task
            WHERE is_deleted = 0
              AND status IN (?, ?)
              AND next_check_at <= ?
            ORDER BY next_check_at ASC, id ASC
            LIMIT ?
        `, [TASK_STATUS_PENDING, TASK_STATUS_WATCHING, dueSec, limit]);
        return rows.map((r) => ({
            id: Number(r.id || 0),
            user_id: Number(r.user_id || 0),
            game_account: String(r.game_account || '').trim(),
            risk_type: String(r.risk_type || '').trim(),
            task_type: String(r.task_type || '').trim(),
            status: String(r.status || '').trim(),
            event_id: Number(r.event_id || 0),
            next_check_at: Number(r.next_check_at || 0),
            last_online_tag: String(r.last_online_tag || '').trim(),
            blacklist_applied: Number(r.blacklist_applied || 0),
            forbidden_applied: Number(r.forbidden_applied || 0),
            retry_count: Number(r.retry_count || 0),
            max_retry: Number(r.max_retry || 5),
            probe_loop_count: Number(r.probe_loop_count || 0),
            last_error: String(r.last_error || '').trim(),
            forbidden_on_at: String(r.forbidden_on_at || '').trim(),
            forbidden_off_at: String(r.forbidden_off_at || '').trim(),
            finished_at: String(r.finished_at || '').trim(),
            create_date: String(r.create_date || '').trim(),
            modify_date: String(r.modify_date || '').trim(),
            desc: String(r.desc || '').trim()
        }));
    } finally {
        db.close();
    }
}

async function updateGuardTaskStatus(taskId, patch = {}) {
    await initProdGuardTaskDb();
    const id = Number(taskId || 0);
    if (!id) return false;
    const now = nowText();
    const status = String(patch.status || '').trim();
    const nextCheckAt = patch.next_check_at === undefined ? null : Math.max(0, Number(patch.next_check_at || 0));
    const lastOnlineTag = patch.last_online_tag === undefined ? null : String(patch.last_online_tag || '').trim();
    const blacklistApplied = patch.blacklist_applied === undefined ? null : (Number(patch.blacklist_applied) > 0 ? 1 : 0);
    const forbiddenApplied = patch.forbidden_applied === undefined ? null : (Number(patch.forbidden_applied) > 0 ? 1 : 0);
    const retryIncr = Math.max(0, Number(patch.retry_incr || 0));
    const probeLoopIncr = Math.max(0, Number(patch.probe_loop_incr || 0));
    const lastError = patch.last_error === undefined ? null : String(patch.last_error || '').trim();
    const forbiddenOnAt = patch.forbidden_on_at === undefined ? null : String(patch.forbidden_on_at || '').trim();
    const forbiddenOffAt = patch.forbidden_off_at === undefined ? null : String(patch.forbidden_off_at || '').trim();
    const desc = patch.desc === undefined ? null : String(patch.desc || '').trim();
    const finishedAt = patch.finished_at === undefined
        ? (status === TASK_STATUS_DONE || status === TASK_STATUS_FAILED ? now : null)
        : String(patch.finished_at || '').trim();

    const sets = ['modify_date = ?'];
    const params = [now];
    if (status) { sets.push('status = ?'); params.push(status); }
    if (nextCheckAt !== null) { sets.push('next_check_at = ?'); params.push(nextCheckAt); }
    if (lastOnlineTag !== null) { sets.push('last_online_tag = ?'); params.push(lastOnlineTag); }
    if (blacklistApplied !== null) { sets.push('blacklist_applied = ?'); params.push(blacklistApplied); }
    if (forbiddenApplied !== null) { sets.push('forbidden_applied = ?'); params.push(forbiddenApplied); }
    if (retryIncr > 0) { sets.push('retry_count = retry_count + ?'); params.push(retryIncr); }
    if (probeLoopIncr > 0) { sets.push('probe_loop_count = probe_loop_count + ?'); params.push(probeLoopIncr); }
    if (lastError !== null) { sets.push('last_error = ?'); params.push(lastError); }
    if (forbiddenOnAt !== null) { sets.push('forbidden_on_at = ?'); params.push(forbiddenOnAt); }
    if (forbiddenOffAt !== null) { sets.push('forbidden_off_at = ?'); params.push(forbiddenOffAt); }
    if (finishedAt !== null) { sets.push('finished_at = ?'); params.push(finishedAt); }
    if (desc !== null && desc) { sets.push('desc = ?'); params.push(desc); }
    params.push(id);

    const db = openDatabase();
    try {
        const ret = await run(db, `
            UPDATE prod_guard_task
            SET ${sets.join(', ')}
            WHERE id = ? AND is_deleted = 0
        `, params);
        return Number(ret.changes || 0) > 0;
    } finally {
        db.close();
    }
}

async function listGuardTasksByUser(userId, options = {}) {
    await initProdGuardTaskDb();
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
            FROM prod_guard_task
            WHERE ${whereSql}
        `, params);
        const rows = await all(db, `
            SELECT
              id, user_id, game_account, risk_type, task_type, status, event_id, next_check_at,
              last_online_tag, blacklist_applied, forbidden_applied, retry_count, max_retry, probe_loop_count,
              last_error, forbidden_on_at, forbidden_off_at, finished_at, create_date, modify_date, desc
            FROM prod_guard_task
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
                task_type: String(r.task_type || '').trim(),
                status: String(r.status || '').trim(),
                event_id: Number(r.event_id || 0),
                next_check_at: Number(r.next_check_at || 0),
                last_online_tag: String(r.last_online_tag || '').trim(),
                blacklist_applied: Number(r.blacklist_applied || 0),
                forbidden_applied: Number(r.forbidden_applied || 0),
                retry_count: Number(r.retry_count || 0),
                max_retry: Number(r.max_retry || 0),
                probe_loop_count: Number(r.probe_loop_count || 0),
                last_error: String(r.last_error || '').trim(),
                forbidden_on_at: String(r.forbidden_on_at || '').trim(),
                forbidden_off_at: String(r.forbidden_off_at || '').trim(),
                finished_at: String(r.finished_at || '').trim(),
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
    TASK_STATUS_PENDING,
    TASK_STATUS_WATCHING,
    TASK_STATUS_DONE,
    TASK_STATUS_FAILED,
    initProdGuardTaskDb,
    upsertGuardTask,
    listDueGuardTasks,
    updateGuardTaskStatus,
    listGuardTasksByUser
};
