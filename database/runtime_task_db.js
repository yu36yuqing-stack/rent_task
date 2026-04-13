const crypto = require('crypto');
const { openRuntimeDatabase } = require('./sqlite_client');

const TASK_STATUS_PENDING = 'pending';
const TASK_STATUS_RUNNING = 'running';
const TASK_STATUS_SUCCESS = 'success';
const TASK_STATUS_PARTIAL_FAILED = 'partial_failed';
const TASK_STATUS_FAILED = 'failed';
const TASK_STATUS_SKIPPED = 'skipped';

const ACTIVE_STATUSES = [
    TASK_STATUS_PENDING,
    TASK_STATUS_RUNNING
];

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

async function initRuntimeTaskDb() {
    const db = openRuntimeDatabase();
    try {
        await run(db, `
            CREATE TABLE IF NOT EXISTS runtime_task (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                task_id TEXT NOT NULL DEFAULT '',
                user_id INTEGER NOT NULL DEFAULT 0,
                task_type TEXT NOT NULL DEFAULT '',
                trigger_source TEXT NOT NULL DEFAULT '',
                status TEXT NOT NULL DEFAULT '',
                stage TEXT NOT NULL DEFAULT '',
                progress_text TEXT NOT NULL DEFAULT '',
                result_json TEXT NOT NULL DEFAULT '{}',
                error_json TEXT NOT NULL DEFAULT '[]',
                attached_manual_count INTEGER NOT NULL DEFAULT 0,
                started_at TEXT NOT NULL DEFAULT '',
                finished_at TEXT NOT NULL DEFAULT '',
                create_date TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
                modify_date TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
                is_deleted INTEGER NOT NULL DEFAULT 0,
                desc TEXT NOT NULL DEFAULT ''
            )
        `);
        await run(db, `
            CREATE UNIQUE INDEX IF NOT EXISTS uq_runtime_task_task_id_alive
            ON runtime_task(task_id, is_deleted)
        `);
        await run(db, `
            CREATE INDEX IF NOT EXISTS idx_runtime_task_user_type_status
            ON runtime_task(user_id, task_type, status, is_deleted, id)
        `);
        await run(db, `
            CREATE INDEX IF NOT EXISTS idx_runtime_task_type_status
            ON runtime_task(task_type, status, is_deleted, id)
        `);
    } finally {
        db.close();
    }
}

function createTaskId(taskType = '') {
    const prefix = String(taskType || 'task').trim().toLowerCase() || 'task';
    const token = typeof crypto.randomUUID === 'function'
        ? crypto.randomUUID().replace(/-/g, '')
        : crypto.randomBytes(16).toString('hex');
    return `${prefix}_${Date.now()}_${token.slice(0, 12)}`;
}

function safeJsonText(input, fallback = '{}') {
    try {
        return JSON.stringify(input === undefined ? JSON.parse(fallback) : input);
    } catch {
        return fallback;
    }
}

async function createRuntimeTask(input = {}) {
    await initRuntimeTaskDb();
    const taskType = String(input.task_type || input.taskType || '').trim();
    if (!taskType) throw new Error('task_type 不能为空');
    const taskId = String(input.task_id || input.taskId || '').trim() || createTaskId(taskType);
    const userId = Number(input.user_id || input.userId || 0);
    const triggerSource = String(input.trigger_source || input.triggerSource || '').trim() || 'system';
    const status = String(input.status || '').trim() || TASK_STATUS_PENDING;
    const stage = String(input.stage || '').trim();
    const progressText = String(input.progress_text || input.progressText || '').trim();
    const resultJson = safeJsonText(input.result_json ?? input.resultJson ?? {}, '{}');
    const errorJson = safeJsonText(input.error_json ?? input.errorJson ?? [], '[]');
    const attachedManualCount = Math.max(0, Number(input.attached_manual_count || input.attachedManualCount || 0));
    const startedAt = String(input.started_at || input.startedAt || '').trim();
    const finishedAt = String(input.finished_at || input.finishedAt || '').trim();
    const desc = String(input.desc || '').trim();
    const db = openRuntimeDatabase();
    try {
        await run(db, `
            INSERT INTO runtime_task
            (task_id, user_id, task_type, trigger_source, status, stage, progress_text, result_json, error_json, attached_manual_count, started_at, finished_at, create_date, modify_date, is_deleted, desc)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, ?)
        `, [taskId, userId, taskType, triggerSource, status, stage, progressText, resultJson, errorJson, attachedManualCount, startedAt, finishedAt, nowText(), nowText(), desc]);
        return await getRuntimeTaskByTaskId(taskId);
    } finally {
        db.close();
    }
}

async function getRuntimeTaskByTaskId(taskId) {
    await initRuntimeTaskDb();
    const key = String(taskId || '').trim();
    if (!key) return null;
    const db = openRuntimeDatabase();
    try {
        return await get(db, `
            SELECT *
            FROM runtime_task
            WHERE task_id = ? AND is_deleted = 0
            LIMIT 1
        `, [key]);
    } finally {
        db.close();
    }
}

async function findLatestActiveRuntimeTask(userId, taskType) {
    await initRuntimeTaskDb();
    const uid = Number(userId || 0);
    const type = String(taskType || '').trim();
    if (!type) return null;
    const db = openRuntimeDatabase();
    try {
        return await get(db, `
            SELECT *
            FROM runtime_task
            WHERE user_id = ?
              AND task_type = ?
              AND status IN (${ACTIVE_STATUSES.map(() => '?').join(',')})
              AND is_deleted = 0
            ORDER BY id DESC
            LIMIT 1
        `, [uid, type, ...ACTIVE_STATUSES]);
    } finally {
        db.close();
    }
}

async function updateRuntimeTask(taskId, patch = {}) {
    await initRuntimeTaskDb();
    const key = String(taskId || '').trim();
    if (!key) throw new Error('task_id 不能为空');
    const sets = ['modify_date = ?'];
    const params = [nowText()];
    const allowed = [
        ['status', 'status'],
        ['stage', 'stage'],
        ['progress_text', 'progressText'],
        ['result_json', 'resultJson'],
        ['error_json', 'errorJson'],
        ['attached_manual_count', 'attachedManualCount'],
        ['started_at', 'startedAt'],
        ['finished_at', 'finishedAt'],
        ['desc', 'desc']
    ];
    for (const [column, alias] of allowed) {
        if (patch[column] === undefined && patch[alias] === undefined) continue;
        let value = patch[column];
        if (value === undefined) value = patch[alias];
        if (column === 'result_json') value = safeJsonText(value ?? {}, '{}');
        if (column === 'error_json') value = safeJsonText(value ?? [], '[]');
        if (column === 'attached_manual_count') value = Math.max(0, Number(value || 0));
        else value = String(value ?? '').trim();
        sets.push(`${column} = ?`);
        params.push(value);
    }
    params.push(key);
    const db = openRuntimeDatabase();
    try {
        await run(db, `
            UPDATE runtime_task
            SET ${sets.join(', ')}
            WHERE task_id = ? AND is_deleted = 0
        `, params);
        return await getRuntimeTaskByTaskId(key);
    } finally {
        db.close();
    }
}

async function markRuntimeTaskRunning(taskId, patch = {}) {
    return await updateRuntimeTask(taskId, {
        ...patch,
        status: TASK_STATUS_RUNNING,
        started_at: String(patch.started_at || patch.startedAt || '').trim() || nowText()
    });
}

async function markRuntimeTaskFinished(taskId, patch = {}) {
    const status = String(patch.status || '').trim() || TASK_STATUS_SUCCESS;
    return await updateRuntimeTask(taskId, {
        ...patch,
        status,
        finished_at: String(patch.finished_at || patch.finishedAt || '').trim() || nowText()
    });
}

async function attachManualToRuntimeTask(taskId) {
    const row = await getRuntimeTaskByTaskId(taskId);
    if (!row) return null;
    const current = Math.max(0, Number(row.attached_manual_count || 0));
    return await updateRuntimeTask(taskId, {
        attached_manual_count: current + 1
    });
}

module.exports = {
    TASK_STATUS_PENDING,
    TASK_STATUS_RUNNING,
    TASK_STATUS_SUCCESS,
    TASK_STATUS_PARTIAL_FAILED,
    TASK_STATUS_FAILED,
    TASK_STATUS_SKIPPED,
    initRuntimeTaskDb,
    createRuntimeTask,
    getRuntimeTaskByTaskId,
    findLatestActiveRuntimeTask,
    updateRuntimeTask,
    markRuntimeTaskRunning,
    markRuntimeTaskFinished,
    attachManualToRuntimeTask
};
