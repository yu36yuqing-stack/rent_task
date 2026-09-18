const crypto = require('crypto');
const { buildDingdingMessage } = require('./ding_style');
const {
    listRuntimeTasksByUserAndType,
    findLatestActiveRuntimeTask,
    updateRuntimeTask
} = require('../../database/runtime_task_db');

const PRODUCT_SYNC_TASK_TYPE = 'product_sync';
const CHECKPOINT_KEY = 'dingding_rent_status';
const FINGERPRINT_VERSION = 'v1';

function hashText(value) {
    return crypto.createHash('sha256').update(String(value || ''), 'utf8').digest('hex');
}

function stableText(value) {
    return String(value == null ? '' : value).trim();
}

function accountSortKey(account = {}) {
    return [
        stableText(account.game_id || '1'),
        stableText(account.account),
        stableText(account.remark)
    ].join('::');
}

function anomalySortKey(row = {}) {
    return [
        stableText(row.platform),
        stableText(row.sample_missing_text),
        Number(row.expected_count || 0),
        Number(row.pulled_count || 0),
        Number(row.missing_count || 0)
    ].join('::');
}

function normalizeDingdingReportPayload(payload = {}) {
    const normalized = {
        ...payload,
        accounts: Array.isArray(payload.accounts)
            ? payload.accounts.map((row) => ({ ...row })).sort((a, b) => accountSortKey(a).localeCompare(accountSortKey(b)))
            : [],
        authorized_platforms: Array.isArray(payload.authorized_platforms)
            ? [...new Set(payload.authorized_platforms.map(stableText).filter(Boolean))].sort()
            : [],
        recentActions: Array.isArray(payload.recentActions)
            ? payload.recentActions.map(stableText).filter(Boolean).sort()
            : [],
        sync_anomalies: Array.isArray(payload.sync_anomalies)
            ? payload.sync_anomalies.map((row) => ({ ...row })).sort((a, b) => anomalySortKey(a).localeCompare(anomalySortKey(b)))
            : []
    };
    return normalized;
}

function buildDingdingReportFingerprint(payload = {}, webhook = '') {
    const normalizedPayload = normalizeDingdingReportPayload(payload);
    const comparisonMessage = buildDingdingMessage({
        ...normalizedPayload,
        hhmm: '__TIME__'
    });
    return {
        content_hash: hashText(`${FINGERPRINT_VERSION}\n${comparisonMessage}`),
        destination_hash: hashText(stableText(webhook)),
        fingerprint_version: FINGERPRINT_VERSION
    };
}

function parseResultJson(value) {
    if (value && typeof value === 'object') return value;
    try {
        const parsed = JSON.parse(String(value || '{}'));
        return parsed && typeof parsed === 'object' ? parsed : {};
    } catch (_) {
        return {};
    }
}

function extractCheckpoint(row) {
    const result = parseResultJson(row && row.result_json);
    const candidates = [
        result.notification_checkpoint && result.notification_checkpoint[CHECKPOINT_KEY],
        result.notify_result && result.notify_result.channels && result.notify_result.channels.dingding
    ];
    for (const candidate of candidates) {
        if (!candidate || typeof candidate !== 'object') continue;
        const status = stableText(candidate.status);
        const contentHash = stableText(candidate.content_hash);
        const destinationHash = stableText(candidate.destination_hash);
        if (!['sent', 'skipped_unchanged'].includes(status) || !contentHash || !destinationHash) continue;
        return {
            ...candidate,
            status,
            content_hash: contentHash,
            destination_hash: destinationHash,
            task_id: stableText(row && row.task_id)
        };
    }
    return null;
}

async function findLatestDingdingReportCheckpoint(userId) {
    const uid = Number(userId || 0);
    if (!uid) return null;
    const rows = await listRuntimeTasksByUserAndType(uid, PRODUCT_SYNC_TASK_TYPE, { limit: 100 });
    for (const row of rows) {
        const checkpoint = extractCheckpoint(row);
        if (checkpoint) return checkpoint;
    }
    return null;
}

async function buildDingdingReportDeliveryDecision({ userId, payload, webhook } = {}) {
    const fingerprint = buildDingdingReportFingerprint(payload, webhook);
    try {
        const previous = await findLatestDingdingReportCheckpoint(userId);
        const unchanged = Boolean(
            previous
            && previous.content_hash === fingerprint.content_hash
            && previous.destination_hash === fingerprint.destination_hash
        );
        return {
            should_send: !unchanged,
            reason: unchanged ? 'unchanged' : (previous ? 'content_changed' : 'first_delivery'),
            previous,
            ...fingerprint
        };
    } catch (error) {
        return {
            should_send: true,
            reason: 'dedup_read_failed',
            previous: null,
            dedup_error: String(error && error.message ? error.message : error),
            ...fingerprint
        };
    }
}

async function recordDingdingReportCheckpoint(userId, checkpoint = {}) {
    const uid = Number(userId || 0);
    if (!uid) return { recorded: false, reason: 'invalid_user' };
    const activeTask = await findLatestActiveRuntimeTask(uid, PRODUCT_SYNC_TASK_TYPE);
    if (!activeTask) return { recorded: false, reason: 'active_task_missing' };

    const result = parseResultJson(activeTask.result_json);
    const savedCheckpoint = {
        status: 'sent',
        content_hash: stableText(checkpoint.content_hash),
        destination_hash: stableText(checkpoint.destination_hash),
        fingerprint_version: stableText(checkpoint.fingerprint_version || FINGERPRINT_VERSION),
        sent_at: new Date().toISOString()
    };
    await updateRuntimeTask(activeTask.task_id, {
        result_json: {
            ...result,
            notification_checkpoint: {
                ...(result.notification_checkpoint && typeof result.notification_checkpoint === 'object'
                    ? result.notification_checkpoint
                    : {}),
                [CHECKPOINT_KEY]: savedCheckpoint
            }
        }
    });
    return {
        recorded: true,
        task_id: stableText(activeTask.task_id),
        checkpoint: savedCheckpoint
    };
}

module.exports = {
    PRODUCT_SYNC_TASK_TYPE,
    CHECKPOINT_KEY,
    FINGERPRINT_VERSION,
    normalizeDingdingReportPayload,
    buildDingdingReportFingerprint,
    findLatestDingdingReportCheckpoint,
    buildDingdingReportDeliveryDecision,
    recordDingdingReportCheckpoint
};
