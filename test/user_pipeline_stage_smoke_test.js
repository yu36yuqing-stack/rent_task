#!/usr/bin/env node
'use strict';

const assert = require('assert');

async function main() {
    const productMod = require('../product/product');
    const prodGuardMod = require('../product/prod_status_guard');
    const orderRuleMod = require('../order/service/order_rule_service');
    const userMod = require('../user/user');
    const actionMod = require('../action_engine/action_engine');
    const reportMod = require('../report/report_rent_status');

    const originals = {
        syncUserAccountsByAuth: productMod.syncUserAccountsByAuth,
        listAllUserGameAccountsByUser: productMod.listAllUserGameAccountsByUser,
        triggerProdStatusGuard: prodGuardMod.triggerProdStatusGuard,
        probeProdOnlineStatus: prodGuardMod.probeProdOnlineStatus,
        reconcileOrderNOffByUser: orderRuleMod.reconcileOrderNOffByUser,
        loadUserBlacklistSet: userMod.loadUserBlacklistSet,
        loadUserBlacklistReasonMap: userMod.loadUserBlacklistReasonMap,
        executeUserActionsIfNeeded: actionMod.executeUserActionsIfNeeded,
        fillTodayOrderCounts: reportMod.fillTodayOrderCounts,
        fillRentingOrderFacts: reportMod.fillRentingOrderFacts,
        buildRecentActionsForUser: reportMod.buildRecentActionsForUser,
        buildPayloadForOneUser: reportMod.buildPayloadForOneUser,
        notifyUserByPayload: reportMod.notifyUserByPayload,
        listUserSyncAnomaliesForReport: reportMod.listUserSyncAnomaliesForReport,
        toReportAccountFromUserGameRow: reportMod.toReportAccountFromUserGameRow
    };

    productMod.syncUserAccountsByAuth = async () => ({ ok: true, platforms: ['stub'], errors: [] });
    productMod.listAllUserGameAccountsByUser = async () => ([
        {
            game_account: 'acc_1',
            game_id: '1',
            game_name: 'WZRY',
            channel_status: { uhaozu: '上架中' },
            channel_prd_info: {}
        }
    ]);
    orderRuleMod.reconcileOrderNOffByUser = async () => ({ ok: true });
    userMod.loadUserBlacklistSet = async () => new Set();
    userMod.loadUserBlacklistReasonMap = async () => ({});
    actionMod.executeUserActionsIfNeeded = async () => ({ actions: [], errors: [], planned: 0 });
    reportMod.toReportAccountFromUserGameRow = (row) => ({
        account: row.game_account,
        game_account: row.game_account,
        game_id: row.game_id,
        game_name: row.game_name
    });
    reportMod.fillTodayOrderCounts = async () => {};
    reportMod.fillRentingOrderFacts = async () => {};
    prodGuardMod.probeProdOnlineStatus = async () => ({
        probe_rows: [{ account: 'acc_1', online_tag: 'ONLINE' }]
    });
    prodGuardMod.triggerProdStatusGuard = () => {};
    reportMod.buildRecentActionsForUser = async () => [];
    reportMod.listUserSyncAnomaliesForReport = async () => [];
    reportMod.buildPayloadForOneUser = () => ({ ok: true });
    reportMod.notifyUserByPayload = async () => ({ ok: true });

    delete require.cache[require.resolve('../pipeline/user_pipeline')];
    const { runFullUserPipeline } = require('../pipeline/user_pipeline');

    const stages = [];
    const out = await runFullUserPipeline(
        { id: 1001, account: 'stage_user', name: 'Stage User', status: 'enabled' },
        {
            logger: { log() {}, warn() {}, error() {} },
            actionEnabled: false,
            readOnly: true,
            onStage: async (patch = {}) => {
                stages.push(String(patch.stage || '').trim());
            }
        }
    );

    assert.strictEqual(out.ok, true, 'pipeline 应成功');
    assert.deepStrictEqual(stages, [
        'sync_accounts',
        'load_accounts',
        'reconcile_order_rules',
        'reconcile_face_verify',
        'load_blacklist',
        'execute_actions',
        'refresh_facts',
        'probe_and_notify',
        'done'
    ], '阶段上报顺序不符合预期');

    Object.assign(productMod, {
        syncUserAccountsByAuth: originals.syncUserAccountsByAuth,
        listAllUserGameAccountsByUser: originals.listAllUserGameAccountsByUser
    });
    Object.assign(prodGuardMod, {
        triggerProdStatusGuard: originals.triggerProdStatusGuard,
        probeProdOnlineStatus: originals.probeProdOnlineStatus
    });
    Object.assign(orderRuleMod, {
        reconcileOrderNOffByUser: originals.reconcileOrderNOffByUser
    });
    Object.assign(userMod, {
        loadUserBlacklistSet: originals.loadUserBlacklistSet,
        loadUserBlacklistReasonMap: originals.loadUserBlacklistReasonMap
    });
    Object.assign(actionMod, {
        executeUserActionsIfNeeded: originals.executeUserActionsIfNeeded
    });
    Object.assign(reportMod, {
        fillTodayOrderCounts: originals.fillTodayOrderCounts,
        fillRentingOrderFacts: originals.fillRentingOrderFacts,
        buildRecentActionsForUser: originals.buildRecentActionsForUser,
        buildPayloadForOneUser: originals.buildPayloadForOneUser,
        notifyUserByPayload: originals.notifyUserByPayload,
        listUserSyncAnomaliesForReport: originals.listUserSyncAnomaliesForReport,
        toReportAccountFromUserGameRow: originals.toReportAccountFromUserGameRow
    });
    delete require.cache[require.resolve('../pipeline/user_pipeline')];

    console.log('[PASS] user_pipeline_stage_smoke_test');
}

main().catch((err) => {
    console.error(`[FAIL] user_pipeline_stage_smoke_test: ${err.message}`);
    process.exit(1);
});
