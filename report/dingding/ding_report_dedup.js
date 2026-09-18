const crypto = require('crypto');
const {
    buildDingdingMessage,
    normalizeAuthorizedPlatforms,
    accountIdentityKey,
    pickIcon,
    shortState
} = require('./ding_style');
const { resolveUuzuhaoReauthorizeState } = require('../../product/prod_channel_status');
const {
    listRuntimeTasksByUserAndType,
    findLatestActiveRuntimeTask,
    getRuntimeTaskByTaskId,
    updateRuntimeTask
} = require('../../database/runtime_task_db');

const PRODUCT_SYNC_TASK_TYPE = 'product_sync';
const CHECKPOINT_KEY = 'dingding_rent_status';
const FINGERPRINT_VERSION = 'v1';
const SNAPSHOT_VERSION = 'v1';

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
        hhmm: '__TIME__',
        dingding_changes: null
    });
    return {
        content_hash: hashText(`${FINGERPRINT_VERSION}\n${comparisonMessage}`),
        destination_hash: hashText(stableText(webhook)),
        fingerprint_version: FINGERPRINT_VERSION
    };
}

function normalizeOnlineTag(value) {
    return stableText(value).toUpperCase();
}

function buildAccountSnapshot(account = {}, authorizedPlatforms = []) {
    const identity = accountIdentityKey(account);
    return {
        key: identity,
        game_id: stableText(account.game_id || '1') || '1',
        account: stableText(account.account),
        display_name: stableText(account.remark || account.account),
        icon: pickIcon(account, authorizedPlatforms),
        order_count: Number(account.today_order_count || 0),
        online_tag: normalizeOnlineTag(account.online_tag),
        youpin: shortState(account.youpin),
        uhaozu: shortState(account.uhaozu),
        zuhaowang: shortState(account.zuhaowan),
        suffix: stableText(account.suffix),
        hint: stableText(account.hint)
    };
}

function buildAuthProblemSnapshot(account = {}) {
    const state = resolveUuzuhaoReauthorizeState(account);
    if (!state.hit) return null;
    return {
        key: accountIdentityKey(account),
        account: stableText(account.account),
        display_name: stableText(account.remark || account.account),
        reason: stableText(state.reason)
    };
}

function buildAnomalySnapshot(row = {}) {
    return {
        platform: stableText(row.platform),
        expected_count: Number(row.expected_count || 0),
        pulled_count: Number(row.pulled_count || 0),
        missing_count: Number(row.missing_count || 0),
        sample_missing_text: stableText(row.sample_missing_text)
    };
}

function buildDingdingReportSnapshot(payload = {}) {
    const normalized = normalizeDingdingReportPayload(payload);
    const authorizedPlatforms = normalizeAuthorizedPlatforms(normalized.authorized_platforms);
    const accounts = normalized.accounts.map((row) => buildAccountSnapshot(row, authorizedPlatforms));
    const authProblems = normalized.accounts
        .map(buildAuthProblemSnapshot)
        .filter(Boolean)
        .sort((a, b) => a.key.localeCompare(b.key));
    const totalPaid = normalized.accounts.reduce((sum, row) => sum + Number(row.today_order_count || 0), 0);
    return {
        version: SNAPSHOT_VERSION,
        summary: {
            report_owner: stableText(normalized.report_owner),
            recent_actions: normalized.recentActions,
            order_count_label: stableText(normalized.order_count_label || '今日订单') || '今日订单',
            order_count: totalPaid,
            master_total: Number(normalized.master_total || 0),
            sync_anomalies: normalized.sync_anomalies.map(buildAnomalySnapshot),
            auth_problems: authProblems,
            footer_normal: Boolean(normalized.allNormal && authProblems.length === 0)
        },
        accounts
    };
}

function jsonEqual(left, right) {
    return JSON.stringify(left) === JSON.stringify(right);
}

function visibleValue(value, fallback = '未记录') {
    const text = stableText(value);
    return text || fallback;
}

function buildAccountFieldChanges(previous = {}, current = {}) {
    const fields = [];
    const add = (key, label, before, after, options = {}) => {
        if (before === after) return;
        fields.push({
            key,
            label,
            before: visibleValue(before, options.fallback),
            after: visibleValue(after, options.fallback)
        });
    };
    add('order_count', '订单', Number(previous.order_count || 0), Number(current.order_count || 0), { fallback: '0' });
    add('online_tag', '在线', previous.online_tag, current.online_tag);
    add('display_name', '名称', previous.display_name, current.display_name);
    add('youpin', '悠悠', previous.youpin, current.youpin);
    add('uhaozu', 'U号', previous.uhaozu, current.uhaozu);
    add('zuhaowang', '租号王', previous.zuhaowang, current.zuhaowang);
    if (previous.suffix !== current.suffix) {
        fields.push({ key: 'suffix', label: '提示', before: previous.suffix, after: current.suffix });
    }
    if (previous.hint !== current.hint) {
        fields.push({ key: 'hint', label: '动作提示', before: previous.hint, after: current.hint });
    }
    if (previous.icon !== current.icon && !fields.some((row) => ['youpin', 'uhaozu', 'zuhaowang'].includes(row.key))) {
        add('icon', '状态', previous.icon, current.icon);
    }
    return fields;
}

function formatAccountChangeDetail(fields = []) {
    return fields.map((field) => {
        if (field.key === 'suffix') return '提示有变化';
        if (field.key === 'hint') return '动作提示有变化';
        return `${field.label} ${field.before}→${field.after}`;
    }).join('；');
}

function diffDingdingReportSnapshots(previous, current) {
    if (!previous || !current || previous.version !== SNAPSHOT_VERSION || current.version !== SNAPSHOT_VERSION) {
        return {
            available: false,
            summary: {},
            accounts: {},
            removed_accounts: [],
            change_count: 0
        };
    }

    const previousSummary = previous.summary && typeof previous.summary === 'object' ? previous.summary : {};
    const currentSummary = current.summary && typeof current.summary === 'object' ? current.summary : {};
    const summary = {};
    if (previousSummary.report_owner !== currentSummary.report_owner) summary.header_changed = true;
    if (!jsonEqual(previousSummary.recent_actions || [], currentSummary.recent_actions || [])) summary.recent_actions_changed = true;
    if (previousSummary.order_count !== currentSummary.order_count || previousSummary.order_count_label !== currentSummary.order_count_label) {
        summary.order_count = {
            before: Number(previousSummary.order_count || 0),
            after: Number(currentSummary.order_count || 0)
        };
    }
    if (previousSummary.master_total !== currentSummary.master_total) {
        summary.master_total = {
            before: Number(previousSummary.master_total || 0),
            after: Number(currentSummary.master_total || 0)
        };
    }
    if (!jsonEqual(previousSummary.sync_anomalies || [], currentSummary.sync_anomalies || [])) summary.sync_anomalies_changed = true;
    if (!jsonEqual(previousSummary.auth_problems || [], currentSummary.auth_problems || [])) summary.auth_problems_changed = true;
    if (previousSummary.footer_normal !== currentSummary.footer_normal) summary.footer_changed = true;

    const previousAccounts = new Map((Array.isArray(previous.accounts) ? previous.accounts : []).map((row) => [row.key, row]));
    const currentAccounts = new Map((Array.isArray(current.accounts) ? current.accounts : []).map((row) => [row.key, row]));
    const accounts = {};
    for (const [key, row] of currentAccounts.entries()) {
        const old = previousAccounts.get(key);
        if (!old) {
            accounts[key] = { type: 'added', detail: '新增账号', fields: [] };
            continue;
        }
        const fields = buildAccountFieldChanges(old, row);
        if (fields.length > 0) {
            accounts[key] = {
                type: 'changed',
                detail: formatAccountChangeDetail(fields),
                fields
            };
        }
    }
    const removedAccounts = [];
    for (const [key, row] of previousAccounts.entries()) {
        if (!currentAccounts.has(key)) removedAccounts.push(row);
    }
    const summaryChangeCount = Object.keys(summary).length;
    return {
        available: true,
        summary,
        accounts,
        removed_accounts: removedAccounts,
        change_count: summaryChangeCount + Object.keys(accounts).length + removedAccounts.length
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
            snapshot: candidate.snapshot && typeof candidate.snapshot === 'object' ? candidate.snapshot : null,
            snapshot_task_id: stableText(candidate.snapshot_task_id),
            task_id: stableText(row && row.task_id)
        };
    }
    return null;
}

async function findLatestDingdingReportCheckpoint(userId) {
    const uid = Number(userId || 0);
    if (!uid) return null;
    const rows = await listRuntimeTasksByUserAndType(uid, PRODUCT_SYNC_TASK_TYPE, { limit: 100 });
    let latest = null;
    for (const row of rows) {
        const checkpoint = extractCheckpoint(row);
        if (!checkpoint) continue;
        if (!latest) {
            latest = checkpoint;
            if (latest.snapshot) return latest;
            if (latest.snapshot_task_id) {
                const snapshotRow = await getRuntimeTaskByTaskId(latest.snapshot_task_id);
                const snapshotCheckpoint = extractCheckpoint(snapshotRow);
                if (
                    snapshotCheckpoint
                    && snapshotCheckpoint.snapshot
                    && snapshotCheckpoint.content_hash === latest.content_hash
                    && snapshotCheckpoint.destination_hash === latest.destination_hash
                ) {
                    return {
                        ...latest,
                        snapshot: snapshotCheckpoint.snapshot
                    };
                }
            }
            continue;
        }
        if (
            checkpoint.snapshot
            && checkpoint.content_hash === latest.content_hash
            && checkpoint.destination_hash === latest.destination_hash
        ) {
            return {
                ...latest,
                snapshot: checkpoint.snapshot,
                snapshot_task_id: checkpoint.task_id
            };
        }
    }
    return latest;
}

async function buildDingdingReportDeliveryDecision({ userId, payload, webhook } = {}) {
    const fingerprint = buildDingdingReportFingerprint(payload, webhook);
    const snapshot = buildDingdingReportSnapshot(payload);
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
            snapshot,
            changes: previous && previous.destination_hash === fingerprint.destination_hash
                ? diffDingdingReportSnapshots(previous.snapshot, snapshot)
                : diffDingdingReportSnapshots(null, snapshot),
            ...fingerprint
        };
    } catch (error) {
        return {
            should_send: true,
            reason: 'dedup_read_failed',
            previous: null,
            snapshot,
            changes: diffDingdingReportSnapshots(null, snapshot),
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
        snapshot: checkpoint.snapshot && typeof checkpoint.snapshot === 'object' ? checkpoint.snapshot : null,
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
    SNAPSHOT_VERSION,
    normalizeDingdingReportPayload,
    buildDingdingReportFingerprint,
    buildDingdingReportSnapshot,
    diffDingdingReportSnapshots,
    findLatestDingdingReportCheckpoint,
    buildDingdingReportDeliveryDecision,
    recordDingdingReportCheckpoint
};
