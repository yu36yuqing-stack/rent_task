const {
    toReportAccountFromUserGameRow,
    fillTodayOrderCounts,
    fillRentingOrderFacts,
    buildRecentActionsForUser,
    buildPayloadForOneUser,
    notifyUserByPayload,
    listUserSyncAnomaliesForReport
} = require('../report/report_rent_status');
const { syncUserAccountsByAuth, listAllUserGameAccountsByUser } = require('../product/product');
const { triggerProdStatusGuard, probeProdOnlineStatus } = require('../product/prod_status_guard');
const { reconcileOrderNOffByUser } = require('../order/service/order_rule_service');
const { loadUserBlacklistSet, loadUserBlacklistReasonMap } = require('../user/user');
const { executeUserActionsIfNeeded } = require('../action_engine/action_engine');
const { isFaceVerifyReason } = require('../product/prod_channel_status');
const { upsertSourceAndReconcile, PLATFORM_FACE_VERIFY_SOURCE } = require('../blacklist/blacklist_source_gateway');
const { listBlacklistSourcesByUserAndAccounts } = require('../database/user_blacklist_source_db');

function accountKeyOf(gameId, account) {
    return `${String(gameId || '1').trim() || '1'}::${String(account || '').trim()}`;
}

const FACE_VERIFY_HOLD_MS = 12 * 3600 * 1000;

function toDateTimeText(input = new Date()) {
    const d = input instanceof Date ? input : new Date(input);
    const p = (n) => String(n).padStart(2, '0');
    return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
}

function detectFaceVerifyPlatforms(row = {}) {
    const prd = row && typeof row.channel_prd_info === 'object' ? row.channel_prd_info : {};
    const checks = [
        { platform: 'uhaozu', reason: String((((prd || {}).uhaozu || {}).audit_reason) || (((prd || {}).uhaozu || {}).reason) || '').trim() },
        { platform: 'zuhaowang', reason: String((((prd || {}).zuhaowang || {}).exception_msg) || '').trim() },
        { platform: 'uuzuhao', reason: String((((prd || {}).uuzuhao || {}).reason) || '').trim() }
    ];
    return checks.filter((item) => isFaceVerifyReason(item.reason));
}

async function reconcilePlatformFaceVerifyBlacklist(userId, rows = [], logger = console) {
    const uid = Number(userId || 0);
    const list = Array.isArray(rows) ? rows : [];
    if (!uid || list.length === 0) return { touched: 0, activated: 0, released: 0 };

    const accounts = list
        .map((row) => ({
            game_account: String((row && row.game_account) || '').trim(),
            game_id: String((row && row.game_id) || '1').trim() || '1',
            game_name: String((row && row.game_name) || 'WZRY').trim() || 'WZRY'
        }))
        .filter((item) => item.game_account);
    const existingRows = await listBlacklistSourcesByUserAndAccounts(uid, accounts, { active_only: false });
    const existingMap = new Map(existingRows
        .filter((row) => String((row && row.source) || '').trim() === PLATFORM_FACE_VERIFY_SOURCE)
        .map((row) => [accountKeyOf(row.game_id, row.game_account), row]));

    let activated = 0;
    let released = 0;
    for (const row of list) {
        const acc = String((row && row.game_account) || '').trim();
        const gid = String((row && row.game_id) || '1').trim() || '1';
        const gname = String((row && row.game_name) || 'WZRY').trim() || 'WZRY';
        if (!acc) continue;
        const key = accountKeyOf(gid, acc);
        const hits = detectFaceVerifyPlatforms(row);
        const existing = existingMap.get(key) || null;
        if (hits.length > 0) {
            const expireAt = toDateTimeText(Date.now() + FACE_VERIFY_HOLD_MS);
            await upsertSourceAndReconcile(uid, {
                game_account: acc,
                game_id: gid,
                game_name: gname
            }, PLATFORM_FACE_VERIFY_SOURCE, {
                active: true,
                reason: '人脸识别',
                priority: 800,
                expire_at: expireAt,
                detail: {
                    platforms: hits.map((item) => item.platform),
                    reasons: hits.map((item) => ({ platform: item.platform, reason: item.reason })),
                    hold_hours: 12,
                    refreshed_at: toDateTimeText()
                }
            }, {
                operator: 'system',
                desc: 'reconcile face verify blacklist by product sync'
            });
            activated += 1;
            continue;
        }
        if (!existing || !existing.active) continue;
        const expireAtText = String(existing.expire_at || '').trim();
        if (!expireAtText) continue;
        const expireTs = Date.parse(expireAtText.replace(' ', 'T'));
        if (!Number.isFinite(expireTs) || expireTs > Date.now()) continue;
        await upsertSourceAndReconcile(uid, {
            game_account: acc,
            game_id: gid,
            game_name: gname
        }, PLATFORM_FACE_VERIFY_SOURCE, {
            active: false,
            reason: '人脸识别',
            priority: 800,
            expire_at: expireAtText,
            detail: {
                ...((existing && existing.detail && typeof existing.detail === 'object') ? existing.detail : {}),
                released_at: toDateTimeText(),
                release_by: 'ttl_12h'
            }
        }, {
            operator: 'system',
            desc: 'release face verify blacklist by ttl'
        });
        released += 1;
    }
    const touched = activated + released;
    if (touched > 0) {
        logger.log(`[FaceVerifyBL] user_id=${uid} activated=${activated} released=${released}`);
    }
    return { touched, activated, released };
}

function applyActionResultToRows(rows = [], actions = []) {
    if (!Array.isArray(rows) || rows.length === 0) return;
    if (!Array.isArray(actions) || actions.length === 0) return;
    const rowMap = new Map();
    for (const row of rows) {
        const acc = String((row && row.game_account) || '').trim();
        const gid = String((row && row.game_id) || '1').trim() || '1';
        if (!acc) continue;
        rowMap.set(accountKeyOf(gid, acc), row);
    }
    for (const act of actions) {
        const type = String((act && act.type) || '').trim();
        const acc = String((act && act.item && act.item.account) || '').trim();
        const gid = String((act && act.item && act.item.game_id) || '1').trim() || '1';
        if (!type || !acc) continue;
        const row = rowMap.get(accountKeyOf(gid, acc));
        if (!row) continue;
        const cs = row.channel_status && typeof row.channel_status === 'object' ? row.channel_status : {};
        if (type === 'off_y') cs.uuzuhao = '下架';
        else if (type === 'on_y') cs.uuzuhao = '上架';
        else if (type === 'off_u') cs.uhaozu = '下架';
        else if (type === 'on_u' || type === 'on_u_modify') cs.uhaozu = '上架';
        else if (type === 'off_z') cs.zuhaowang = '下架';
        else if (type === 'on_z') cs.zuhaowang = '上架';
        row.channel_status = cs;
    }
}

async function reportPipelineStage(options = {}, stage = '', progressText = '', extra = {}) {
    const fn = options && typeof options.onStage === 'function' ? options.onStage : null;
    if (!fn) return;
    await fn({
        stage: String(stage || '').trim(),
        progress_text: String(progressText || '').trim(),
        ...extra
    });
}

async function runFullUserPipeline(user, options = {}) {
    const logger = options.logger || console;
    const actionEnabled = options.actionEnabled === undefined ? true : Boolean(options.actionEnabled);
    const readOnly = options.readOnly === undefined ? false : Boolean(options.readOnly);
    const uid = Number(user && user.id || 0);
    const userAccount = String(user && user.account || '').trim();
    if (!uid) {
        return { ok: false, errors: ['invalid_user'], stage: 'validate' };
    }

    let rows = [];
    let blacklistSet = new Set();
    let blacklistReasonMap = {};
    const actionResult = { actions: [], errors: [], planned: 0 };
    let syncOut = null;
    let notifyResult = null;
    let accounts = [];
    const nonFatalErrors = [];
    try {
        logger.log(`[User] 开始处理 user_id=${uid} account=${userAccount}`);
        await reportPipelineStage(options, 'sync_accounts', '同步商品账号');
        syncOut = await syncUserAccountsByAuth(uid);
        await reportPipelineStage(options, 'load_accounts', '加载账号快照');
        rows = await listAllUserGameAccountsByUser(uid);

        try {
            await reportPipelineStage(options, 'reconcile_order_rules', '收敛订单规则');
            const reconcile = await reconcileOrderNOffByUser(user);
            logger.log(`[Order3Off] user_id=${uid} reconcile=${JSON.stringify(reconcile)}`);
        } catch (e) {
            const msg = String(e && e.message ? e.message : e || 'reconcile_failed');
            nonFatalErrors.push(`order3off_reconcile_failed:${msg}`);
            logger.warn(`[Order3Off] 收敛失败 user_id=${uid}: ${msg}`);
        }

        try {
            await reportPipelineStage(options, 'reconcile_face_verify', '收敛人脸识别规则');
            const faceRet = await reconcilePlatformFaceVerifyBlacklist(uid, rows, logger);
            if (faceRet && Number(faceRet.touched || 0) > 0) {
                logger.log(`[FaceVerifyBL] user_id=${uid} result=${JSON.stringify(faceRet)}`);
            }
        } catch (e) {
            const msg = String(e && e.message ? e.message : e || 'face_verify_reconcile_failed');
            nonFatalErrors.push(`face_verify_reconcile_failed:${msg}`);
            logger.warn(`[FaceVerifyBL] 收敛失败 user_id=${uid}: ${msg}`);
        }

        await reportPipelineStage(options, 'load_blacklist', '加载黑名单状态');
        blacklistSet = await loadUserBlacklistSet(uid);
        blacklistReasonMap = await loadUserBlacklistReasonMap(uid);

        await reportPipelineStage(options, 'execute_actions', '执行上下架动作');
        const actionOut = await executeUserActionsIfNeeded({
            user,
            rows,
            blacklistSet,
            actionEnabled,
            readOnly
        });
        actionResult.actions = Array.isArray(actionOut && actionOut.actions) ? actionOut.actions : [];
        actionResult.errors = Array.isArray(actionOut && actionOut.errors) ? actionOut.errors : [];
        actionResult.planned = Number(actionOut && actionOut.planned || 0);
        applyActionResultToRows(rows, actionResult.actions);

        await reportPipelineStage(options, 'refresh_facts', '刷新订单事实');
        accounts = rows.map((r) => toReportAccountFromUserGameRow(r, blacklistSet, blacklistReasonMap));
        await fillTodayOrderCounts(uid, accounts);
        await fillRentingOrderFacts(uid, accounts);
        await reportPipelineStage(options, 'probe_and_notify', '探测在线并发送通知');
        const onlineProbe = await probeProdOnlineStatus(user, accounts, { logger, include_rows: true });
        const onlineTagMap = {};
        for (const row of (onlineProbe && Array.isArray(onlineProbe.probe_rows) ? onlineProbe.probe_rows : [])) {
            const acc = String((row && row.account) || '').trim();
            if (!acc) continue;
            onlineTagMap[acc] = String((row && row.online_tag) || '').trim().toUpperCase();
        }
        for (const one of accounts) {
            const acc = String((one && one.account) || '').trim();
            one.online_tag = String(onlineTagMap[acc] || '').trim();
        }
        triggerProdStatusGuard(user, accounts, { logger, snapshot: onlineProbe });
        const recentActions = await buildRecentActionsForUser(uid, { limit: 8 });
        const syncAnomalies = await listUserSyncAnomaliesForReport(uid);
        const payload = buildPayloadForOneUser(accounts, {
            report_owner: String(user.name || user.account || '').trim(),
            recentActions,
            master_total: rows.length,
            sync_anomalies: syncAnomalies
        });

        notifyResult = await notifyUserByPayload(user, payload);
        if (!notifyResult.ok) {
            const errs = Array.isArray(notifyResult.errors) ? notifyResult.errors : [notifyResult.reason || 'notify_failed'];
            return {
                ok: false,
                stage: 'notify',
                sync: syncOut,
                accounts_count: accounts.length,
                action_result: actionResult,
                errors: errs,
                non_fatal_errors: nonFatalErrors
            };
        }

        logger.log(`[User] 处理完成 user_id=${uid} accounts=${accounts.length}`);
        await reportPipelineStage(options, 'done', '任务完成', { finished: true });
        return {
            ok: true,
            stage: 'done',
            sync: syncOut,
            accounts_count: accounts.length,
            action_result: actionResult,
            notify_result: notifyResult,
            non_fatal_errors: nonFatalErrors
        };
    } catch (e) {
        const msg = `sync_failed: ${String(e && e.message ? e.message : e || 'pipeline_failed')}`;
        logger.error(`[User] 处理失败 user_id=${uid}: ${msg}`);
        return {
            ok: false,
            stage: 'pipeline',
            sync: syncOut,
            accounts_count: accounts.length,
            action_result: actionResult,
            errors: [msg],
            non_fatal_errors: nonFatalErrors
        };
    }
}

module.exports = {
    runFullUserPipeline,
    reconcilePlatformFaceVerifyBlacklist,
    detectFaceVerifyPlatforms
};
