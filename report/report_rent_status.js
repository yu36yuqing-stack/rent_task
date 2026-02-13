const fs = require('fs');
const path = require('path');
const { sendTelegramMessage } = require('./telegram/tg_notify.js');
const { sendDingdingMessage } = require('./dingding/ding_notify.js');
const { buildTelegramMessage } = require('./telegram/tg_style.js');
const { buildDingdingMessage } = require('./dingding/ding_style.js');

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

function toReportAccountFromUserGameRow(row, blacklistSet = new Set()) {
    const status = row && typeof row.channel_status === 'object' ? row.channel_status : {};
    const account = String(row.game_account || '').trim();
    const blacklisted = blacklistSet.has(account);
    return {
        account,
        remark: String(row.account_remark || account),
        youpin: String(status.uuzuhao || ''),
        uhaozu: String(status.uhaozu || ''),
        zuhaowan: String(status.zuhaowang || ''),
        uhaozu_debug: '',
        is_blacklisted: blacklisted,
        suffix: blacklisted ? ' (已按黑名单强制下架)' : '',
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
        allNormal: list.every((x) => isAccountNormal(x)),
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

    const tgMsg = buildTelegramMessage(payload);
    const dingMsg = buildDingdingMessage(payload);

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
    buildPayloadForOneUser,
    notifyUserByPayload
};
