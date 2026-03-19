const {
    listUserBlacklistByUserWithMeta
} = require('../database/user_blacklist_db');
const { listBlacklistSourcesByUserAndAccounts } = require('../database/user_blacklist_source_db');
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
const {
    upsertSourceAndReconcile,
    clearSourceAndReconcile,
    setGuardSourcesByProbeAndReconcile
} = require('./blacklist_source_gateway');

const REASON_ONLINE = '检测在线';
const REASON_FORBIDDEN = '禁玩中';
const DEFAULT_BRIDGE_RISK_TYPE = 'online_non_renting';
const DEFAULT_BRIDGE_TASK_TYPE = 'sheep_fix';
const DEFAULT_BRIDGE_BOOTSTRAP_DELAY_SEC = 5;
const DEFAULT_BRIDGE_MAX_RETRY = 5;
const ORDER_N_OFF_SOURCE_CANDIDATES = new Set(['order_3_off', 'order_3_off_guard']);

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
    const acc = String((gameAccount && gameAccount.game_account) || gameAccount || '').trim();
    const gameId = String((gameAccount && gameAccount.game_id) || options.game_id || '1').trim() || '1';
    const gameName = String((gameAccount && gameAccount.game_name) || options.game_name || 'WZRY').trim() || 'WZRY';
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
    const event = await upsertOpenRiskEvent(uid, { game_account: acc, game_id: gameId, game_name: gameName }, riskType, {
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
        game_id: gameId,
        game_name: gameName,
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
    const acc = String((gameAccount && gameAccount.game_account) || gameAccount || '').trim();
    if (!uid) throw new Error('user_id 非法');
    if (!acc) throw new Error('game_account 不能为空');

    const gameId = String((gameAccount && gameAccount.game_id) || options.game_id || '1').trim() || '1';
    const gameName = String((gameAccount && gameAccount.game_name) || options.game_name || 'WZRY').trim() || 'WZRY';
    const source = String(options.source || 'guard').trim();
    const operator = String(options.operator || 'guard').trim();
    const desc = String(options.desc || '').trim();

    let online = false;
    let forbidden = false;
    let guard_checked = false;
    let guard_error = '';

    try {
        const onlineRes = await queryOnlineStatusCached(uid, acc, {
            game_id: gameId,
            game_name: gameName,
            desc: 'update by blacklist guard online'
        });
        const forbiddenRes = await queryForbiddenStatusCached(uid, acc, {
            game_id: gameId,
            game_name: gameName,
            desc: 'update by blacklist guard forbidden'
        });
        guard_checked = true;
        online = Boolean(onlineRes && onlineRes.online);
        forbidden = Boolean(forbiddenRes && forbiddenRes.enabled);
    } catch (e) {
        guard_error = String(e && e.message ? e.message : e || '').trim();
    }

    const key = { game_account: acc, game_id: gameId, game_name: gameName };
    const guardApply = await setGuardSourcesByProbeAndReconcile(uid, key, {
        online,
        forbidden,
        game_id: gameId,
        game_name: gameName,
        detail: {
            guard_checked,
            guard_error
        }
    }, {
        source,
        operator,
        desc: `${desc || 'delete with guard'};refresh guard source`
    });
    const blockReason = guardApply && guardApply.online_active
        ? REASON_ONLINE
        : ((guardApply && guardApply.forbidden_active) ? REASON_FORBIDDEN : '');
    if (blockReason) {
        let bridge = { bridged: false, reason: 'skipped' };
        try {
            bridge = await bridgeGuardBlockedToRiskTask(uid, key, options, {
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
            suppressed_by_active_order: Boolean(guardApply && guardApply.suppressed_by_active_order),
            suppressed_by_recent_end: Boolean(guardApply && guardApply.suppressed_by_recent_end),
            guard_checked,
            guard_error,
            bridge
        };
    }

    const reasonExpected = String(options.reason_expected || '').trim();
    const sourceExpected = String(options.source_expected || '').trim().toLowerCase();
    let clearSource = sourceExpected;
    if (!clearSource) {
        if (reasonExpected === '冷却期下架') clearSource = 'order_cooldown';
        else if (/^\d+单下架$/.test(reasonExpected)) clearSource = 'order_n_off';
        else if (reasonExpected === REASON_ONLINE) clearSource = 'guard_online';
        else if (reasonExpected === REASON_FORBIDDEN) clearSource = 'guard_forbidden';
        else if (reasonExpected === '维护中') clearSource = 'manual_maintenance';
        else if (reasonExpected === '人工下架') clearSource = 'manual_block';
        else if (reasonExpected === '账号找回') clearSource = 'manual_recover';
    }
    if (!clearSource) {
        if (source === 'order_cooldown') clearSource = 'order_cooldown';
        else if (ORDER_N_OFF_SOURCE_CANDIDATES.has(source)) clearSource = 'order_n_off';
        else if (source === 'h5_maintenance') clearSource = 'manual_maintenance';
        else if (source === 'h5') clearSource = 'manual_block';
    }

    let removed = false;
    let entryAbsent = false;
    let removeBlockedReason = '';
    if (clearSource) {
        const out = await clearSourceAndReconcile(uid, key, clearSource, {
            source,
            operator,
            desc: desc || `clear source=${clearSource} by guard`,
            detail: { cleared_by_guard: true }
        });
        removed = Boolean(out && out.reconcile && out.reconcile.removed);
        const activeRows = await listBlacklistSourcesByUserAndAccounts(uid, [key], { active_only: true });
        entryAbsent = !Array.isArray(activeRows) || activeRows.length === 0;
    } else {
        const activeRows = await listBlacklistSourcesByUserAndAccounts(uid, [key], { active_only: true });
        for (const row of (Array.isArray(activeRows) ? activeRows : [])) {
            const src = String((row && row.source) || '').trim().toLowerCase();
            if (!src) continue;
            await clearSourceAndReconcile(uid, key, src, {
                source,
                operator,
                desc: desc || 'clear all active source by guard',
                detail: { cleared_by_guard: true, clear_all: true }
            });
        }
        const leftRows = await listBlacklistSourcesByUserAndAccounts(uid, [key], { active_only: true });
        entryAbsent = !Array.isArray(leftRows) || leftRows.length === 0;
        removed = entryAbsent;
    }

    if (!removed) {
        const allEntries = await listUserBlacklistByUserWithMeta(uid);
        const exists = (Array.isArray(allEntries) ? allEntries : []).some((x) =>
            String((x && x.game_account) || '').trim() === acc
            && (String((x && x.game_id) || '1').trim() || '1') === gameId
        );
        entryAbsent = !exists || entryAbsent;
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
