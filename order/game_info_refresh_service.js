'use strict';

const crypto = require('crypto');
const ledger = require('../database/order_game_info_refresh_db');
const policyModule = require('./game_info_refresh_policy');
const { getActiveUserById } = require('../database/user_db');
const { listUserPlatformAuth } = require('../database/user_platform_auth_db');
const { getLatestUserGameAccountByUserAndAccount } = require('../database/user_game_account_db');
const { getLastSyncTimestamp } = require('./service/order_command_service');
const { listRentingWindowByAccounts } = require('./service/order_query_service');
const { assertUuzuhaoBackgroundOperationAllowed } = require('../product/prod_probe_cache_service');
const { resolveUuzuhaoReauthorizeState } = require('../product/prod_channel_status');
const { normalizeUuzuhaoAuthState } = require('../common/uuzuhao_auth_state');
const { tryAcquireLock, releaseOwnedLock } = require('../database/lock_db');
const { updateProductGameInfo } = require('../uuzuhao/uuzuhao_api');

const ACTIVE_STATUSES = new Set(['租赁中', '出租中']);
const CHANNELS = new Set(['uuzuhao', 'uhaozu', 'zuhaowang', '5e']);
const FRESHNESS_SEC = 12 * 60;
const DEFER_SEC = 5 * 60;
const REQUEST_TIMEOUT_MS = 15000;
const ORDER_LOCK_LEASE_SEC = 120;

function dependencies(options) {
    return {
        ...ledger, ...policyModule, getActiveUserById, listUserPlatformAuth,
        getLatestUserGameAccountByUserAndAccount, getLastSyncTimestamp, listRentingWindowByAccounts,
        assertUuzuhaoBackgroundOperationAllowed, resolveUuzuhaoReauthorizeState,
        normalizeUuzuhaoAuthState, tryAcquireLock, releaseOwnedLock, updateProductGameInfo,
        ...options.deps
    };
}

function nowDate(options) {
    const date = new Date(options.now === undefined ? Date.now() : options.now);
    if (!Number.isFinite(date.getTime())) throw new Error('刷新任务时间无效');
    return date;
}

function timeText(date) {
    const pad = value => String(value).padStart(2, '0');
    return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`;
}

function identity(order) {
    return {
        business_scene: policyModule.BUSINESS_SCENE,
        target_channel: policyModule.TARGET_CHANNEL,
        user_id: Number(order.user_id), source_channel: String(order.channel || order.source_channel || '').trim().toLowerCase(),
        order_no: String(order.order_no || '').trim(), game_id: String(order.game_id || '').trim(),
        game_name: String(order.game_name || '').trim(), game_account: String(order.game_account || '').trim(),
        order_status: String(order.order_status || order.source_order_status || '').trim(),
        start_time: String(order.start_time || '').trim(), end_time: String(order.end_time || '').trim(),
        observed_active_at: String(order.observed_active_at || '').trim()
    };
}

function normalizedChannel(value) {
    return value === 'zuhaowang-yuanbao' ? 'zuhaowang' : String(value || '').trim();
}

function observableActiveOrder(order, uid) {
    return Number(order.user_id) === uid && Number(order.is_deleted || 0) === 0
        && ACTIVE_STATUSES.has(order.order_status) && CHANNELS.has(String(order.channel || order.source_channel))
        && Number.isSafeInteger(Number(order.game_id)) && Number(order.game_id) > 0
        && Boolean(String(order.game_account || '').trim() && String(order.order_no || '').trim());
}

function authIsUsable(row, now, d) {
    if (row.channel_enabled === false || row.channel_enabled === 0 || row.auth_status !== 'valid') return false;
    if (!row.expire_at) return true;
    const expiry = d.parseOrderTime(row.expire_at);
    return Number.isFinite(expiry) && expiry > now.getTime();
}

function accountProduct(row, task, d) {
    if (!row || Number(row.is_deleted || 0) !== 0
        || Number(row.user_id) !== Number(task.user_id) || String(row.game_id) !== String(task.game_id)
        || String(row.game_account) !== task.game_account) return { reason: 'account_missing_or_changed' };
    const info = row.channel_prd_info && row.channel_prd_info.uuzuhao;
    const productId = info && typeof info.prd_id === 'string' ? info.prd_id.trim() : '';
    if (!productId) return { reason: 'product_missing' };
    if (d.normalizeUuzuhaoAuthState(row.uuzuhao_auth_state).required
        || d.resolveUuzuhaoReauthorizeState(row).hit) return { reason: 'authorization_paused', deferred: true };
    return { product_id: productId };
}

async function scanOrders(d, uid, policy, options, visit) {
    let cursor = 0;
    const limit = Math.min(500, Math.max(1, Math.floor(Number(options.batch_size) || 200)));
    for (;;) {
        const rows = await d.listSourceOrdersForRefresh(uid, { activated_at: policy.activated_at, after_id: cursor, limit });
        if (!rows.length) break;
        for (const order of rows) await visit(order);
        const next = Math.max(...rows.map(order => Number(order.id)));
        if (!(next > cursor)) throw new Error('刷新订单分页游标未前进');
        cursor = next;
        if (rows.length < limit) break;
    }
}

async function enabledUser(d, uid, policy, now) {
    if (!d.policyAllowsUser(policy, uid, now.getTime())) return false;
    const user = await d.getActiveUserById(uid);
    return Boolean(user && user.status === 'enabled');
}

async function prepareGameInfoRefreshByUser(userId, options = {}) {
    const d = dependencies(options), now = nowDate(options), uid = Number(userId);
    const policy = await d.loadGameInfoRefreshPolicy({ logger: options.logger });
    if (!await enabledUser(d, uid, policy, now)) return { skipped: true, reason: 'disabled_or_user_unavailable', observed: 0 };
    await d.initOrderGameInfoRefreshDb();
    const syncToken = crypto.randomUUID();
    await d.beginRefreshOrderSync(uid, { token: syncToken, now });
    let observed = 0;
    await scanOrders(d, uid, policy, options, async order => {
        if (observableActiveOrder(order, uid)) {
            await d.observeActiveOrder(identity(order), { now, sync_token: syncToken });
            observed += 1;
        }
    });
    return { skipped: false, observed, sync_token: syncToken };
}

async function reconcileGameInfoRefreshByUser(userId, options = {}) {
    const out = { skipped: false, scanned: 0, observed: 0, created: 0, queued: 0 };
    if (options.sync_complete !== true) return { ...out, skipped: true, reason: 'order_sync_incomplete' };
    const syncToken = typeof options.sync_token === 'string' ? options.sync_token.trim() : '';
    if (!syncToken) return { ...out, skipped: true, reason: 'sync_context_missing' };
    const d = dependencies(options), now = nowDate(options), uid = Number(userId);
    const policy = await d.loadGameInfoRefreshPolicy({ logger: options.logger });
    if (!await enabledUser(d, uid, policy, now)) return { ...out, skipped: true, reason: 'disabled_or_user_unavailable' };
    await d.initOrderGameInfoRefreshDb();
    await scanOrders(d, uid, policy, options, async order => {
        out.scanned += 1;
        const input = identity(order);
        if (observableActiveOrder(order, uid)) {
            await d.observeActiveOrder(input, { now, sync_token: syncToken }); out.observed += 1; return;
        }
        if (!d.isRefreshOrderEligible(order, policy, { now })) return;
        const account = await d.getLatestUserGameAccountByUserAndAccount(uid, input.game_account, input.game_id, input.game_name);
        const target = accountProduct(account, input, d);
        // 授权暂停的商品仍可登记，执行阶段等待恢复；不会发送外部请求。
        const productId = target.product_id || (target.deferred && account.channel_prd_info.uuzuhao.prd_id);
        if (!productId) return;
        const result = await d.enqueueRefreshOrder({ ...input, target_product_id: productId }, { now, sync_token: syncToken });
        if (result.created) out.created += 1;
        if (result.queued) out.queued += 1;
    });
    await d.completeRefreshOrderSync(uid, { token: syncToken, now });
    return out;
}

async function freshAuthorization(d, task, now) {
    const rows = await d.listUserPlatformAuth(task.user_id, { with_payload: true });
    const supported = rows.filter(row => CHANNELS.has(normalizedChannel(row.platform)) && row.channel_enabled !== false && row.channel_enabled !== 0);
    if (!supported.length || supported.some(row => !authIsUsable(row, now, d))) return { reason: 'platform_authorization_unavailable' };
    const channels = new Set(supported.map(row => normalizedChannel(row.platform)));
    if (!channels.has(task.source_channel)) return { reason: 'source_channel_unavailable' };
    const authRow = supported.find(row => row.platform === 'uuzuhao');
    const auth = authRow && authRow.auth_payload;
    if (!auth || !String(auth.app_key || '').trim() || !String(auth.app_secret || '').trim()) return { reason: 'uuzuhao_authorization_unavailable' };
    const watermarks = await Promise.all([...channels].map(channel => d.getLastSyncTimestamp(task.user_id, channel)));
    if (watermarks.some(value => !Number.isFinite(value) || value <= 0 || value > now.getTime() / 1000 + 60
        || now.getTime() / 1000 - value > FRESHNESS_SEC)) return { reason: 'order_snapshot_stale' };
    return { auth: { ...auth, timeout_ms: REQUEST_TIMEOUT_MS } };
}

function safeMessage(value, auth) {
    let text = String(value || '');
    for (const secret of [auth && auth.app_key, auth && auth.app_secret]) if (secret) text = text.split(secret).join('[REDACTED]');
    return text.slice(0, 160);
}

function responseSummary(response) {
    const data = response && response.data;
    return {
        data_type: data === null ? 'null' : Array.isArray(data) ? 'array' : typeof data,
        game_account_info_count: data && Array.isArray(data.gameAccountInfoList) ? data.gameAccountInfoList.length : null
    };
}

async function processGameInfoRefreshTasks(options = {}) {
    const d = dependencies(options), firstNow = nowDate(options);
    const out = { runnable: 0, claimed: 0, success: 0, failed: 0, unknown: 0, deferred: 0, skipped: 0, results: [] };
    const initialPolicy = await d.loadGameInfoRefreshPolicy({ logger: options.logger });
    if (!initialPolicy.available || !initialPolicy.enabled || (initialPolicy.user_ids && !initialPolicy.user_ids.length)) {
        return { ...out, disabled: true, reason: initialPolicy.reason || 'disabled' };
    }
    await d.initOrderGameInfoRefreshDb();
    const staleSec = Math.max(120, Number(options.stale_after_sec) || 300);
    const recovered = await d.recoverStaleRefreshAttempts({ before: new Date(firstNow.getTime() - staleSec * 1000), now: firstNow });
    out.unknown += Number(recovered.changes || 0);
    const tasks = await d.listPendingRefreshTasks({ now: firstNow, user_ids: initialPolicy.user_ids, limit: Math.min(1000, Math.max(1, Number(options.limit) || 100)) });
    out.runnable = tasks.length;
    for (const task of tasks) {
        if (options.should_stop && options.should_stop()) break;
        const now = nowDate(options), policy = await d.loadGameInfoRefreshPolicy({ logger: options.logger });
        if (!d.policyAllowsUser(policy, task.user_id, now.getTime())) break;
        let attempted = false, lock, lockKey, sourceOrder;
        const owner = `pid=${process.pid} refresh=${crypto.randomUUID()}`;
        let result;
        const defer = async reason => {
            await d.deferRefreshTask(task.id, { reason, next_check_at: timeText(new Date(now.getTime() + DEFER_SEC * 1000)), now });
            return { id: task.id, state: 'deferred', reason };
        };
        const skip = async reason => {
            await d.skipRefreshTask(task.id, { reason, now });
            return { id: task.id, state: 'skipped', reason };
        };
        try {
            if (task.business_scene !== policyModule.BUSINESS_SCENE || task.target_channel !== policyModule.TARGET_CHANNEL) {
                result = { id: task.id, state: 'skipped', reason: 'different_business' };
            } else {
                lockKey = d.buildRefreshLockKey(task);
                lock = await d.tryAcquireLock(lockKey, ORDER_LOCK_LEASE_SEC, owner);
                if (!lock.acquired) result = await defer('order_locked');
                if (!result) {
                    const order = await d.getSourceOrder(task.user_id, task.source_channel, task.order_no);
                    sourceOrder = order;
                    if (!order || Number(order.is_deleted || 0) !== 0) result = await skip('order_missing');
                    else if (Number(order.user_id) !== Number(task.user_id) || String(order.channel) !== task.source_channel
                        || String(order.order_no) !== task.order_no || String(order.game_account) !== task.game_account
                        || String(order.game_id) !== String(task.game_id)) result = await skip('order_identity_changed');
                    else if (ACTIVE_STATUSES.has(order.order_status)) {
                        await d.observeActiveOrder(identity(order), { now });
                        result = { id: task.id, state: 'deferred', reason: 'order_active_again' };
                    } else if (!d.isRefreshOrderEligible({ ...order, observed_active_at: task.observed_active_at }, policy, { now })) result = await defer('order_not_eligible');
                }
                if (!result && !await enabledUser(d, task.user_id, policy, now)) result = await defer('user_unavailable');
                let authContext;
                if (!result) {
                    authContext = await freshAuthorization(d, task, now);
                    if (authContext.reason) result = await defer(authContext.reason);
                }
                if (!result) {
                    const account = await d.getLatestUserGameAccountByUserAndAccount(task.user_id, task.game_account, task.game_id, task.game_name);
                    const target = accountProduct(account, task, d);
                    if (target.reason) result = target.deferred ? await defer(target.reason) : await skip(target.reason);
                    else if (target.product_id !== task.target_product_id) result = await skip('product_changed');
                }
                if (!result) {
                    await d.assertUuzuhaoBackgroundOperationAllowed(task.user_id, task.game_account, { game_id: task.game_id, game_name: task.game_name });
                    const active = await d.listRentingWindowByAccounts(task.user_id, [{ game_id: task.game_id, game_account: task.game_account }]);
                    if (active[`${task.game_id}::${task.game_account}`]) result = await defer('account_renting');
                }
                if (!result) {
                    const sendPolicy = await d.loadGameInfoRefreshPolicy({ logger: options.logger });
                    if ((options.should_stop && options.should_stop())
                        || !d.isRefreshOrderEligible({ ...sourceOrder, observed_active_at: task.observed_active_at }, sendPolicy, { now: nowDate(options) })) {
                        result = await defer('policy_or_worker_changed');
                    }
                }
                if (!result) {
                    const claimed = await d.claimRefreshAttempt(task.id, { now, sync_token: task.sync_token });
                    if (!claimed) result = { id: task.id, state: 'skipped', reason: 'already_claimed' };
                    else {
                        attempted = true; out.claimed += 1;
                        let state, code, message, summary;
                        try {
                            const response = await d.updateProductGameInfo(task.target_product_id, { auth: authContext.auth });
                            if (!response || !response.raw || response.raw.code !== 0) {
                                state = 'failed'; code = 'INVALID_SUCCESS_RESPONSE'; message = '更新接口未返回成功业务码';
                            } else {
                                state = 'success'; code = '0'; message = safeMessage(response.raw.msg, authContext.auth); summary = responseSummary(response);
                            }
                        } catch (error) {
                            state = error.uuzuhao_response ? 'failed' : 'unknown';
                            code = safeMessage(error.code || error.name, authContext.auth);
                            message = error.uuzuhao_response ? safeMessage(error.uuzuhao_response.msg, authContext.auth) : '请求结果未知，不自动重试';
                        }
                        const persisted = await d.finishRefreshAttempt(task.id, { status: state, code, message, summary: summary || {}, now: nowDate(options) });
                        result = persisted ? { id: task.id, state, code } : { id: task.id, state: 'unknown', reason: 'result_not_persisted' };
                    }
                }
            }
        } catch {
            result = { id: task.id, state: attempted ? 'unknown' : 'deferred', reason: attempted ? 'result_persistence_unavailable' : 'preflight_unavailable' };
            if (!attempted) await d.deferRefreshTask(task.id, { reason: result.reason, next_check_at: timeText(new Date(now.getTime() + DEFER_SEC * 1000)), now }).catch(() => {});
            options.logger?.warn?.('[GameInfoRefresh] task_processing_unavailable');
        } finally {
            if (lock && lock.acquired) await d.releaseOwnedLock(lockKey, owner, `released ${owner}`).catch(() => options.logger?.warn?.('[GameInfoRefresh] lock_release_unavailable'));
        }
        out[result.state] += 1;
        out.results.push(result);
        if (options.on_progress) {
            try { await options.on_progress(result); }
            catch { options.logger?.warn?.('[GameInfoRefresh] progress_unavailable'); break; }
        }
    }
    return out;
}

module.exports = { prepareGameInfoRefreshByUser, reconcileGameInfoRefreshByUser, processGameInfoRefreshTasks };
