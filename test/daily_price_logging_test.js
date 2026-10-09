'use strict';

const assert = require('assert');
const { _internal: { dailyCalculationLog, publishVerificationLog } } = require('../price/price_ladder_reconcile_service');
const { applyDailyPolicy } = require('../price/daily_price_policy');
const { getPriceChannelAdapter } = require('../price/channel_adapters/channel_price_registry');

for (const channel of ['uhaozu', 'zuhaowang', 'uuzuhao']) {
    const adapter = getPriceChannelAdapter(channel);
    const key = channel === 'uhaozu' ? 'day' : 'p24';
    const rule = { prices: [2, 2.1, 2.2, 2.3] };
    const build = adapter.buildTierPricesByRatios || adapter.buildTierPrices;
    const original = build(rule.prices, adapter.default_ratios);
    const normalize = adapter.normalizePackagePrice || ((key, value) => Number(value.toFixed(2)));
    for (const mode of ['follow', 'flat', 'decrease']) {
        const policy = { mode, factors: [0.95, 0.9, 0.85, 0.85] };
        const tiers = applyDailyPolicy(original, adapter.capability, policy, normalize);
        for (const desired of tiers) {
            assert.deepStrictEqual(dailyCalculationLog(adapter, rule, {
                baseline: { ratios: adapter.default_ratios, daily_policy: policy }
            }, desired), {
                mode, daily_price_key: key, first_tier_hour_price: 2,
                target_tier_hour_price: desired.prices.hour, daily_ratio: adapter.default_ratios[key],
                base_daily_price: original[0].prices[key],
                calculation_base: mode === 'follow' ? 'target_tier_hour' : 'first_tier_daily',
                factor: mode === 'decrease' ? policy.factors[desired.tier - 1] : 1,
                target_daily_price: desired.prices[key],
                ...(channel === 'uhaozu' && mode === 'decrease' ? {
                    night_calculation: {
                        calculation_base: 'first_tier_night', night_ratio: 4,
                        base_night_price: 8, factor: policy.factors[desired.tier - 1],
                        target_night_price: desired.prices.night
                    }
                } : {})
            });
        }
    }
}
const u = getPriceChannelAdapter('uhaozu');
const z = getPriceChannelAdapter('zuhaowang');
const y = getPriceChannelAdapter('uuzuhao');
const target = { hour: 2, night: 8, day: 12, week: 70 };
const returned = { rentalByHour: 2, rentalByNight: 8, rentalByDay: 12, rentalByWeek: 70, token: 'never-log-me' };
const full = publishVerificationLog(u, { ok: true, prices: returned }, target);
assert.deepStrictEqual(full, {
    verification_status: 'full', verified_price_keys: ['hour', 'night', 'day', 'week'], readback_prices: target
});
assert(!JSON.stringify(full).includes('never-log-me'));
assert.strictEqual(publishVerificationLog(u, { ok: true }, target).verification_status, 'unknown');
assert.strictEqual(publishVerificationLog(u, { ok: true, verification_status: 'full', prices: { ...returned, rentalByDay: 11 } }, target).verification_status, 'unknown',
    'claimed full success cannot override a mismatched returned price');
assert.strictEqual(publishVerificationLog(u, { ok: true, verification_status: 'partial', prices: returned }, target).verification_status, 'partial');
const malformed = publishVerificationLog(u, { ok: true, prices: { rentalByHour: '2', rentalByNight: NaN, rentalByDay: 0, rentalByWeek: Infinity } }, target);
assert.deepStrictEqual(malformed.readback_prices, {});
assert.strictEqual(malformed.verification_status, 'unknown');
assert.strictEqual(publishVerificationLog(u, null, target).verification_status, 'failed');
assert.strictEqual(publishVerificationLog(u, { ok: false, prices: returned }, target).verification_status, 'failed');
const zPrices = { hour: 2, p24: 9, p72: 27, p168: 63 };
for (const [mode, keys] of [['day_only', ['p24', 'p72', 'p168']], ['hour_only', ['hour']], ['hour_and_day', ['hour', 'p24', 'p72', 'p168']]]) {
    const prices = Object.fromEntries(keys.map(key => [key, zPrices[key]]));
    const facts = publishVerificationLog(z, { ok: true, prices, rent_mode: mode }, zPrices);
    assert.strictEqual(facts.verification_status, 'full');
    assert.deepStrictEqual(facts.verified_price_keys, keys);
    assert.deepStrictEqual(facts.readback_prices, prices);
}
const yy = publishVerificationLog(y, { ok: true, prices: { hour: 2, p24: 28.8 }, verification_status: 'partial' }, { hour: 2, p24: 28.8 });
assert.deepStrictEqual(yy, { verification_status: 'partial', verified_price_keys: ['hour'], readback_prices: { hour: 2 } });
assert.strictEqual(publishVerificationLog(y, { ok: true, prices: { hour: 2, p24: 28.8 } }, { hour: 2, p24: 28.8 }).verification_status, 'partial');
assert.strictEqual(publishVerificationLog({ package_keys: [] }, { ok: true }, {}).verification_status, 'unknown');
assert.strictEqual(publishVerificationLog(null, { ok: true }, {}).verification_status, 'unknown');
assert.strictEqual(dailyCalculationLog(null, {}, {}, {}), null);
console.log('[PASS] daily calculation evidence, verification scope, malformed metadata and safe log whitelisting');
