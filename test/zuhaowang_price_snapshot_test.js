'use strict';

const assert = require('assert');
const { pickZuhaowangSyncPriceFields: pick, mergeZuhaowangSyncPriceSnapshot: merge } = require('../product/zuhaowang_price_snapshot');

assert.deepStrictEqual(pick(), {});
assert.deepStrictEqual(pick({ raw: null }), {});
assert.deepStrictEqual(pick({ raw: 'bad' }), {});
assert.deepStrictEqual(pick({ hourPrice: 2, rent_mode: 'day_only', raw: {
    hourPrice: 99, p24Price: 12, price_template_type: 1, token: 'private', roleName: 'old'
} }), { hourPrice: 2, p24Price: 12, rent_mode: 'day_only', price_template_type: 1 });

const old = Object.freeze({ prd_id: 'same', hourPrice: 3.6, p24Price: 18, p72Price: 54, p168Price: 126,
    rent_mode: 'hour_and_day', price_template_type: '1', exception_msg: 'old-error', raw_status: 1,
    remark: 'old-name', unrelated: 'must-not-survive' });
const incoming = Object.freeze({ prd_id: 'same', exception_msg: '', raw_status: -1, remark: 'new-name' });
assert.deepStrictEqual(merge(old, incoming), { ...incoming, hourPrice: 3.6, p24Price: 18, p72Price: 54,
    p168Price: 126, rent_mode: 'hour_and_day', price_template_type: '1' });
assert.deepStrictEqual(merge(), {});
assert.deepStrictEqual(merge(old, { prd_id: 'new' }), { prd_id: 'new' });
assert.deepStrictEqual(merge(old, {}), {});
assert.deepStrictEqual(merge({}, incoming), incoming);
assert.deepStrictEqual(merge({ hourPrice: 99 }, incoming), incoming);
assert.strictEqual(merge({ data_id: ' same ', obtainPrice: '2.40' }, incoming).hourPrice, 2.4);

for (const [canonical, alias, base] of [['hourPrice', 'hour_price', 3.6], ['p24Price', 'p24_price', 18],
    ['p72Price', 'p72_price', 54], ['p168Price', 'p168_price', 126]]) {
    for (const value of [undefined, null, '', ' ', 'bad', NaN, Infinity, 0, -1, false, true, [], {}]) {
        const result = merge(old, { prd_id: 'same', [canonical]: value });
        assert.strictEqual(result[canonical], base, `${canonical} should retain on ${String(value)}`);
        assert.strictEqual(Object.hasOwn(result, alias), false);
        assert.strictEqual(Object.hasOwn(merge({}, { prd_id: 'same', [canonical]: value }), canonical), false);
    }
    for (const value of [1, 99, '2.50']) {
        const result = merge(old, { prd_id: 'same', [alias]: value });
        assert.strictEqual(result[canonical], Number(value));
        assert.strictEqual(Object.hasOwn(result, alias), false, 'canonical old value must not shadow a new alias');
    }
}
assert.strictEqual(merge(old, { prd_id: 'same', obtainPrice: '1.9' }).hourPrice, 1.9);
assert.strictEqual(merge(old, { prd_id: 'same', hourPrice: null, hour_price: 2.1 }).hourPrice, 2.1);
assert.strictEqual(merge({ prd_id: 'same', hourPrice: 'invalid', obtainPrice: '3' }, incoming).hourPrice, 3);
assert.strictEqual(merge({ prd_id: 'same', hourPrice: 0 }, incoming).hourPrice, undefined);
assert.strictEqual(merge(old, { prd_id: 'new', hourPrice: 2 }).hourPrice, 2);
const dayOnly = merge(old, { prd_id: 'same', rent_mode: 'day_only', hourPrice: 0, p24Price: 20 });
assert.strictEqual(dayOnly.hourPrice, 3.6, 'day-only sync must retain the hourly calculation basis');
assert.strictEqual(dayOnly.p24Price, 20);
assert.strictEqual(dayOnly.rent_mode, 'day_only');
assert.strictEqual(merge(old, { prd_id: 'same', price_template_type: '2' }).price_template_type, '2');
assert.strictEqual(old.hourPrice, 3.6);
assert.strictEqual(incoming.exception_msg, '');
console.log('[PASS] zuhaowang price snapshot: missing/invalid/new prices, aliases, identity changes, day-only and fresh status');
