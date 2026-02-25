const { listUserPlatformAuth } = require('../database/user_platform_auth_db');
const {
    getUserGameAccountProbeSnapshotsByUserAndAccount,
    updateUserGameAccountOnlineProbeSnapshot,
    updateUserGameAccountForbiddenProbeSnapshot
} = require('../database/user_game_account_db');
const {
    queryAccountOnlineStatus,
    queryForbiddenPlay,
    setForbiddenPlay
} = require('../uuzuhao/uuzuhao_api');

const DEFAULT_PROBE_CACHE_TTL_SEC = Math.max(1, Number(process.env.PROBE_CACHE_TTL_SEC || 60));

function nowText() {
    const d = new Date();
    const p = (n) => String(n).padStart(2, '0');
    return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
}

function parseDateTimeTextToSec(v) {
    const text = String(v || '').trim();
    if (!text) return 0;
    const ts = Date.parse(text.replace(' ', 'T'));
    if (Number.isNaN(ts) || ts <= 0) return 0;
    return Math.floor(ts / 1000);
}

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
    if (!uid) throw new Error('user_id 不合法');
    const rows = await listUserPlatformAuth(uid, { with_payload: true });
    const hit = rows.find((r) => String(r.platform || '').trim() === 'uuzuhao' && isAuthUsable(r));
    if (!hit || !hit.auth_payload || typeof hit.auth_payload !== 'object') {
        throw new Error('缺少可用的 uuzuhao 授权');
    }
    const payload = hit.auth_payload;
    const appKey = String(payload.app_key || '').trim();
    const appSecret = String(payload.app_secret || '').trim();
    if (!appKey || !appSecret) throw new Error('uuzuhao 授权缺少 app_key/app_secret');
    return payload;
}

async function queryOnlineStatusCached(userId, gameAccount, options = {}) {
    const uid = Number(userId || 0);
    const acc = String(gameAccount || '').trim();
    const gameName = String(options.game_name || 'WZRY').trim() || 'WZRY';
    if (!uid) throw new Error('user_id 不合法');
    if (!acc) throw new Error('game_account 不能为空');
    const ttlSec = Math.max(1, Number(options.ttl_sec || DEFAULT_PROBE_CACHE_TTL_SEC));
    const nowSec = Math.floor(Date.now() / 1000);
    const forceRefresh = Boolean(options.force_refresh);

    if (!forceRefresh) {
        const cached = await getUserGameAccountProbeSnapshotsByUserAndAccount(uid, acc);
        const snap = cached && cached.online_probe_snapshot && typeof cached.online_probe_snapshot === 'object'
            ? cached.online_probe_snapshot
            : {};
        const queryTime = String(snap.query_time || '').trim();
        const querySec = parseDateTimeTextToSec(queryTime);
        if (querySec > 0 && (nowSec - querySec) < ttlSec && typeof snap.online === 'boolean') {
            return {
                game_account: acc,
                game_name: gameName,
                online: Boolean(snap.online),
                query_time: queryTime,
                cached: true
            };
        }
    }

    const auth = options.auth && typeof options.auth === 'object'
        ? options.auth
        : await resolveUuzuhaoAuthByUser(uid);
    const result = await queryAccountOnlineStatus(acc, gameName, { auth });
    const queryTime = nowText();
    await updateUserGameAccountOnlineProbeSnapshot(uid, acc, {
        online: Boolean(result && result.online),
        query_time: queryTime
    }, String(options.desc || 'update by probe cache service').trim());
    return {
        game_account: acc,
        game_name: String((result && result.game_name) || gameName).trim() || gameName,
        online: Boolean(result && result.online),
        query_time: queryTime,
        cached: false
    };
}

async function queryForbiddenStatusCached(userId, gameAccount, options = {}) {
    const uid = Number(userId || 0);
    const acc = String(gameAccount || '').trim();
    const gameName = String(options.game_name || 'WZRY').trim() || 'WZRY';
    if (!uid) throw new Error('user_id 不合法');
    if (!acc) throw new Error('game_account 不能为空');
    const ttlSec = Math.max(1, Number(options.ttl_sec || DEFAULT_PROBE_CACHE_TTL_SEC));
    const nowSec = Math.floor(Date.now() / 1000);
    const forceRefresh = Boolean(options.force_refresh);

    if (!forceRefresh) {
        const cached = await getUserGameAccountProbeSnapshotsByUserAndAccount(uid, acc);
        const snap = cached && cached.forbidden_probe_snapshot && typeof cached.forbidden_probe_snapshot === 'object'
            ? cached.forbidden_probe_snapshot
            : {};
        const queryTime = String(snap.query_time || '').trim();
        const querySec = parseDateTimeTextToSec(queryTime);
        if (querySec > 0 && (nowSec - querySec) < ttlSec && typeof snap.enabled === 'boolean') {
            return {
                game_account: acc,
                game_name: gameName,
                enabled: Boolean(snap.enabled),
                query_time: queryTime,
                type: 1,
                cached: true
            };
        }
    }

    const auth = options.auth && typeof options.auth === 'object'
        ? options.auth
        : await resolveUuzuhaoAuthByUser(uid);
    const result = await queryForbiddenPlay(acc, { auth, game_name: gameName });
    const queryTime = nowText();
    await updateUserGameAccountForbiddenProbeSnapshot(uid, acc, {
        enabled: Boolean(result && result.enabled),
        query_time: queryTime
    }, String(options.desc || 'update by probe cache service').trim());
    return {
        game_account: acc,
        game_name: String((result && result.game_name) || gameName).trim() || gameName,
        enabled: Boolean(result && result.enabled),
        query_time: queryTime,
        type: Number((result && result.type) || 1),
        cached: false
    };
}

async function setForbiddenPlayWithSnapshot(userId, gameAccount, enabled, options = {}) {
    const uid = Number(userId || 0);
    const acc = String(gameAccount || '').trim();
    const gameName = String(options.game_name || 'WZRY').trim() || 'WZRY';
    if (!uid) throw new Error('user_id 不合法');
    if (!acc) throw new Error('game_account 不能为空');
    const auth = options.auth && typeof options.auth === 'object'
        ? options.auth
        : await resolveUuzuhaoAuthByUser(uid);
    const result = await setForbiddenPlay(acc, Boolean(enabled), { auth, game_name: gameName, type: 2 });
    const queryTime = nowText();
    await updateUserGameAccountForbiddenProbeSnapshot(uid, acc, {
        enabled: Boolean(result && result.enabled),
        query_time: queryTime
    }, String(options.desc || 'update by probe set').trim());
    return {
        game_account: acc,
        game_name: String((result && result.game_name) || gameName).trim() || gameName,
        enabled: Boolean(result && result.enabled),
        query_time: queryTime,
        type: Number((result && result.type) || 2)
    };
}

module.exports = {
    DEFAULT_PROBE_CACHE_TTL_SEC,
    resolveUuzuhaoAuthByUser,
    queryOnlineStatusCached,
    queryForbiddenStatusCached,
    setForbiddenPlayWithSnapshot
};
