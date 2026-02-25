const {
    upsertUserBlacklistEntry,
    hardDeleteUserBlacklistEntry,
    listUserBlacklistByUserWithMeta
} = require('../database/user_blacklist_db');
const {
    queryOnlineStatusCached,
    queryForbiddenStatusCached
} = require('../product/prod_probe_cache_service');

const REASON_ONLINE = '检测在线';
const REASON_FORBIDDEN = '禁玩中';

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
        const onlineRes = await queryOnlineStatusCached(uid, acc, {
            game_name: gameName,
            desc: 'update by blacklist guard online'
        });
        const forbiddenRes = await queryForbiddenStatusCached(uid, acc, {
            game_name: gameName,
            desc: 'update by blacklist guard forbidden'
        });
        guard_checked = true;
        online = Boolean(onlineRes && onlineRes.online);
        forbidden = Boolean(forbiddenRes && forbiddenRes.enabled);
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
    let entryAbsent = false;
    let removeBlockedReason = '';
    if (!removed) {
        const allEntries = await listUserBlacklistByUserWithMeta(uid);
        const exists = (Array.isArray(allEntries) ? allEntries : []).some((x) => String((x && x.game_account) || '').trim() === acc);
        entryAbsent = !exists;
        removeBlockedReason = entryAbsent ? '' : 'entry_exists_but_not_removed';
    }
    return {
        removed: Boolean(removed),
        entry_absent: Boolean(entryAbsent),
        done: Boolean(removed) || Boolean(entryAbsent),
        remove_blocked_reason: removeBlockedReason,
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
