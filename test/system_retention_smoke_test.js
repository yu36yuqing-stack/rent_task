const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'system-retention-'));
process.env.MAIN_DB_FILE_PATH = path.join(tempDir, 'main.db');
process.env.RUNTIME_DB_FILE_PATH = path.join(tempDir, 'runtime.db');
process.env.ORDER_DB_FILE_PATH = path.join(tempDir, 'order.db');
process.env.STATS_DB_FILE_PATH = path.join(tempDir, 'stats.db');
process.env.PRICE_DB_FILE_PATH = path.join(tempDir, 'price.db');

const { openRuntimeDatabase } = require('../database/sqlite_client');
const { initRuntimeTaskDb } = require('../database/runtime_task_db');
const {
    LOCK_KEY_SYSTEM_RETENTION,
    runSystemRetention,
    runScheduledSystemRetentionIfDue,
    _internal,
    getSystemRetentionDashboard
} = require('../maintenance/system_retention_service');
const { tryAcquireLock, releaseOwnedLock } = require('../database/lock_db');

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

function sqlDateDaysAgo(days) {
    const date = new Date(Date.now() - days * 24 * 60 * 60 * 1000);
    return date.toISOString().slice(0, 19).replace('T', ' ');
}

async function insertTask(taskId, status, createDate) {
    const db = openRuntimeDatabase();
    try {
        await run(db, `
            INSERT INTO runtime_task
            (task_id, user_id, task_type, trigger_source, status, stage, progress_text, result_json, error_json,
             attached_manual_count, started_at, finished_at, create_date, modify_date, is_deleted, desc)
            VALUES (?, 0, 'retention_test', 'test', ?, '', '', '{}', '[]', 0, '', '', ?, ?, 0, '')
        `, [taskId, status, createDate, createDate]);
    } finally {
        db.close();
    }
}

(async () => {
    await initRuntimeTaskDb();
    await insertTask('old_success', 'success', sqlDateDaysAgo(10));
    await insertTask('old_running', 'running', sqlDateDaysAgo(10));
    await insertTask('new_success', 'success', sqlDateDaysAgo(2));

    const beforeSchedule = await runScheduledSystemRetentionIfDue({
        now: new Date(2026, 8, 20, 2, 0, 0)
    });
    assert.strictEqual(beforeSchedule.skipped, true);
    assert.strictEqual(beforeSchedule.reason, 'before_schedule_window');

    const logDir = path.join(tempDir, 'log');
    fs.mkdirSync(logDir, { recursive: true });
    const oldIso = new Date(Date.now() - 10 * 24 * 60 * 60 * 1000).toISOString();
    const recentIso = new Date(Date.now() - 2 * 24 * 60 * 60 * 1000).toISOString();
    fs.writeFileSync(path.join(logDir, 'order_worker.log'), `[${oldIso}] old\n[${recentIso}] recent\n`);

    const out = await runSystemRetention({
        trigger_type: 'manual_script',
        trigger_user_id: 8,
        retention_days: 7,
        log_dir: logDir,
        files: ['order_worker.log'],
        compaction_force: true,
        compaction_min_free_bytes: 0,
        compaction_busy_timeout_ms: 20
    });
    assert.strictEqual(out.ok, true);
    assert.strictEqual(out.result.runtime_task.deleted_rows, 1);
    assert.strictEqual(out.result.application_logs.deleted_rows, 1);
    assert.strictEqual(out.result.user_blacklist_history.deleted_rows, 0);
    assert.strictEqual(out.result.product_onoff_history.deleted_rows, 0);
    assert.strictEqual(out.result.order_detail_html.cleared_rows, 0);
    assert.strictEqual(out.result.database_compaction.length, 3);
    assert(out.result.database_compaction.every((item) => item.status === 'compacted'));
    assert.strictEqual(out.result.retention_policy.user_blacklist_history, 30);
    assert.strictEqual(out.result.retention_policy.product_onoff_history, 7);
    assert.strictEqual(out.result.retention_policy.order_detail_html, 30);

    const db = openRuntimeDatabase();
    const counts = await get(db, `
        SELECT
          SUM(CASE WHEN task_id = 'old_success' THEN 1 ELSE 0 END) AS old_success,
          SUM(CASE WHEN task_id = 'old_running' THEN 1 ELSE 0 END) AS old_running,
          SUM(CASE WHEN task_id = 'new_success' THEN 1 ELSE 0 END) AS new_success
        FROM runtime_task
    `);
    db.close();
    assert.strictEqual(Number(counts.old_success || 0), 0);
    assert.strictEqual(Number(counts.old_running || 0), 1);
    assert.strictEqual(Number(counts.new_success || 0), 1);

    const dashboard = await getSystemRetentionDashboard({ limit: 5 });
    assert.strictEqual(dashboard.latest.task_type, 'system_retention');
    assert.strictEqual(dashboard.latest.status, 'success');
    assert.strictEqual(dashboard.latest.result.application_logs.processed_files, 1);
    assert.strictEqual(dashboard.retention_policy.user_blacklist_history, 30);
    assert.strictEqual(dashboard.compaction_policy.min_free_ratio, 0.25);

    const disabledCompaction = await _internal.compactManagedDatabases({ enabled: false });
    assert.deepStrictEqual(disabledCompaction, []);

    const lockOwner = 'system-retention-smoke-holder';
    const held = await tryAcquireLock(LOCK_KEY_SYSTEM_RETENTION, 30, lockOwner);
    assert.strictEqual(held.acquired, true);
    await assert.rejects(
        () => runSystemRetention({ log_dir: logDir, files: ['order_worker.log'], compact_databases: false }),
        (err) => err && err.code === 'LOCK_BUSY'
    );
    await releaseOwnedLock(LOCK_KEY_SYSTEM_RETENTION, lockOwner, 'smoke release');

    console.log(`[PASS] system_retention_smoke_test temp_dir=${tempDir}`);
})().catch((err) => {
    console.error(`[FAIL] system_retention_smoke_test: ${err.stack || err.message}`);
    process.exit(1);
});
