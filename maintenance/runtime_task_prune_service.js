const { openRuntimeDatabase } = require('../database/sqlite_client');
const { tryAcquireLock, releaseLock } = require('../database/lock_db');
const { getLastRunDate, setLastRunDate } = require('../database/order_stats_job_state_db');
const { initRuntimeTaskDb } = require('../database/runtime_task_db');
const {
    createMaintenanceTaskLog,
    finishMaintenanceTaskLog,
    listMaintenanceTaskLogs
} = require('../database/maintenance_task_log_db');

const TASK_TYPE_RUNTIME_TASK_PRUNE = 'runtime_task_prune';
const LOCK_KEY_RUNTIME_TASK_PRUNE = 'maintenance_runtime_task_prune';
const JOB_KEY_RUNTIME_TASK_PRUNE = 'maintenance_runtime_task_prune';
const DEFAULT_RETENTION_DAYS = 7;
const SCHEDULE_HOUR = 3;
const SCHEDULE_MINUTE = 30;
const TERMINAL_STATUSES = ['success', 'failed', 'partial_failed', 'skipped', 'canceled', 'cancelled'];

function nowText() {
    const d = new Date();
    const p = (n) => String(n).padStart(2, '0');
    return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
}

function todayText() {
    return nowText().slice(0, 10);
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

function scheduledWindowReached(date = new Date()) {
    const hour = Number(date.getHours() || 0);
    const minute = Number(date.getMinutes() || 0);
    return hour > SCHEDULE_HOUR || (hour === SCHEDULE_HOUR && minute >= SCHEDULE_MINUTE);
}

async function getRuntimeTaskBytes(db) {
    try {
        const row = await get(db, `
            SELECT COALESCE(SUM(pgsize), 0) AS bytes
            FROM dbstat
            WHERE name = 'runtime_task'
        `);
        return Math.max(0, Number(row && row.bytes || 0));
    } catch {
        return 0;
    }
}

async function getRuntimeDbFileBytes(db) {
    try {
        const row = await get(db, `PRAGMA page_count`);
        const size = await get(db, `PRAGMA page_size`);
        return Math.max(0, Number(row && row.page_count || 0) * Number(size && size.page_size || 0));
    } catch {
        return 0;
    }
}

async function countRuntimeTaskRows(db) {
    const row = await get(db, `SELECT COUNT(*) AS total FROM runtime_task WHERE is_deleted = 0`);
    return Math.max(0, Number(row && row.total || 0));
}

async function pruneRuntimeTaskRows(retentionDays = DEFAULT_RETENTION_DAYS) {
    await initRuntimeTaskDb();
    const retainDays = Math.max(1, Math.floor(Number(retentionDays || DEFAULT_RETENTION_DAYS)));
    const cutoff = `-${retainDays} days`;
    const placeholders = TERMINAL_STATUSES.map(() => '?').join(',');
    const db = openRuntimeDatabase();
    try {
        const beforeBytes = await getRuntimeTaskBytes(db);
        const beforeDbBytes = await getRuntimeDbFileBytes(db);
        const beforeRows = await countRuntimeTaskRows(db);
        const eligible = await get(db, `
            SELECT COUNT(*) AS rows
            FROM runtime_task
            WHERE is_deleted = 0
              AND create_date < datetime('now', 'localtime', ?)
              AND status IN (${placeholders})
        `, [cutoff, ...TERMINAL_STATUSES]);
        const eligibleRows = Math.max(0, Number(eligible && eligible.rows || 0));
        const avgBytes = beforeRows > 0 && beforeBytes > 0 ? beforeBytes / beforeRows : 0;
        const estimatedDeletedBytes = Math.max(0, Math.round(avgBytes * eligibleRows));

        const r = await run(db, `
            DELETE FROM runtime_task
            WHERE is_deleted = 0
              AND create_date < datetime('now', 'localtime', ?)
              AND status IN (${placeholders})
        `, [cutoff, ...TERMINAL_STATUSES]);
        await run(db, `PRAGMA wal_checkpoint(TRUNCATE)`);

        const afterBytes = await getRuntimeTaskBytes(db);
        const afterDbBytes = await getRuntimeDbFileBytes(db);
        return {
            target_table: 'runtime_task',
            retention_days: retainDays,
            cutoff_expr: cutoff,
            terminal_statuses: TERMINAL_STATUSES,
            before_rows: beforeRows,
            deleted_rows: Math.max(0, Number(r && r.changes || 0)),
            after_rows: Math.max(0, beforeRows - Number(r && r.changes || 0)),
            before_bytes: beforeBytes,
            after_bytes: afterBytes,
            before_db_bytes: beforeDbBytes,
            after_db_bytes: afterDbBytes,
            estimated_deleted_bytes: estimatedDeletedBytes,
            freed_bytes: Math.max(0, beforeDbBytes - afterDbBytes)
        };
    } finally {
        db.close();
    }
}

async function runRuntimeTaskPrune(options = {}) {
    const triggerType = String(options.trigger_type || options.triggerType || 'manual').trim() || 'manual';
    const triggerUserId = Number(options.trigger_user_id || options.triggerUserId || 0);
    const retentionDays = Math.max(1, Math.floor(Number(options.retention_days || options.retentionDays || DEFAULT_RETENTION_DAYS)));
    const owner = `runtime_task_prune trigger=${triggerType} user_id=${triggerUserId} pid=${process.pid}`;
    const lock = await tryAcquireLock(LOCK_KEY_RUNTIME_TASK_PRUNE, 1800, owner);
    if (!lock.acquired) {
        const e = new Error('数据清理任务执行中');
        e.code = 'LOCK_BUSY';
        e.lease_until = lock.lease_until;
        throw e;
    }

    const startedAt = nowText();
    const startMs = Date.now();
    let log = null;
    try {
        log = await createMaintenanceTaskLog({
            task_type: TASK_TYPE_RUNTIME_TASK_PRUNE,
            trigger_type: triggerType,
            trigger_user_id: triggerUserId,
            status: 'running',
            started_at: startedAt,
            target_table: 'runtime_task',
            retention_days: retentionDays,
            desc: owner
        });
        const result = await pruneRuntimeTaskRows(retentionDays);
        const finished = await finishMaintenanceTaskLog(log.id, {
            status: 'success',
            finished_at: nowText(),
            duration_ms: Date.now() - startMs,
            deleted_rows: result.deleted_rows,
            before_bytes: result.before_bytes,
            after_bytes: result.after_bytes,
            estimated_deleted_bytes: result.estimated_deleted_bytes,
            freed_bytes: result.freed_bytes,
            result_json: result,
            desc: owner
        });
        return { ok: true, log: finished, result };
    } catch (err) {
        if (log && log.id) {
            await finishMaintenanceTaskLog(log.id, {
                status: 'failed',
                finished_at: nowText(),
                duration_ms: Date.now() - startMs,
                error_message: String(err && err.message ? err.message : err),
                result_json: {},
                desc: owner
            }).catch(() => {});
        }
        throw err;
    } finally {
        await releaseLock(LOCK_KEY_RUNTIME_TASK_PRUNE, `release ${owner}`).catch(() => {});
    }
}

async function runScheduledRuntimeTaskPruneIfDue(options = {}) {
    const now = options.now instanceof Date ? options.now : new Date();
    const today = todayText();
    if (!scheduledWindowReached(now)) {
        return { ok: true, skipped: true, reason: 'before_schedule_window', schedule: '03:30' };
    }
    const lastRunDate = await getLastRunDate(JOB_KEY_RUNTIME_TASK_PRUNE);
    if (lastRunDate === today) {
        return { ok: true, skipped: true, reason: 'already_ran_today', last_run_date: lastRunDate };
    }
    const out = await runRuntimeTaskPrune({
        trigger_type: 'scheduled',
        trigger_user_id: 0,
        retention_days: options.retention_days || DEFAULT_RETENTION_DAYS
    });
    await setLastRunDate(JOB_KEY_RUNTIME_TASK_PRUNE, today, `scheduled runtime_task prune at ${nowText()}`);
    return { ...out, skipped: false };
}

async function getRuntimeTaskPruneDashboard(options = {}) {
    const limit = Math.max(1, Math.min(50, Number(options.limit || 20)));
    const logs = await listMaintenanceTaskLogs({
        task_type: TASK_TYPE_RUNTIME_TASK_PRUNE,
        limit
    });
    return {
        task_type: TASK_TYPE_RUNTIME_TASK_PRUNE,
        target_table: 'runtime_task',
        retention_days: DEFAULT_RETENTION_DAYS,
        schedule: '每天 03:30 后首次触发',
        terminal_statuses: TERMINAL_STATUSES,
        latest: logs[0] || null,
        logs
    };
}

module.exports = {
    TASK_TYPE_RUNTIME_TASK_PRUNE,
    LOCK_KEY_RUNTIME_TASK_PRUNE,
    JOB_KEY_RUNTIME_TASK_PRUNE,
    DEFAULT_RETENTION_DAYS,
    TERMINAL_STATUSES,
    runRuntimeTaskPrune,
    runScheduledRuntimeTaskPruneIfDue,
    getRuntimeTaskPruneDashboard
};
