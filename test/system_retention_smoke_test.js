const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'system-retention-'));
process.env.RUNTIME_DB_FILE_PATH = path.join(tempDir, 'runtime.db');

const { openRuntimeDatabase } = require('../database/sqlite_client');
const { initRuntimeTaskDb } = require('../database/runtime_task_db');
const {
    runSystemRetention,
    getSystemRetentionDashboard
} = require('../maintenance/system_retention_service');

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
        files: ['order_worker.log']
    });
    assert.strictEqual(out.ok, true);
    assert.strictEqual(out.result.runtime_task.deleted_rows, 1);
    assert.strictEqual(out.result.application_logs.deleted_rows, 1);

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

    console.log(`[PASS] system_retention_smoke_test temp_dir=${tempDir}`);
})().catch((err) => {
    console.error(`[FAIL] system_retention_smoke_test: ${err.stack || err.message}`);
    process.exit(1);
});
