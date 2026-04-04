const {
    listBlacklistSourcesByUserAndAccounts,
    listBlacklistSourcesByUser,
    upsertBlacklistSource,
    initUserBlacklistSourceDb
} = require('../database/user_blacklist_source_db');
const {
    listUserBlacklistByUserWithMeta,
    upsertUserBlacklistEntry,
    hardDeleteUserBlacklistEntry
} = require('../database/user_blacklist_db');

const MODE_LEGACY = 0;
const MODE_DUAL_READ_OLD = 1;
const MODE_DUAL_READ_NEW = 2;
const MODE_V2 = 3;

const SOURCE_RULES = Object.freeze({
    manual_recover: { priority: 1000, reason: '账号找回' },
    manual_maintenance: { priority: 900, reason: '维护中' },
    manual_block: { priority: 850, reason: '人工下架' },
    platform_face_verify: { priority: 800, reason: '人脸识别' },
    guard_forbidden: { priority: 700, reason: '禁玩中' },
    guard_online: { priority: 650, reason: '检测在线' },
    order_cooldown: { priority: 500, reason: '冷却期下架' },
    order_n_off: { priority: 400, reason: 'N单下架' },
    legacy_carryover: { priority: 600, reason: '历史黑名单' }
});

function normalizeMode(input) {
    const n = Number(input);
    if (n === MODE_LEGACY || n === MODE_DUAL_READ_OLD || n === MODE_DUAL_READ_NEW || n === MODE_V2) return n;
    return MODE_DUAL_READ_OLD;
}

function getBlacklistV2Mode() {
    return MODE_V2;
}

function getSourceRule(source = '') {
    const key = String(source || '').trim().toLowerCase();
    return SOURCE_RULES[key] || { priority: 300, reason: '' };
}

function normalizeReasonBySource(source = '', reason = '') {
    const text = String(reason || '').trim();
    if (text) return text;
    const rule = getSourceRule(source);
    return String(rule.reason || '').trim();
}

function normalizePriorityBySource(source = '', priority = 0) {
    const p = Number(priority || 0);
    if (Number.isFinite(p) && p > 0) return p;
    const rule = getSourceRule(source);
    return Number(rule.priority || 0);
}

function reasonFromLegacy(reasonText = '') {
    const reason = String(reasonText || '').trim();
    if (!reason) return { source: 'legacy_carryover', priority: 600, reason: '历史黑名单' };
    if (reason === '冷却期下架') return { source: 'order_cooldown', priority: 500, reason };
    if (/^\d+单下架$/.test(reason)) return { source: 'order_n_off', priority: 400, reason };
    if (reason === '检测在线') return { source: 'guard_online', priority: 650, reason };
    if (reason === '禁玩中') return { source: 'guard_forbidden', priority: 700, reason };
    if (reason === '维护中') return { source: 'manual_maintenance', priority: 900, reason };
    if (reason === '人工下架') return { source: 'manual_block', priority: 850, reason };
    if (reason === '人脸识别') return { source: 'platform_face_verify', priority: 800, reason };
    if (reason === '账号找回') return { source: 'manual_recover', priority: 1000, reason };
    return { source: 'legacy_carryover', priority: 600, reason };
}

function pickWinner(sources = []) {
    const list = Array.isArray(sources) ? sources : [];
    if (list.length === 0) return null;
    const sorted = list.slice().sort((a, b) => {
        const pa = Number(a.priority || 0);
        const pb = Number(b.priority || 0);
        if (pb !== pa) return pb - pa;
        const ma = String(a.modify_date || '');
        const mb = String(b.modify_date || '');
        if (mb !== ma) return mb.localeCompare(ma);
        return String(a.source || '').localeCompare(String(b.source || ''));
    });
    return sorted[0] || null;
}

function groupByAccount(rows = []) {
    const out = new Map();
    for (const row of (Array.isArray(rows) ? rows : [])) {
        const acc = String((row && row.game_account) || '').trim();
        const gid = String((row && row.game_id) || '1').trim() || '1';
        if (!acc) continue;
        const key = `${gid}::${acc}`;
        if (!out.has(key)) out.set(key, []);
        out.get(key).push(row);
    }
    return out;
}

function toProjectedMapBySources(rows = []) {
    const grouped = groupByAccount(rows);
    const out = {};
    for (const [key, list] of grouped.entries()) {
        const activeList = list
            .filter((x) => Boolean(x && x.active))
            .map((x) => ({
                ...x,
                reason: normalizeReasonBySource(x.source, x.reason),
                priority: normalizePriorityBySource(x.source, x.priority)
            }));
        const winner = pickWinner(activeList);
        if (!winner) continue;
        out[key] = {
            game_account: String(winner.game_account || '').trim(),
            game_id: String(winner.game_id || '1').trim() || '1',
            game_name: String(winner.game_name || 'WZRY').trim() || 'WZRY',
            reason: String(winner.reason || '').trim(),
            source: String(winner.source || '').trim(),
            priority: Number(winner.priority || 0),
            winner_detail: winner && winner.detail && typeof winner.detail === 'object' ? winner.detail : {},
            winner_modify_date: String(winner.modify_date || '').trim(),
            source_count: activeList.length,
            sources: activeList
                .sort((a, b) => Number(b.priority || 0) - Number(a.priority || 0))
                .map((x) => ({
                    source: String(x.source || '').trim(),
                    reason: String(x.reason || '').trim(),
                    priority: Number(x.priority || 0),
                    modify_date: String(x.modify_date || '').trim()
                }))
        };
    }
    return out;
}

async function ensureSourceSnapshotByLegacy(userId, gameAccount, legacyReason = '', options = {}) {
    const uid = Number(userId || 0);
    const acc = String((gameAccount && gameAccount.game_account) || gameAccount || '').trim();
    const gameId = String((gameAccount && gameAccount.game_id) || options.game_id || '1').trim() || '1';
    const gameName = String((gameAccount && gameAccount.game_name) || options.game_name || 'WZRY').trim() || 'WZRY';
    if (!uid || !acc) return null;
    const normalized = reasonFromLegacy(legacyReason);
    return upsertBlacklistSource(uid, { game_account: acc, game_id: gameId, game_name: gameName }, normalized.source, {
        active: 1,
        reason: normalized.reason,
        priority: normalized.priority,
        detail: {
            from: 'legacy_blacklist',
            bootstrap: true,
            reason: normalized.reason
        },
        expire_at: ''
    }, {
        desc: String(options.desc || 'bootstrap from legacy blacklist').trim()
    });
}

async function reconcileBlacklistForAccount(userId, gameAccount, options = {}) {
    await initUserBlacklistSourceDb();
    const uid = Number(userId || 0);
    const acc = String((gameAccount && gameAccount.game_account) || gameAccount || '').trim();
    const gameId = String((gameAccount && gameAccount.game_id) || options.game_id || '1').trim() || '1';
    const gameName = String((gameAccount && gameAccount.game_name) || options.game_name || 'WZRY').trim() || 'WZRY';
    if (!uid || !acc) throw new Error('invalid user/account');

    const mode = normalizeMode(options.mode === undefined ? getBlacklistV2Mode() : options.mode);
    const applyProjection = options.apply_projection === undefined
        ? (mode >= MODE_DUAL_READ_NEW)
        : Boolean(options.apply_projection);

    const key = `${gameId}::${acc}`;
    const rows = await listBlacklistSourcesByUserAndAccounts(uid, [{ game_account: acc, game_id: gameId, game_name: gameName }], { active_only: false });
    const projected = toProjectedMapBySources(rows);
    const winner = projected[key] || null;

    if (!applyProjection) {
        return {
            mode,
            account: acc,
            game_id: gameId,
            projected: winner,
            applied: false,
            removed: false,
            upserted: false
        };
    }

    if (!winner) {
        const removed = await hardDeleteUserBlacklistEntry(uid, { game_account: acc, game_id: gameId, game_name: gameName }, {
            source: 'reconcile_blacklist_v2',
            operator: String(options.operator || 'system').trim() || 'system',
            desc: String(options.desc || 'reconcile remove by v2').trim() || 'reconcile remove by v2'
        });
        return {
            mode,
            account: acc,
            projected: null,
            applied: true,
            removed: Boolean(removed),
            upserted: false
        };
    }

    await upsertUserBlacklistEntry(uid, {
        game_account: acc,
        game_id: gameId,
        game_name: gameName,
        reason: String(winner.reason || '').trim()
    }, {
        source: 'reconcile_blacklist_v2',
        operator: String(options.operator || 'system').trim() || 'system',
        desc: JSON.stringify({
            type: 'reconcile_blacklist_v2',
            winner_source: winner.source,
            winner_priority: winner.priority,
            winner_detail: winner.winner_detail && typeof winner.winner_detail === 'object' ? winner.winner_detail : {},
            source_count: winner.source_count,
            sources: winner.sources
        })
    });

    return {
        mode,
        account: acc,
        game_id: gameId,
        projected: winner,
        applied: true,
        removed: false,
        upserted: true
    };
}

async function buildProjectedBlacklistByUser(userId, options = {}) {
    await initUserBlacklistSourceDb();
    const uid = Number(userId || 0);
    if (!uid) return {};
    const rows = await listBlacklistSourcesByUser(uid, { active_only: false });
    const projected = toProjectedMapBySources(rows);

    if (options.include_legacy_bootstrap) {
        const projectedAccountSet = new Set(
            Object.values(projected || {})
                .map((row) => String((row && row.game_account) || '').trim())
                .filter(Boolean)
        );
        const legacyRows = await listUserBlacklistByUserWithMeta(uid);
        for (const row of (Array.isArray(legacyRows) ? legacyRows : [])) {
            const acc = String((row && row.game_account) || '').trim();
            const gid = String((row && row.game_id) || '1').trim() || '1';
            const key = `${gid}::${acc}`;
            if (!acc) continue;
            if (projected[key]) continue;
            if (projectedAccountSet.has(acc)) continue;
            projected[key] = {
                game_account: acc,
                game_id: gid,
                game_name: String((row && row.game_name) || 'WZRY').trim() || 'WZRY',
                reason: String((row && row.reason) || '').trim(),
                source: 'legacy_shadow',
                priority: 0,
                source_count: 0,
                sources: []
            };
        }
    }

    return projected;
}

function mapLegacyBlacklistRows(rows = []) {
    const out = {};
    for (const row of (Array.isArray(rows) ? rows : [])) {
        const acc = String((row && row.game_account) || '').trim();
        const gid = String((row && row.game_id) || '1').trim() || '1';
        const key = `${gid}::${acc}`;
        if (!acc) continue;
        out[key] = {
            game_account: acc,
            game_id: gid,
            game_name: String((row && row.game_name) || 'WZRY').trim() || 'WZRY',
            reason: String((row && row.reason) || '').trim()
        };
    }
    return out;
}

async function compareLegacyAndProjectedByUser(userId) {
    const uid = Number(userId || 0);
    if (!uid) return { user_id: uid, mismatch: [], legacy_total: 0, projected_total: 0 };

    const legacyRows = await listUserBlacklistByUserWithMeta(uid);
    const legacyMap = mapLegacyBlacklistRows(legacyRows);
    const projectedMap = await buildProjectedBlacklistByUser(uid, { include_legacy_bootstrap: false });

    const allAccounts = Array.from(new Set([
        ...Object.keys(legacyMap),
        ...Object.keys(projectedMap)
    ])).sort((a, b) => a.localeCompare(b));

    const mismatch = [];
    for (const acc of allAccounts) {
        const legacy = legacyMap[acc] || null;
        const projected = projectedMap[acc] || null;
        const legacyReason = legacy ? String(legacy.reason || '').trim() : '';
        const projectedReason = projected ? String(projected.reason || '').trim() : '';
        if (!!legacy === !!projected && legacyReason === projectedReason) continue;
        mismatch.push({
            game_account: String((legacy || projected || {}).game_account || '').trim(),
            game_id: (legacy || projected || {}).game_id || '',
            legacy_reason: legacyReason,
            projected_reason: projectedReason,
            projected_source: projected ? String(projected.source || '').trim() : ''
        });
    }

    return {
        user_id: uid,
        mismatch,
        legacy_total: Object.keys(legacyMap).length,
        projected_total: Object.keys(projectedMap).length
    };
}

module.exports = {
    MODE_LEGACY,
    MODE_DUAL_READ_OLD,
    MODE_DUAL_READ_NEW,
    MODE_V2,
    SOURCE_RULES,
    getBlacklistV2Mode,
    normalizeMode,
    normalizeReasonBySource,
    normalizePriorityBySource,
    reasonFromLegacy,
    ensureSourceSnapshotByLegacy,
    reconcileBlacklistForAccount,
    buildProjectedBlacklistByUser,
    compareLegacyAndProjectedByUser
};
