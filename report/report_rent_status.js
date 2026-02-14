const fs = require('fs');
const path = require('path');
const { sendTelegramMessage } = require('./telegram/tg_notify.js');
const { sendDingdingMessage } = require('./dingding/ding_notify.js');
const { buildTelegramMessage } = require('./telegram/tg_style.js');
const { buildDingdingMessage } = require('./dingding/ding_style.js');
const { listTodayPaidOrderCountByAccounts } = require('../database/order_db');
const { listRecentProductOnoffByUser } = require('../database/product_onoff_history_db');
const { listAccountRemarksByUserAndAccounts } = require('../database/user_game_account_db');
const { listUserPlatformAuth } = require('../database/user_platform_auth_db');

const TASK_DIR = path.resolve(__dirname, '..');
const STATUS_FILE = path.join(TASK_DIR, 'rent_robot_status.json');
const HISTORY_FILE = path.join(TASK_DIR, 'rent_robot_history.jsonl');

function readJson(file, fallback) {
    try {
        if (!fs.existsSync(file)) return fallback;
        return JSON.parse(fs.readFileSync(file, 'utf8'));
    } catch {
        return fallback;
    }
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

    const accs = [...new Set(rows.map((r) => String(r.game_account || '').trim()).filter(Boolean))];
    const remarkMap = await listAccountRemarksByUserAndAccounts(uid, accs);
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
        if (!acc) continue;
        const key = `${direction}::${acc}`;
        const ts = Number(row.event_time || 0);
        const skipped = Number(row.skipped || 0) > 0;
        const reason = String(row.reason || '').trim();
        const pf = platformName(row.platform);

        let g = grouped.get(key);
        if (!g) {
            g = {
                direction,
                account: acc,
                remark: String(remarkMap[acc] || '').trim(),
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
            if (!g.remark) g.remark = String(remarkMap[acc] || '').trim();
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
        const pfText = Array.from(g.platforms).join('/');
        const countText = g.count > 1 ? `（${g.count}次）` : '';
        const reason = g.latest_reason || '自动处理';
        let mode = '';
        if (g.skipped_count === g.count && g.count > 0) mode = ' (只读跳过)';
        else if (g.skipped_count > 0) mode = ` (含${g.skipped_count}条只读跳过)`;
        return `• ${ts} ${icon} ${name} -> ${pfText}${countText} (${reason})${mode}`;
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

function toReportAccountFromUserGameRow(row, blacklistSet = new Set(), blacklistReasonMap = {}) {
    const status = row && typeof row.channel_status === 'object' ? row.channel_status : {};
    const account = String(row.game_account || '').trim();
    const blacklisted = blacklistSet.has(account);
    const reason = String((blacklistReasonMap && blacklistReasonMap[account]) || '').trim() || '黑名单';
    return {
        account,
        remark: String(row.account_remark || account),
        youpin: String(status.uuzuhao || ''),
        uhaozu: String(status.uhaozu || ''),
        zuhaowan: String(status.zuhaowang || ''),
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
    return {
        ok: true,
        hhmm,
        runCount: 0,
        recentActions: [],
        accounts: list,
        allNormal: list.every((x) => isAccountNormalByAuthorizedPlatforms(x, extra.authorized_platforms || [])),
        ...extra
    };
}

async function buildReportPayload() {
    if (!fs.existsSync(STATUS_FILE)) {
        return {
            ok: false,
            allNormal: false,
            message: '⚠️ 暂无状态数据 (任务可能未运行)'
        };
    }

    const status = readJson(STATUS_FILE, { timestamp: Date.now(), accounts: [] });
    const history = readHistory();
    const blacklistSet = new Set();

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

    const accounts = Array.isArray(status.accounts) ? [...status.accounts] : [];
    accounts.sort((a, b) => scoreAccount(b) - scoreAccount(a));

    const hhmm = new Date(status.timestamp || Date.now()).toLocaleTimeString('zh-CN', {
        hour: '2-digit',
        minute: '2-digit',
        hour12: false
    });

    const allNormal = accounts.every((acc) => {
        const y = acc.youpin;
        const u = acc.uhaozu;
        const z = acc.zuhaowan;
        const allUp = y === '上架' && u === '上架' && z === '上架';
        const allDown = y === '下架' && u === '下架' && z === '下架';
        const anyRent = [y, u, z].includes('租赁中');
        const blacklistDown = blacklistSet.has(String(acc.account)) && y !== '上架' && u !== '上架' && z !== '上架';
        return allUp || allDown || anyRent || blacklistDown || u === '审核失败';
    });

    const viewAccounts = accounts.map((acc) => {
        const blacklisted = blacklistSet.has(String(acc.account));
        let suffix = '';
        if (blacklisted) suffix = ' 🔸已按黑名单规则下架';
        else if ([acc.youpin, acc.uhaozu, acc.zuhaowan].includes('租赁中') && acc.youpin !== '上架' && acc.uhaozu !== '上架' && acc.zuhaowan !== '上架') {
            suffix = ' (已全平台下架)';
        } else if (acc.uhaozu === '审核失败') {
            suffix = ` (${acc.uhaozu_debug || 'U号审核失败'})`;
        }
        return {
            ...acc,
            is_blacklisted: blacklisted,
            suffix,
            hint: computeActionHint(acc, blacklisted)
        };
    });

    return {
        ok: true,
        allNormal,
        hhmm,
        runCount,
        recentActions,
        accounts: viewAccounts
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
        authorized_platforms: authorizedPlatforms,
        allNormal: Array.isArray(payload.accounts)
            ? payload.accounts.every((x) => isAccountNormalByAuthorizedPlatforms(x, authorizedPlatforms))
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

async function fillTodayOrderCounts(userId, accounts = []) {
    const uid = Number(userId || 0);
    if (!uid || !Array.isArray(accounts) || accounts.length === 0) return;
    try {
        const accList = accounts.map((a) => String((a && a.account) || '').trim()).filter(Boolean);
        const countMap = await listTodayPaidOrderCountByAccounts(uid, accList);
        for (const acc of accounts) {
            const key = String((acc && acc.account) || '').trim();
            acc.today_order_count = Number(countMap[key] || 0);
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
    notifyUserByPayload
};
