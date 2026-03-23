const fs = require('fs');
const path = require('path');
const { sendTelegramMessage } = require('./telegram/tg_notify.js');
const { sendDingdingMessage } = require('./dingding/ding_notify.js');
const { buildTelegramMessage } = require('./telegram/tg_style.js');
const { buildDingdingMessage } = require('./dingding/ding_style.js');
const { listTodayPaidOrderCountByAccounts, listRolling24hPaidOrderCountByAccounts } = require('../database/order_db');
const { listRecentProductOnoffByUser } = require('../database/product_onoff_history_db');
const { listAccountRemarksByUserAndIdentities } = require('../database/user_game_account_db');
const { listUserPlatformAuth } = require('../database/user_platform_auth_db');
const { listOpenProductSyncAnomaliesByUser } = require('../database/product_sync_anomaly_db');
const { getUserRuleByName } = require('../database/user_rule_db');
const { resolveDisplayNameByRow } = require('../product/display_name');

const TASK_DIR = path.resolve(__dirname, '..');
const HISTORY_FILE = path.join(TASK_DIR, 'rent_robot_history.jsonl');
const ORDER_OFF_THRESHOLD_RULE_NAME = 'X单下架阈值';
const ORDER_OFF_MODE_NATURAL_DAY = 'natural_day';
const ORDER_OFF_MODE_ROLLING_24H = 'rolling_24h';

function normalizeOrderOffMode(mode, fallback = ORDER_OFF_MODE_NATURAL_DAY) {
    const text = String(mode || '').trim().toLowerCase();
    if (text === ORDER_OFF_MODE_ROLLING_24H) return ORDER_OFF_MODE_ROLLING_24H;
    if (text === ORDER_OFF_MODE_NATURAL_DAY) return ORDER_OFF_MODE_NATURAL_DAY;
    return fallback;
}

async function getOrderOffRuleByUser(userId) {
    const uid = Number(userId || 0);
    if (!uid) return { mode: ORDER_OFF_MODE_NATURAL_DAY };
    const rule = await getUserRuleByName(uid, ORDER_OFF_THRESHOLD_RULE_NAME);
    const detail = rule && rule.rule_detail && typeof rule.rule_detail === 'object' ? rule.rule_detail : {};
    return {
        mode: normalizeOrderOffMode(detail.mode ?? detail.order_off_mode, ORDER_OFF_MODE_NATURAL_DAY)
    };
}

function readHistory() {
    try {
        if (!fs.existsSync(HISTORY_FILE)) return [];
        return fs
            .readFileSync(HISTORY_FILE, 'utf8')
            .split('\n')
            .map((l) => l.trim())
            .filter(Boolean)
            .map((l) => {
                try { return JSON.parse(l); } catch { return null; }
            })
            .filter(Boolean);
    } catch {
        return [];
    }
}

function formatActionForDisplay(act = {}, fallbackTs = Date.now()) {
    const type = String(act.type || '').trim();
    if (!type || type === 'notify_user' || type === 'order_sync_spawn') return '';
    const ts = new Date(Number(act.time || fallbackTs)).toLocaleTimeString('zh-CN', {
        hour: '2-digit',
        minute: '2-digit',
        second: '2-digit',
        hour12: false
    });
    const isOff = type.startsWith('off');
    const icon = isOff ? '🔴下架' : '🟢上架';
    const platform = type.endsWith('_y')
        ? '悠悠'
        : type.endsWith('_u')
        ? 'U号'
        : type.endsWith('_z')
        ? '租号王'
        : '未知';
    const account = String((act.item && act.item.account) || '未知');
    const reason = String(act.reason || '自动处理');
    const mode = act.skipped ? ' (只读跳过)' : '';
    return `• ${ts} ${icon}${platform} -> ${account} (${reason})${mode}`;
}

async function buildRecentActionsForUser(userId, options = {}) {
    const uid = Number(userId || 0);
    if (!uid) return [];
    const limit = Math.max(1, Number(options.limit || 8));
    const windowMs = Math.max(60 * 1000, Number(options.window_ms || 1800 * 1000));
    const rawLimit = Math.max(limit * 8, 64);
    const rows = await listRecentProductOnoffByUser(uid, { window_ms: windowMs, limit: rawLimit });
    if (!Array.isArray(rows) || rows.length === 0) return [];

    const identities = rows.map((r) => ({
        game_account: String(r.game_account || '').trim(),
        game_id: String(r.game_id || '1').trim() || '1',
        game_name: String(r.game_name || 'WZRY').trim() || 'WZRY'
    })).filter((x) => x.game_account);
    const remarkMap = await listAccountRemarksByUserAndIdentities(uid, identities);
    const platformName = (p) => {
        const key = String(p || '').trim();
        if (key === 'uuzuhao') return '悠悠';
        if (key === 'uhaozu') return 'U号';
        if (key === 'zuhaowang') return '租号王';
        return '未知';
    };

    const grouped = new Map();
    for (const row of rows) {
        const actionType = String(row.action_type || '').trim();
        if (!actionType || actionType === 'notify_user' || actionType === 'order_sync_spawn') continue;
        const direction = actionType.startsWith('off') ? 'off' : (actionType.startsWith('on') ? 'on' : '');
        if (!direction) continue;
        const acc = String(row.game_account || '').trim();
        const gid = String(row.game_id || '1').trim() || '1';
        if (!acc) continue;
        const key = `${direction}::${gid}::${acc}`;
        const ts = Number(row.event_time || 0);
        const skipped = Number(row.skipped || 0) > 0;
        const reason = String(row.reason || '').trim();
        const pf = platformName(row.platform);

        let g = grouped.get(key);
        if (!g) {
            g = {
                direction,
                account: acc,
                game_id: gid,
                game_name: String(row.game_name || 'WZRY').trim() || 'WZRY',
                remark: String(remarkMap[`${gid}::${acc}`] || '').trim(),
                latest_ts: ts,
                latest_reason: reason,
                count: 0,
                skipped_count: 0,
                platforms: new Set()
            };
            grouped.set(key, g);
        }

        g.count += 1;
        if (skipped) g.skipped_count += 1;
        g.platforms.add(pf);
        if (ts >= g.latest_ts) {
            g.latest_ts = ts;
            g.latest_reason = reason || g.latest_reason;
            if (!g.remark) g.remark = String(remarkMap[`${gid}::${acc}`] || '').trim();
        }
    }

    const merged = Array.from(grouped.values())
        .sort((a, b) => Number(b.latest_ts || 0) - Number(a.latest_ts || 0))
        .slice(0, limit);

    return merged.map((g) => {
        const ts = new Date(Number(g.latest_ts || Date.now())).toLocaleTimeString('zh-CN', {
            hour: '2-digit',
            minute: '2-digit',
            second: '2-digit',
            hour12: false
        });
        const icon = g.direction === 'off' ? '🔴下架' : '🟢上架';
        const name = g.remark || g.account;
        const pfList = Array.from(g.platforms);
        const pfText = pfList.join('/');
        const platformCount = pfList.length;
        const reason = platformCount > 1
            ? (g.direction === 'off' ? '检测到出租，执行下架' : '无租赁，自动补上架')
            : (g.latest_reason || '自动处理');
        let mode = '';
        if (g.skipped_count === g.count && g.count > 0) mode = ' (只读跳过)';
        else if (g.skipped_count > 0) mode = ` (含${g.skipped_count}条只读跳过)`;
        return `• ${ts} ${icon} ${name} -> ${pfText} (${reason})${mode}`;
    });
}

function scoreAccount(acc) {
    const y = acc.youpin;
    const u = acc.uhaozu;
    const z = acc.zuhaowan;
    const anyRent = [y, u, z].includes('租赁中');
    const allUp = y === '上架' && u === '上架' && z === '上架';
    const allDown = y === '下架' && u === '下架' && z === '下架';
    const hasReviewFail = u === '审核失败';
    const mismatch = !(allUp || allDown) && !anyRent;

    if (anyRent) return 400;
    if (mismatch) return 300;
    if (hasReviewFail) return 250;
    if (allUp) return 100;
    return 0;
}

function computeActionHint(acc, isBlacklisted) {
    const y = acc.youpin;
    const u = acc.uhaozu;
    const z = acc.zuhaowan;
    const anyRent = [y, u, z].includes('租赁中');

    if (isBlacklisted) return '';

    if (anyRent) {
        const toOff = [];
        if (y === '上架') toOff.push('Y');
        if (u === '上架') toOff.push('U');
        if (z === '上架') toOff.push('Z');
        return toOff.length > 0 ? ` -> 🔄 正在下架${toOff.join('/')}` : '';
    }

    const toOn = [];
    if (y === '下架') toOn.push('Y');
    if (u === '下架') toOn.push('U');
    if (z === '下架') toOn.push('Z');
    return toOn.length > 0 ? ` -> 🔄 正在上架${toOn.join('/')}` : '';
}

function isAccountNormal(acc) {
    const authorized = new Set(['uuzuhao', 'uhaozu', 'zuhaowang']);
    return isAccountNormalByAuthorizedPlatforms(acc, authorized);
}

function normalizeAuthorizedPlatforms(input) {
    const all = ['uuzuhao', 'uhaozu', 'zuhaowang'];
    const arr = Array.isArray(input) ? input : [];
    const out = [];
    for (const p of arr) {
        const v = String(p || '').trim().toLowerCase();
        if (v === 'uuzuhao' || v === 'uhaozu' || v === 'zuhaowang') {
            if (!out.includes(v)) out.push(v);
        }
    }
    return out.length > 0 ? out : all;
}

function isAccountNormalByAuthorizedPlatforms(acc, authorizedPlatforms = []) {
    const y = acc.youpin;
    const u = acc.uhaozu;
    const z = acc.zuhaowan;
    const stateByPlatform = {
        uuzuhao: y,
        uhaozu: u,
        zuhaowang: z
    };
    const evalStates = normalizeAuthorizedPlatforms(authorizedPlatforms).map((p) => stateByPlatform[p]).filter((s) => s !== '');
    const anyRent = evalStates.includes('租赁中');
    const allUp = evalStates.length > 0 && evalStates.every((s) => s === '上架');
    const allDown = evalStates.length > 0 && evalStates.every((s) => s === '下架');
    const hasReviewFail = normalizeAuthorizedPlatforms(authorizedPlatforms).includes('uhaozu') && u === '审核失败';
    return allUp || allDown || anyRent || hasReviewFail || Boolean(acc.is_blacklisted);
}

function accountKeyOf(gameId, account) {
    return `${String(gameId || '1').trim() || '1'}::${String(account || '').trim()}`;
}

function toReportAccountFromUserGameRow(row, blacklistSet = new Set(), blacklistReasonMap = {}) {
    const status = row && typeof row.channel_status === 'object' ? row.channel_status : {};
    const prdInfo = row && typeof row.channel_prd_info === 'object' ? row.channel_prd_info : {};
    const account = String(row.game_account || '').trim();
    const gameId = String((row && row.game_id) || '1').trim() || '1';
    const identityKey = accountKeyOf(gameId, account);
    const blacklisted = blacklistSet.has(identityKey);
    const reason = String((blacklistReasonMap && blacklistReasonMap[identityKey]) || '').trim() || '黑名单';
    return {
        account,
        game_id: gameId,
        game_name: String((row && row.game_name) || 'WZRY').trim() || 'WZRY',
        remark: resolveDisplayNameByRow(row, account),
        youpin: String(status.uuzuhao || ''),
        uhaozu: String(status.uhaozu || ''),
        zuhaowan: String(status.zuhaowang || ''),
        switch: row && row.switch && typeof row.switch === 'object' ? row.switch : {},
        channel_prd_info: prdInfo,
        uhaozu_debug: '',
        is_blacklisted: blacklisted,
        suffix: blacklisted ? ` 🔸已按${reason}规则下架` : '',
        hint: ''
    };
}

function buildPayloadForOneUser(accounts, extra = {}) {
    const hhmm = new Date().toLocaleTimeString('zh-CN', {
        hour: '2-digit',
        minute: '2-digit',
        hour12: false
    });
    const list = Array.isArray(accounts) ? accounts : [];
    const syncAnomalies = Array.isArray(extra.sync_anomalies) ? extra.sync_anomalies : [];
    const missingKeySet = new Set();
    syncAnomalies.forEach((row) => {
        const missingAccounts = Array.isArray(row && row.missing_accounts) ? row.missing_accounts : [];
        missingAccounts.forEach((item) => {
            missingKeySet.add(accountKeyOf(item && item.game_id, item && item.game_account));
        });
    });
    const masterTotal = Number(extra.master_total || list.length || 0);
    return {
        ok: true,
        hhmm,
        runCount: 0,
        recentActions: [],
        accounts: list,
        master_total: masterTotal,
        sync_effective_total: Math.max(0, masterTotal - missingKeySet.size),
        sync_anomaly_count: syncAnomalies.length,
        sync_anomalies: syncAnomalies,
        allNormal: list.every((x) => isAccountNormalByAuthorizedPlatforms(x, extra.authorized_platforms || [])),
        ...extra
    };
}

async function buildReportPayload() {
    const history = readHistory();
    const oneHourAgo = Date.now() - 3600 * 1000;
    const recentRuns = history.filter((h) => h.timestamp > oneHourAgo);
    const runCount = recentRuns.length;

    const recentActions = [];
    for (const rec of recentRuns) {
        const actions = Array.isArray(rec.actions) ? rec.actions : [];
        for (const act of actions) {
            const ts = new Date(act.time || rec.timestamp).toLocaleTimeString('zh-CN', {
                hour: '2-digit',
                minute: '2-digit',
                second: '2-digit'
            });
            const icon = String(act.type || '').startsWith('off') ? '🔴下架' : '🟢上架';
            const platform = String(act.type || '').endsWith('_y')
                ? '悠悠'
                : String(act.type || '').endsWith('_u')
                ? 'U号'
                : String(act.type || '').endsWith('_z')
                ? '租号王'
                : '未知';
            recentActions.push(`• ${ts} ${icon}${platform} -> ${act.item?.account || '未知'} (${act.reason || '自动处理'})`);
        }
    }

    return {
        ok: recentRuns.length > 0,
        allNormal: true,
        hhmm: new Date().toLocaleTimeString('zh-CN', {
            hour: '2-digit',
            minute: '2-digit',
            hour12: false
        }),
        runCount,
        recentActions,
        accounts: [],
        message: recentRuns.length > 0 ? '' : '⚠️ 暂无运行历史'
    };
}

async function buildReportMessage() {
    const payload = await buildReportPayload();
    return {
        ...payload,
        message: buildTelegramMessage(payload)
    };
}

async function sendTelegram(message, mode = 'html', options = {}) {
    if (!message) return false;
    await sendTelegramMessage(message, mode, options);
    return true;
}

async function sendDingding(message, options = {}) {
    if (!message) return false;
    await sendDingdingMessage(message, options);
    return true;
}

async function notifyUserByPayload(user, payload) {
    const cfg = user && user.notify_config && typeof user.notify_config === 'object' ? user.notify_config : {};
    const tgCfg = cfg.telegram || {};
    const dingCfg = cfg.dingding || {};
    const orderOffRule = await getOrderOffRuleByUser(Number((user && user.id) || 0)).catch(() => ({
        mode: ORDER_OFF_MODE_NATURAL_DAY
    }));
    const orderCountLabel = orderOffRule.mode === ORDER_OFF_MODE_ROLLING_24H ? '近24h订单' : '今日订单';

    let authorizedPlatforms = ['uuzuhao', 'uhaozu', 'zuhaowang'];
    try {
        const authRows = await listUserPlatformAuth(Number((user && user.id) || 0), { with_payload: false });
        const validRows = authRows.filter((r) => String(r.auth_status || '') === 'valid');
        authorizedPlatforms = normalizeAuthorizedPlatforms(validRows.map((r) => String(r.platform || '')));
    } catch (_) {
        authorizedPlatforms = ['uuzuhao', 'uhaozu', 'zuhaowang'];
    }

    const payloadWithAuth = {
        ...payload,
        order_count_mode: orderOffRule.mode,
        order_count_label: orderCountLabel,
        authorized_platforms: authorizedPlatforms,
        allNormal: Array.isArray(payload.accounts)
            ? payload.accounts.every((x) => isAccountNormalByAuthorizedPlatforms(x, authorizedPlatforms))
                && (!Array.isArray(payload.sync_anomalies) || payload.sync_anomalies.length === 0)
            : Boolean(payload.allNormal)
    };

    const tgMsg = buildTelegramMessage(payloadWithAuth);
    const dingMsg = buildDingdingMessage(payloadWithAuth);

    const jobs = [];
    if (tgCfg.bot_token && tgCfg.chat_id) {
        jobs.push(
            sendTelegramMessage(tgMsg, payload.ok ? 'html' : '', {
                token: tgCfg.bot_token,
                chat_id: tgCfg.chat_id,
                proxy: tgCfg.proxy || ''
            })
        );
    }
    if (dingCfg.webhook) {
        jobs.push(
            sendDingdingMessage(dingMsg, {
                webhook: dingCfg.webhook,
                secret: dingCfg.secret || ''
            })
        );
    }

    if (jobs.length === 0) {
        return { ok: false, reason: 'notify_config_missing', errors: ['notify_config_missing'] };
    }

    const settled = await Promise.allSettled(jobs);
    const failed = settled.filter((s) => s.status === 'rejected');
    if (failed.length > 0) {
        return {
            ok: false,
            reason: 'notify_failed',
            errors: failed.map((f) => f.reason?.message || String(f.reason))
        };
    }
    return { ok: true, reason: '', errors: [] };
}

async function listUserSyncAnomaliesForReport(userId) {
    const rows = await listOpenProductSyncAnomaliesByUser(userId);
    return rows.map((row) => ({
        platform: String((row && row.platform) || '').trim(),
        expected_count: Number((row && row.expected_count) || 0),
        pulled_count: Number((row && row.pulled_count) || 0),
        missing_count: Number((row && row.missing_count) || 0),
        sample_missing_text: String((row && row.sample_missing_text) || '').trim(),
        first_seen_at: String((row && row.first_seen_at) || '').trim(),
        last_seen_at: String((row && row.last_seen_at) || '').trim()
    }));
}

async function fillTodayOrderCounts(userId, accounts = []) {
    const uid = Number(userId || 0);
    if (!uid || !Array.isArray(accounts) || accounts.length === 0) return;
    try {
        const orderOffRule = await getOrderOffRuleByUser(uid);
        const accList = accounts
            .map((a) => ({
                game_account: String((a && a.account) || '').trim(),
                game_id: String((a && a.game_id) || '1').trim() || '1'
            }))
            .filter((a) => a.game_account);
        const countMap = orderOffRule.mode === ORDER_OFF_MODE_ROLLING_24H
            ? await listRolling24hPaidOrderCountByAccounts(uid, accList)
            : await listTodayPaidOrderCountByAccounts(uid, accList);
        for (const acc of accounts) {
            const gameId = String((acc && acc.game_id) || '1').trim() || '1';
            const account = String((acc && acc.account) || '').trim();
            const fullKey = accountKeyOf(gameId, account);
            // Backward compatible with any legacy account-only count maps.
            acc.today_order_count = Number(countMap[fullKey] || countMap[account] || 0);
        }
    } catch (e) {
        for (const acc of accounts) acc.today_order_count = 0;
        console.warn(`[Report] 查询今日订单数失败 user=${uid}: ${e.message}`);
    }
}

if (require.main === module) {
    (async () => {
        try {
            const result = await buildReportMessage();
            console.log(result.message);
        } catch (err) {
            console.error('Report Error:', err);
            process.exitCode = 1;
        }
    })();
}

module.exports = {
    buildReportPayload,
    buildReportMessage,
    sendTelegram,
    sendDingding,
    toReportAccountFromUserGameRow,
    fillTodayOrderCounts,
    formatActionForDisplay,
    buildRecentActionsForUser,
    buildPayloadForOneUser,
    notifyUserByPayload,
    listUserSyncAnomaliesForReport
};
