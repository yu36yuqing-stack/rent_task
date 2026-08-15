const { tryAcquireLock, releaseOwnedLock, touchLock } = require('../database/lock_db');
const { getLastRunDate, setLastRunDate } = require('../database/order_stats_job_state_db');
const {
    createMaintenanceTaskLog,
    finishMaintenanceTaskLog,
    listMaintenanceTaskLogs
} = require('../database/maintenance_task_log_db');
const {
    TASK_TYPE_RUNTIME_TASK_PRUNE,
    DEFAULT_RETENTION_DAYS,
    TERMINAL_STATUSES,
    pruneRuntimeTaskRows
} = require('./runtime_task_prune_service');
const { pruneApplicationLogs } = require('./log_retention_service');

const TASK_TYPE_SYSTEM_RETENTION = 'system_retention';
const LOCK_KEY_SYSTEM_RETENTION = 'maintenance_system_retention';
const JOB_KEY_SYSTEM_RETENTION = 'maintenance_system_retention';
const LOCK_LEASE_SEC = 300;
const SCHEDULE_HOUR = 3;
const SCHEDULE_MINUTE = 30;

function dateTimeText(date = new Date()) {
    const p = (n) => String(n).padStart(2, '0');
    return `${date.getFullYear()}-${p(date.getMonth() + 1)}-${p(date.getDate())} ${p(date.getHours())}:${p(date.getMinutes())}:${p(date.getSeconds())}`;
}

function dateText(date = new Date()) {
    return dateTimeText(date).slice(0, 10);
}

function scheduledWindowReached(date = new Date()) {
    const hour = Number(date.getHours() || 0);
    const minute = Number(date.getMinutes() || 0);
    return hour > SCHEDULE_HOUR || (hour === SCHEDULE_HOUR && minute >= SCHEDULE_MINUTE);
}

function parseResultJson(row) {
    if (!row) return null;
    try {
        return { ...row, result: JSON.parse(String(row.result_json || '{}')) };
    } catch {
        return { ...row, result: {} };
    }
}

function aggregateResult(runtimeTask, applicationLogs, retentionDays) {
    return {
        target: 'runtime_task + application_logs',
        retention_days: retentionDays,
        runtime_task: runtimeTask,
        application_logs: applicationLogs,
        deleted_rows: Number(runtimeTask.deleted_rows || 0) + Number(applicationLogs.deleted_rows || 0),
        before_bytes: Number(runtimeTask.before_bytes || 0) + Number(applicationLogs.before_bytes || 0),
        after_bytes: Number(runtimeTask.after_bytes || 0) + Number(applicationLogs.after_bytes || 0),
        estimated_deleted_bytes: Number(runtimeTask.estimated_deleted_bytes || 0)
            + Number(applicationLogs.estimated_deleted_bytes || 0),
        freed_bytes: Number(runtimeTask.freed_bytes || 0) + Number(applicationLogs.freed_bytes || 0)
    };
}

async function runSystemRetention(options = {}) {
    const triggerType = String(options.trigger_type || options.triggerType || 'manual').trim() || 'manual';
    const triggerUserId = Number(options.trigger_user_id || options.triggerUserId || 0);
    const retentionDays = Math.max(1, Math.floor(Number(options.retention_days || options.retentionDays || DEFAULT_RETENTION_DAYS)));
    const owner = `system_retention trigger=${triggerType} user_id=${triggerUserId} pid=${process.pid}`;
    const lock = await tryAcquireLock(LOCK_KEY_SYSTEM_RETENTION, LOCK_LEASE_SEC, owner);
    if (!lock.acquired) {
        const err = new Error('系统数据清理任务执行中');
        err.code = 'LOCK_BUSY';
        err.lease_until = lock.lease_until;
        throw err;
    }

    const startedAt = dateTimeText();
    const startMs = Date.now();
    let log = null;
    const partialResult = {};
    const heartbeat = async () => {
        const touched = await touchLock(LOCK_KEY_SYSTEM_RETENTION, LOCK_LEASE_SEC, owner);
        if (!touched) {
            const err = new Error('系统数据清理锁已失效');
            err.code = 'LOCK_LOST';
            throw err;
        }
    };
    try {
        log = await createMaintenanceTaskLog({
            task_type: TASK_TYPE_SYSTEM_RETENTION,
            trigger_type: triggerType,
            trigger_user_id: triggerUserId,
            status: 'running',
            started_at: startedAt,
            target_table: 'runtime_task + application_logs',
            retention_days: retentionDays,
            desc: owner
        });
        partialResult.runtime_task = await pruneRuntimeTaskRows(retentionDays);
        await heartbeat();
        partialResult.application_logs = await pruneApplicationLogs({
            retention_days: retentionDays,
            log_dir: options.log_dir || options.logDir,
            files: options.files,
            now: options.now,
            on_progress: heartbeat
        });
        const result = aggregateResult(partialResult.runtime_task, partialResult.application_logs, retentionDays);
        const finished = await finishMaintenanceTaskLog(log.id, {
            status: 'success',
            finished_at: dateTimeText(),
            duration_ms: Date.now() - startMs,
            deleted_rows: result.deleted_rows,
            before_bytes: result.before_bytes,
            after_bytes: result.after_bytes,
            estimated_deleted_bytes: result.estimated_deleted_bytes,
            freed_bytes: result.freed_bytes,
            result_json: result,
            desc: owner
        });
        return { ok: true, log: parseResultJson(finished), result };
    } catch (err) {
        if (log && log.id) {
            await finishMaintenanceTaskLog(log.id, {
                status: 'failed',
                finished_at: dateTimeText(),
                duration_ms: Date.now() - startMs,
                error_message: String(err && err.message ? err.message : err),
                result_json: partialResult,
                desc: owner
            }).catch(() => {});
        }
        throw err;
    } finally {
        await releaseOwnedLock(LOCK_KEY_SYSTEM_RETENTION, owner, `release ${owner}`).catch(() => {});
    }
}

async function runScheduledSystemRetentionIfDue(options = {}) {
    const now = options.now instanceof Date ? options.now : new Date();
    const today = dateText(now);
    if (!scheduledWindowReached(now)) {
        return { ok: true, skipped: true, reason: 'before_schedule_window', schedule: '03:30' };
    }
    const lastRunDate = await getLastRunDate(JOB_KEY_SYSTEM_RETENTION);
    if (lastRunDate === today) {
        return { ok: true, skipped: true, reason: 'already_ran_today', last_run_date: lastRunDate };
    }
    const out = await runSystemRetention({
        ...options,
        trigger_type: 'scheduled',
        trigger_user_id: 0,
        retention_days: options.retention_days || DEFAULT_RETENTION_DAYS
    });
    await setLastRunDate(JOB_KEY_SYSTEM_RETENTION, today, `scheduled system retention at ${dateTimeText(now)}`);
    return { ...out, skipped: false };
}

async function getSystemRetentionDashboard(options = {}) {
    const limit = Math.max(1, Math.min(50, Number(options.limit || 20)));
    const logs = await listMaintenanceTaskLogs({
        task_types: [TASK_TYPE_SYSTEM_RETENTION, TASK_TYPE_RUNTIME_TASK_PRUNE],
        limit
    });
    const hydrated = logs.map(parseResultJson);
    return {
        task_type: TASK_TYPE_SYSTEM_RETENTION,
        target_table: 'runtime_task + application_logs',
        retention_days: DEFAULT_RETENTION_DAYS,
        schedule: '每天 03:30 后首次触发',
        terminal_statuses: TERMINAL_STATUSES,
        log_policy: '应用日志保留最近 7 天，历史内容使用 gzip 压缩',
        latest: hydrated[0] || null,
        logs: hydrated
    };
}

module.exports = {
    TASK_TYPE_SYSTEM_RETENTION,
    LOCK_KEY_SYSTEM_RETENTION,
    JOB_KEY_SYSTEM_RETENTION,
    LOCK_LEASE_SEC,
    runSystemRetention,
    runScheduledSystemRetentionIfDue,
    getSystemRetentionDashboard
};
