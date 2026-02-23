const { listUserPlatformAuth } = require('../database/user_platform_auth_db');
const {
    upsertUserBlacklistEntry,
    hardDeleteUserBlacklistEntry
} = require('../database/user_blacklist_db');
const {
    queryAccountOnlineStatus,
    queryForbiddenPlay
} = require('../uuzuhao/uuzuhao_api');

const REASON_ONLINE = '检测在线';
const REASON_FORBIDDEN = '禁玩中';

function isAuthUsable(row = {}) {
    if (!row || typeof row !== 'object') return false;
    if (String(row.auth_status || '').trim() !== 'valid') return false;
    const exp = String(row.expire_at || '').trim();
    if (!exp) return true;
    const ts = Date.parse(exp);
    if (Number.isNaN(ts)) return true;
    return ts > Date.now();
}

async function resolveUuzuhaoAuthByUser(userId) {
    const uid = Number(userId || 0);
    if (!uid) return null;
    const rows = await listUserPlatformAuth(uid, { with_payload: true });
    const hit = rows.find((r) => String(r.platform || '').trim() === 'uuzuhao' && isAuthUsable(r));
    if (!hit || !hit.auth_payload || typeof hit.auth_payload !== 'object') return null;
    const payload = hit.auth_payload;
    const appKey = String(payload.app_key || '').trim();
    const appSecret = String(payload.app_secret || '').trim();
    if (!appKey || !appSecret) return null;
    return payload;
}

async function deleteBlacklistWithGuard(userId, gameAccount, options = {}) {
    const uid = Number(userId || 0);
    const acc = String(gameAccount || '').trim();
    if (!uid) throw new Error('user_id 非法');
    if (!acc) throw new Error('game_account 不能为空');

    const gameName = String(options.game_name || 'WZRY').trim() || 'WZRY';
    const source = String(options.source || 'guard').trim();
    const operator = String(options.operator || 'guard').trim();
    const desc = String(options.desc || '').trim();

    let online = false;
    let forbidden = false;
    let guard_checked = false;
    let guard_error = '';

    try {
        const auth = await resolveUuzuhaoAuthByUser(uid);
        if (auth) {
            guard_checked = true;
            const onlineRes = await queryAccountOnlineStatus(acc, gameName, { auth });
            online = Boolean(onlineRes && onlineRes.online);
            const forbiddenRes = await queryForbiddenPlay(acc, { auth, game_name: gameName });
            forbidden = Boolean(forbiddenRes && forbiddenRes.enabled);
        }
    } catch (e) {
        guard_error = String(e && e.message ? e.message : e || '').trim();
    }

    const blockReason = online ? REASON_ONLINE : (forbidden ? REASON_FORBIDDEN : '');
    if (blockReason) {
        const now = new Date();
        const p = (n) => String(n).padStart(2, '0');
        const createDate = `${now.getFullYear()}-${p(now.getMonth() + 1)}-${p(now.getDate())} ${p(now.getHours())}:${p(now.getMinutes())}:${p(now.getSeconds())}`;
        await upsertUserBlacklistEntry(uid, {
            game_account: acc,
            reason: blockReason
        }, {
            source: `${source}_guard`,
            operator,
            desc: JSON.stringify({
                type: 'release_guard_block',
                online,
                forbidden,
                guard_checked,
                guard_error
            }),
            create_date: createDate
        });
        return {
            removed: false,
            blocked: true,
            blocked_reason: blockReason,
            online,
            forbidden,
            guard_checked,
            guard_error
        };
    }

    const removed = await hardDeleteUserBlacklistEntry(uid, acc, {
        source,
        operator,
        desc,
        reason_expected: options.reason_expected
    });
    return {
        removed: Boolean(removed),
        blocked: false,
        blocked_reason: '',
        online,
        forbidden,
        guard_checked,
        guard_error
    };
}

module.exports = {
    REASON_ONLINE,
    REASON_FORBIDDEN,
    deleteBlacklistWithGuard
};
