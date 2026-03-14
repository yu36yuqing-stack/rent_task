const { listActiveUsers, USER_TYPE_ADMIN, USER_STATUS_ENABLED } = require('../database/user_db');
const { tryAcquireLock, releaseLock } = require('../database/lock_db');
const { sendDingdingMessage, resolveDingdingAtOptions } = require('../report/dingding/ding_notify');
const {
    buildBlacklistInspectorMismatchText,
    buildBlacklistInspectorSummaryText
} = require('../report/dingding/ding_style');
const {
    compareLegacyAndProjectedByUser,
    getBlacklistV2Mode
} = require('./blacklist_reconciler');

const INSPECTOR_ENABLE = !['0', 'false', 'no', 'off'].includes(String(process.env.BL_V2_INSPECTOR_ENABLE || 'true').toLowerCase());
const INSPECTOR_INTERVAL_SEC = Math.max(60, Number(process.env.BL_V2_INSPECTOR_INTERVAL_SEC || 300));
const INSPECTOR_LOCK_KEY = String(process.env.BL_V2_INSPECTOR_LOCK_KEY || 'blacklist_inspector_worker');
const INSPECTOR_LOCK_LEASE_SEC = Math.max(60, Number(process.env.BL_V2_INSPECTOR_LOCK_LEASE_SEC || 240));
const INSPECTOR_ALERT_ENABLE = !['0', 'false', 'no', 'off'].includes(String(process.env.BL_V2_ALERT_ENABLE || 'true').toLowerCase());
const INSPECTOR_ALERT_DEDUP_SEC = Math.max(60, Number(process.env.BL_V2_ALERT_DEDUP_SEC || 1800));

let inspectorTimer = null;
let inspectorRunning = false;
const alertDedupMap = new Map();

function nowText() {
    const d = new Date();
    const p = (n) => String(n).padStart(2, '0');
    return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
}

function makeMismatchFingerprint(userId, mismatch = []) {
    const parts = (Array.isArray(mismatch) ? mismatch : [])
        .slice()
        .sort((a, b) => String(a.game_account || '').localeCompare(String(b.game_account || '')))
        .map((x) => `${String(x.game_account || '').trim()}|${String(x.legacy_reason || '').trim()}|${String(x.projected_reason || '').trim()}|${String(x.projected_source || '').trim()}`)
        .join(';');
    return `${Number(userId || 0)}::${parts}`;
}

function shouldSendAlertByFingerprint(fingerprint) {
    const key = String(fingerprint || '').trim();
    if (!key) return false;
    const now = Date.now();
    const expireBefore = now - (INSPECTOR_ALERT_DEDUP_SEC * 1000);
    for (const [k, t] of alertDedupMap.entries()) {
        if (Number(t || 0) < expireBefore) alertDedupMap.delete(k);
    }
    const prev = Number(alertDedupMap.get(key) || 0);
    if (prev > 0 && (now - prev) < INSPECTOR_ALERT_DEDUP_SEC * 1000) return false;
    alertDedupMap.set(key, now);
    return true;
}

function resolveUserDingding(user = {}) {
    const cfg = user && user.notify_config && typeof user.notify_config === 'object' ? user.notify_config : {};
    const ding = cfg && cfg.dingding && typeof cfg.dingding === 'object' ? cfg.dingding : {};
    return {
        webhook: String(ding.webhook || '').trim(),
        secret: String(ding.secret || '').trim(),
        at_options: resolveDingdingAtOptions(ding, '')
    };
}

function isExpectedMismatch(row = {}) {
    const legacyReason = String((row && row.legacy_reason) || '').trim();
    const projectedReason = String((row && row.projected_reason) || '').trim();
    const projectedSource = String((row && row.projected_source) || '').trim();

    // 新链路先产生冷却期 source、旧黑名单稍后再投影是预期过程，不做巡检告警。
    if (!legacyReason && projectedReason === '冷却期下架' && projectedSource === 'order_cooldown') {
        return true;
    }
    return false;
}

async function notifyMismatch(user, mismatchResult, mode, logger = console) {
    const ding = resolveUserDingding(user);
    if (!ding.webhook) {
        logger.warn(`[BlacklistInspector] skip alert user_id=${Number(user && user.id || 0)} reason=dingding_webhook_missing`);
        return { sent: false, reason: 'webhook_missing' };
    }

    const fingerprint = makeMismatchFingerprint(Number(user && user.id || 0), mismatchResult.mismatch || []);
    if (!shouldSendAlertByFingerprint(fingerprint)) {
        return { sent: false, reason: 'dedup_suppressed' };
    }

    const text = buildBlacklistInspectorMismatchText({
        user_id: Number(user && user.id || 0),
        user_name: String(user && user.name || '').trim(),
        user_account: String(user && user.account || '').trim(),
        mode,
        checked_at: nowText(),
        legacy_total: Number(mismatchResult.legacy_total || 0),
        projected_total: Number(mismatchResult.projected_total || 0),
        mismatch: mismatchResult.mismatch || []
    });

    await sendDingdingMessage(text, {
        webhook: ding.webhook,
        secret: ding.secret,
        ...ding.at_options
    });
    return { sent: true, reason: '' };
}

async function runBlacklistInspectorOnce(options = {}) {
    const logger = options.logger || console;
    if (!INSPECTOR_ENABLE) return { ok: true, skipped: true, reason: 'disabled' };
    if (inspectorRunning) return { ok: true, skipped: true, reason: 'already_running' };
    inspectorRunning = true;
    const begin = Date.now();

    const lockOwner = `pid=${process.pid} blacklist_inspector`;
    let lockAcquired = false;
    try {
        const lock = await tryAcquireLock(INSPECTOR_LOCK_KEY, INSPECTOR_LOCK_LEASE_SEC, lockOwner);
        if (!lock || !lock.acquired) {
            return {
                ok: true,
                skipped: true,
                reason: 'lock_not_acquired',
                lease_until: Number((lock && lock.lease_until) || 0)
            };
        }
        lockAcquired = true;

        const mode = String(getBlacklistV2Mode());
        const users = (await listActiveUsers())
            .filter((u) => String((u && u.user_type) || '') !== USER_TYPE_ADMIN)
            .filter((u) => String((u && u.status) || '') === USER_STATUS_ENABLED);

        let usersMismatch = 0;
        let accountsMismatch = 0;
        let alertsSent = 0;
        const errors = [];

        for (const user of users) {
            const uid = Number((user && user.id) || 0);
            if (!uid) continue;
            try {
                const cmp = await compareLegacyAndProjectedByUser(uid);
                const mismatch = (Array.isArray(cmp.mismatch) ? cmp.mismatch : []).filter((row) => !isExpectedMismatch(row));
                if (mismatch.length > 0) {
                    usersMismatch += 1;
                    accountsMismatch += mismatch.length;
                    if (INSPECTOR_ALERT_ENABLE) {
                        try {
                            const out = await notifyMismatch(user, {
                                ...cmp,
                                mismatch,
                                legacy_total: Number(cmp.legacy_total || 0),
                                projected_total: Number(cmp.projected_total || 0)
                            }, mode, logger);
                            if (out && out.sent) alertsSent += 1;
                        } catch (e) {
                            errors.push(`alert_failed user=${uid} ${String(e && e.message ? e.message : e || 'unknown')}`);
                        }
                    }
                }
            } catch (e) {
                errors.push(`compare_failed user=${uid} ${String(e && e.message ? e.message : e || 'unknown')}`);
            }
        }

        const summary = {
            checked_at: nowText(),
            mode,
            users_checked: users.length,
            users_mismatch: usersMismatch,
            accounts_mismatch: accountsMismatch,
            duration_ms: Date.now() - begin,
            alerts_sent: alertsSent,
            errors
        };

        const line = buildBlacklistInspectorSummaryText(summary);
        if (usersMismatch > 0 || errors.length > 0) logger.warn(line);
        else logger.log(line);

        if (errors.length > 0) {
            logger.warn(`[BlacklistInspector] errors=${errors.length} detail=${JSON.stringify(errors.slice(0, 6))}`);
        }
        return { ok: true, skipped: false, ...summary };
    } finally {
        try {
            if (lockAcquired) await releaseLock(INSPECTOR_LOCK_KEY, `release by ${lockOwner}`);
        } catch (e) {
            logger.error(`[BlacklistInspector] release lock failed: ${String(e && e.message ? e.message : e || 'unknown')}`);
        }
        inspectorRunning = false;
    }
}

function startBlacklistInspectorIfNeeded(options = {}) {
    const logger = options.logger || console;
    if (!INSPECTOR_ENABLE) {
        return { started: false, reason: 'disabled' };
    }
    if (inspectorTimer) {
        return { started: true, reason: 'already_started', interval_sec: INSPECTOR_INTERVAL_SEC };
    }

    const run = () => {
        runBlacklistInspectorOnce({ logger }).catch((e) => {
            logger.error(`[BlacklistInspector] run failed: ${String(e && e.message ? e.message : e || 'unknown')}`);
        });
    };

    run();
    inspectorTimer = setInterval(run, INSPECTOR_INTERVAL_SEC * 1000);
    if (inspectorTimer && typeof inspectorTimer.unref === 'function') inspectorTimer.unref();
    logger.log(`[BlacklistInspector] started interval_sec=${INSPECTOR_INTERVAL_SEC} lock_key=${INSPECTOR_LOCK_KEY}`);
    return { started: true, reason: 'started', interval_sec: INSPECTOR_INTERVAL_SEC };
}

module.exports = {
    startBlacklistInspectorIfNeeded,
    runBlacklistInspectorOnce
};
