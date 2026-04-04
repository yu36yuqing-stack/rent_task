const { openDatabase } = require('../database/sqlite_client');
const { initOrderDb, listRentingOrderWindowByAccounts } = require('../database/order_db');
const { upsertBlacklistSource } = require('../database/user_blacklist_source_db');
const { normalizeGameProfile } = require('../common/game_profile');
const {
    SOURCE_RULES,
    getBlacklistV2Mode,
    reconcileBlacklistForAccount
} = require('./blacklist_reconciler');

const GUARD_ONLINE_SOURCE = 'guard_online';
const GUARD_FORBIDDEN_SOURCE = 'guard_forbidden';
const PLATFORM_FACE_VERIFY_SOURCE = 'platform_face_verify';
const GUARD_ONLINE_RECENT_END_SEC = 25 * 60;

function nowText(input = null) {
    const d = input instanceof Date ? input : new Date();
    const p = (n) => String(n).padStart(2, '0');
    return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
}

function parseDateTimeToSec(v) {
    const text = String(v || '').trim();
    if (!text) return 0;
    const ts = Date.parse(text.replace(' ', 'T'));
    if (!Number.isFinite(ts) || ts <= 0) return 0;
    return Math.floor(ts / 1000);
}

function normalizeSource(source = '') {
    return String(source || '').trim().toLowerCase();
}

function normalizeAccountKey(input, fallback = {}) {
    if (input && typeof input === 'object' && !Array.isArray(input)) {
        const normalizedGame = normalizeGameProfile(input.game_id || fallback.game_id, input.game_name || fallback.game_name, { preserveUnknown: true });
        return {
            game_account: String(input.game_account || input.account || '').trim(),
            game_id: String(normalizedGame.game_id || '1').trim() || '1',
            game_name: String(normalizedGame.game_name || 'WZRY').trim() || 'WZRY'
        };
    }
    const normalizedGame = normalizeGameProfile(fallback.game_id, fallback.game_name, { preserveUnknown: true });
    return {
        game_account: String(input || '').trim(),
        game_id: String(normalizedGame.game_id || '1').trim() || '1',
        game_name: String(normalizedGame.game_name || 'WZRY').trim() || 'WZRY'
    };
}

function normalizeSourceRule(source = '', patch = {}) {
    const src = normalizeSource(source);
    const rule = SOURCE_RULES[src] || null;
    const reason = String(patch.reason || (rule && rule.reason) || '').trim();
    const priority = Number.isFinite(Number(patch.priority))
        ? Number(patch.priority)
        : Number((rule && rule.priority) || 0);
    return { src, reason, priority };
}

async function queryLatestOrderEndSecByAccount(userId, gameAccount) {
    const uid = Number(userId || 0);
    const key = normalizeAccountKey(gameAccount);
    const acc = key.game_account;
    if (!uid || !acc) return 0;
    await initOrderDb();
    const db = openDatabase();
    try {
        const row = await new Promise((resolve, reject) => {
            db.get(`
                SELECT end_time
                FROM "order"
                WHERE user_id = ?
                  AND is_deleted = 0
                  AND game_id = ?
                  AND game_account = ?
                  AND TRIM(COALESCE(end_time, '')) <> ''
                ORDER BY datetime(end_time) DESC, id DESC
                LIMIT 1
            `, [uid, key.game_id, acc], (err, r) => {
                if (err) return reject(err);
                resolve(r || null);
            });
        });
        return parseDateTimeToSec(row && row.end_time);
    } finally {
        db.close();
    }
}

async function hasActiveOrderByAccount(userId, gameAccount) {
    const uid = Number(userId || 0);
    const key = normalizeAccountKey(gameAccount);
    const acc = key.game_account;
    if (!uid || !acc) return false;
    const map = await listRentingOrderWindowByAccounts(uid, [key]);
    const x = map && typeof map === 'object' ? map[`${key.game_id}::${acc}`] : null;
    return Boolean(x && Number(x.count || 0) > 0);
}

async function upsertSourceAndReconcile(userId, gameAccount, source, patch = {}, opts = {}) {
    const uid = Number(userId || 0);
    const key = normalizeAccountKey(gameAccount, patch);
    const acc = key.game_account;
    const { src, reason, priority } = normalizeSourceRule(source, patch);
    if (!uid) throw new Error('user_id 非法');
    if (!acc) throw new Error('game_account 不能为空');
    if (!src) throw new Error('source 不能为空');

    const detail = patch.detail && typeof patch.detail === 'object' ? patch.detail : {};
    const expireAt = String(patch.expire_at || '').trim();
    const active = Boolean(patch.active);
    const desc = String(opts.desc || '').trim();
    const operator = String(opts.operator || 'system').trim() || 'system';
    const mode = Number(opts.mode === undefined ? getBlacklistV2Mode() : opts.mode);

    const sourceRow = await upsertBlacklistSource(uid, key, src, {
        active,
        reason,
        game_id: key.game_id,
        game_name: key.game_name,
        priority,
        detail,
        expire_at: expireAt
    }, { desc });

    const rec = await reconcileBlacklistForAccount(uid, key, {
        mode,
        apply_projection: true,
        operator,
        desc: desc || `reconcile by source=${src}`
    });
    return { source_row: sourceRow, reconcile: rec };
}

async function setReasonSourceAndReconcile(userId, gameAccount, reasonText, opts = {}) {
    const reason = String(reasonText || '').trim();
    let source = 'legacy_carryover';
    if (reason === '账号找回') source = 'manual_recover';
    else if (reason === '维护中') source = 'manual_maintenance';
    else if (reason === '人工下架') source = 'manual_block';
    else if (reason === '禁玩中') source = GUARD_FORBIDDEN_SOURCE;
    else if (reason === '检测在线') source = GUARD_ONLINE_SOURCE;
    else if (reason === '人脸识别') source = PLATFORM_FACE_VERIFY_SOURCE;
    else if (reason === '冷却期下架') source = 'order_cooldown';
    else if (/^\d+单下架$/.test(reason)) source = 'order_n_off';
    const key = normalizeAccountKey(gameAccount, opts);
    return upsertSourceAndReconcile(userId, key, source, {
        active: true,
        reason,
        game_id: key.game_id,
        game_name: key.game_name,
        detail: opts.detail || {}
    }, opts);
}

async function clearSourceAndReconcile(userId, gameAccount, source, opts = {}) {
    const key = normalizeAccountKey(gameAccount, opts);
    return upsertSourceAndReconcile(userId, key, source, {
        active: false,
        game_id: key.game_id,
        game_name: key.game_name,
        detail: opts.detail || {}
    }, opts);
}

async function setGuardSourcesByProbeAndReconcile(userId, gameAccount, probe = {}, opts = {}) {
    const uid = Number(userId || 0);
    const key = normalizeAccountKey(gameAccount, probe);
    const acc = key.game_account;
    if (!uid) throw new Error('user_id 非法');
    if (!acc) throw new Error('game_account 不能为空');

    const nowSec = Math.floor(Date.now() / 1000);
    const onlineProbe = Boolean(probe.online);
    const forbiddenProbe = Boolean(probe.forbidden);
    const activeOrder = await hasActiveOrderByAccount(uid, key);
    const lastEndSec = await queryLatestOrderEndSecByAccount(uid, key);
    const withinRecentEnd = Boolean(lastEndSec > 0 && (nowSec - lastEndSec) >= 0 && (nowSec - lastEndSec) <= GUARD_ONLINE_RECENT_END_SEC);
    const onlineActive = onlineProbe && !activeOrder && !withinRecentEnd;
    const cooldownUntilSec = lastEndSec > 0 ? lastEndSec + GUARD_ONLINE_RECENT_END_SEC : 0;

    const baseDetail = probe.detail && typeof probe.detail === 'object' ? probe.detail : {};
    await upsertBlacklistSource(uid, key, GUARD_ONLINE_SOURCE, {
        active: onlineActive,
        game_id: key.game_id,
        game_name: key.game_name,
        reason: (SOURCE_RULES[GUARD_ONLINE_SOURCE] && SOURCE_RULES[GUARD_ONLINE_SOURCE].reason) || '检测在线',
        priority: (SOURCE_RULES[GUARD_ONLINE_SOURCE] && SOURCE_RULES[GUARD_ONLINE_SOURCE].priority) || 650,
        detail: {
            ...baseDetail,
            online_probe: onlineProbe,
            active_order: activeOrder,
            last_order_end_sec: lastEndSec,
            suppress_recent_end_sec: GUARD_ONLINE_RECENT_END_SEC,
            suppressed_by_recent_end: withinRecentEnd,
            suppressed_by_active_order: activeOrder,
            calc_at: nowText()
        },
        expire_at: cooldownUntilSec > nowSec ? nowText(new Date(cooldownUntilSec * 1000)) : ''
    }, { desc: String(opts.desc || '').trim() || 'update guard_online by probe' });

    await upsertBlacklistSource(uid, key, GUARD_FORBIDDEN_SOURCE, {
        active: forbiddenProbe,
        game_id: key.game_id,
        game_name: key.game_name,
        reason: (SOURCE_RULES[GUARD_FORBIDDEN_SOURCE] && SOURCE_RULES[GUARD_FORBIDDEN_SOURCE].reason) || '禁玩中',
        priority: (SOURCE_RULES[GUARD_FORBIDDEN_SOURCE] && SOURCE_RULES[GUARD_FORBIDDEN_SOURCE].priority) || 700,
        detail: {
            ...baseDetail,
            forbidden_probe: forbiddenProbe,
            calc_at: nowText()
        },
        expire_at: ''
    }, { desc: String(opts.desc || '').trim() || 'update guard_forbidden by probe' });

    const rec = await reconcileBlacklistForAccount(uid, key, {
        mode: Number(opts.mode === undefined ? getBlacklistV2Mode() : opts.mode),
        apply_projection: true,
        operator: String(opts.operator || 'system').trim() || 'system',
        desc: String(opts.desc || '').trim() || 'reconcile by guard probe'
    });
    return {
        online_active: onlineActive,
        forbidden_active: forbiddenProbe,
        suppressed_by_active_order: activeOrder,
        suppressed_by_recent_end: withinRecentEnd,
        reconcile: rec
    };
}

module.exports = {
    GUARD_ONLINE_SOURCE,
    GUARD_FORBIDDEN_SOURCE,
    PLATFORM_FACE_VERIFY_SOURCE,
    GUARD_ONLINE_RECENT_END_SEC,
    upsertSourceAndReconcile,
    clearSourceAndReconcile,
    setReasonSourceAndReconcile,
    setGuardSourcesByProbeAndReconcile
};
