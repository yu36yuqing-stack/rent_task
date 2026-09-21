#!/usr/bin/env node
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const assert = require('assert');

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'rent-zhw-price-publish-'));
process.env.MAIN_DB_FILE_PATH = path.join(tempDir, 'rent_robot.db');
process.env.PRICE_DB_FILE_PATH = path.join(tempDir, 'rent_robot_price.db');

const { upsertUserGameAccount, listUserGameAccounts } = require('../database/user_game_account_db');
const { listPricePublishItemLogsByBatchId } = require('../database/price_publish_log_db');
const {
    publishZuhaowangAccountPriceSetByUser,
    _internals
} = require('../price/price_publish_service');

function template({ dayOnly = false, hour = 2, p24 = 9, p72 = 27, p168 = 63 } = {}) {
    return {
        accountInfo: { priceTemplateType: 1, dataId: '90779045' },
        selfTemplate: {
            shortRent: {
                isOpen: !dayOnly,
                obtainPrice: hour,
                discounts: [{
                    key: '3',
                    selected: 1,
                    details: [
                        { hour: 2, discount: 9.5 },
                        { hour: 3, discount: 9 },
                        { hour: 5, discount: 8 }
                    ]
                }],
                minHours: [{ hour: 1, isChecked: false }, { hour: 2, isChecked: true }]
            },
            longRent: {
                isOpen: true,
                grades: [
                    { key: '24', currentObtainPrice: p24, minObtainPrice: 0.5, maxObtainPrice: 500 },
                    { key: '72', currentObtainPrice: p72, minObtainPrice: 0.9, maxObtainPrice: 1500 },
                    { key: '168', currentObtainPrice: p168, minObtainPrice: 2.1, maxObtainPrice: 3500 }
                ]
            }
        },
        pricePlanInfo: null
    };
}

async function seed(userId, account, dataId) {
    await upsertUserGameAccount({
        user_id: userId,
        game_id: '1',
        game_name: 'WZRY',
        game_account: account,
        account_remark: account,
        channel_prd_info: {
            zuhaowang: { prd_id: dataId, game_id: '1104466820' }
        }
    });
}

async function main() {
    const auth = { token_yuanbao: 'x', device_id: 'd', package_name: 'com.duodian.merchant' };
    await seed(91, 'hour-day', '90680414');
    const requests = [];
    const hourDayTemplates = [
        template(),
        template({ hour: 2.2, p24: 9.9, p72: 29.7, p168: 69.3 })
    ];
    const hourDay = await publishZuhaowangAccountPriceSetByUser(91, {
        game_id: '1', game_name: 'WZRY', game_account: 'hour-day', tier: 2,
        prices: { hour: 2.2, p24: 9.9, p72: 29.7, p168: 69.3 },
        trigger_source: 'order_finished_changed', force_publish: true
    }, {
        auth,
        get_template: async () => hourDayTemplates.shift(),
        change_template: async (params) => { requests.push(params); return { code: '0', desc: 'ok' }; }
    });
    assert.strictEqual(hourDay.ok, true);
    assert.strictEqual(hourDay.rent_mode, 'hour_and_day');
    assert.strictEqual(requests[0].selfTemplate.shortRent.obtainPrice, 2.2);
    assert.strictEqual(requests[0].selfTemplate.shortRent.minHour, 2);
    assert.deepStrictEqual(requests[0].selfTemplate.longRent.grades, [
        { obtainPrice: '9.9', key: '24' },
        { obtainPrice: '29.7', key: '72' },
        { obtainPrice: '69.3', key: '168' }
    ]);
    const hourLogs = await listPricePublishItemLogsByBatchId(hourDay.batch_id);
    assert.strictEqual(hourLogs[0].request_data.target_prices.p72, 29.7);
    assert.strictEqual(hourLogs[0].response_data.verification_status, 'full');

    await seed(92, 'day-only', 'old-id');
    const getCalls = [];
    let afterRefreshRead = 0;
    const dayOnly = await publishZuhaowangAccountPriceSetByUser(92, {
        game_id: '1', game_name: 'WZRY', game_account: 'day-only', tier: 1,
        prices: { hour: 2.2, p24: 11, p72: 22, p168: 44 },
        force_publish: true
    }, {
        auth,
        resolve_data_id: async (account, gameId) => {
            assert.strictEqual(account, 'day-only');
            assert.strictEqual(gameId, 1104466820);
            return '90779045';
        },
        get_template: async (dataId) => {
            getCalls.push(dataId);
            if (dataId === 'old-id') throw new Error('dataId失效');
            afterRefreshRead += 1;
            return afterRefreshRead === 1
                ? template({ dayOnly: true, hour: 3.4, p24: 15, p72: 27, p168: 63 })
                : template({ dayOnly: true, hour: 3.4, p24: 11, p72: 22, p168: 44 });
        },
        change_template: async (params) => {
            requests.push(params);
            throw new Error('网络超时');
        }
    });
    assert.strictEqual(dayOnly.ok, true);
    assert.strictEqual(dayOnly.rent_mode, 'day_only');
    assert.strictEqual(dayOnly.recovered_after_modify_error, true);
    assert.deepStrictEqual(getCalls, ['old-id', '90779045', '90779045']);
    const dayRequest = requests[1];
    assert.strictEqual(dayRequest.dataId, '90779045');
    assert.strictEqual(dayRequest.selfTemplate.shortRent, null);
    assert.strictEqual(dayRequest.selfTemplate.longRent.grades[0].obtainPrice, '11');
    const rows = await listUserGameAccounts(92, 1, 10);
    assert.strictEqual(rows.list[0].channel_prd_info.zuhaowang.prd_id, '90779045');
    assert.strictEqual(rows.list[0].channel_prd_info.zuhaowang.rent_mode, 'day_only');

    const normalized = _internals.normalizeZuhaowangTemplate(template({ dayOnly: true }));
    assert.strictEqual(normalized.rent_mode, 'day_only');
    assert.strictEqual(normalized.prices.hour, 0);
    assert.strictEqual(_internals.sameZuhaowangActivePriceSet(
        { hour: 99, p24: 9, p72: 27, p168: 63 },
        normalized.prices,
        'day_only'
    ), true);
    assert.throws(() => _internals.normalizeZuhaowangTargetPriceSet({ hour: 2 }), /p24/);
    assert.throws(() => _internals.normalizeZuhaowangTemplate({
        accountInfo: { priceTemplateType: 1 },
        selfTemplate: {}
    }), /未开启/);
    assert.throws(() => _internals.normalizeZuhaowangTemplate({
        accountInfo: { priceTemplateType: 2 },
        selfTemplate: { shortRent: { isOpen: true }, longRent: { isOpen: false } }
    }), /自主定价/);
    const rangeTemplate = _internals.normalizeZuhaowangTemplate(template());
    assert.throws(() => _internals.buildZuhaowangChangePriceParams('1', rangeTemplate, {
        hour: 2, p24: 0.1, p72: 27, p168: 63
    }), /不能低于/);

    console.log('[OK] zuhaowang_price_publish_service_smoke_test passed');
}

main().catch((error) => {
    console.error('[FAIL] zuhaowang_price_publish_service_smoke_test failed:', error);
    process.exit(1);
});
