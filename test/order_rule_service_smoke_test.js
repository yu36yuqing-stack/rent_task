#!/usr/bin/env node
'use strict';

const orderModule = require('../order/order');
const cooldownModule = require('../order/order_cooldown');
const ruleService = require('../order/service/order_rule_service');

function fail(msg) {
    console.error(`[FAIL] ${msg}`);
    process.exit(1);
}

function pass(msg) {
    console.log(`[PASS] ${msg}`);
}

function assertEqual(actual, expected, msg) {
    if (actual !== expected) {
        fail(`${msg} | expected=${JSON.stringify(expected)} actual=${JSON.stringify(actual)}`);
    }
    pass(msg);
}

function assertDeepEqual(actual, expected, msg) {
    const a = JSON.stringify(actual);
    const b = JSON.stringify(expected);
    if (a !== b) fail(`${msg} | expected=${b} actual=${a}`);
    pass(msg);
}

async function main() {
    const originalReconcileOrderOffByUser = orderModule.reconcileOrderOffByUser;
    const originalReconcileOrder3OffBlacklistByUser = orderModule.reconcileOrder3OffBlacklistByUser;
    const originalReconcileOrderCooldownEntryByUser = cooldownModule.reconcileOrderCooldownEntryByUser;
    const originalReleaseOrderCooldownBlacklistByUser = cooldownModule.releaseOrderCooldownBlacklistByUser;

    const calls = [];
    orderModule.reconcileOrderOffByUser = async (user, options) => {
        calls.push(['off', user, options]);
        return { source: 'order', kind: 'off' };
    };
    orderModule.reconcileOrder3OffBlacklistByUser = async (user, options) => {
        calls.push(['n_off', user, options]);
        return { source: 'order', kind: 'n_off' };
    };
    cooldownModule.reconcileOrderCooldownEntryByUser = async (userId, options) => {
        calls.push(['cooldown_entry', userId, options]);
        return { source: 'cooldown', kind: 'entry' };
    };
    cooldownModule.releaseOrderCooldownBlacklistByUser = async (userId, options) => {
        calls.push(['cooldown_release', userId, options]);
        return { source: 'cooldown', kind: 'release' };
    };

    try {
        const user = { id: 301, name: 'rule smoke' };
        const options = { trace_id: 'trace-1' };

        assertDeepEqual(await ruleService.reconcileOrderOffByUser(user, options), { source: 'order', kind: 'off' }, '规则服务统一入口透传 reconcileOrderOffByUser');
        assertDeepEqual(await ruleService.reconcileOrderNOffByUser(user, options), { source: 'order', kind: 'n_off' }, '规则服务透传 N 单下架入口');
        assertDeepEqual(await ruleService.reconcileOrder3OffBlacklistByUser(user, options), { source: 'order', kind: 'n_off' }, '兼容导出仍指向 N 单下架入口');
        assertDeepEqual(await ruleService.reconcileOrderCooldownEntryByUser(301, options), { source: 'cooldown', kind: 'entry' }, '规则服务透传冷却期入场入口');
        assertDeepEqual(await ruleService.releaseOrderCooldownBlacklistByUser(301, options), { source: 'cooldown', kind: 'release' }, '规则服务透传冷却期释放入口');

        assertEqual(calls.length, 5, '规则服务应命中全部转发分支');
        assertDeepEqual(calls[0], ['off', user, options], '统一入口转发参数正确');
        assertDeepEqual(calls[1], ['n_off', user, options], 'N 单下架转发参数正确');
        assertDeepEqual(calls[2], ['n_off', user, options], '兼容别名转发参数正确');
        assertDeepEqual(calls[3], ['cooldown_entry', 301, options], '冷却期入场转发参数正确');
        assertDeepEqual(calls[4], ['cooldown_release', 301, options], '冷却期释放转发参数正确');

        console.log('[OrderRuleServiceSmoke] ok');
    } finally {
        orderModule.reconcileOrderOffByUser = originalReconcileOrderOffByUser;
        orderModule.reconcileOrder3OffBlacklistByUser = originalReconcileOrder3OffBlacklistByUser;
        cooldownModule.reconcileOrderCooldownEntryByUser = originalReconcileOrderCooldownEntryByUser;
        cooldownModule.releaseOrderCooldownBlacklistByUser = originalReleaseOrderCooldownBlacklistByUser;
    }
}

main().catch((err) => {
    console.error(`[OrderRuleServiceSmoke] failed: ${err.message}`);
    process.exit(1);
});
