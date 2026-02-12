const fs = require('fs');
const path = require('path');
const { sendTelegramMessage } = require('./telegram/tg_notify.js');
const { getActiveBlacklist, ensureBlacklistSyncedFromFile } = require('../database/blacklist_db.js');

const TASK_DIR = path.resolve(__dirname, '..');
const STATUS_FILE = path.join(TASK_DIR, 'rent_robot_status.json');
const HISTORY_FILE = path.join(TASK_DIR, 'rent_robot_history.jsonl');
const BLACKLIST_FILE = path.join(TASK_DIR, 'config', 'blacklist.json');

function esc(v) {
    return String(v ?? '')
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;');
}

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

function shortState(s) {
    if (!s) return '未';
    return String(s)
        .replace('租赁中', '租')
        .replace('出租中', '租')
        .replace('审核失败', '审核失败')
        .replace('上架', '上')
        .replace('下架', '下');
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

function pickIcon(acc) {
    const y = acc.youpin;
    const u = acc.uhaozu;
    const z = acc.zuhaowan;
    const anyRent = [y, u, z].includes('租赁中');
    const allUp = y === '上架' && u === '上架' && z === '上架';
    const allDown = y === '下架' && u === '下架' && z === '下架';

    if (anyRent) return '💰';
    if (allUp) return '✅';
    if (allDown) return '⬇️';
    return '⚠️';
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

async function buildReportMessage() {
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

    let msg = '';
    msg += `<b>执行汇报</b> <code>${esc(hhmm)}</code>\n\n`;
    msg += allNormal
        ? '<blockquote>✅ 所有状态正常 (三方一致或无冲突)</blockquote>\n\n'
        : '<blockquote>⚠️ 检测到待修复状态</blockquote>\n\n';
    msg += '<b>📊 租号状态汇报</b>\n';
    msg += `⏱️ 最近1小时执行: <b>${esc(runCount)}</b> 次\n`;
    msg += `💓 心跳检测: <b>${esc(runCount)}</b> 次 (正常)\n\n`;

    if (recentActions.length > 0) {
        msg += '<b>🛠️ 近1小时自动操作</b>\n';
        msg += `${recentActions.slice(-8).map(esc).join('\n')}\n\n`;
    } else {
        msg += '<b>🛠️ 近1小时自动操作</b>\n';
        msg += '• 无\n\n';
    }

    msg += `<b>📋 完整账号列表</b> <code>(${esc(accounts.length)}个)</code>\n\n`;
    accounts.forEach((acc) => {
        const y = shortState(acc.youpin);
        const u = shortState(acc.uhaozu);
        const z = shortState(acc.zuhaowan);
        const icon = pickIcon(acc);
        const blacklisted = blacklistSet.has(String(acc.account));

        let suffix = '';
        if (blacklisted) suffix = ' (已按黑名单强制下架)';
        else if ([acc.youpin, acc.uhaozu, acc.zuhaowan].includes('租赁中') && acc.youpin !== '上架' && acc.uhaozu !== '上架' && acc.zuhaowan !== '上架') {
            suffix = ' (已全平台下架)';
        } else if (acc.uhaozu === '审核失败') {
            suffix = ` (${acc.uhaozu_debug || 'U号审核失败'})`;
        }

        const hint = computeActionHint(acc, blacklisted);
        msg += `${esc(icon)} <b>${esc(acc.remark || acc.account)}</b>: `;
        msg += `Y[<code>${esc(y)}</code>] U[<code>${esc(u)}</code>] Z[<code>${esc(z)}</code>]`;
        msg += `${esc(suffix)}${esc(hint)}\n`;
    });

    msg += '\n';
    msg += '<b>系统状态</b>：';
    msg += allNormal ? '所有账号状态均正常，系统运行稳定。' : '存在待修复账号，系统正在自动处理。';

    return {
        ok: true,
        allNormal,
        message: msg
    };
}

async function sendTelegram(message, mode = 'html') {
    if (!message) return false;
    await sendTelegramMessage(message, mode);
    return true;
}

async function reportAndNotify() {
    const result = await buildReportMessage();
    if (result.ok) {
        await sendTelegram(result.message, 'html');
    } else {
        await sendTelegram(result.message, '');
    }
    return result;
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
    buildReportMessage,
    sendTelegram,
    reportAndNotify
};
