#!/usr/bin/env node
'use strict';

const assert = require('assert');
const uhaozu = require('../price/channel_adapters/uhaozu_price_adapter');
const zuhaowang = require('../price/channel_adapters/zuhaowang_price_adapter');
const uuzuhao = require('../price/channel_adapters/uuzuhao_price_adapter');
const {
    getPriceChannelAdapter,
    listEnabledPriceChannelAdapters,
    listPriceChannelCapabilities
} = require('../price/channel_adapters/channel_price_registry');
const { _internals: productInternal } = require('../product/product');

const account = {
    channel_prd_info: {
        uhaozu: {
            prd_id: 'u-1',
            rentalByHour: 2,
            rentalByNight: 8,
            rentalByDay: 12,
            rentalByWeek: 70
        },
        uuzuhao: {
            prd_id: 'y-1',
            hourPrice: 2,
            minRentHour: 3
        },
        zuhaowang: {
            prd_id: 'z-1',
            game_id: '1104466820',
            rent_mode: 'day_only',
            p24Price: 9,
            p72Price: 27,
            p168Price: 63
        }
    }
};

assert.strictEqual(getPriceChannelAdapter('uhaozu'), uhaozu);
assert.strictEqual(getPriceChannelAdapter('uuzuhao'), uuzuhao);
assert.strictEqual(getPriceChannelAdapter('zuhaowang'), zuhaowang);
assert.strictEqual(getPriceChannelAdapter('missing'), null);
assert.deepStrictEqual(listEnabledPriceChannelAdapters(account).map((item) => item.channel), ['uhaozu', 'zuhaowang', 'uuzuhao']);
assert.deepStrictEqual(listEnabledPriceChannelAdapters({ channel_prd_info: {} }), []);
const zuhaowangCapability = listPriceChannelCapabilities().find((item) => item.channel === 'zuhaowang');
assert.strictEqual(zuhaowangCapability.enabled, true);
assert.strictEqual(zuhaowangCapability.label, '租号王');
assert.deepStrictEqual(zuhaowangCapability.package_keys, ['hour', 'p24', 'p72', 'p168']);
assert.deepStrictEqual(zuhaowangCapability.price_rules.p24, { decimals: 1, rounding: 'truncate' });

assert.deepStrictEqual(uhaozu.pickCurrentPriceSet(account).prices, {
    hour: 2,
    night: 8,
    day: 12,
    week: 70
});
assert.deepStrictEqual(uhaozu.buildTierPrices([2, 3, 4, 5], {
    hour: 2,
    night: 8,
    day: 12,
    week: 70
})[1].prices, {
    hour: 3,
    night: 12,
    day: 18,
    week: 105
});
assert.strictEqual(uhaozu.samePriceSet({ hour: 2, night: 8, day: 12, week: 70 }, {
    hour: 2,
    night: 8,
    day: 12,
    week: 70
}), true);
assert.strictEqual(uhaozu.shouldForcePublish('rule_saved'), true);
assert.strictEqual(uhaozu.shouldForcePublish('daily_reset'), false);
assert.strictEqual(uhaozu.shouldForcePublish('package_ratio_saved'), true);

assert.deepStrictEqual(zuhaowang.pickCurrentPriceSet(account), {
    goods_id: 'z-1',
    prices: { hour: 0, p24: 9, p72: 27, p168: 63 },
    complete: true,
    comparable_keys: ['p24', 'p72', 'p168'],
    rent_mode: 'day_only'
});
assert.deepStrictEqual(zuhaowang.buildPriceSet(2), { hour: 2, p24: 9, p72: 27, p168: 63 });
assert.deepStrictEqual(zuhaowang.buildPriceSet(2.5, { hour: 1, p24: 5.5, p72: 15, p168: 40 }), {
    hour: 2.5, p24: 13.7, p72: 37.5, p168: 100
});
assert.strictEqual(zuhaowang.normalizePackagePrice('p24', 13.75), 13.7);
assert.strictEqual(zuhaowang.normalizePackagePrice('p24', 13.2), 13.2);
assert.strictEqual(zuhaowang.buildTierPrices([2, 3, 4, 5]).length, 4);
assert.strictEqual(zuhaowang.samePriceSet(
    { hour: 99, p24: 9, p72: 27, p168: 63 },
    { hour: 0, p24: 9, p72: 27, p168: 63 }
), true);

assert.deepStrictEqual(uuzuhao.pickCurrentPriceSet(account), {
    goods_id: 'y-1',
    prices: { hour: 2 },
    complete: true,
    comparable_keys: ['hour'],
    min_rent_hour: 3
});
assert.deepStrictEqual(uuzuhao.buildPriceSet(2), {
    hour: 2,
    p2: 3.6,
    p3: 4.8,
    p5: 7,
    p7: 9.8,
    p9: 12.6,
    p10: 14,
    p24: 28.8,
    p168: 201.6
});
assert.strictEqual(uuzuhao.buildTierPrices([2, 3, 4, 5]).length, 4);
assert.deepStrictEqual(uuzuhao.capability.package_labels, {
    hour: '时租',
    p2: '2小时',
    p3: '3小时',
    p5: '5小时',
    p7: '7小时',
    p9: '9小时',
    p10: '10小时',
    p24: '24小时',
    p168: '168小时'
});
assert.strictEqual(uuzuhao.samePriceSet({ hour: 2, p2: 3.6 }, { hour: 2, p2: 99 }), true);
assert.strictEqual(uuzuhao.shouldForcePublish('daily_reset'), true);
assert.strictEqual(uuzuhao.shouldForcePublish('order_finished_changed'), true);
assert.deepStrictEqual(productInternal.buildPlatformPrdInfo('uuzuhao', {
    id: 'product-price',
    remark: '价格账号',
    raw: {
        gameId: 2,
        productHourRentPrice: 3.2,
        minRentHour: 2,
        productStatus: 1000,
        saleStatus: 1000
    }
}), {
    prd_id: 'product-price',
    game_id: '2',
    remark: '价格账号',
    role_name: '',
    reason: '',
    off_type: '',
    sale_status: 1000,
    product_status: 1000,
    tab_key: '',
    hourPrice: 3.2,
    minRentHour: 2
});

console.log('[OK] price_channel_adapter_smoke_test passed');
