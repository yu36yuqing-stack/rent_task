const { openRuntimeDatabase } = require('./sqlite_client');

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

async function initMaintenanceTaskLogDb() {
    const db = openRuntimeDatabase();
    try {
        await run(db, `
            CREATE TABLE IF NOT EXISTS maintenance_task_log (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                task_type TEXT NOT NULL DEFAULT '',
                trigger_type TEXT NOT NULL DEFAULT '',
                trigger_user_id INTEGER NOT NULL DEFAULT 0,
                status TEXT NOT NULL DEFAULT '',
                started_at TEXT NOT NULL DEFAULT '',
                finished_at TEXT NOT NULL DEFAULT '',
                duration_ms INTEGER NOT NULL DEFAULT 0,
                target_table TEXT NOT NULL DEFAULT '',
                retention_days INTEGER NOT NULL DEFAULT 0,
                deleted_rows INTEGER NOT NULL DEFAULT 0,
                before_bytes INTEGER NOT NULL DEFAULT 0,
                after_bytes INTEGER NOT NULL DEFAULT 0,
                estimated_deleted_bytes INTEGER NOT NULL DEFAULT 0,
                freed_bytes INTEGER NOT NULL DEFAULT 0,
                error_message TEXT NOT NULL DEFAULT '',
                result_json TEXT NOT NULL DEFAULT '{}',
                create_date TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
                modify_date TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
                is_deleted INTEGER NOT NULL DEFAULT 0,
                desc TEXT NOT NULL DEFAULT ''
            )
        `);
        await run(db, `
            CREATE INDEX IF NOT EXISTS idx_maintenance_task_log_type_status
            ON maintenance_task_log(task_type, status, is_deleted, id)
        `);
    } finally {
        db.close();
    }
}

async function createMaintenanceTaskLog(input = {}) {
    await initMaintenanceTaskLogDb();
    const now = nowText();
    const db = openRuntimeDatabase();
    try {
        const r = await run(db, `
            INSERT INTO maintenance_task_log
            (task_type, trigger_type, trigger_user_id, status, started_at, target_table, retention_days,
             create_date, modify_date, is_deleted, desc)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 0, ?)
        `, [
            String(input.task_type || '').trim(),
            String(input.trigger_type || '').trim(),
            Number(input.trigger_user_id || 0),
            String(input.status || 'running').trim(),
            String(input.started_at || now).trim(),
            String(input.target_table || '').trim(),
            Math.max(0, Number(input.retention_days || 0)),
            now,
            now,
            String(input.desc || '').trim()
        ]);
        return await get(db, `SELECT * FROM maintenance_task_log WHERE id = ?`, [Number(r.lastID || 0)]);
    } finally {
        db.close();
    }
}

async function finishMaintenanceTaskLog(id, patch = {}) {
    await initMaintenanceTaskLogDb();
    const logId = Number(id || 0);
    if (!logId) throw new Error('maintenance_task_log id 不能为空');
    const now = nowText();
    const resultJson = (() => {
        try {
            return JSON.stringify(patch.result_json || patch.resultJson || {});
        } catch {
            return '{}';
        }
    })();
    const db = openRuntimeDatabase();
    try {
        await run(db, `
            UPDATE maintenance_task_log
            SET status = ?,
                finished_at = ?,
                duration_ms = ?,
                deleted_rows = ?,
                before_bytes = ?,
                after_bytes = ?,
                estimated_deleted_bytes = ?,
                freed_bytes = ?,
                error_message = ?,
                result_json = ?,
                modify_date = ?,
                desc = ?
            WHERE id = ? AND is_deleted = 0
        `, [
            String(patch.status || '').trim(),
            String(patch.finished_at || now).trim(),
            Math.max(0, Number(patch.duration_ms || 0)),
            Math.max(0, Number(patch.deleted_rows || 0)),
            Math.max(0, Number(patch.before_bytes || 0)),
            Math.max(0, Number(patch.after_bytes || 0)),
            Math.max(0, Number(patch.estimated_deleted_bytes || 0)),
            Math.max(0, Number(patch.freed_bytes || 0)),
            String(patch.error_message || '').trim(),
            resultJson,
            now,
            String(patch.desc || '').trim(),
            logId
        ]);
        return await get(db, `SELECT * FROM maintenance_task_log WHERE id = ? AND is_deleted = 0`, [logId]);
    } finally {
        db.close();
    }
}

async function listMaintenanceTaskLogs(options = {}) {
    await initMaintenanceTaskLogDb();
    const taskType = String(options.task_type || '').trim();
    const limit = Math.max(1, Math.min(100, Number(options.limit || 20)));
    const where = ['is_deleted = 0'];
    const params = [];
    if (taskType) {
        where.push('task_type = ?');
        params.push(taskType);
    }
    params.push(limit);
    const db = openRuntimeDatabase();
    try {
        return await all(db, `
            SELECT *
            FROM maintenance_task_log
            WHERE ${where.join(' AND ')}
            ORDER BY id DESC
            LIMIT ?
        `, params);
    } finally {
        db.close();
    }
}

module.exports = {
    initMaintenanceTaskLogDb,
    createMaintenanceTaskLog,
    finishMaintenanceTaskLog,
    listMaintenanceTaskLogs
};
