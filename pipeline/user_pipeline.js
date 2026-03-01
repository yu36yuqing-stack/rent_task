const {
    toReportAccountFromUserGameRow,
    fillTodayOrderCounts,
    buildRecentActionsForUser,
    buildPayloadForOneUser,
    notifyUserByPayload
} = require('../report/report_rent_status');
const { syncUserAccountsByAuth, listAllUserGameAccountsByUser } = require('../product/product');
const { triggerProdStatusGuard, probeProdOnlineStatus } = require('../product/prod_status_guard');
const { reconcileOrder3OffBlacklistByUser } = require('../order/order');
const { loadUserBlacklistSet, loadUserBlacklistReasonMap } = require('../user/user');
const { executeUserActionsIfNeeded } = require('../action_engine/action_engine');

function applyActionResultToRows(rows = [], actions = []) {
    if (!Array.isArray(rows) || rows.length === 0) return;
    if (!Array.isArray(actions) || actions.length === 0) return;
    const rowMap = new Map();
    for (const row of rows) {
        const acc = String((row && row.game_account) || '').trim();
        if (!acc) continue;
        rowMap.set(acc, row);
    }
    for (const act of actions) {
        const type = String((act && act.type) || '').trim();
        const acc = String((act && act.item && act.item.account) || '').trim();
        if (!type || !acc) continue;
        const row = rowMap.get(acc);
        if (!row) continue;
        const cs = row.channel_status && typeof row.channel_status === 'object' ? row.channel_status : {};
        if (type === 'off_y') cs.uuzuhao = '下架';
        else if (type === 'on_y') cs.uuzuhao = '上架';
        else if (type === 'off_u') cs.uhaozu = '下架';
        else if (type === 'on_u') cs.uhaozu = '上架';
        else if (type === 'off_z') cs.zuhaowang = '下架';
        else if (type === 'on_z') cs.zuhaowang = '上架';
        row.channel_status = cs;
    }
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
        syncOut = await syncUserAccountsByAuth(uid);
        rows = await listAllUserGameAccountsByUser(uid);

        try {
            const reconcile = await reconcileOrder3OffBlacklistByUser(user);
            logger.log(`[Order3Off] user_id=${uid} reconcile=${JSON.stringify(reconcile)}`);
        } catch (e) {
            const msg = String(e && e.message ? e.message : e || 'reconcile_failed');
            nonFatalErrors.push(`order3off_reconcile_failed:${msg}`);
            logger.warn(`[Order3Off] 收敛失败 user_id=${uid}: ${msg}`);
        }

        blacklistSet = await loadUserBlacklistSet(uid);
        blacklistReasonMap = await loadUserBlacklistReasonMap(uid);

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

        accounts = rows.map((r) => toReportAccountFromUserGameRow(r, blacklistSet, blacklistReasonMap));
        await fillTodayOrderCounts(uid, accounts);
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
        const payload = buildPayloadForOneUser(accounts, {
            report_owner: String(user.name || user.account || '').trim(),
            recentActions
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
    runFullUserPipeline
};
