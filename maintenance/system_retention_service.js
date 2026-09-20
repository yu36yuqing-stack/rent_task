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
const { pruneUserBlacklistHistory } = require('../database/user_blacklist_db');
const { pruneProductOnoffHistory } = require('../database/product_onoff_history_db');
const { pruneOrderDetailHtml } = require('../database/order_detail_db');
const {
    MAIN_DB_FILE,
    RUNTIME_DB_FILE,
    ORDER_DB_FILE,
    openMainDatabase,
    openRuntimeDatabase,
    openOrderDatabase
} = require('../database/sqlite_client');
const {
    DEFAULT_MIN_FREE_RATIO,
    DEFAULT_MIN_FREE_BYTES,
    compactDatabaseIfNeeded
} = require('./database_compaction_service');

const TASK_TYPE_SYSTEM_RETENTION = 'system_retention';
const LOCK_KEY_SYSTEM_RETENTION = 'maintenance_system_retention';
const JOB_KEY_SYSTEM_RETENTION = 'maintenance_system_retention';
const LOCK_LEASE_SEC = 300;
const SCHEDULE_HOUR = 3;
const SCHEDULE_MINUTE = 30;
const BLACKLIST_HISTORY_RETENTION_DAYS = 30;
const PRODUCT_ONOFF_HISTORY_RETENTION_DAYS = 7;
const ORDER_DETAIL_HTML_RETENTION_DAYS = 30;

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

function sumMetric(items, field) {
    return items.reduce((sum, item) => sum + Math.max(0, Number(item && item[field] || 0)), 0);
}

function aggregateResult(partialResult, retentionPolicy) {
    const runtimeTask = partialResult.runtime_task || {};
    const applicationLogs = partialResult.application_logs || {};
    const cleanupItems = [
        runtimeTask,
        partialResult.user_blacklist_history,
        partialResult.product_onoff_history,
        partialResult.order_detail_html,
        applicationLogs
    ].filter(Boolean);
    const compactions = Array.isArray(partialResult.database_compaction)
        ? partialResult.database_compaction
        : [];
    return {
        target: 'runtime_task + application_logs + history_tables + order_detail_html',
        retention_days: retentionPolicy.runtime_task,
        retention_policy: retentionPolicy,
        runtime_task: runtimeTask,
        user_blacklist_history: partialResult.user_blacklist_history || null,
        product_onoff_history: partialResult.product_onoff_history || null,
        order_detail_html: partialResult.order_detail_html || null,
        application_logs: applicationLogs,
        database_compaction: compactions,
        deleted_rows: sumMetric(cleanupItems, 'deleted_rows'),
        before_bytes: sumMetric(cleanupItems, 'before_bytes'),
        after_bytes: sumMetric(cleanupItems, 'after_bytes'),
        estimated_deleted_bytes: sumMetric(cleanupItems, 'estimated_deleted_bytes'),
        freed_bytes: sumMetric(cleanupItems, 'freed_bytes') + sumMetric(compactions, 'freed_bytes')
    };
}

async function compactManagedDatabases(options = {}) {
    if (options.enabled === false) return [];
    const specs = [
        { database_name: 'main', file_path: MAIN_DB_FILE, open_database: openMainDatabase },
        { database_name: 'order', file_path: ORDER_DB_FILE, open_database: openOrderDatabase },
        { database_name: 'runtime', file_path: RUNTIME_DB_FILE, open_database: openRuntimeDatabase }
    ];
    const results = [];
    for (const spec of specs) {
        results.push(await compactDatabaseIfNeeded({
            ...spec,
            min_free_ratio: options.min_free_ratio,
            min_free_bytes: options.min_free_bytes,
            busy_timeout_ms: options.busy_timeout_ms,
            force: options.force === true
        }));
        if (typeof options.on_progress === 'function') await options.on_progress(results[results.length - 1]);
    }
    return results;
}

async function runSystemRetention(options = {}) {
    const triggerType = String(options.trigger_type || options.triggerType || 'manual').trim() || 'manual';
    const triggerUserId = Number(options.trigger_user_id || options.triggerUserId || 0);
    const retentionDays = Math.max(1, Math.floor(Number(options.retention_days || options.retentionDays || DEFAULT_RETENTION_DAYS)));
    const retentionPolicy = {
        runtime_task: retentionDays,
        application_logs: retentionDays,
        user_blacklist_history: Math.max(1, Math.floor(Number(
            options.blacklist_history_retention_days || BLACKLIST_HISTORY_RETENTION_DAYS
        ))),
        product_onoff_history: Math.max(1, Math.floor(Number(
            options.product_onoff_history_retention_days || PRODUCT_ONOFF_HISTORY_RETENTION_DAYS
        ))),
        order_detail_html: Math.max(1, Math.floor(Number(
            options.order_detail_html_retention_days || ORDER_DETAIL_HTML_RETENTION_DAYS
        )))
    };
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
            target_table: 'runtime_task + application_logs + history_tables + order_detail_html',
            retention_days: retentionDays,
            desc: owner
        });
        partialResult.runtime_task = await pruneRuntimeTaskRows(retentionDays);
        await heartbeat();
        partialResult.user_blacklist_history = await pruneUserBlacklistHistory({
            retain_days: retentionPolicy.user_blacklist_history
        });
        await heartbeat();
        partialResult.product_onoff_history = await pruneProductOnoffHistory({
            retain_days: retentionPolicy.product_onoff_history
        });
        await heartbeat();
        partialResult.order_detail_html = await pruneOrderDetailHtml({
            retain_days: retentionPolicy.order_detail_html
        });
        await heartbeat();
        partialResult.application_logs = await pruneApplicationLogs({
            retention_days: retentionDays,
            log_dir: options.log_dir || options.logDir,
            files: options.files,
            now: options.now,
            on_progress: heartbeat
        });
        await heartbeat();
        partialResult.database_compaction = await compactManagedDatabases({
            enabled: options.compact_databases !== false,
            min_free_ratio: options.compaction_min_free_ratio ?? DEFAULT_MIN_FREE_RATIO,
            min_free_bytes: options.compaction_min_free_bytes ?? DEFAULT_MIN_FREE_BYTES,
            busy_timeout_ms: options.compaction_busy_timeout_ms,
            force: options.compaction_force === true,
            on_progress: heartbeat
        });
        const result = aggregateResult(partialResult, retentionPolicy);
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
        target_table: 'runtime_task + application_logs + history_tables + order_detail_html',
        retention_days: DEFAULT_RETENTION_DAYS,
        retention_policy: {
            runtime_task: DEFAULT_RETENTION_DAYS,
            application_logs: DEFAULT_RETENTION_DAYS,
            user_blacklist_history: BLACKLIST_HISTORY_RETENTION_DAYS,
            product_onoff_history: PRODUCT_ONOFF_HISTORY_RETENTION_DAYS,
            order_detail_html: ORDER_DETAIL_HTML_RETENTION_DAYS
        },
        compaction_policy: {
            min_free_ratio: DEFAULT_MIN_FREE_RATIO,
            min_free_bytes: DEFAULT_MIN_FREE_BYTES,
            busy_behavior: 'skip'
        },
        schedule: '每天 03:30 后首次触发',
        terminal_statuses: TERMINAL_STATUSES,
        log_policy: '应用日志保留最近 7 天，历史内容使用 gzip 压缩；数据库空闲页达到阈值后压缩',
        latest: hydrated[0] || null,
        logs: hydrated
    };
}

module.exports = {
    TASK_TYPE_SYSTEM_RETENTION,
    LOCK_KEY_SYSTEM_RETENTION,
    JOB_KEY_SYSTEM_RETENTION,
    LOCK_LEASE_SEC,
    BLACKLIST_HISTORY_RETENTION_DAYS,
    PRODUCT_ONOFF_HISTORY_RETENTION_DAYS,
    ORDER_DETAIL_HTML_RETENTION_DAYS,
    runSystemRetention,
    runScheduledSystemRetentionIfDue,
    getSystemRetentionDashboard,
    _internal: {
        sumMetric,
        aggregateResult,
        compactManagedDatabases
    }
};
