#!/usr/bin/env node
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const assert = require('assert');

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'rent-package-ratio-'));
process.env.MAIN_DB_FILE_PATH = path.join(tempDir, 'rent_robot.db');
process.env.ORDER_DB_FILE_PATH = path.join(tempDir, 'rent_robot_order.db');
process.env.PRICE_DB_FILE_PATH = path.join(tempDir, 'rent_robot_price.db');
process.env.RUNTIME_DB_FILE_PATH = path.join(tempDir, 'rent_robot_runtime.db');
process.env.ORDER_COUNT_TRACE = 'false';

const { upsertUserGameAccount } = require('../database/user_game_account_db');
const { upsertAccountPriceLadderRule } = require('../database/account_price_ladder_rule_db');
const { getAccountPriceLadderRuntime } = require('../database/account_price_ladder_runtime_db');
const {
    getUserChannelPackageRatio,
    listUserChannelPackageRatios,
    saveUserChannelPackageRatio,
    _internal: dbInternal
} = require('../database/user_channel_package_ratio_db');
const {
    getPackageRatioSettingsByUser,
    savePackageRatioSettingsByUser
} = require('../price/package_ratio_service');
const { normalizeRatios, roundRatio } = require('../price/channel_package_ratio');

async function expectReject(fn, pattern) {
    let hit = null;
    try {
        await fn();
    } catch (error) {
        hit = error;
    }
    assert(hit);
    assert(pattern.test(String(hit.message || hit)));
    return hit;
}

async function main() {
    const userId = 81;
    await upsertUserGameAccount({
        user_id: userId,
        game_id: '1',
        game_name: 'WZRY',
        game_account: 'ratio-account',
        account_remark: '倍率账号',
        channel_prd_info: {
            uhaozu: { prd_id: 'u-ratio', rentalByHour: 2, rentalByNight: 8, rentalByDay: 12, rentalByWeek: 70 },
            zuhaowang: { prd_id: '90779045', game_id: '1104466820' },
            uuzuhao: { prd_id: 'y-ratio', hourPrice: 2, minRentHour: 2 }
        }
    });
    await upsertAccountPriceLadderRule(userId, {
        game_id: '1',
        game_name: 'WZRY',
        game_account: 'ratio-account',
        prices: [2, 2.2, 2.5, 3]
    }, { expected_version: 0 });

    const defaults = await getPackageRatioSettingsByUser(userId);
    assert.deepStrictEqual(defaults.channels.map((item) => item.channel), ['uhaozu', 'zuhaowang', 'uuzuhao']);
    assert.strictEqual(defaults.channels.find((item) => item.channel === 'uhaozu').ratios.week, 35);
    assert.strictEqual(defaults.channels.find((item) => item.channel === 'zuhaowang').ratios.p72, 13.5);
    assert.deepStrictEqual(defaults.channels.find((item) => item.channel === 'zuhaowang').price_rules.p24, {
        decimals: 1, rounding: 'truncate'
    });
    assert.strictEqual(defaults.channels.find((item) => item.channel === 'uuzuhao').ratios.p168, 100.8);
    assert(defaults.channels.every((item) => item.source === 'default' && item.version === 0));

    const saved = await savePackageRatioSettingsByUser(userId, {
        channel: 'zuhaowang',
        ratios: { hour: 9, p24: 5, p72: 12, p168: 28 },
        expected_version: 0
    });
    assert.deepStrictEqual(saved.ratios, { hour: 1, p24: 5, p72: 12, p168: 28 });
    assert.strictEqual(saved.version, 1);
    assert.deepStrictEqual(saved.price_rules.p168, { decimals: 1, rounding: 'truncate' });
    assert.strictEqual(saved.queued_count, 1);
    const runtime = await getAccountPriceLadderRuntime(userId, '1', 'ratio-account', 'zuhaowang');
    assert.strictEqual(runtime.status, 'pending');
    assert.strictEqual(runtime.trigger_source, 'package_ratio_saved');

    const reloaded = await getPackageRatioSettingsByUser(userId);
    assert.strictEqual(reloaded.channels.find((item) => item.channel === 'zuhaowang').source, 'saved');
    assert.strictEqual((await getUserChannelPackageRatio(userId, 'zuhaowang')).ratios.p24, 5);
    assert.strictEqual((await listUserChannelPackageRatios(userId)).length, 1);
    assert.deepStrictEqual(await listUserChannelPackageRatios(0), []);
    assert.strictEqual(await getUserChannelPackageRatio(0, 'zuhaowang'), null);
    const updatedDirect = await saveUserChannelPackageRatio(userId, {
        channel: 'zuhaowang',
        ratios: { hour: 1, p24: 5.1, p72: 12.1, p168: 28.1 }
    }, { expected_version: 1, desc: 'direct update' });
    assert.strictEqual(updatedDirect.version, 2);
    assert.strictEqual(updatedDirect.desc, 'direct update');
    const conflict = await expectReject(() => savePackageRatioSettingsByUser(userId, {
        channel: 'zuhaowang',
        ratios: { p24: 5, p72: 12, p168: 28 },
        expected_version: 0
    }), /已变化/);
    assert.strictEqual(conflict.code, 'PRICE_LADDER_VERSION_CONFLICT');
    await expectReject(() => savePackageRatioSettingsByUser(userId, {
        channel: 'missing', ratios: {}
    }), /不支持/);
    await expectReject(() => savePackageRatioSettingsByUser(userId, {
        channel: 'uhaozu', ratios: { night: 0, day: 6, week: 35 }, expected_version: 0
    }), /倍率/);
    await expectReject(() => saveUserChannelPackageRatio(0, {}), /user_id/);
    await expectReject(() => saveUserChannelPackageRatio(userId, {}), /channel/);
    await expectReject(() => saveUserChannelPackageRatio(userId, {
        channel: 'x', ratios: {}
    }, { expected_version: -1 }), /expected_version/);
    assert.deepStrictEqual(normalizeRatios({
        package_keys: ['hour', 'day'],
        package_labels: { day: '包天' },
        default_ratios: { hour: 1, day: 6 }
    }, {}, { strict: true }), { hour: 1, day: 6 });
    assert.strictEqual(roundRatio(1.23456), 1.2346);
    assert.deepStrictEqual(dbInternal.parseRatios('bad'), {});
    assert.strictEqual(dbInternal.toRatioConfig({}).version, 0);
    assert(/\d{4}-\d{2}-\d{2}/.test(dbInternal.nowText()));

    console.log('[OK] package_ratio_service_smoke_test passed');
}

main().catch((error) => {
    console.error('[FAIL] package_ratio_service_smoke_test failed:', error);
    process.exit(1);
});
