const {
    upsertUserBlacklistEntry,
    hardDeleteUserBlacklistEntry,
    listUserBlacklistByUserWithMeta
} = require('../database/user_blacklist_db');
const { getActiveUserById } = require('../database/user_db');
const {
    initProdRiskEventDb,
    upsertOpenRiskEvent
} = require('../database/prod_risk_event_db');
const {
    TASK_STATUS_PENDING,
    TASK_STATUS_WATCHING,
    initProdGuardTaskDb,
    upsertGuardTask,
    getGuardTaskByEventId
} = require('../database/prod_guard_task_db');
const {
    queryOnlineStatusCached,
    queryForbiddenStatusCached
} = require('../product/prod_probe_cache_service');

const REASON_ONLINE = '检测在线';
const REASON_FORBIDDEN = '禁玩中';
const DEFAULT_BRIDGE_RISK_TYPE = 'online_non_renting';
const DEFAULT_BRIDGE_TASK_TYPE = 'sheep_fix';
const DEFAULT_BRIDGE_BOOTSTRAP_DELAY_SEC = 5;
const DEFAULT_BRIDGE_MAX_RETRY = 5;

function nowText() {
    const d = new Date();
    const p = (n) => String(n).padStart(2, '0');
    return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
}

function isProdGuardEnabledByUser(user) {
    const sw = user && user.switch && typeof user.switch === 'object' ? user.switch : {};
    if (sw.prod_guard_enabled === undefined) return true;
    return Boolean(sw.prod_guard_enabled);
}

async function bridgeGuardBlockedToRiskTask(userId, gameAccount, options = {}, guardRet = {}) {
    const uid = Number(userId || 0);
    const acc = String(gameAccount || '').trim();
    if (!uid || !acc) return { bridged: false, reason: 'invalid_input' };
    const blockedReason = String((guardRet && guardRet.blocked_reason) || '').trim();
    if (!blockedReason) return { bridged: false, reason: 'empty_blocked_reason' };

    const user = await getActiveUserById(uid).catch(() => null);
    if (!isProdGuardEnabledByUser(user)) {
        return { bridged: false, reason: 'prod_guard_disabled_by_user_switch' };
    }

    await initProdRiskEventDb();
    await initProdGuardTaskDb();

    const source = String(options.source || 'guard').trim() || 'guard';
    const riskType = String(options.bridge_risk_type || DEFAULT_BRIDGE_RISK_TYPE).trim() || DEFAULT_BRIDGE_RISK_TYPE;
    const taskType = String(options.bridge_task_type || DEFAULT_BRIDGE_TASK_TYPE).trim() || DEFAULT_BRIDGE_TASK_TYPE;
    const bootstrapDelaySec = Math.max(0, Number(options.bridge_bootstrap_delay_sec || DEFAULT_BRIDGE_BOOTSTRAP_DELAY_SEC));
    const maxRetry = Math.max(1, Number(options.bridge_max_retry || DEFAULT_BRIDGE_MAX_RETRY));
    const hitAt = nowText();
    const snapshot = {
        source: `${source}_guard_bridge`,
        blocked_reason: blockedReason,
        online_tag: blockedReason === REASON_ONLINE ? 'ON' : '',
        guard_checked: Boolean(guardRet && guardRet.guard_checked),
        guard_error: String((guardRet && guardRet.guard_error) || '').trim(),
        hit_at: hitAt
    };
    const event = await upsertOpenRiskEvent(uid, acc, riskType, {
        risk_level: 'high',
        snapshot,
        desc: `auto open by ${source} guard blocked`
    });
    if (!event || !Number(event.id || 0)) return { bridged: false, reason: 'risk_event_upsert_failed' };

    const existTask = await getGuardTaskByEventId(Number(event.id || 0));
    if (existTask && (existTask.status === TASK_STATUS_PENDING || existTask.status === TASK_STATUS_WATCHING)) {
        return {
            bridged: true,
            event_id: Number(event.id || 0),
            task_id: Number(existTask.id || 0),
            task_reused: true
        };
    }
    const task = await upsertGuardTask({
        user_id: uid,
        game_account: acc,
        risk_type: riskType,
        task_type: taskType,
        status: TASK_STATUS_PENDING,
        event_id: Number(event.id || 0),
        next_check_at: Math.floor(Date.now() / 1000) + bootstrapDelaySec,
        max_retry: maxRetry
    }, {
        desc: `auto enqueue by ${source} guard blocked`
    });
    return {
        bridged: true,
        event_id: Number(event.id || 0),
        task_id: Number((task && task.id) || 0),
        task_reused: false
    };
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
        let bridge = { bridged: false, reason: 'skipped' };
        try {
            bridge = await bridgeGuardBlockedToRiskTask(uid, acc, options, {
                blocked_reason: blockReason,
                online,
                forbidden,
                guard_checked,
                guard_error
            });
        } catch (e) {
            bridge = { bridged: false, reason: `bridge_error:${String(e && e.message ? e.message : e || 'unknown')}` };
        }
        return {
            removed: false,
            blocked: true,
            blocked_reason: blockReason,
            online,
            forbidden,
            guard_checked,
            guard_error,
            bridge
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
