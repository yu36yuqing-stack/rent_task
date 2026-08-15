const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { fork } = require('child_process');
const {
    TASK_STATUS_SUCCESS,
    TASK_STATUS_FAILED,
    createOrReuseRuntimeTaskByPrefix,
    getRuntimeTaskByTaskId,
    listRuntimeTasksByUserAndType,
    listRunnableRuntimeTasks,
    claimRuntimeTask,
    updateRuntimeTask,
    markRuntimeTaskFinished
} = require('../database/runtime_task_db');
const { listUserPlatformAuth } = require('../database/user_platform_auth_db');
const { listRentingOrderWindowByAccounts } = require('../database/order_db');
const { getLatestUserGameAccountByUserAndAccount } = require('../database/user_game_account_db');
const { revokeAccountAuth } = require('../uuzuhao/uuzuhao_api');
const { normalizeGameProfile } = require('../common/game_profile');

const AUTH_REVOKE_TASK_TYPE = 'uuzuhao_auth_revoke';
const FINISHED_ORDER_STATUSES = new Set([
    '已完成',
    '部分完成',
    '已撤单',
    '已退款',
    '投诉/撤单'
]);

function safeJsonObject(value, fallback = {}) {
    if (value && typeof value === 'object' && !Array.isArray(value)) return value;
    try {
        const parsed = JSON.parse(String(value || ''));
        return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : fallback;
    } catch {
        return fallback;
    }
}

function safeJsonArray(value) {
    if (Array.isArray(value)) return value;
    try {
        const parsed = JSON.parse(String(value || ''));
        return Array.isArray(parsed) ? parsed : [];
    } catch {
        return [];
    }
}

function isAuthRevokeTriggerOrder(order = {}) {
    return FINISHED_ORDER_STATUSES.has(String(order.order_status || '').trim());
}

function buildAuthRevokeCandidate(userId, order = {}) {
    const uid = Number(userId || 0);
    const channel = String(order.channel || '').trim().toLowerCase();
    const orderNo = String(order.order_no || '').trim();
    const gameId = Number(order.game_id);
    const gameAccount = String(order.game_account || '').trim();
    if (!uid || !channel || !orderNo || !Number.isInteger(gameId) || gameId <= 0 || !gameAccount) return null;
    if (!isAuthRevokeTriggerOrder(order)) return null;
    return {
        user_id: uid,
        channel,
        order_no: orderNo,
        order_status: String(order.order_status || '').trim(),
        game_id: gameId,
        game_name: String(order.game_name || '').trim(),
        game_account: gameAccount,
        end_time: String(order.end_time || '').trim()
    };
}

function buildAuthRevokeCandidateOnStatusChange(userId, order = {}, upsertResult = {}) {
    if (upsertResult.status_changed !== true) return null;
    return buildAuthRevokeCandidate(userId, order);
}

function buildAuthRevokeTaskPrefix(candidate = {}) {
    const uid = Number(candidate.user_id || 0);
    const gameId = Number(candidate.game_id || 0);
    const gameAccount = String(candidate.game_account || '').trim();
    if (!uid || !Number.isInteger(gameId) || gameId <= 0 || !gameAccount) {
        throw new Error('解除授权任务缺少 user_id/game_id/game_account');
    }
    const digest = crypto.createHash('sha256')
        .update(`${uid}|${gameId}|${gameAccount}`)
        .digest('hex')
        .slice(0, 20);
    return `${AUTH_REVOKE_TASK_TYPE}_${uid}_${gameId}_${digest}_`;
}

function buildAuthRevokeTaskId(candidate = {}) {
    const prefix = buildAuthRevokeTaskPrefix(candidate);
    const token = typeof crypto.randomUUID === 'function'
        ? crypto.randomUUID().replace(/-/g, '').slice(0, 10)
        : crypto.randomBytes(5).toString('hex');
    return `${prefix}${Date.now()}_${token}`;
}

function buildOrderTrigger(candidate, triggerTaskId = '') {
    return {
        trigger_key: `order_finished|${candidate.channel}|${candidate.order_no}`,
        source: 'order_finished',
        time: new Date().toISOString(),
        channel: candidate.channel,
        order_no: candidate.order_no,
        order_status: candidate.order_status,
        trigger_task_id: triggerTaskId
    };
}

function buildManualTrigger() {
    const time = new Date().toISOString();
    const token = crypto.randomBytes(4).toString('hex');
    return {
        trigger_key: `manual_product_action|${time}|${token}`,
        source: 'manual_product_action',
        time
    };
}

function authRevokeIdentityKey(gameId, gameAccount) {
    return `${String(gameId || '').trim()}::${String(gameAccount || '').trim()}`;
}

function buildAuthRevokeTaskView(task = {}) {
    if (!task || typeof task !== 'object') return null;
    const state = safeJsonObject(task.result_json, {});
    const input = safeJsonObject(state.input, {});
    const status = String(task.status || '').trim();
    const stage = String(task.stage || '').trim();
    const statusText = status === 'success'
        ? '成功'
        : status === 'running'
            ? '解除中'
            : status === 'failed'
                ? '失败待重试'
                : status === 'pending' && stage === 'waiting_active_order'
                    ? '等待订单结束'
                    : status === 'pending'
                        ? '待执行'
                        : '未知';
    return {
        task_id: String(task.task_id || '').trim(),
        game_id: String(input.game_id || '').trim(),
        game_account: String(input.game_account || '').trim(),
        status,
        stage,
        status_text: statusText,
        progress_text: String(task.progress_text || '').trim(),
        last_error: String(state.last_error || '').trim(),
        started_at: String(task.started_at || '').trim(),
        finished_at: String(task.finished_at || '').trim(),
        modify_date: String(task.modify_date || '').trim()
    };
}

async function listLatestAuthRevokeTaskViewsByUser(userId, options = {}) {
    const uid = Number(userId || 0);
    if (!uid) throw new Error('user_id 不合法');
    const rows = await listRuntimeTasksByUserAndType(uid, AUTH_REVOKE_TASK_TYPE, {
        limit: Number(options.limit || 2000)
    });
    const out = {};
    for (const row of rows) {
        const view = buildAuthRevokeTaskView(row);
        if (!view || !view.game_id || !view.game_account) continue;
        const key = authRevokeIdentityKey(view.game_id, view.game_account);
        if (!out[key]) out[key] = view;
    }
    return out;
}

async function getAuthRevokeTaskViewByUser(userId, taskId) {
    const uid = Number(userId || 0);
    const key = String(taskId || '').trim();
    if (!uid) throw new Error('user_id 不合法');
    if (!key) throw new Error('task_id 不能为空');
    const task = await getRuntimeTaskByTaskId(key);
    if (!task || Number(task.user_id || 0) !== uid || String(task.task_type || '') !== AUTH_REVOKE_TASK_TYPE) {
        return null;
    }
    return buildAuthRevokeTaskView(task);
}

async function enqueueAuthRevokeTasks(userId, candidates = [], options = {}) {
    const uid = Number(userId || 0);
    if (!uid) throw new Error('user_id 不合法');
    const triggerTaskId = String(options.trigger_task_id || options.triggerTaskId || '').trim();
    const unique = new Map();
    let skipped = 0;
    for (const raw of Array.isArray(candidates) ? candidates : []) {
        const candidate = buildAuthRevokeCandidate(uid, raw);
        if (!candidate) {
            skipped += 1;
            continue;
        }
        unique.set(`${candidate.channel}|${candidate.order_no}`, candidate);
    }

    const out = {
        candidates: Array.isArray(candidates) ? candidates.length : 0,
        valid: unique.size,
        created: 0,
        existing: 0,
        reused: 0,
        recent_success: 0,
        skipped,
        task_ids: []
    };
    for (const candidate of unique.values()) {
        const taskIdPrefix = buildAuthRevokeTaskPrefix(candidate);
        const taskId = buildAuthRevokeTaskId(candidate);
        const trigger = buildOrderTrigger(candidate, triggerTaskId);
        const state = {
            input: {
                ...candidate,
                trigger_task_id: triggerTaskId
            },
            triggers: [trigger],
            last_trigger: trigger,
            coalesced_trigger_count: 0,
            attempt_count: 0,
            last_response: null,
            last_error: ''
        };
        const result = await createOrReuseRuntimeTaskByPrefix({
            task_id: taskId,
            user_id: uid,
            task_type: AUTH_REVOKE_TASK_TYPE,
            trigger_source: 'order_finished',
            status: 'pending',
            stage: 'queued',
            progress_text: '等待解除账号授权',
            result_json: state,
            error_json: [],
            desc: `order finished channel=${candidate.channel} order_no=${candidate.order_no}`
        }, {
            task_id_prefix: taskIdPrefix,
            recent_success_sec: 60,
            trigger
        });
        if (result.created) out.created += 1;
        else {
            out.existing += 1;
            out.reused += 1;
            if (result.reuse_reason === 'recent_success') out.recent_success += 1;
        }
        if (!out.task_ids.includes(result.task.task_id)) out.task_ids.push(result.task.task_id);
    }
    return out;
}

async function enqueueManualAuthRevokeTask(userId, input = {}, options = {}) {
    const uid = Number(userId || 0);
    const gameAccount = String(input.game_account || '').trim();
    const normalizedGame = normalizeGameProfile(input.game_id, input.game_name, { preserveUnknown: true });
    const gameId = Number(normalizedGame.game_id);
    if (!uid) throw new Error('user_id 不合法');
    if (!gameAccount) throw new Error('game_account 不能为空');
    if (!Number.isInteger(gameId) || gameId <= 0) throw new Error('game_id 不合法');

    const account = await getLatestUserGameAccountByUserAndAccount(
        uid,
        gameAccount,
        String(gameId),
        normalizedGame.game_name
    );
    if (!account) throw new Error(`找不到账号: ${gameAccount}`);

    const trigger = buildManualTrigger();
    const candidate = {
        user_id: uid,
        game_id: gameId,
        game_account: gameAccount
    };
    const state = {
        input: {
            source: 'manual_product_action',
            user_id: uid,
            game_id: gameId,
            game_name: String(normalizedGame.game_name || account.game_name || '').trim(),
            game_account: gameAccount,
            role_name: String(account.account_remark || '').trim()
        },
        triggers: [trigger],
        last_trigger: trigger,
        coalesced_trigger_count: 0,
        attempt_count: 0,
        last_response: null,
        last_error: ''
    };
    const result = await createOrReuseRuntimeTaskByPrefix({
        task_id: buildAuthRevokeTaskId(candidate),
        user_id: uid,
        task_type: AUTH_REVOKE_TASK_TYPE,
        trigger_source: 'manual_product_action',
        status: 'pending',
        stage: 'queued',
        progress_text: '等待解除账号授权',
        result_json: state,
        error_json: [],
        attached_manual_count: 1,
        desc: `manual auth revoke game_id=${gameId} game_account=${gameAccount}`
    }, {
        task_id_prefix: buildAuthRevokeTaskPrefix(candidate),
        recent_success_sec: 60,
        trigger
    });
    const shouldStartWorker = options.start_worker !== false && result.reuse_reason !== 'recent_success';
    const worker = !shouldStartWorker
        ? { triggered: false, reason: 'disabled', pid: 0 }
        : startAuthRevokeTaskWorker({ task_dir: options.task_dir });
    if (result.reuse_reason === 'recent_success') worker.reason = 'recent_success';
    return {
        task: result.task,
        task_view: buildAuthRevokeTaskView(result.task),
        worker,
        created: result.created,
        reused: result.reused,
        reuse_reason: result.reuse_reason
    };
}

async function resolveUuzuhaoRevokeAuthByUser(userId) {
    const uid = Number(userId || 0);
    if (!uid) throw new Error('user_id 不合法');
    const rows = await listUserPlatformAuth(uid, { with_payload: true });
    const hit = rows.find((row) => {
        if (String(row.platform || '') !== 'uuzuhao') return false;
        if (String(row.auth_status || '') !== 'valid') return false;
        const expireAt = String(row.expire_at || '').trim();
        if (!expireAt) return true;
        const ts = Date.parse(expireAt);
        return Number.isNaN(ts) || ts > Date.now();
    });
    if (!hit || !hit.auth_payload || typeof hit.auth_payload !== 'object') {
        throw new Error(`user_id=${uid} 缺少可用 uuzuhao 授权`);
    }
    return hit.auth_payload;
}

async function processAuthRevokeTasks(options = {}) {
    const runnable = await listRunnableRuntimeTasks(AUTH_REVOKE_TASK_TYPE, {
        limit: Number(options.limit || 100),
        stale_after_sec: Number(options.stale_after_sec || 300),
        stale_before: options.stale_before
    });
    const out = {
        runnable: runnable.length,
        claimed: 0,
        success: 0,
        failed: 0,
        deferred: 0,
        results: []
    };
    const authCache = new Map();

    for (const listed of runnable) {
        const task = await claimRuntimeTask(listed.task_id, AUTH_REVOKE_TASK_TYPE, {
            stale_after_sec: Number(options.stale_after_sec || 300),
            stale_before: options.stale_before,
            stage: 'revoke_auth',
            progress_text: '正在解除账号授权'
        });
        if (!task) continue;
        out.claimed += 1;
        const state = safeJsonObject(task.result_json, {});
        const input = safeJsonObject(state.input, {});
        const attemptCount = Math.max(0, Number(state.attempt_count || 0)) + 1;
        const errors = safeJsonArray(task.error_json);
        try {
            const uid = Number(input.user_id || task.user_id || 0);
            const gameId = Number(input.game_id || 0);
            const gameAccount = String(input.game_account || '').trim();
            if (!uid || !Number.isInteger(gameId) || gameId <= 0 || !gameAccount) {
                throw new Error('解除授权任务参数不完整');
            }
            const activeOrders = await listRentingOrderWindowByAccounts(uid, [{
                game_id: String(gameId),
                game_account: gameAccount
            }]);
            const accountKey = `${gameId}::${gameAccount}`;
            if (activeOrders[accountKey]) {
                await updateRuntimeTask(task.task_id, {
                    status: 'pending',
                    stage: 'waiting_active_order',
                    progress_text: '账号仍有租赁中订单，等待下轮重试',
                    result_json: {
                        ...state,
                        input,
                        last_error: ''
                    },
                    error_json: errors,
                    desc: 'auth revoke deferred because account is renting'
                });
                out.deferred += 1;
                out.results.push({ task_id: task.task_id, ok: true, deferred: true, reason: 'active_order' });
                continue;
            }
            if (!authCache.has(uid)) authCache.set(uid, resolveUuzuhaoRevokeAuthByUser(uid));
            const auth = await authCache.get(uid);
            const response = await revokeAccountAuth(gameAccount, { game_id: gameId, auth });
            await markRuntimeTaskFinished(task.task_id, {
                status: TASK_STATUS_SUCCESS,
                stage: 'done',
                progress_text: '解除账号授权成功',
                result_json: {
                    ...state,
                    input,
                    attempt_count: attemptCount,
                    last_response: response,
                    last_error: ''
                },
                error_json: errors,
                desc: `auth revoke success attempt=${attemptCount}`
            });
            out.success += 1;
            out.results.push({ task_id: task.task_id, ok: true, attempt_count: attemptCount });
        } catch (error) {
            const message = String(error && error.message ? error.message : error || 'auth_revoke_failed');
            errors.push({ time: new Date().toISOString(), attempt: attemptCount, message });
            const recentErrors = errors.slice(-20);
            await markRuntimeTaskFinished(task.task_id, {
                status: TASK_STATUS_FAILED,
                stage: 'failed',
                progress_text: '解除账号授权失败，等待重试',
                result_json: {
                    ...state,
                    input,
                    attempt_count: attemptCount,
                    last_error: message
                },
                error_json: recentErrors,
                desc: `auth revoke failed attempt=${attemptCount}`
            });
            out.failed += 1;
            out.results.push({ task_id: task.task_id, ok: false, attempt_count: attemptCount, error: message });
            console.warn(`[AuthRevokeWorker] task_id=${task.task_id} failed=${message}`);
        }
    }
    return out;
}

function startAuthRevokeTaskWorker(options = {}) {
    const taskDir = String(options.task_dir || path.join(__dirname, '..'));
    const workerScript = path.join(taskDir, 'order', 'auth_revoke_worker.js');
    if (!fs.existsSync(workerScript)) {
        return { triggered: false, reason: 'worker_missing', pid: 0 };
    }
    const child = fork(workerScript, [], {
        cwd: taskDir,
        env: { ...process.env, AUTH_REVOKE_WORKER_TRIGGER_TS: String(Date.now()) },
        detached: true,
        stdio: 'ignore'
    });
    child.unref();
    return { triggered: true, reason: 'spawned', pid: Number(child.pid || 0) };
}

module.exports = {
    AUTH_REVOKE_TASK_TYPE,
    FINISHED_ORDER_STATUSES,
    isAuthRevokeTriggerOrder,
    buildAuthRevokeCandidate,
    buildAuthRevokeCandidateOnStatusChange,
    buildAuthRevokeTaskPrefix,
    buildAuthRevokeTaskId,
    buildAuthRevokeTaskView,
    listLatestAuthRevokeTaskViewsByUser,
    getAuthRevokeTaskViewByUser,
    enqueueAuthRevokeTasks,
    enqueueManualAuthRevokeTask,
    resolveUuzuhaoRevokeAuthByUser,
    processAuthRevokeTasks,
    startAuthRevokeTaskWorker,
    _internals: {
        safeJsonObject,
        safeJsonArray
    }
};
