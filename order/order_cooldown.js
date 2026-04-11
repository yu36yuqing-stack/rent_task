const { listUserPlatformAuth } = require('../database/user_platform_auth_db');
const { getLastSyncTimestamp } = require('../database/order_sync_db');
const { listBlacklistSourcesByUser } = require('../database/user_blacklist_source_db');
const {
    listUserBlacklistByUserWithMeta
} = require('../database/user_blacklist_db');
const { upsertSourceAndReconcile } = require('../blacklist/blacklist_source_gateway');
const {
    getCooldownConfigByUser,
    DEFAULT_COOLDOWN_RELEASE_DELAY_MIN
} = require('./order_cooldown_config');
const {
    listActiveRentingOrdersByUser,
    getOrderStatusByOrderNo,
    getOrderEndTimeByOrderNo
} = require('./service/order_query_service');

const CHANNEL_UUZUHAO = 'uuzuhao';
const CHANNEL_UHAOZU = 'uhaozu';
const CHANNEL_ZHW = 'zuhaowang';
const CHANNEL_ZHW_YUANBAO = 'zuhaowang-yuanbao';

const COOLDOWN_REASON = '冷却期下架';
const COOLDOWN_SOURCE = 'order_cooldown';
const COOLDOWN_NEAR_END_SEC = 10 * 60;
const COOLDOWN_END_DELAY_SEC = DEFAULT_COOLDOWN_RELEASE_DELAY_MIN * 60;
const COOLDOWN_SYNC_FRESH_WINDOW_SEC = 12 * 60;

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
        const winner = obj && obj.winner_detail && typeof obj.winner_detail === 'object'
            ? obj.winner_detail
            : {};
        const rootCooldownUntil = Number((obj && obj.cooldown_until) || 0);
        const winnerCooldownUntil = Number((winner && winner.cooldown_until) || 0);
        const cooldownUntil = rootCooldownUntil > 0 ? rootCooldownUntil : winnerCooldownUntil;
        const sourceOrderNo = String((obj && obj.source_order_no) || (winner && winner.source_order_no) || '').trim();
        const sourceChannel = normalizeOrderPlatform(String((obj && obj.source_channel) || (winner && winner.source_channel) || '').trim());
        return {
            cooldown_until: cooldownUntil,
            source_order_no: sourceOrderNo,
            source_channel: sourceChannel
        };
    } catch {
        return { cooldown_until: 0, source_order_no: '', source_channel: '' };
    }
}

function parseCooldownMetaFromSourceRow(row = {}) {
    const detail = row && row.detail && typeof row.detail === 'object' ? row.detail : {};
    const sourceOrderNo = String(detail.source_order_no || '').trim();
    const sourceChannel = normalizeOrderPlatform(String(detail.source_channel || '').trim());
    const detailCooldownUntil = Number(detail.cooldown_until || 0);
    const expireAtSec = parseDateTimeTextToSec(String(row.expire_at || '').trim());
    const cooldownUntil = detailCooldownUntil > 0 ? detailCooldownUntil : expireAtSec;
    return {
        cooldown_until: cooldownUntil,
        source_order_no: sourceOrderNo,
        source_channel: sourceChannel
    };
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

async function reconcileOrderCooldownEntryByUser(userId, options = {}) {
    const uid = Number(userId || 0);
    if (!uid) throw new Error('user_id 不合法');
    const nowSec = Math.floor(Date.now() / 1000);
    const nearEndSec = Math.max(0, Number(options.near_end_sec || COOLDOWN_NEAR_END_SEC));
    const cooldownCfg = await getCooldownConfigByUser(uid);
    const defaultEndDelaySec = Math.max(0, Number(cooldownCfg.release_delay_min || 0) * 60);
    const endDelaySec = Math.max(0, Number(options.end_delay_sec ?? defaultEndDelaySec ?? COOLDOWN_END_DELAY_SEC));
    const rentingOrders = await listActiveRentingOrdersByUser(uid);
    const cooldownByAccount = new Map();

    for (const row of rentingOrders) {
        const startSec = parseDateTimeTextToSec(row.start_time);
        const endSec = parseDateTimeTextToSec(row.end_time);
        if (!startSec || !endSec) continue;
        if (nowSec >= endSec) continue;
        if ((endSec - nowSec) > nearEndSec) continue;
        const untilSec = endSec + endDelaySec;
        if (untilSec <= nowSec) continue;
        const acc = row.game_account;
        const key = `${row.game_id}::${acc}`;
        const prev = cooldownByAccount.get(key);
        if (!prev || untilSec > prev.cooldown_until) {
            cooldownByAccount.set(key, {
                game_account: acc,
                game_id: row.game_id,
                game_name: row.game_name,
                cooldown_until: untilSec,
                order_no: row.order_no,
                channel: row.channel
            });
        }
    }

    const current = await listUserBlacklistByUserWithMeta(uid);
    const currentMap = new Map(current.map((x) => [`${String(x.game_id || '1').trim() || '1'}::${String(x.game_account || '').trim()}`, x]));
    let added = 0;
    let updated = 0;
    let skipped_conflict = 0;

    for (const [key, meta] of cooldownByAccount.entries()) {
        const old = currentMap.get(key);
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
        await upsertSourceAndReconcile(uid, {
            game_account: meta.game_account,
            game_id: meta.game_id,
            game_name: meta.game_name
        }, 'order_cooldown', {
            active: true,
            reason: COOLDOWN_REASON,
            expire_at: new Date(meta.cooldown_until * 1000).toISOString().slice(0, 19).replace('T', ' '),
            detail: {
                source_order_no: meta.order_no,
                source_channel: meta.channel,
                cooldown_until: meta.cooldown_until
            }
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
        hit_account_keys: Array.from(cooldownByAccount.keys()),
        release_delay_min: Math.floor(endDelaySec / 60),
        added,
        updated,
        skipped_conflict
    };
}

async function releaseOrderCooldownBlacklistByUser(userId, options = {}) {
    const uid = Number(userId || 0);
    if (!uid) throw new Error('user_id 不合法');
    const freshWindowSec = Math.max(60, Number(options.fresh_window_sec || COOLDOWN_SYNC_FRESH_WINDOW_SEC));
    const endDelaySec = Math.max(0, Number(options.end_delay_sec || COOLDOWN_END_DELAY_SEC));
    const nearEndSec = Math.max(0, Number(options.near_end_sec || COOLDOWN_NEAR_END_SEC));
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
    const legacyCooldownRows = current.filter((x) => String(x.reason || '').trim() === COOLDOWN_REASON);
    const sourceRows = (await listBlacklistSourcesByUser(uid, { active_only: true }))
        .filter((x) => String(x.source || '').trim() === COOLDOWN_SOURCE);
    const releaseCandidates = new Map();

    for (const row of sourceRows) {
        const acc = String(row.game_account || '').trim();
        const gid = String(row.game_id || '1').trim() || '1';
        if (!acc) continue;
        releaseCandidates.set(`${gid}::${acc}`, {
            game_account: acc,
            game_id: gid,
            game_name: String(row.game_name || 'WZRY').trim() || 'WZRY',
            source_row: row,
            legacy_row: null
        });
    }
    for (const row of legacyCooldownRows) {
        const acc = String(row.game_account || '').trim();
        const gid = String(row.game_id || '1').trim() || '1';
        if (!acc || releaseCandidates.has(`${gid}::${acc}`)) continue;
        releaseCandidates.set(`${gid}::${acc}`, {
            game_account: acc,
            game_id: gid,
            game_name: String(row.game_name || 'WZRY').trim() || 'WZRY',
            source_row: null,
            legacy_row: row
        });
    }

    let released = 0;
    let released_by_refund = 0;
    let pending = 0;
    let invalid = 0;
    let guard_blocked = 0;
    let guard_blocked_bridged = 0;
    let guard_blocked_bridge_failed = 0;
    for (const candidate of releaseCandidates.values()) {
        const acc = String(candidate.game_account || '').trim();
        if (!acc) continue;
        const sourceMeta = candidate.source_row ? parseCooldownMetaFromSourceRow(candidate.source_row) : null;
        const legacyMeta = candidate.legacy_row ? parseCooldownMetaFromDesc(candidate.legacy_row.desc) : null;
        const meta = {
            cooldown_until: Number((sourceMeta && sourceMeta.cooldown_until) || (legacyMeta && legacyMeta.cooldown_until) || 0),
            source_order_no: String((sourceMeta && sourceMeta.source_order_no) || (legacyMeta && legacyMeta.source_order_no) || '').trim(),
            source_channel: String((sourceMeta && sourceMeta.source_channel) || (legacyMeta && legacyMeta.source_channel) || '').trim()
        };
        let untilSec = Number(meta.cooldown_until || 0);
        if (!untilSec && meta.source_order_no) {
            const endTime = await getOrderEndTimeByOrderNo(uid, meta.source_order_no, meta.source_channel);
            const endSec = parseDateTimeTextToSec(endTime);
            if (endSec > 0) untilSec = endSec + endDelaySec;
        }
        if (!untilSec) {
            invalid += 1;
            continue;
        }
        if (meta.source_order_no) {
            const orderStatus = await getOrderStatusByOrderNo(uid, meta.source_order_no, meta.source_channel);
            const endTime = await getOrderEndTimeByOrderNo(uid, meta.source_order_no, meta.source_channel);
            const endSec = parseDateTimeTextToSec(endTime);
            if (orderStatus === '已退款') {
                await upsertSourceAndReconcile(uid, {
                    game_account: acc,
                    game_id: candidate.game_id,
                    game_name: candidate.game_name
                }, 'order_cooldown', {
                    active: false,
                    reason: COOLDOWN_REASON,
                    detail: {
                        released_by: 'refund',
                        source_order_no: meta.source_order_no
                    }
                }, {
                    source: COOLDOWN_SOURCE,
                    operator: 'product_sync',
                    desc: `auto release by refunded order status (${meta.source_order_no})`,
                });
                released += 1;
                released_by_refund += 1;
                continue;
            }
            if (endSec > nowSec && (endSec - nowSec) > nearEndSec) {
                await upsertSourceAndReconcile(uid, {
                    game_account: acc,
                    game_id: candidate.game_id,
                    game_name: candidate.game_name
                }, 'order_cooldown', {
                    active: false,
                    reason: COOLDOWN_REASON,
                    detail: {
                        released_by: 'end_time_moved_out_of_cooldown_window',
                        source_order_no: meta.source_order_no,
                        end_time: endTime
                    }
                }, {
                    source: COOLDOWN_SOURCE,
                    operator: 'product_sync',
                    desc: `auto release by latest end_time out of cooldown window (${meta.source_order_no})`,
                });
                released += 1;
                continue;
            }
        }
        if (nowSec < untilSec) {
            pending += 1;
            continue;
        }
        await upsertSourceAndReconcile(uid, {
            game_account: acc,
            game_id: candidate.game_id,
            game_name: candidate.game_name
        }, 'order_cooldown', {
            active: false,
            reason: COOLDOWN_REASON,
            detail: {
                released_by: 'cooldown_until',
                cooldown_until: untilSec
            }
        }, {
            source: COOLDOWN_SOURCE,
            operator: 'product_sync',
            desc: 'auto release by cooldown_until',
        });
        released += 1;
    }

    return {
        skipped: false,
        reason: COOLDOWN_REASON,
        source: COOLDOWN_SOURCE,
        freshness,
        total_cooldown_rows: releaseCandidates.size,
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
    COOLDOWN_NEAR_END_SEC,
    COOLDOWN_END_DELAY_SEC,
    COOLDOWN_SYNC_FRESH_WINDOW_SEC,
    listAuthorizedOrderPlatforms,
    isOrderSyncFreshByUser,
    reconcileOrderCooldownEntryByUser,
    releaseOrderCooldownBlacklistByUser
};
