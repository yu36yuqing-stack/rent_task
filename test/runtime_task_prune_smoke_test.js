const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'runtime-task-prune-'));
process.env.RUNTIME_DB_FILE_PATH = path.join(tempDir, 'runtime.db');

const { openRuntimeDatabase } = require('../database/sqlite_client');
const { initRuntimeTaskDb } = require('../database/runtime_task_db');
const {
    runRuntimeTaskPrune,
    getRuntimeTaskPruneDashboard
} = require('../maintenance/runtime_task_prune_service');

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

async function insertTask(row) {
    const db = openRuntimeDatabase();
    try {
        await run(db, `
            INSERT INTO runtime_task
            (task_id, user_id, task_type, trigger_source, status, stage, progress_text, result_json, error_json,
             attached_manual_count, started_at, finished_at, create_date, modify_date, is_deleted, desc)
            VALUES (?, 0, 'smoke', 'test', ?, '', '', '{}', '[]', 0, '', '', ?, ?, 0, '')
        `, [row.task_id, row.status, row.create_date, row.create_date]);
    } finally {
        db.close();
    }
}

async function countTasks() {
    const db = openRuntimeDatabase();
    try {
        return await get(db, `
            SELECT
              SUM(CASE WHEN task_id = 'old_success' THEN 1 ELSE 0 END) AS old_success,
              SUM(CASE WHEN task_id = 'old_running' THEN 1 ELSE 0 END) AS old_running,
              SUM(CASE WHEN task_id = 'new_success' THEN 1 ELSE 0 END) AS new_success
            FROM runtime_task
        `);
    } finally {
        db.close();
    }
}

(async () => {
    await initRuntimeTaskDb();
    await insertTask({ task_id: 'old_success', status: 'success', create_date: '2026-05-01 00:00:00' });
    await insertTask({ task_id: 'old_running', status: 'running', create_date: '2026-05-01 00:00:00' });
    await insertTask({ task_id: 'new_success', status: 'success', create_date: '2026-05-18 00:00:00' });

    const out = await runRuntimeTaskPrune({
        trigger_type: 'manual',
        trigger_user_id: 8,
        retention_days: 7
    });
    assert.strictEqual(out.ok, true);
    assert.strictEqual(Number(out.result.deleted_rows), 1);

    const counts = await countTasks();
    assert.strictEqual(Number(counts.old_success || 0), 0);
    assert.strictEqual(Number(counts.old_running || 0), 1);
    assert.strictEqual(Number(counts.new_success || 0), 1);

    const dashboard = await getRuntimeTaskPruneDashboard({ limit: 5 });
    assert.strictEqual(String(dashboard.latest.status), 'success');
    assert.strictEqual(Number(dashboard.latest.deleted_rows), 1);
    assert.strictEqual(Number(dashboard.latest.trigger_user_id), 8);

    console.log(`[PASS] runtime_task_prune_smoke_test temp_dir=${tempDir}`);
})().catch((err) => {
    console.error(`[FAIL] runtime_task_prune_smoke_test: ${err.message}`);
    process.exit(1);
});
