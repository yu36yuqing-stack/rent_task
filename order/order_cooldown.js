const { openDatabase } = require('../database/sqlite_client');
const { initOrderDb } = require('../database/order_db');
const { listUserPlatformAuth } = require('../database/user_platform_auth_db');
const { getLastSyncTimestamp } = require('../database/order_sync_db');
const { getActiveUserById } = require('../database/user_db');
const {
    listUserBlacklistByUserWithMeta,
    upsertUserBlacklistEntry
} = require('../database/user_blacklist_db');
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
const { deleteBlacklistWithGuard } = require('../blacklist/blacklist_release_guard');

const CHANNEL_UUZUHAO = 'uuzuhao';
const CHANNEL_UHAOZU = 'uhaozu';
const CHANNEL_ZHW = 'zuhaowang';
const CHANNEL_ZHW_YUANBAO = 'zuhaowang-yuanbao';

const COOLDOWN_REASON = '冷却期下架';
const COOLDOWN_SOURCE = 'order_cooldown';
const COOLDOWN_START_DELAY_SEC = 10 * 60;
const COOLDOWN_END_DELAY_SEC = 10 * 60;
const COOLDOWN_SYNC_FRESH_WINDOW_SEC = 12 * 60;
const GUARD_BRIDGE_RISK_TYPE = 'online_non_renting';
const GUARD_BRIDGE_TASK_TYPE = 'sheep_fix';
const GUARD_BRIDGE_BOOTSTRAP_DELAY_SEC = 5;
const GUARD_BRIDGE_MAX_RETRY = 5;

function dbAll(db, sql, params = []) {
    return new Promise((resolve, reject) => {
        db.all(sql, params, (err, rows) => {
            if (err) return reject(err);
            resolve(rows || []);
        });
    });
}

function dbGet(db, sql, params = []) {
    return new Promise((resolve, reject) => {
        db.get(sql, params, (err, row) => {
            if (err) return reject(err);
            resolve(row || null);
        });
    });
}

function parseDateTimeTextToSec(v) {
    const text = String(v || '').trim();
    if (!text) return 0;
    const ts = Date.parse(text.replace(' ', 'T'));
    if (Number.isNaN(ts) || ts <= 0) return 0;
    return Math.floor(ts / 1000);
}

function normalizeOrderPlatform(platform) {
    const p = String(platform || '').trim().toLowerCase();
    if (p === CHANNEL_UUZUHAO) return CHANNEL_UUZUHAO;
    if (p === CHANNEL_UHAOZU) return CHANNEL_UHAOZU;
    if (p === CHANNEL_ZHW || p === CHANNEL_ZHW_YUANBAO) return CHANNEL_ZHW;
    return '';
}

function isAuthUsable(row = {}) {
    if (!row || typeof row !== 'object') return false;
    if (String(row.auth_status || '') !== 'valid') return false;
    const exp = String(row.expire_at || '').trim();
    if (!exp) return true;
    const ts = Date.parse(exp);
    if (Number.isNaN(ts)) return true;
    return ts > Date.now();
}

function buildCooldownDesc(cooldownUntilSec, ext = {}) {
    return JSON.stringify({
        type: COOLDOWN_SOURCE,
        reason: COOLDOWN_REASON,
        cooldown_until: Number(cooldownUntilSec || 0),
        ...ext
    });
}

function parseCooldownUntilFromDesc(descText) {
    const text = String(descText || '').trim();
    if (!text) return 0;
    try {
        const obj = JSON.parse(text);
        return Number((obj && obj.cooldown_until) || 0);
    } catch {
        return 0;
    }
}

function parseCooldownMetaFromDesc(descText) {
    const text = String(descText || '').trim();
    if (!text) return { cooldown_until: 0, source_order_no: '', source_channel: '' };
    try {
        const obj = JSON.parse(text);
        return {
            cooldown_until: Number((obj && obj.cooldown_until) || 0),
            source_order_no: String((obj && obj.source_order_no) || '').trim(),
            source_channel: normalizeOrderPlatform(String((obj && obj.source_channel) || '').trim())
        };
    } catch {
        return { cooldown_until: 0, source_order_no: '', source_channel: '' };
    }
}

function toDateTimeText(d = new Date()) {
    const p = (n) => String(n).padStart(2, '0');
    return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
}

function isProdGuardEnabledByUser(user) {
    const sw = user && user.switch && typeof user.switch === 'object' ? user.switch : {};
    if (sw.prod_guard_enabled === undefined) return true;
    return Boolean(sw.prod_guard_enabled);
}

async function bridgeGuardBlockedToRiskTask(userId, gameAccount, row, guardRet = {}) {
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

    const meta = parseCooldownMetaFromDesc(row && row.desc);
    const snapshot = {
        source: 'order_cooldown_guard_bridge',
        blocked_reason: blockedReason,
        online_tag: blockedReason === '检测在线' ? 'ON' : '',
        guard_checked: Boolean(guardRet && guardRet.guard_checked),
        guard_error: String((guardRet && guardRet.guard_error) || '').trim(),
        cooldown_reason: COOLDOWN_REASON,
        source_order_no: String(meta.source_order_no || '').trim(),
        source_channel: String(meta.source_channel || '').trim(),
        cooldown_until: Number(meta.cooldown_until || 0),
        hit_at: toDateTimeText()
    };
    const event = await upsertOpenRiskEvent(uid, acc, GUARD_BRIDGE_RISK_TYPE, {
        risk_level: 'high',
        snapshot,
        desc: 'auto open by order_cooldown guard blocked'
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
        risk_type: GUARD_BRIDGE_RISK_TYPE,
        task_type: GUARD_BRIDGE_TASK_TYPE,
        status: TASK_STATUS_PENDING,
        event_id: Number(event.id || 0),
        next_check_at: Math.floor(Date.now() / 1000) + GUARD_BRIDGE_BOOTSTRAP_DELAY_SEC,
        max_retry: GUARD_BRIDGE_MAX_RETRY
    }, {
        desc: 'auto enqueue by order_cooldown guard blocked'
    });
    return {
        bridged: true,
        event_id: Number(event.id || 0),
        task_id: Number((task && task.id) || 0),
        task_reused: false
    };
}

async function getOrderStatusByOrderNo(userId, orderNo, channel = '') {
    const uid = Number(userId || 0);
    const no = String(orderNo || '').trim();
    const ch = normalizeOrderPlatform(channel);
    if (!uid || !no) return '';
    await initOrderDb();
    const db = openDatabase();
    try {
        const row = ch
            ? await dbGet(db, `
                SELECT order_status
                FROM "order"
                WHERE user_id = ?
                  AND is_deleted = 0
                  AND order_no = ?
                  AND channel = ?
                ORDER BY id DESC
                LIMIT 1
            `, [uid, no, ch])
            : await dbGet(db, `
                SELECT order_status
                FROM "order"
                WHERE user_id = ?
                  AND is_deleted = 0
                  AND order_no = ?
                ORDER BY id DESC
                LIMIT 1
            `, [uid, no]);
        return String((row && row.order_status) || '').trim();
    } finally {
        db.close();
    }
}

async function listAuthorizedOrderPlatforms(userId) {
    const uid = Number(userId || 0);
    if (!uid) return [];
    const rows = await listUserPlatformAuth(uid, { with_payload: false });
    const out = [];
    for (const row of rows) {
        if (!isAuthUsable(row)) continue;
        const p = normalizeOrderPlatform(row.platform);
        if (!p) continue;
        if (!out.includes(p)) out.push(p);
    }
    return out;
}

async function isOrderSyncFreshByUser(userId, freshWindowSec = COOLDOWN_SYNC_FRESH_WINDOW_SEC) {
    const uid = Number(userId || 0);
    if (!uid) return { fresh: false, reason: 'invalid_user', lag_sec: 0, channels: [] };
    const channels = await listAuthorizedOrderPlatforms(uid);
    if (channels.length === 0) {
        return { fresh: false, reason: 'no_authorized_channel', lag_sec: 0, channels };
    }
    const nowSec = Math.floor(Date.now() / 1000);
    let maxLag = 0;
    for (const ch of channels) {
        const ts = await getLastSyncTimestamp(uid, ch);
        if (!ts) return { fresh: false, reason: `missing_sync_ts:${ch}`, lag_sec: 0, channels };
        const lag = Math.max(0, nowSec - Number(ts || 0));
        if (lag > maxLag) maxLag = lag;
    }
    if (maxLag > Number(freshWindowSec || COOLDOWN_SYNC_FRESH_WINDOW_SEC)) {
        return { fresh: false, reason: 'stale_sync', lag_sec: maxLag, channels };
    }
    return { fresh: true, reason: '', lag_sec: maxLag, channels };
}

async function listActiveRentingOrdersByUser(userId) {
    const uid = Number(userId || 0);
    if (!uid) return [];
    await initOrderDb();
    const db = openDatabase();
    try {
        const rows = await dbAll(db, `
            SELECT game_account, start_time, end_time, order_no, channel
            FROM "order"
            WHERE user_id = ?
              AND is_deleted = 0
              AND COALESCE(order_status, '') IN ('租赁中', '出租中')
              AND TRIM(COALESCE(game_account, '')) <> ''
        `, [uid]);
        return rows.map((r) => ({
            game_account: String(r.game_account || '').trim(),
            start_time: String(r.start_time || '').trim(),
            end_time: String(r.end_time || '').trim(),
            order_no: String(r.order_no || '').trim(),
            channel: String(r.channel || '').trim()
        })).filter((r) => r.game_account);
    } finally {
        db.close();
    }
}

async function reconcileOrderCooldownEntryByUser(userId, options = {}) {
    const uid = Number(userId || 0);
    if (!uid) throw new Error('user_id 不合法');
    const nowSec = Math.floor(Date.now() / 1000);
    const startDelaySec = Math.max(0, Number(options.start_delay_sec || COOLDOWN_START_DELAY_SEC));
    const endDelaySec = Math.max(0, Number(options.end_delay_sec || COOLDOWN_END_DELAY_SEC));
    const rentingOrders = await listActiveRentingOrdersByUser(uid);
    const cooldownByAccount = new Map();

    for (const row of rentingOrders) {
        const startSec = parseDateTimeTextToSec(row.start_time);
        const endSec = parseDateTimeTextToSec(row.end_time);
        if (!startSec || !endSec) continue;
        if (nowSec < startSec + startDelaySec) continue;
        const untilSec = endSec + endDelaySec;
        if (untilSec <= nowSec) continue;
        const acc = row.game_account;
        const prev = cooldownByAccount.get(acc);
        if (!prev || untilSec > prev.cooldown_until) {
            cooldownByAccount.set(acc, {
                cooldown_until: untilSec,
                order_no: row.order_no,
                channel: row.channel
            });
        }
    }

    const current = await listUserBlacklistByUserWithMeta(uid);
    const currentMap = new Map(current.map((x) => [String(x.game_account || '').trim(), x]));
    let added = 0;
    let updated = 0;
    let skipped_conflict = 0;

    for (const [acc, meta] of cooldownByAccount.entries()) {
        const old = currentMap.get(acc);
        const oldReason = String((old && old.reason) || '').trim();
        if (old && oldReason && oldReason !== COOLDOWN_REASON) {
            skipped_conflict += 1;
            continue;
        }
        const desc = buildCooldownDesc(meta.cooldown_until, {
            source_order_no: meta.order_no,
            source_channel: meta.channel,
            updated_at_sec: nowSec
        });
        await upsertUserBlacklistEntry(uid, {
            game_account: acc,
            reason: COOLDOWN_REASON
        }, {
            source: COOLDOWN_SOURCE,
            operator: 'order_worker',
            desc
        });
        if (old && oldReason === COOLDOWN_REASON) updated += 1;
        else added += 1;
    }

    return {
        reason: COOLDOWN_REASON,
        source: COOLDOWN_SOURCE,
        scanned_orders: rentingOrders.length,
        hit_accounts: cooldownByAccount.size,
        added,
        updated,
        skipped_conflict
    };
}

async function releaseOrderCooldownBlacklistByUser(userId, options = {}) {
    const uid = Number(userId || 0);
    if (!uid) throw new Error('user_id 不合法');
    const freshWindowSec = Math.max(60, Number(options.fresh_window_sec || COOLDOWN_SYNC_FRESH_WINDOW_SEC));
    const nowSec = Math.floor(Date.now() / 1000);
    const freshness = await isOrderSyncFreshByUser(uid, freshWindowSec);
    if (!freshness.fresh) {
        return {
            skipped: true,
            reason: 'order_sync_not_fresh',
            freshness
        };
    }

    const current = await listUserBlacklistByUserWithMeta(uid);
    const cooldownRows = current.filter((x) => String(x.reason || '').trim() === COOLDOWN_REASON);
    let released = 0;
    let released_by_refund = 0;
    let pending = 0;
    let invalid = 0;
    let guard_blocked = 0;
    let guard_blocked_bridged = 0;
    let guard_blocked_bridge_failed = 0;
    for (const row of cooldownRows) {
        const acc = String(row.game_account || '').trim();
        if (!acc) continue;
        const meta = parseCooldownMetaFromDesc(row.desc);
        const untilSec = Number(meta.cooldown_until || 0);
        if (!untilSec) {
            invalid += 1;
            continue;
        }
        if (meta.source_order_no) {
            const orderStatus = await getOrderStatusByOrderNo(uid, meta.source_order_no, meta.source_channel);
            if (orderStatus === '已退款') {
                const out = await deleteBlacklistWithGuard(uid, acc, {
                    source: COOLDOWN_SOURCE,
                    operator: 'product_sync',
                    desc: `auto release by refunded order status (${meta.source_order_no})`,
                    reason_expected: COOLDOWN_REASON
                });
                if (out && out.removed) {
                    released += 1;
                    released_by_refund += 1;
                    continue;
                }
                if (out && out.blocked) {
                    guard_blocked += 1;
                    try {
                        const bridgeRet = await bridgeGuardBlockedToRiskTask(uid, acc, row, out);
                        if (bridgeRet && bridgeRet.bridged) guard_blocked_bridged += 1;
                        else guard_blocked_bridge_failed += 1;
                    } catch {
                        guard_blocked_bridge_failed += 1;
                    }
                    continue;
                }
            }
        }
        if (nowSec < untilSec) {
            pending += 1;
            continue;
        }
        const out = await deleteBlacklistWithGuard(uid, acc, {
            source: COOLDOWN_SOURCE,
            operator: 'product_sync',
            desc: 'auto release by cooldown_until',
            reason_expected: COOLDOWN_REASON
        });
        if (out && out.removed) {
            released += 1;
            continue;
        }
        if (out && out.blocked) {
            guard_blocked += 1;
            try {
                const bridgeRet = await bridgeGuardBlockedToRiskTask(uid, acc, row, out);
                if (bridgeRet && bridgeRet.bridged) guard_blocked_bridged += 1;
                else guard_blocked_bridge_failed += 1;
            } catch {
                guard_blocked_bridge_failed += 1;
            }
        }
    }

    return {
        skipped: false,
        reason: COOLDOWN_REASON,
        source: COOLDOWN_SOURCE,
        freshness,
        total_cooldown_rows: cooldownRows.length,
        released,
        released_by_refund,
        pending,
        invalid,
        guard_blocked,
        guard_blocked_bridged,
        guard_blocked_bridge_failed
    };
}

module.exports = {
    COOLDOWN_REASON,
    COOLDOWN_SOURCE,
    COOLDOWN_START_DELAY_SEC,
    COOLDOWN_END_DELAY_SEC,
    COOLDOWN_SYNC_FRESH_WINDOW_SEC,
    listAuthorizedOrderPlatforms,
    isOrderSyncFreshByUser,
    reconcileOrderCooldownEntryByUser,
    releaseOrderCooldownBlacklistByUser
};
