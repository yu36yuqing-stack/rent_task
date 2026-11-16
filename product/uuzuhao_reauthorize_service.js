'use strict';

const crypto = require('crypto');
const storage = require('../database/uuzuhao_reauthorize_db');
const tasks = require('../database/runtime_task_db');
const locks = require('../database/lock_db');
const api = require('../uuzuhao/uuzuhao_api');
const { withUuzuhaoOperationLock, OPERATIONS } = require('../common/uuzuhao_operation_lock');

const QUERY_INTERVAL_MS = 90000;
const MAX_QUERIES = 3;
const WORKER_LOCK = 'uuzuhao_reauthorize_worker';
function enabled() { return process.env.UUZUHAO_AUTO_REAUTHORIZE_ENABLED === '1'; }
function usable(row, now) {
    return row.user_status === 'enabled' && !row.is_deleted && !row.manual_deleted && row.asset_status !== 'sold'
        && Number(row.channel_enabled) === 1 && row.auth_status === 'valid'
        && (!row.expire_at || Date.parse(row.expire_at) > now)
        && Boolean(row.auth_payload.app_key && row.auth_payload.app_secret);
}
function identity(row) { return { user_id: row.user_id, game_id: row.game_id, game_account: row.game_account }; }
function snapshot(row) {
    return { id: row.id, user_id: row.user_id, uuzuhao_auth_state: row.uuzuhao_auth_state,
        channel_prd_info: { uuzuhao: row.channel_prd_info.uuzuhao || {} } };
}

function createRecoveryService(overrides = {}) {
    const d = { ...storage, ...tasks, ...locks, ...api, withUuzuhaoOperationLock, now: Date.now, enabled, logger: console, ...overrides };
    async function save(task, state, stage, terminal = false) {
        const completedText = { recovered: '重新授权成功，已解除授权异常', external_recovered: '授权异常已由原有流程解除',
            superseded: '已有新的异常信息，旧恢复任务结束', manual_required: '授权异常，需人工介入' };
        const patch = { stage, result_json: state, status: terminal ? 'success' : 'pending',
            progress_text: completedText[stage] || `自动恢复中（已查询${state.query_count}/3次）` };
        if (stage === 'superseded') patch.status = 'skipped';
        if (terminal) patch.finished_at = new Date(d.now()).toISOString();
        // Unresolved manual work must not be pruned like completed runtime history.
        if (stage === 'manual_required') { patch.status = 'manual_required'; patch.finished_at = ''; }
        const result = await d.updateRuntimeTask(task.task_id, patch);
        d.logger.log(`[UuzuhaoReauthorize] user_id=${task.user_id} task_id=${task.task_id} game_id=${state.game_id} account=${state.game_account} remote_task_id=${state.remote_task_id || ''} stage=${stage} query_count=${state.query_count} remote_status=${state.last_status ?? ''} reason=${state.reason || ''}`);
        return result;
    }
    async function finish(task, state, stage, reason) {
        return save(task, { ...state, reason }, stage, true);
    }
    async function advance(row, task) {
        let state = storage.object(task.result_json);
        if (task.stage === 'submitting' && !state.remote_task_id) {
            return finish(task, state, 'manual_required', 'creation_result_unknown');
        }
        if (!state.remote_task_id) {
            if (![1, 2, 3].includes(Number(row.game_id))) return finish(task, state, 'manual_required', 'unsupported_game');
            state = { ...state, baseline: snapshot(row) };
            await save(task, state, 'submitting');
            let remote;
            try { remote = await d.createReauthorizeTask(row.game_account, { game_id: row.game_id, auth: row.auth_payload }); }
            catch (error) { return finish(task, state, 'manual_required', 'creation_failed'); }
            return save(task, { ...state, remote_task_id: remote.task_id, game_union_id: remote.game_union_id,
                next_query_at: d.now() + QUERY_INTERVAL_MS }, 'waiting_result');
        }
        if (state.last_status !== 2) {
            if (d.now() < state.next_query_at) return;
            if (state.query_count >= MAX_QUERIES) return finish(task, state, 'manual_required', 'queries_exhausted');
            // Reserve the attempt durably before HTTP: a restart must never issue a fourth query.
            state = { ...state, query_count: state.query_count + 1, query_started_at: d.now(),
                next_query_at: d.now() + QUERY_INTERVAL_MS };
            await save(task, state, 'checking');
            try {
                const result = await d.queryReauthorizeTask(row.game_account, state.remote_task_id,
                    { game_id: row.game_id, auth: row.auth_payload });
                state.last_status = result.status;
                state.reason = result.status === 3 ? 'captcha_required' : result.status === -1 ? 'remote_failed' : 'processing';
            } catch (error) {
                state.last_status = null;
                state.reason = 'query_failed';
            }
        }
        if (state.last_status === 2) {
            await save(task, state, 'restoring');
            const cleared = await d.clearRecoveredAuthorization(state.baseline, state.query_started_at);
            return finish(task, state, cleared ? 'recovered' : 'superseded', cleared ? 'authorization_recovered' : 'newer_observation');
        }
        return state.query_count >= MAX_QUERIES
            ? finish(task, state, 'manual_required', state.reason)
            : save(task, state, 'waiting_result');
    }
    async function tick() {
        if (!d.enabled()) return { skipped: true, reason: 'disabled' };
        const owner = `pid=${process.pid} token=${crypto.randomUUID()}`;
        if (!(await d.tryAcquireLock(WORKER_LOCK, 120, owner)).acquired) return { skipped: true, reason: 'locked' };
        const result = { processed: 0, errors: 0 };
        try {
            const accounts = await d.listRecoveryAccounts();
            const latest = await d.listRecoveryTasks();
            for (const listed of accounts) {
                if (!(await d.touchLock(WORKER_LOCK, 120, owner))) throw new Error('recovery worker lease lost');
                try {
                    await d.withUuzuhaoOperationLock(OPERATIONS.PLATFORM_REAUTHORIZE, listed, async () => {
                        const row = await d.getRecoveryAccount(listed.id);
                        if (!row || !usable(row, d.now())) return;
                        let task = latest.get(row.id);
                        if (!d.hasAuthorizationError(row)) {
                            if (task && !['recovered', 'external_recovered', 'superseded'].includes(task.stage)) {
                                await finish(task, storage.object(task.result_json), 'external_recovered', 'recovered_by_existing_logic');
                            }
                            return;
                        }
                        if (task && task.stage === 'manual_required') {
                            const firstFailure = row.uuzuhao_auth_state.first_failed_at;
                            const oldFailure = task.state.baseline?.uuzuhao_auth_state?.first_failed_at;
                            if (!firstFailure || !oldFailure || firstFailure === oldFailure) return;
                            // Existing detection already observed recovery and then a new failure between ticks.
                            task = null;
                        }
                        if (!task || ['recovered', 'external_recovered', 'superseded'].includes(task.stage)) {
                            task = await d.createRuntimeTask({ user_id: row.user_id, task_type: storage.TASK_TYPE,
                                trigger_source: 'existing_authorization_error', stage: 'queued',
                                result_json: { ...identity(row), account_id: row.id, query_count: 0 } });
                        }
                        await advance(row, task);
                        result.processed++;
                    });
                } catch (error) {
                    result.errors++;
                    d.logger.error(`[UuzuhaoReauthorize] account_id=${listed.id} error=task_processing_failed`);
                }
            }
            return result;
        } finally { await d.releaseOwnedLock(WORKER_LOCK, owner); }
    }
    return { tick };
}

async function listRecoveryViews(userId) {
    const map = {};
    for (const task of (await storage.listRecoveryTasks(userId)).values()) {
        const state = task.state;
        map[`${state.game_id}::${state.game_account}`] = { stage: task.stage, query_count: state.query_count,
            reason: state.reason || '', task_id: task.task_id };
    }
    return map;
}
function startReauthorizeWorker(options = {}) {
    if (!(options.enabled || enabled)()) return { started: false };
    const service = options.service || createRecoveryService();
    const logger = options.logger || console;
    let busy = false;
    const run = async () => {
        if (busy) return;
        busy = true;
        try { await service.tick(); }
        catch (error) { logger.error('[UuzuhaoReauthorize] error=worker_failed'); }
        finally { busy = false; }
    };
    const timer = (options.setInterval || setInterval)(run, 15000);
    timer.unref?.();
    void run();
    return { started: true, stop: () => (options.clearInterval || clearInterval)(timer) };
}
module.exports = { createRecoveryService, startReauthorizeWorker, listRecoveryViews, QUERY_INTERVAL_MS, MAX_QUERIES };
