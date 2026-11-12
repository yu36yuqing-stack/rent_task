'use strict';

const { getSystemConfig } = require('../database/system_config_db');

const CONFIG_KEY = 'uuzuhao.order_game_info_refresh';
const BUSINESS_SCENE = 'order_game_info_refresh';
const TARGET_CHANNEL = 'uuzuhao';
const MIN_DURATION_SECONDS = 20 * 60;
const TERMINAL_STATUSES = new Set(['已完成', '部分完成', '已退款', '已撤单', '投诉/撤单']);
const SOURCE_CHANNELS = new Set(['uuzuhao', 'uhaozu', 'zuhaowang', '5e']);

function parseOrderTime(value) {
    if (typeof value !== 'string') return NaN;
    const text = value.trim();
    const parts = /^(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2}):(\d{2})(?:\.\d{1,3})?(?:Z|[+-]\d{2}:\d{2})?$/.exec(text);
    if (!parts) return NaN;
    const [year, month, day, hour, minute, second] = parts.slice(1).map(Number);
    const days = new Date(Date.UTC(year, month, 0)).getUTCDate();
    if (year < 1970 || month < 1 || month > 12 || day < 1 || day > days || hour > 23 || minute > 59 || second > 59) return NaN;
    return Date.parse(text.replace(' ', 'T'));
}

function localTimeText(ms) {
    const d = new Date(ms);
    const pad = value => String(value).padStart(2, '0');
    return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
}

function invalidPolicy(reason) {
    return Object.freeze({ available: false, enabled: false, user_ids: Object.freeze([]), activated_at: '', activated_at_ms: NaN, reason });
}

function normalizeGameInfoRefreshPolicy(value) {
    if (!value || typeof value !== 'object' || Array.isArray(value)
        || Object.keys(value).some(key => !['enabled', 'user_ids', 'activated_at'].includes(key))
        || typeof value.enabled !== 'boolean' || typeof value.activated_at !== 'string') {
        return invalidPolicy('invalid_config');
    }
    const users = value.user_ids;
    if (users !== null && (!Array.isArray(users) || users.length > 1000
        || users.some(id => !Number.isSafeInteger(id) || id <= 0))) return invalidPolicy('invalid_config');
    const activatedMs = parseOrderTime(value.activated_at);
    if ((value.enabled || value.activated_at.trim()) && !Number.isFinite(activatedMs)) return invalidPolicy('invalid_config');
    return Object.freeze({
        available: true,
        enabled: value.enabled,
        user_ids: users === null ? null : Object.freeze([...new Set(users)]),
        activated_at: Number.isFinite(activatedMs) ? localTimeText(activatedMs) : '',
        activated_at_ms: activatedMs,
        reason: value.enabled ? '' : 'disabled'
    });
}

async function loadGameInfoRefreshPolicy(options = {}) {
    try {
        const record = await (options.get_config || getSystemConfig)(CONFIG_KEY);
        if (!record || !record.found) return invalidPolicy('config_missing');
        return normalizeGameInfoRefreshPolicy(record.value);
    } catch {
        // 不输出配置值、数据库异常堆栈或潜在授权内容。
        options.logger?.warn?.('[GameInfoRefresh] config_unavailable');
        return invalidPolicy('config_unavailable');
    }
}

function policyAllowsUser(policy, userId, nowMs = Date.now()) {
    const uid = Number(userId);
    return Boolean(policy && policy.available && policy.enabled
        && Number.isSafeInteger(uid) && uid > 0
        && Number.isFinite(nowMs) && Number.isFinite(policy.activated_at_ms)
        && nowMs >= policy.activated_at_ms
        && (policy.user_ids === null || policy.user_ids.includes(uid)));
}

function isRefreshOrderEligible(order, policy, options = {}) {
    if (!order || typeof order !== 'object') return false;
    const now = options.now instanceof Date ? options.now.getTime() : Number(options.now ?? Date.now());
    if (!policyAllowsUser(policy, order.user_id, now)) return false;
    const channel = String(order.channel || order.source_channel || '').trim().toLowerCase();
    if (!SOURCE_CHANNELS.has(channel) || !TERMINAL_STATUSES.has(String(order.order_status || '').trim())
        || !String(order.order_no || '').trim() || !String(order.game_account || '').trim()
        || !Number.isSafeInteger(Number(order.game_id)) || Number(order.game_id) <= 0
        || Number(order.is_deleted || 0) !== 0) return false;
    const start = parseOrderTime(order.start_time);
    const end = parseOrderTime(order.end_time);
    const observed = parseOrderTime(order.observed_active_at);
    return Number.isFinite(start) && Number.isFinite(end)
        && end - start >= MIN_DURATION_SECONDS * 1000 && end <= now
        && end >= policy.activated_at_ms
        && (start >= policy.activated_at_ms || (Number.isFinite(observed) && observed >= policy.activated_at_ms));
}

function buildRefreshLockKey(task = {}) {
    const scene = String(task.business_scene || BUSINESS_SCENE).trim();
    const target = String(task.target_channel || TARGET_CHANNEL).trim();
    const uid = Number(task.user_id);
    const source = String(task.source_channel || task.channel || '').trim().toLowerCase();
    const orderNo = String(task.order_no || '').trim();
    if (!/^[a-z0-9_]+$/.test(scene) || !/^[a-z0-9_]+$/.test(target)
        || !Number.isSafeInteger(uid) || uid <= 0 || !SOURCE_CHANNELS.has(source) || !orderNo) {
        throw new Error('刷新锁缺少有效业务场景、渠道、号主或订单号');
    }
    return `${scene}:${target}:${uid}:${source}:${orderNo}`;
}

module.exports = {
    CONFIG_KEY, BUSINESS_SCENE, TARGET_CHANNEL, MIN_DURATION_SECONDS, TERMINAL_STATUSES,
    parseOrderTime, normalizeGameInfoRefreshPolicy, loadGameInfoRefreshPolicy,
    policyAllowsUser, isRefreshOrderEligible, buildRefreshLockKey
};
