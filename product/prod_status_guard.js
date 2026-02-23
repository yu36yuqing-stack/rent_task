const { listUserPlatformAuth } = require('../database/user_platform_auth_db');
const { openDatabase } = require('../database/sqlite_client');
const { initOrderDb } = require('../database/order_db');
const { queryAccountOnlineStatus } = require('../uuzuhao/uuzuhao_api');
const { sendDingdingMessage } = require('../report/dingding/ding_notify');

const PLATFORM_YYZ = 'uuzuhao';
const ONLINE_PROBE_WINDOW_SEC = 90;
const ONLINE_PROBE_INTERVAL_SEC = Math.max(60, Number(process.env.ONLINE_PROBE_INTERVAL_SEC || 600));
const ONLINE_PROBE_FORCE = ['1', 'true', 'yes', 'on'].includes(String(process.env.ONLINE_PROBE_FORCE || 'false').toLowerCase());
const RECENT_ORDER_END_SUPPRESS_SEC = Math.max(60, Number(process.env.ONLINE_ALERT_RECENT_END_SUPPRESS_SEC || 600));

function sleep(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
}

function dbAll(db, sql, params = []) {
    return new Promise((resolve, reject) => {
        db.all(sql, params, (err, rows) => {
            if (err) return reject(err);
            resolve(rows || []);
        });
    });
}

function toDateTimeText(d = new Date()) {
    const p = (n) => String(n).padStart(2, '0');
    return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
}

function shouldProbeOnlineNow(now = new Date()) {
    const sec = (now.getMinutes() * 60) + now.getSeconds();
    const offset = sec % ONLINE_PROBE_INTERVAL_SEC;
    return offset <= ONLINE_PROBE_WINDOW_SEC || offset >= (ONLINE_PROBE_INTERVAL_SEC - ONLINE_PROBE_WINDOW_SEC);
}

function isAuthUsable(row = {}) {
    if (!row || typeof row !== 'object') return false;
    if (String(row.auth_status || '') !== 'valid') return false;
    const exp = String(row.expire_at || '').trim();
    if (!exp) return true;
    const t = Date.parse(exp);
    if (Number.isNaN(t)) return true;
    return t > Date.now();
}

async function resolveUuzuhaoAuthByUser(userId) {
    const rows = await listUserPlatformAuth(userId, { with_payload: true });
    const hit = rows.find((r) => String(r.platform || '') === PLATFORM_YYZ && isAuthUsable(r));
    const auth = hit && hit.auth_payload && typeof hit.auth_payload === 'object'
        ? hit.auth_payload
        : null;
    if (!auth) return null;
    const appKey = String(auth.app_key || '').trim();
    const appSecret = String(auth.app_secret || '').trim();
    return appKey && appSecret ? auth : null;
}

function isRentingStatus(v) {
    const s = String(v || '').trim();
    return s === '租赁中' || s === '出租中';
}

function collectOnlineButNotRenting(accounts = []) {
    const list = Array.isArray(accounts) ? accounts : [];
    return list.filter((acc) => {
        const y = String((acc && acc.youpin) || '').trim();
        const u = String((acc && acc.uhaozu) || '').trim();
        const z = String((acc && acc.zuhaowan) || '').trim();
        const online = String((acc && acc.online_tag) || '').trim().toUpperCase();
        const anyRent = isRentingStatus(y) || isRentingStatus(u) || isRentingStatus(z);
        return online === 'ON' && !anyRent;
    });
}

function buildOnlineButNotRentingAlertText(user, badAccounts = []) {
    const nowText = new Date().toLocaleString('zh-CN', { hour12: false });
    const owner = String((user && (user.name || user.account)) || '').trim() || `user_${user && user.id ? user.id : 'unknown'}`;
    const lines = [
        `⚠️ ${owner} 在线状态告警`,
        `时间: ${nowText}`,
        '命中条件: 非租赁中，但状态为在线(ON)',
        `账号数: ${badAccounts.length}`
    ];
    const limit = Math.min(20, badAccounts.length);
    for (let i = 0; i < limit; i += 1) {
        const a = badAccounts[i] || {};
        const name = String(a.remark || a.account || `账号${i + 1}`).trim();
        lines.push(`• ${name} (Y:${a.youpin || '-'} / U:${a.uhaozu || '-'} / Z:${a.zuhaowan || '-'})`);
    }
    if (badAccounts.length > limit) {
        lines.push(`… 其余 ${badAccounts.length - limit} 个账号未展开`);
    }
    return lines.join('\n');
}

async function listRecentlyEndedAccountsByUser(userId, accounts = [], suppressSec = RECENT_ORDER_END_SUPPRESS_SEC) {
    const uid = Number(userId || 0);
    if (!uid) return new Set();
    const accs = Array.isArray(accounts) ? accounts.map((x) => String(x || '').trim()).filter(Boolean) : [];
    if (accs.length === 0) return new Set();

    await initOrderDb();
    const db = openDatabase();
    try {
        const now = new Date();
        const lower = new Date(now.getTime() - Math.max(60, Number(suppressSec || RECENT_ORDER_END_SUPPRESS_SEC)) * 1000);
        const nowText = toDateTimeText(now);
        const lowerText = toDateTimeText(lower);
        const marks = accs.map(() => '?').join(',');
        const rows = await dbAll(db, `
            SELECT DISTINCT game_account
            FROM "order"
            WHERE user_id = ?
              AND is_deleted = 0
              AND TRIM(COALESCE(game_account, '')) <> ''
              AND game_account IN (${marks})
              AND end_time >= ?
              AND end_time <= ?
        `, [uid, ...accs, lowerText, nowText]);
        return new Set(rows.map((r) => String((r && r.game_account) || '').trim()).filter(Boolean));
    } finally {
        db.close();
    }
}

async function runProdStatusGuard(user, accounts = [], options = {}) {
    const logger = options.logger && typeof options.logger.log === 'function' ? options.logger : console;
    const dingCfg = user && user.notify_config && user.notify_config.dingding && typeof user.notify_config.dingding === 'object'
        ? user.notify_config.dingding
        : {};
    if (!dingCfg.webhook) return { ok: true, skipped: true, reason: 'dingding_not_configured' };
    if (!ONLINE_PROBE_FORCE && !shouldProbeOnlineNow()) return { ok: true, skipped: true, reason: 'out_of_probe_window' };

    const list = Array.isArray(accounts) ? accounts : [];
    if (list.length === 0) return { ok: true, skipped: true, reason: 'empty_accounts' };
    const auth = await resolveUuzuhaoAuthByUser(user && user.id);
    if (!auth) return { ok: true, skipped: true, reason: 'uuzuhao_auth_missing' };

    const probeRows = list.map((x) => ({
        account: String(x.account || '').trim(),
        remark: String(x.remark || '').trim(),
        youpin: String(x.youpin || '').trim(),
        uhaozu: String(x.uhaozu || '').trim(),
        zuhaowan: String(x.zuhaowan || '').trim(),
        online_tag: ''
    })).filter((x) => x.account);

    for (const row of probeRows) {
        try {
            const r = await queryAccountOnlineStatus(row.account, 'WZRY', { auth });
            row.online_tag = r.online ? 'ON' : 'OFF';
        } catch (e) {
            row.online_tag = '';
            logger.warn(`[ProdStatusGuard] 在线查询失败 user_id=${user && user.id} account=${row.account}: ${e.message}`);
        }
        await sleep(180);
    }

    const badAccountsRaw = collectOnlineButNotRenting(probeRows);
    if (badAccountsRaw.length === 0) return { ok: true, skipped: true, reason: 'no_conflict' };
    const recentEnded = await listRecentlyEndedAccountsByUser(
        user && user.id,
        badAccountsRaw.map((x) => x.account),
        RECENT_ORDER_END_SUPPRESS_SEC
    );
    const badAccounts = badAccountsRaw.filter((x) => !recentEnded.has(String(x.account || '').trim()));
    if (badAccounts.length === 0) {
        return {
            ok: true,
            skipped: true,
            reason: 'recent_order_ended_within_suppress_window',
            suppressed: badAccountsRaw.length
        };
    }

    const text = buildOnlineButNotRentingAlertText(user, badAccounts);
    await sendDingdingMessage(text, {
        webhook: dingCfg.webhook,
        secret: dingCfg.secret || '',
        at_all: true
    });
    return { ok: true, skipped: false, alerted: badAccounts.length };
}

function triggerProdStatusGuard(user, accounts = [], options = {}) {
    const logger = options.logger && typeof options.logger.log === 'function' ? options.logger : console;
    const userId = Number((user && user.id) || 0);
    const rows = Array.isArray(accounts) ? accounts.map((x) => ({ ...x })) : [];
    void Promise.resolve()
        .then(() => runProdStatusGuard(user, rows, options))
        .then((ret) => {
            if (ret && ret.skipped) return;
            logger.warn(`[ProdStatusGuard] user_id=${userId} alerted=${Number((ret && ret.alerted) || 0)}`);
        })
        .catch((e) => {
            logger.error(`[ProdStatusGuard] user_id=${userId} error=${e && e.message ? e.message : e}`);
        });
}

module.exports = {
    runProdStatusGuard,
    triggerProdStatusGuard
};
