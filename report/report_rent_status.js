const fs = require('fs');
const path = require('path');
const { sendTelegramMessage } = require('./telegram/tg_notify.js');
const { sendDingdingMessage } = require('./dingding/ding_notify.js');
const { buildTelegramMessage } = require('./telegram/tg_style.js');
const { buildDingdingMessage } = require('./dingding/ding_style.js');
const { getActiveBlacklist, ensureBlacklistSyncedFromFile } = require('../database/blacklist_db.js');
const { listOwnersByGameAccounts } = require('../database/user_game_account_db.js');
const { listActiveUsers } = require('../database/user_db.js');

const TASK_DIR = path.resolve(__dirname, '..');
const STATUS_FILE = path.join(TASK_DIR, 'rent_robot_status.json');
const HISTORY_FILE = path.join(TASK_DIR, 'rent_robot_history.jsonl');
const BLACKLIST_FILE = path.join(TASK_DIR, 'config', 'blacklist.json');

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
            .map(l => l.trim())
            .filter(Boolean)
            .map(l => {
                try { return JSON.parse(l); } catch { return null; }
            })
            .filter(Boolean);
    } catch {
        return [];
    }
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
    const y = acc.youpin;
    const u = acc.uhaozu;
    const z = acc.zuhaowan;
    const allUp = y === '上架' && u === '上架' && z === '上架';
    const allDown = y === '下架' && u === '下架' && z === '下架';
    const anyRent = [y, u, z].includes('租赁中');
    return allUp || allDown || anyRent || u === '审核失败' || Boolean(acc.is_blacklisted);
}

async function loadBlacklistRecords() {
    try {
        await ensureBlacklistSyncedFromFile(BLACKLIST_FILE, {
            source: 'report_build',
            operator: 'system',
            desc: 'sync before build report'
        });
        return await getActiveBlacklist();
    } catch (e) {
        console.warn(`[Report] DB读取黑名单失败，回退文件读取: ${e.message}`);
    }
    const fallback = readJson(BLACKLIST_FILE, []);
    return Array.isArray(fallback) ? fallback : [];
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
    const blacklist = await loadBlacklistRecords();
    const blacklistSet = new Set(
        (Array.isArray(blacklist) ? blacklist : [])
            .filter(e => e && e.account)
            .filter(e => String(e.action || 'off').toLowerCase() !== 'on')
            .map(e => String(e.account))
    );

    const oneHourAgo = Date.now() - 3600 * 1000;
    const recentRuns = history.filter(h => h.timestamp > oneHourAgo);
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

    const allNormal = accounts.every(acc => {
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
        if (blacklisted) suffix = ' (已按黑名单强制下架)';
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

async function sendTelegram(message, mode = 'html') {
    if (!message) return false;
    await sendTelegramMessage(message, mode);
    return true;
}

async function sendDingding(message) {
    if (!message) return false;
    await sendDingdingMessage(message);
    return true;
}

async function reportAndNotifyByUser(payload) {
    if (!payload?.ok) return { routed: false, reason: 'payload_not_ok' };
    const accounts = Array.isArray(payload.accounts) ? payload.accounts : [];
    if (accounts.length === 0) return { routed: false, reason: 'no_accounts' };

    const accountValues = accounts.map((a) => String(a.account || '').trim()).filter(Boolean);
    const ownerMap = await listOwnersByGameAccounts(accountValues, 'WZRY');
    const users = await listActiveUsers();
    const userById = new Map(users.map((u) => [Number(u.id), u]));

    const grouped = new Map();
    for (const acc of accounts) {
        const ownerId = Number(ownerMap[String(acc.account || '')] || 0);
        if (!ownerId) continue;
        const arr = grouped.get(ownerId) || [];
        arr.push(acc);
        grouped.set(ownerId, arr);
    }

    const routed = [];
    const errors = [];

    for (const [userId, userAccounts] of grouped.entries()) {
        const user = userById.get(Number(userId));
        if (!user) continue;

        const cfg = user.notify_config || {};
        const tgCfg = cfg.telegram || {};
        const dingCfg = cfg.dingding || {};

        const userPayload = {
            ...payload,
            accounts: userAccounts,
            allNormal: userAccounts.every((x) => isAccountNormal(x))
        };
        const tgMsg = buildTelegramMessage(userPayload);
        const dingMsg = buildDingdingMessage(userPayload);

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
        if (jobs.length === 0) continue;

        const settled = await Promise.allSettled(jobs);
        const failed = settled.filter((s) => s.status === 'rejected');
        if (failed.length > 0) {
            errors.push({
                user_id: user.id,
                account: user.account,
                errors: failed.map((f) => f.reason?.message || String(f.reason))
            });
            continue;
        }

        routed.push({
            user_id: user.id,
            account: user.account,
            accounts: userAccounts.length
        });
    }

    return {
        routed: routed.length > 0,
        routed_users: routed,
        routed_user_count: routed.length,
        errors
    };
}

async function reportAndNotify() {
    const payload = await buildReportPayload();
    const userMode = String(process.env.USER_MODE_ENABLED || '').toLowerCase() === 'true';

    if (userMode) {
        try {
            const routed = await reportAndNotifyByUser(payload);
            if (routed.routed) {
                return {
                    ...payload,
                    user_mode: true,
                    route: routed
                };
            }
            console.warn(`[Notify] USER_MODE_ENABLED=true 但未命中用户路由，回退全局通知。reason=${routed.reason || 'none'}`);
        } catch (e) {
            console.error('[Notify] 用户路由通知失败，回退全局通知:', e.message);
        }
    }

    const telegramMessage = buildTelegramMessage(payload);
    const dingdingMessage = buildDingdingMessage(payload);
    const notifyJobs = [
        sendTelegram(telegramMessage, payload.ok ? 'html' : ''),
        sendDingding(dingdingMessage)
    ];
    const settled = await Promise.allSettled(notifyJobs);
    if (settled[0].status === 'rejected') {
        console.error('[Notify] Telegram 发送失败:', settled[0].reason?.message || settled[0].reason);
    }
    if (settled[1].status === 'rejected') {
        console.error('[Notify] 钉钉发送失败:', settled[1].reason?.message || settled[1].reason);
    }
    return {
        ...payload,
        message: telegramMessage,
        dingding_message: dingdingMessage
    };
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
    reportAndNotify,
    reportAndNotifyByUser
};
