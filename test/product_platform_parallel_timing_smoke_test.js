#!/usr/bin/env node
'use strict';

const assert = require('assert');

function sleep(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
}

async function main() {
    const zhwApi = require('../zuhaowang/zuhaowang_api');
    const uhzApi = require('../uhaozu/uhaozu_api');
    const yyzApi = require('../uuzuhao/uuzuhao_api');
    const authDb = require('../database/user_platform_auth_db');
    const accountDb = require('../database/user_game_account_db');
    const orderRuleService = require('../order/service/order_rule_service');
    const orderQueryService = require('../order/service/order_query_service');
    const anomalyDb = require('../database/product_sync_anomaly_db');

    const originals = {
        getGoodsList: zhwApi.getGoodsList,
        collectUhaozuData: uhzApi.collectUhaozuData,
        collectYoupinData: yyzApi.collectYoupinData,
        listUserPlatformAuth: authDb.listUserPlatformAuth,
        upsertUserGameAccount: accountDb.upsertUserGameAccount,
        listUserGameAccounts: accountDb.listUserGameAccounts,
        isUserGameAccountManuallyDeleted: accountDb.isUserGameAccountManuallyDeleted,
        releaseOrderCooldownBlacklistByUser: orderRuleService.releaseOrderCooldownBlacklistByUser,
        listLinkedOrderAccountsByUser: orderQueryService.listLinkedOrderAccountsByUser,
        upsertOpenProductSyncAnomaly: anomalyDb.upsertOpenProductSyncAnomaly,
        resolveOpenProductSyncAnomaly: anomalyDb.resolveOpenProductSyncAnomaly
    };

    const starts = {};
    const rows = [];

    zhwApi.getGoodsList = async () => {
        starts.zuhaowang = Date.now();
        await sleep(80);
        return [{
            id: 'zhw_prd_1',
            account: 'acc_1',
            status: '上架',
            gameId: '1',
            gameName: 'WZRY',
            roleName: 'role z'
        }];
    };
    uhzApi.collectUhaozuData = async () => {
        starts.uhaozu = Date.now();
        await sleep(80);
        return {
            data: [{
                id: 'uhz_prd_1',
                account: 'acc_1',
                status: '上架',
                raw: { gameId: '1', gameName: 'WZRY', gameRoleName: 'role u' }
            }]
        };
    };
    yyzApi.collectYoupinData = async () => {
        starts.uuzuhao = Date.now();
        await sleep(80);
        return {
            data: [{
                id: 'yyz_prd_1',
                account: 'acc_1',
                status: '上架',
                raw: { gameId: '1', gameName: 'WZRY', roleName: 'role y' }
            }]
        };
    };
    authDb.listUserPlatformAuth = async () => ([
        { platform: 'uhaozu', auth_payload: { cookie: 'u' }, auth_status: 'valid' },
        { platform: 'zuhaowang', auth_payload: { cookie: 'z' }, auth_status: 'valid' },
        { platform: 'uuzuhao', auth_payload: { app_key: 'k', app_secret: 's' }, auth_status: 'valid' }
    ]);
    accountDb.upsertUserGameAccount = async (row) => {
        rows.push(row);
        return row;
    };
    accountDb.listUserGameAccounts = async () => ({ list: rows });
    accountDb.isUserGameAccountManuallyDeleted = async () => false;
    orderRuleService.releaseOrderCooldownBlacklistByUser = async () => ({ skipped: true, reason: 'stub' });
    orderQueryService.listLinkedOrderAccountsByUser = async () => [];
    anomalyDb.upsertOpenProductSyncAnomaly = async (_uid, platform) => ({ platform });
    anomalyDb.resolveOpenProductSyncAnomaly = async () => null;

    delete require.cache[require.resolve('../product/product')];
    const { syncUserAccountsByAuth } = require('../product/product');
    const out = await syncUserAccountsByAuth(1001);

    assert.strictEqual(out.ok, true, '同步应成功');
    assert.deepStrictEqual(out.platforms, ['uhaozu', 'zuhaowang', 'uuzuhao'], '平台顺序应保持授权顺序');
    assert.strictEqual(out.upserted, 1, '同一账号应合并后只 upsert 一次');
    assert.ok(out.timing && Number(out.timing.platform_pull_total_ms) >= 0, '应返回平台拉取总耗时');
    assert.ok(out.platform_timing && out.platform_timing.uhaozu && out.platform_timing.zuhaowang && out.platform_timing.uuzuhao, '应返回各平台耗时');
    const startedAtList = Object.values(starts);
    assert.strictEqual(startedAtList.length, 3, '三个平台都应启动拉取');
    assert.ok(Math.max(...startedAtList) - Math.min(...startedAtList) < 50, '三个平台应并发启动，而不是串行启动');

    Object.assign(zhwApi, { getGoodsList: originals.getGoodsList });
    Object.assign(uhzApi, { collectUhaozuData: originals.collectUhaozuData });
    Object.assign(yyzApi, { collectYoupinData: originals.collectYoupinData });
    Object.assign(authDb, { listUserPlatformAuth: originals.listUserPlatformAuth });
    Object.assign(accountDb, {
        upsertUserGameAccount: originals.upsertUserGameAccount,
        listUserGameAccounts: originals.listUserGameAccounts,
        isUserGameAccountManuallyDeleted: originals.isUserGameAccountManuallyDeleted
    });
    Object.assign(orderRuleService, { releaseOrderCooldownBlacklistByUser: originals.releaseOrderCooldownBlacklistByUser });
    Object.assign(orderQueryService, { listLinkedOrderAccountsByUser: originals.listLinkedOrderAccountsByUser });
    Object.assign(anomalyDb, {
        upsertOpenProductSyncAnomaly: originals.upsertOpenProductSyncAnomaly,
        resolveOpenProductSyncAnomaly: originals.resolveOpenProductSyncAnomaly
    });
    delete require.cache[require.resolve('../product/product')];

    console.log('[PASS] product_platform_parallel_timing_smoke_test');
}

main().catch((err) => {
    console.error(`[FAIL] product_platform_parallel_timing_smoke_test: ${err.message}`);
    process.exit(1);
});
