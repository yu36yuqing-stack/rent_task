const { listRentingOrderWindowByAccounts } = require('../database/order_db');
const {
    listBlacklistSourcesByUserAndAccounts,
    upsertBlacklistSource
} = require('../database/user_blacklist_source_db');
const {
    SOURCE_RULES,
    getBlacklistV2Mode,
    buildProjectedBlacklistByUser,
    reconcileBlacklistForAccount
} = require('./blacklist_reconciler');
const {
    queryOnlineStatusCached,
    queryForbiddenStatusCached
} = require('../product/prod_probe_cache_service');
const { setGuardSourcesByProbeAndReconcile } = require('./blacklist_source_gateway');

function sourceReason(source = '') {
    const key = String(source || '').trim().toLowerCase();
    const rule = SOURCE_RULES[key] || null;
    return String((rule && rule.reason) || '').trim();
}

function sourcePriority(source = '') {
    const key = String(source || '').trim().toLowerCase();
    const rule = SOURCE_RULES[key] || null;
    return Number((rule && rule.priority) || 0);
}

async function hasActiveOrderByAccount(userId, gameAccount) {
    const uid = Number(userId || 0);
    const acc = String(gameAccount || '').trim();
    if (!uid || !acc) return false;
    const map = await listRentingOrderWindowByAccounts(uid, [acc]);
    const x = map && typeof map === 'object' ? map[acc] : null;
    return Boolean(x && Number(x.count || 0) > 0);
}

async function patchSource(userId, gameAccount, source, patch = {}, options = {}) {
    const uid = Number(userId || 0);
    const acc = String(gameAccount || '').trim();
    const src = String(source || '').trim().toLowerCase();
    if (!uid || !acc || !src) return null;

    const rows = await listBlacklistSourcesByUserAndAccounts(uid, [acc], { active_only: false });
    const current = (Array.isArray(rows) ? rows : []).find((x) => String((x && x.source) || '').trim() === src) || null;
    const reason = String(patch.reason || (current && current.reason) || sourceReason(src) || '').trim();
    const priority = Number.isFinite(Number(patch.priority))
        ? Number(patch.priority)
        : Number((current && current.priority) || sourcePriority(src));
    const detail = {
        ...(current && current.detail && typeof current.detail === 'object' ? current.detail : {}),
        ...(patch.detail && typeof patch.detail === 'object' ? patch.detail : {})
    };
    const expireAt = patch.expire_at === undefined
        ? String((current && current.expire_at) || '').trim()
        : String(patch.expire_at || '').trim();

    return upsertBlacklistSource(uid, acc, src, {
        active: Boolean(patch.active),
        reason,
        priority,
        detail,
        expire_at: expireAt
    }, {
        desc: String(options.desc || '').trim()
    });
}

async function manualRemoveBlacklistMode2(userId, gameAccount, options = {}) {
    const uid = Number(userId || 0);
    const acc = String(gameAccount || '').trim();
    if (!uid) throw new Error('user_id 非法');
    if (!acc) throw new Error('game_account 不能为空');

    const operator = String(options.operator || 'system').trim() || 'system';
    const source = String(options.source || 'h5').trim() || 'h5';
    const desc = String(options.desc || 'manual remove by mode2').trim();
    const gameName = String(options.game_name || 'WZRY').trim() || 'WZRY';

    const projectedBefore = await buildProjectedBlacklistByUser(uid, { include_legacy_bootstrap: false });
    const winnerBefore = projectedBefore && projectedBefore[acc] ? projectedBefore[acc] : null;
    const clearSource = String((winnerBefore && winnerBefore.source) || '').trim().toLowerCase();
    const clearedSources = [];
    const guard = {
        skipped_by_active_order: false,
        refreshed: false,
        online: null,
        forbidden: null,
        error: ''
    };

    if (clearSource) {
        await patchSource(uid, acc, clearSource, {
            active: false,
            detail: {
                manual_remove: true,
                manual_remove_source: source
            }
        }, {
            desc: `${desc};clear winner source=${clearSource}`
        });
        clearedSources.push(clearSource);
    }

    const hasActiveOrder = await hasActiveOrderByAccount(uid, acc);
    if (hasActiveOrder) {
        guard.skipped_by_active_order = true;
        const out = await patchSource(uid, acc, 'guard_online', {
            active: false,
            detail: {
                suppressed_by_active_order: true,
                manual_remove_source: source
            }
        }, {
            desc: `${desc};suppress guard_online while order in progress`
        });
        if (out && !clearedSources.includes('guard_online')) clearedSources.push('guard_online');
    } else if (clearSource === 'guard_online' || clearSource === 'guard_forbidden') {
        try {
            const onlineRes = await queryOnlineStatusCached(uid, acc, {
                game_name: gameName,
                force_refresh: true,
                desc: 'refresh guard_online by manual remove mode2'
            });
            const forbiddenRes = await queryForbiddenStatusCached(uid, acc, {
                game_name: gameName,
                force_refresh: true,
                desc: 'refresh guard_forbidden by manual remove mode2'
            });
            guard.refreshed = true;
            guard.online = Boolean(onlineRes && onlineRes.online);
            guard.forbidden = Boolean(forbiddenRes && forbiddenRes.enabled);

            await setGuardSourcesByProbeAndReconcile(uid, acc, {
                online: guard.online,
                forbidden: guard.forbidden,
                detail: {
                    refreshed_by_manual_remove: true
                }
            }, {
                source,
                operator,
                desc: `${desc};refresh guard sources by probe`
            });
        } catch (e) {
            guard.error = String(e && e.message ? e.message : e || '').trim();
        }
    }

    const rec = await reconcileBlacklistForAccount(uid, acc, {
        mode: Number(getBlacklistV2Mode()),
        apply_projection: true,
        operator,
        desc: `${desc};reconcile by mode2 manual remove`
    });

    const projectedAfter = await buildProjectedBlacklistByUser(uid, { include_legacy_bootstrap: false });
    const winnerAfter = projectedAfter && projectedAfter[acc] ? projectedAfter[acc] : null;

    return {
        mode: Number(getBlacklistV2Mode()),
        account: acc,
        cleared_sources: Array.from(new Set(clearedSources)),
        has_active_order: hasActiveOrder,
        guard,
        removed: !winnerAfter,
        blocked: Boolean(winnerAfter),
        blocked_reason: String((winnerAfter && winnerAfter.reason) || '').trim(),
        winner_source: String((winnerAfter && winnerAfter.source) || '').trim(),
        reconcile: rec
    };
}

module.exports = {
    manualRemoveBlacklistMode2
};
