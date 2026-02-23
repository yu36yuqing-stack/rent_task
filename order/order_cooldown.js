const { openDatabase } = require('../database/sqlite_client');
const { initOrderDb } = require('../database/order_db');
const { listUserPlatformAuth } = require('../database/user_platform_auth_db');
const { getLastSyncTimestamp } = require('../database/order_sync_db');
const {
    listUserBlacklistByUserWithMeta,
    upsertUserBlacklistEntry,
    hardDeleteUserBlacklistEntry
} = require('../database/user_blacklist_db');

const CHANNEL_UUZUHAO = 'uuzuhao';
const CHANNEL_UHAOZU = 'uhaozu';
const CHANNEL_ZHW = 'zuhaowang';
const CHANNEL_ZHW_YUANBAO = 'zuhaowang-yuanbao';

const COOLDOWN_REASON = '冷却期下架';
const COOLDOWN_SOURCE = 'order_cooldown';
const COOLDOWN_START_DELAY_SEC = 10 * 60;
const COOLDOWN_END_DELAY_SEC = 10 * 60;
const COOLDOWN_SYNC_FRESH_WINDOW_SEC = 12 * 60;

function dbAll(db, sql, params = []) {
    return new Promise((resolve, reject) => {
        db.all(sql, params, (err, rows) => {
            if (err) return reject(err);
            resolve(rows || []);
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
    let pending = 0;
    let invalid = 0;
    for (const row of cooldownRows) {
        const acc = String(row.game_account || '').trim();
        if (!acc) continue;
        const untilSec = parseCooldownUntilFromDesc(row.desc);
        if (!untilSec) {
            invalid += 1;
            continue;
        }
        if (nowSec < untilSec) {
            pending += 1;
            continue;
        }
        const ok = await hardDeleteUserBlacklistEntry(uid, acc, {
            source: COOLDOWN_SOURCE,
            operator: 'product_sync',
            desc: 'auto release by cooldown_until',
            reason_expected: COOLDOWN_REASON
        });
        if (ok) released += 1;
    }

    return {
        skipped: false,
        reason: COOLDOWN_REASON,
        source: COOLDOWN_SOURCE,
        freshness,
        total_cooldown_rows: cooldownRows.length,
        released,
        pending,
        invalid
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
