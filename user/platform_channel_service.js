const {
    listUserPlatformAuth,
    setPlatformChannelEnabled
} = require('../database/user_platform_auth_db');
const {
    clearPlatformDataForUser
} = require('../database/user_game_account_db');
const {
    listBlacklistSourcesByUser,
    upsertBlacklistSource
} = require('../database/user_blacklist_source_db');
const { reconcileBlacklistForAccount, getBlacklistV2Mode } = require('../blacklist/blacklist_reconciler');
const { removePlatformRestrictByUserAndPlatform } = require('../database/user_platform_restrict_db');
const { finishAliveGuardTasksByUser } = require('../database/prod_guard_task_db');
const { resolveOpenProductSyncAnomaly } = require('../database/product_sync_anomaly_db');

function normalizePlatform(platform) {
    return String(platform || '').trim().toLowerCase();
}

function platformEnabled(row = {}) {
    return row && row.channel_enabled !== false;
}

function canAffectSourceByPlatform(row = {}, platform = '') {
    const src = String((row && row.source) || '').trim();
    if (!src || !platform) return false;
    if (platform === 'uuzuhao' && (src === 'guard_online' || src === 'guard_forbidden')) return true;
    if (src !== 'platform_face_verify') return false;
    const detail = row && row.detail && typeof row.detail === 'object' ? row.detail : {};
    const platforms = Array.isArray(detail.platforms) ? detail.platforms.map((x) => String(x || '').trim()) : [];
    return platforms.includes(platform);
}

function removePlatformFromFaceVerifyDetail(detail = {}, platform = '') {
    const next = { ...(detail && typeof detail === 'object' ? detail : {}) };
    const platforms = Array.isArray(next.platforms) ? next.platforms : [];
    const reasons = Array.isArray(next.reasons) ? next.reasons : [];
    next.platforms = platforms.filter((x) => String(x || '').trim() !== platform);
    next.reasons = reasons.filter((x) => String((x && x.platform) || '').trim() !== platform);
    return next;
}

async function deactivateChannelBlacklistSources(userId, platform) {
    const uid = Number(userId || 0);
    const pf = normalizePlatform(platform);
    if (!uid || !pf) return { touched: 0 };

    const rows = await listBlacklistSourcesByUser(uid, { active_only: false });
    let touched = 0;
    for (const row of rows) {
        if (!canAffectSourceByPlatform(row, pf)) continue;
        const key = {
            game_account: String(row.game_account || '').trim(),
            game_id: String(row.game_id || '1').trim() || '1',
            game_name: String(row.game_name || 'WZRY').trim() || 'WZRY'
        };
        if (!key.game_account) continue;
        const source = String(row.source || '').trim();
        const detail = row && row.detail && typeof row.detail === 'object' ? row.detail : {};
        if (source === 'platform_face_verify') {
            const nextDetail = removePlatformFromFaceVerifyDetail(detail, pf);
            const remainingPlatforms = Array.isArray(nextDetail.platforms) ? nextDetail.platforms.filter(Boolean) : [];
            await upsertBlacklistSource(uid, key, source, {
                active: remainingPlatforms.length > 0 ? 1 : 0,
                reason: String(row.reason || '人脸识别').trim(),
                priority: Number(row.priority || 800),
                detail: {
                    ...nextDetail,
                    disabled_platform: pf
                },
                expire_at: String(row.expire_at || '').trim()
            }, { desc: `deactivate source by channel disabled platform=${pf}` });
        } else {
            await upsertBlacklistSource(uid, key, source, {
                active: 0,
                reason: String(row.reason || '').trim(),
                priority: Number(row.priority || 0),
                detail: {
                    ...detail,
                    disabled_platform: pf
                },
                expire_at: String(row.expire_at || '').trim()
            }, { desc: `deactivate source by channel disabled platform=${pf}` });
        }
        await reconcileBlacklistForAccount(uid, key, {
            mode: getBlacklistV2Mode(),
            apply_projection: true,
            operator: 'system',
            desc: `reconcile by channel disabled platform=${pf}`
        });
        touched += 1;
    }
    return { touched };
}

async function disablePlatformChannelByUser(userId, platform) {
    const uid = Number(userId || 0);
    const pf = normalizePlatform(platform);
    if (!uid) throw new Error('user_id 不合法');
    if (!pf) throw new Error('platform 不合法');

    const row = await setPlatformChannelEnabled(uid, pf, false, `disable channel platform=${pf}`);
    await clearPlatformDataForUser(uid, pf);
    const sourceCleanup = await deactivateChannelBlacklistSources(uid, pf);
    const restrictRemoved = await removePlatformRestrictByUserAndPlatform(uid, pf, `remove restrict by channel disabled platform=${pf}`);
    const anomalyResolved = await resolveOpenProductSyncAnomaly(uid, pf, {
        desc: `resolve anomaly by channel disabled platform=${pf}`
    });
    let guardTasksFinished = 0;
    if (pf === 'uuzuhao') {
        guardTasksFinished = await finishAliveGuardTasksByUser(uid, `skip_by_channel_disabled:${pf}`);
    }
    return {
        row,
        cleanup: {
            source_touched: Number(sourceCleanup.touched || 0),
            restrict_removed: Number(restrictRemoved || 0),
            anomaly_resolved: Number(anomalyResolved || 0),
            guard_tasks_finished: Number(guardTasksFinished || 0)
        }
    };
}

async function togglePlatformChannelByUser(userId, platform, enabled) {
    const uid = Number(userId || 0);
    const pf = normalizePlatform(platform);
    if (!uid) throw new Error('user_id 不合法');
    if (!pf) throw new Error('platform 不合法');
    const rows = await listUserPlatformAuth(uid, { with_payload: false });
    const current = rows.find((row) => String((row && row.platform) || '').trim() === pf);
    if (!current) throw new Error(`user_id=${uid} 缺少 ${pf} 授权`);
    const nextEnabled = Boolean(enabled);
    if (platformEnabled(current) === nextEnabled) {
        return {
            row: current,
            cleanup: {
                source_touched: 0,
                restrict_removed: 0,
                anomaly_resolved: 0,
                guard_tasks_finished: 0
            }
        };
    }
    if (nextEnabled) {
        const row = await setPlatformChannelEnabled(uid, pf, true, `enable channel platform=${pf}`);
        return {
            row,
            cleanup: {
                source_touched: 0,
                restrict_removed: 0,
                anomaly_resolved: 0,
                guard_tasks_finished: 0
            }
        };
    }
    return disablePlatformChannelByUser(uid, pf);
}

module.exports = {
    togglePlatformChannelByUser
};
