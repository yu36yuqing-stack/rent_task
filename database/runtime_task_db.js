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

function nowText(input = new Date()) {
    const d = input instanceof Date ? input : new Date(input);
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

function safeJsonObject(input) {
    if (input && typeof input === 'object' && !Array.isArray(input)) return input;
    try {
        const parsed = JSON.parse(String(input || ''));
        return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {};
    } catch {
        return {};
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

async function createRuntimeTaskIfAbsent(input = {}) {
    const taskId = String(input.task_id || input.taskId || '').trim();
    if (!taskId) throw new Error('幂等创建任务必须提供 task_id');
    try {
        return {
            created: true,
            task: await createRuntimeTask({ ...input, task_id: taskId })
        };
    } catch (error) {
        if (!String(error && error.code || '').startsWith('SQLITE_CONSTRAINT')) throw error;
        const existed = await getRuntimeTaskByTaskId(taskId);
        if (!existed) throw error;
        return { created: false, task: existed };
    }
}

async function createOrReuseRuntimeTaskByPrefix(input = {}, options = {}) {
    await initRuntimeTaskDb();
    const taskType = String(input.task_type || input.taskType || '').trim();
    const taskId = String(input.task_id || input.taskId || '').trim();
    const taskIdPrefix = String(options.task_id_prefix || options.taskIdPrefix || '').trim();
    const userId = Number(input.user_id || input.userId || 0);
    if (!taskType) throw new Error('task_type 不能为空');
    if (!taskId) throw new Error('创建任务必须提供 task_id');
    if (!taskIdPrefix || !taskId.startsWith(taskIdPrefix)) throw new Error('task_id_prefix 不合法');
    if (!userId) throw new Error('user_id 不合法');

    const now = nowText(options.now || new Date());
    const recentSuccessSec = Math.max(0, Number(options.recent_success_sec ?? options.recentSuccessSec ?? 60));
    const recentSuccessSince = nowText(new Date(new Date(options.now || Date.now()).getTime() - recentSuccessSec * 1000));
    const trigger = safeJsonObject(options.trigger);
    const db = openRuntimeDatabase();
    try {
        await run(db, 'BEGIN IMMEDIATE TRANSACTION');
        const existing = await get(db, `
            SELECT *
            FROM runtime_task
            WHERE user_id = ?
              AND task_type = ?
              AND is_deleted = 0
              AND substr(task_id, 1, length(?)) = ?
              AND (
                status IN (?, ?, ?)
                OR (status = ? AND finished_at >= ?)
              )
            ORDER BY
              CASE WHEN status IN (?, ?, ?) THEN 0 ELSE 1 END,
              id DESC
            LIMIT 1
        `, [
            userId,
            taskType,
            taskIdPrefix,
            taskIdPrefix,
            TASK_STATUS_PENDING,
            TASK_STATUS_RUNNING,
            TASK_STATUS_FAILED,
            TASK_STATUS_SUCCESS,
            recentSuccessSince,
            TASK_STATUS_PENDING,
            TASK_STATUS_RUNNING,
            TASK_STATUS_FAILED
        ]);

        if (existing) {
            const state = safeJsonObject(existing.result_json);
            const previousTriggers = Array.isArray(state.triggers) ? state.triggers : [];
            const triggerKey = String(trigger.trigger_key || '').trim();
            const triggerText = safeJsonText(trigger, '{}');
            const hasTrigger = previousTriggers.some((item) => {
                if (triggerKey) return String(item && item.trigger_key || '').trim() === triggerKey;
                return safeJsonText(item, '{}') === triggerText;
            });
            const triggers = (hasTrigger ? previousTriggers : [...previousTriggers, trigger]).slice(-20);
            const isManual = String(trigger.source || '').trim() === 'manual_product_action';
            const attachedManualCount = Math.max(0, Number(existing.attached_manual_count || 0)) + (isManual ? 1 : 0);
            const resultJson = {
                ...state,
                manual_consumed_count: state.manual_consumed_count
                    ?? (Number(state.attempt_count || 0) > 0 ? Number(existing.attached_manual_count || 0) : 0),
                triggers,
                last_trigger: trigger,
                coalesced_trigger_count: Math.max(0, Number(state.coalesced_trigger_count || 0)) + 1
            };
            await run(db, `
                UPDATE runtime_task
                SET result_json = ?, attached_manual_count = ?, modify_date = ?
                WHERE id = ? AND is_deleted = 0
            `, [safeJsonText(resultJson, '{}'), attachedManualCount, now, existing.id]);
            const task = await get(db, 'SELECT * FROM runtime_task WHERE id = ? LIMIT 1', [existing.id]);
            await run(db, 'COMMIT');
            return {
                created: false,
                reused: true,
                reuse_reason: existing.status === TASK_STATUS_SUCCESS ? 'recent_success' : 'active_task',
                task
            };
        }

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
        await run(db, `
            INSERT INTO runtime_task
            (task_id, user_id, task_type, trigger_source, status, stage, progress_text, result_json, error_json, attached_manual_count, started_at, finished_at, create_date, modify_date, is_deleted, desc)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, ?)
        `, [taskId, userId, taskType, triggerSource, status, stage, progressText, resultJson, errorJson, attachedManualCount, startedAt, finishedAt, now, now, desc]);
        const task = await get(db, 'SELECT * FROM runtime_task WHERE task_id = ? AND is_deleted = 0 LIMIT 1', [taskId]);
        await run(db, 'COMMIT');
        return { created: true, reused: false, reuse_reason: '', task };
    } catch (error) {
        await run(db, 'ROLLBACK').catch(() => {});
        throw error;
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

async function listRuntimeTasksByUserAndType(userId, taskType, options = {}) {
    await initRuntimeTaskDb();
    const uid = Number(userId || 0);
    const type = String(taskType || '').trim();
    if (!uid) throw new Error('user_id 不合法');
    if (!type) throw new Error('task_type 不能为空');
    const limit = Math.max(1, Math.min(5000, Number(options.limit || 2000)));
    const db = openRuntimeDatabase();
    try {
        return await new Promise((resolve, reject) => {
            db.all(`
                SELECT *
                FROM runtime_task
                WHERE user_id = ?
                  AND task_type = ?
                  AND is_deleted = 0
                ORDER BY id DESC
                LIMIT ?
            `, [uid, type, limit], (error, rows) => {
                if (error) return reject(error);
                resolve(rows || []);
            });
        });
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

function dateTimeBefore(seconds) {
    const sec = Math.max(0, Number(seconds || 0));
    return nowText(new Date(Date.now() - sec * 1000));
}

async function listRunnableRuntimeTasks(taskType, options = {}) {
    await initRuntimeTaskDb();
    const type = String(taskType || '').trim();
    if (!type) throw new Error('task_type 不能为空');
    const limit = Math.max(1, Math.min(500, Number(options.limit || 100)));
    const staleBefore = String(options.stale_before || options.staleBefore || '').trim()
        || dateTimeBefore(options.stale_after_sec || options.staleAfterSec || 300);
    const db = openRuntimeDatabase();
    try {
        return await new Promise((resolve, reject) => {
            db.all(`
                SELECT *
                FROM runtime_task
                WHERE task_type = ?
                  AND is_deleted = 0
                  AND (
                    status IN (?, ?)
                    OR (status = ? AND COALESCE(NULLIF(started_at, ''), modify_date) <= ?)
                  )
                ORDER BY CASE WHEN COALESCE(started_at, '') = '' THEN 0 ELSE 1 END,
                         COALESCE(NULLIF(started_at, ''), create_date) ASC, id ASC
                LIMIT ?
            `, [type, TASK_STATUS_PENDING, TASK_STATUS_FAILED, TASK_STATUS_RUNNING, staleBefore, limit], (error, rows) => {
                if (error) return reject(error);
                resolve(rows || []);
            });
        });
    } finally {
        db.close();
    }
}

async function claimRuntimeTask(taskId, taskType, options = {}) {
    await initRuntimeTaskDb();
    const key = String(taskId || '').trim();
    const type = String(taskType || '').trim();
    if (!key) throw new Error('task_id 不能为空');
    if (!type) throw new Error('task_type 不能为空');
    const staleBefore = String(options.stale_before || options.staleBefore || '').trim()
        || dateTimeBefore(options.stale_after_sec || options.staleAfterSec || 300);
    const stage = String(options.stage || '').trim() || 'executing';
    const progressText = String(options.progress_text || options.progressText || '').trim() || '任务执行中';
    const now = nowText();
    const db = openRuntimeDatabase();
    try {
        await run(db, 'BEGIN IMMEDIATE TRANSACTION');
        const ret = await run(db, `
            UPDATE runtime_task
            SET status = ?, stage = ?, progress_text = ?,
                started_at = ?,
                finished_at = '', modify_date = ?
            WHERE task_id = ?
              AND task_type = ?
              AND is_deleted = 0
              AND (
                status IN (?, ?)
                OR (status = ? AND COALESCE(NULLIF(started_at, ''), modify_date) <= ?)
              )
        `, [
            TASK_STATUS_RUNNING,
            stage,
            progressText,
            now,
            now,
            key,
            type,
            TASK_STATUS_PENDING,
            TASK_STATUS_FAILED,
            TASK_STATUS_RUNNING,
            staleBefore
        ]);
        const row = Number(ret.changes || 0) > 0
            ? await get(db, `
                SELECT * FROM runtime_task
                WHERE task_id = ? AND is_deleted = 0
                LIMIT 1
            `, [key])
            : null;
        await run(db, 'COMMIT');
        return row;
    } catch (error) {
        await run(db, 'ROLLBACK').catch(() => {});
        throw error;
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
        if (column === 'result_json' && patch.preserve_trigger_state === true) {
            // A click/order may attach while the worker is awaiting an API response.
            sets.push(`result_json = json_set(?,
                '$.triggers', json(COALESCE(json_extract(result_json, '$.triggers'), '[]')),
                '$.last_trigger', json(COALESCE(json_extract(result_json, '$.last_trigger'), '{}')),
                '$.coalesced_trigger_count', COALESCE(json_extract(result_json, '$.coalesced_trigger_count'), 0),
                '$.manual_consumed_count', ${patch.consume_manual_attempt === true
                    ? 'attached_manual_count'
                    : "COALESCE(json_extract(result_json, '$.manual_consumed_count'), CASE WHEN COALESCE(json_extract(result_json, '$.attempt_count'), 0) > 0 THEN attached_manual_count ELSE 0 END)"})`);
            params.push(value);
            continue;
        }
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
    createRuntimeTaskIfAbsent,
    createOrReuseRuntimeTaskByPrefix,
    getRuntimeTaskByTaskId,
    listRuntimeTasksByUserAndType,
    findLatestActiveRuntimeTask,
    listRunnableRuntimeTasks,
    claimRuntimeTask,
    updateRuntimeTask,
    markRuntimeTaskRunning,
    markRuntimeTaskFinished,
    attachManualToRuntimeTask
};
