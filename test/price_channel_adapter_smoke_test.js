#!/usr/bin/env node
'use strict';

const assert = require('assert');
const uhaozu = require('../price/channel_adapters/uhaozu_price_adapter');
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
        }
    }
};

assert.strictEqual(getPriceChannelAdapter('uhaozu'), uhaozu);
assert.strictEqual(getPriceChannelAdapter('uuzuhao'), uuzuhao);
assert.strictEqual(getPriceChannelAdapter('missing'), null);
assert.deepStrictEqual(listEnabledPriceChannelAdapters(account).map((item) => item.channel), ['uhaozu', 'uuzuhao']);
assert.deepStrictEqual(listEnabledPriceChannelAdapters({ channel_prd_info: {} }), []);
assert.strictEqual(listPriceChannelCapabilities().find((item) => item.channel === 'zuhaowang').enabled, false);

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
