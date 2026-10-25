'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'rent-hour-ratio-calculation-'));
for (const [key, name] of Object.entries({
    MAIN_DB_FILE_PATH: 'main.db', RUNTIME_DB_FILE_PATH: 'runtime.db',
    PRICE_DB_FILE_PATH: 'price.db', ORDER_DB_FILE_PATH: 'order.db', STATS_DB_FILE_PATH: 'stats.db'
})) process.env[key] = path.join(directory, name);

const { normalizeRatios, roundRatio, resolvePackageRatios } = require('../price/channel_package_ratio');
const { saveUserChannelPackageRatio } = require('../database/user_channel_package_ratio_db');
const { applyDailyPolicy } = require('../price/daily_price_policy');
const adapters = ['uhaozu', 'uuzuhao', 'zuhaowang'].map(channel => require(`../price/channel_adapters/${channel}_price_adapter`));
const [uhaozu, youyou, zuhaowang] = adapters;
const hourPrices = [2, 2.2, 2.4, 2.6];
const policies = [{ mode: 'follow' }, { mode: 'flat' }, { mode: 'decrease', factors: [1, 0.95, 0.9, 0.85] }];
const money = (key, value) => Number(value.toFixed(2));
const build = (adapter, prices, ratios, options) => (adapter.buildTierPricesByRatios || adapter.buildTierPrices)(prices, ratios, options);

async function main() {
    assert.strictEqual(roundRatio('1.23456'), 1.2346);
    assert.strictEqual(roundRatio(Infinity), 0);
    assert.deepStrictEqual(normalizeRatios(), {});
    assert.deepStrictEqual(normalizeRatios({ package_keys: 'hour' }), {});
    const hourly = { package_keys: ['hour'], package_labels: { hour: '时租' } };
    for (const legacy of [{}, [], null, 'old']) {
        assert.deepStrictEqual(normalizeRatios(hourly, legacy, { strict: true }), { hour: 1 });
    }
    assert.deepStrictEqual(normalizeRatios(hourly, { hour: '1.23456', ignored: 5 }, { strict: true }), { hour: 1.2346 });
    for (const invalid of [0, -1, '', null, 'bad', NaN, Infinity, 0.000001]) {
        assert.throws(() => normalizeRatios(hourly, { hour: invalid }, { strict: true }), error =>
            error.code === 'PRICE_PACKAGE_RATIO_INVALID' && error.message.includes('时租'));
    }
    assert.deepStrictEqual(normalizeRatios(hourly, { hour: 'bad' }), { hour: 0 });
    assert.throws(() => normalizeRatios({ package_keys: ['missing'] }, {}, { strict: true }), /missing/);
    for (const factors of [[0, 1, 1, 1], [0.9, 1, 0.8, 0.7], [0.000001, 0.000001, 0.000001, 0.000001]]) {
        assert.throws(() => applyDailyPolicy([], uhaozu.capability, { factors }, money), /日租系数/);
    }
    assert.throws(() => applyDailyPolicy([], uhaozu.capability, { mode: 'flat' }, money), /不完整/);

    for (const adapter of adapters) {
        const original = build(adapter, hourPrices, adapter.default_ratios);
        const normalize = adapter.normalizePackagePrice || money;
        const dayKey = adapter.channel === 'uhaozu' ? 'day' : 'p24';
        for (const ratio of [0.9, 1, 1.2]) {
            const ratios = { ...adapter.default_ratios, hour: ratio };
            const raw = build(adapter, [...hourPrices, 99], ratios);
            assert.strictEqual(raw.length, 4);
            assert.deepStrictEqual(raw.map(tier => tier.prices.hour), hourPrices.map(value => normalize('hour', value * ratio)));
            for (const key of adapter.package_keys.filter(key => key !== 'hour')) {
                assert.deepStrictEqual(raw.map(tier => tier.prices[key]), original.map(tier => tier.prices[key]),
                    `${adapter.channel} ${key} must not multiply by the hourly ratio`);
            }
            for (const policy of policies) {
                const actual = applyDailyPolicy(raw, adapter.capability, policy, normalize);
                const reference = applyDailyPolicy(original, adapter.capability, policy, normalize);
                assert.deepStrictEqual(actual.map(tier => tier.prices.hour), raw.map(tier => tier.prices.hour));
                for (const key of adapter.package_keys.filter(key => key !== 'hour')) {
                    assert.deepStrictEqual(actual.map(tier => tier.prices[key]), reference.map(tier => tier.prices[key]),
                        `${adapter.channel}/${policy.mode}/${key} preserves the original package base`);
                }
                if (policy.mode === 'flat') assert(actual.every(tier => tier.prices[dayKey] === reference[0].prices[dayKey]));
            }
            assert.strictEqual(ratios.hour, ratio, 'calculators must not mutate the saved ratios');
        }
        const { hour, ...legacyRatios } = adapter.default_ratios;
        assert.deepStrictEqual(build(adapter, hourPrices, legacyRatios), original, 'old ratios without hour retain multiplier 1');
        assert.strictEqual(build(adapter, [0.01], { ...adapter.default_ratios, hour: 0.0001 })[0].prices.hour, 0);
        assert.strictEqual(build(adapter, [2], { ...adapter.default_ratios, hour: 0 })[0].prices.hour, 0);
        assert.strictEqual(build(adapter, [NaN], adapter.default_ratios)[0].prices.hour, 0);
        assert.strictEqual(adapter.isAvailable(), false);
        assert.strictEqual(adapter.isAvailable({ channel_prd_info: 'invalid' }), false);
        assert.strictEqual(adapter.isAvailable({ channel_prd_info: { [adapter.channel]: { prd_id: 'product' } } }), true);
        assert.strictEqual(adapter.samePriceSet({}, {}), true);
        assert.strictEqual(adapter.samePriceSet({ hour: 1 }, { hour: 2 }), false);
        assert.strictEqual(adapter.pickCurrentPriceSet().complete, false);

        const defaultConfig = await resolvePackageRatios(101, adapter.capability);
        assert.strictEqual(defaultConfig.ratios.hour, 1);
        assert.strictEqual(defaultConfig.source, 'default');
        await saveUserChannelPackageRatio(101, { channel: adapter.channel,
            ratios: { ...adapter.default_ratios, hour: 1.2 }, daily_policy: { mode: 'follow' } });
        const resolved = await adapter.resolveTierPrices({ user_id: 101, rule: { prices: hourPrices } });
        assert.strictEqual(resolved.ready, true);
        assert.strictEqual(resolved.baseline.ratios.hour, 1.2);
        assert.strictEqual(resolved.baseline_status, 'saved');
        assert.strictEqual(resolved.baseline_version, 1);
        assert.deepStrictEqual(resolved.tiers.map(tier => tier.prices.hour), [2.4, 2.64, 2.88, 3.12]);
        assert.strictEqual((await adapter.resolveTierPrices({ user_id: 101, rule: { prices: [] } })).ready, false);
        const tooSmall = await adapter.resolveTierPrices({ user_id: 101, rule: { prices: [0.001, 0.001, 0.001, 0.001] } });
        assert.strictEqual(tooSmall.ready, false);
        assert.notStrictEqual(tooSmall.error, '');
        assert.notStrictEqual(tooSmall.reason, '');

        await saveUserChannelPackageRatio(102, { channel: adapter.channel, ratios: legacyRatios });
        assert.strictEqual((await resolvePackageRatios(102, adapter.capability)).ratios.hour, 1);
        await saveUserChannelPackageRatio(103, { channel: adapter.channel, ratios: { ...adapter.default_ratios, hour: 0 } });
        await assert.rejects(() => resolvePackageRatios(103, adapter.capability), error => error.code === 'PRICE_PACKAGE_RATIO_INVALID');
    }

    assert.deepStrictEqual(uhaozu.buildRatios(), { hour: 0, night: 0, day: 0, week: 0 });
    assert.deepStrictEqual(uhaozu.buildTierPrices([2], { hour: 2, night: 8, day: 12, week: 70 }),
        [{ tier: 1, prices: { hour: 2, night: 8, day: 12, week: 70 } }], 'legacy inferred-ratio path remains unchanged');
    assert.strictEqual(uhaozu.shouldForcePublish('rule_saved'), true);
    assert.strictEqual(uhaozu.shouldForcePublish('package_ratio_saved'), true);
    assert.strictEqual(uhaozu.shouldForcePublish('order_sync'), false);
    assert.strictEqual(youyou.shouldForcePublish(), true);
    assert.strictEqual(zuhaowang.shouldForcePublish(), true);
    assert.strictEqual(youyou.buildPriceSet(2).p2, 3.6);
    assert.strictEqual(youyou.buildPriceSet(2, { hour: 1.2 }).p2, 0);
    assert.strictEqual(zuhaowang.buildPriceSet(3.25, { ...zuhaowang.default_ratios, hour: 1.2 }).p168, 102.3);
    assert.strictEqual(zuhaowang.buildPriceSet(3.25, { ...zuhaowang.default_ratios, hour: 1.2 }).hour, 3.9);

    const expensiveHour = { ...zuhaowang.default_ratios, hour: 1000 };
    const onlyDay = zuhaowang.buildTierPrices(hourPrices, expensiveHour, { rent_mode: 'day_only' });
    assert.deepStrictEqual(onlyDay.map(tier => tier.prices.hour), hourPrices, 'disabled hourly package retains the real daily calculation base');
    assert.strictEqual(zuhaowang.buildPriceSet(0.01, { ...expensiveHour, hour: 0.0001 }, { rent_mode: 'day_only' }).hour, 0.01);
    assert.strictEqual(zuhaowang.buildPriceSet(2, expensiveHour, { rent_mode: ' day_only ' }).hour, 2);
    const bogusHour = onlyDay.map(tier => ({ ...tier, prices: { ...tier.prices, hour: 100000 } }));
    for (const policy of policies) {
        const dayResult = applyDailyPolicy(bogusHour, zuhaowang.capability, policy, zuhaowang.normalizePackagePrice, { rent_mode: 'day_only' });
        assert.strictEqual(dayResult[0].prices.p24, 9);
    }
    assert.throws(() => applyDailyPolicy(bogusHour, zuhaowang.capability, { mode: 'flat' }, zuhaowang.normalizePackagePrice), /冲突/);
    const hourOnly = zuhaowang.buildTierPrices(hourPrices, expensiveHour, { rent_mode: 'hour_only' });
    assert.strictEqual(applyDailyPolicy(hourOnly, zuhaowang.capability, { mode: 'flat' }, zuhaowang.normalizePackagePrice,
        { rent_mode: 'hour_only' }), hourOnly, 'hour-only accounts do not apply or validate disabled daily packages');
    assert.throws(() => applyDailyPolicy(hourOnly, zuhaowang.capability, { mode: 'invalid' }, zuhaowang.normalizePackagePrice,
        { rent_mode: 'hour_only' }), /不支持/);
    const badLong = bogusHour.map(tier => ({ ...tier, prices: { ...tier.prices, p72: 0.1 } }));
    assert.throws(() => applyDailyPolicy(badLong, zuhaowang.capability, { mode: 'flat' }, zuhaowang.normalizePackagePrice,
        { rent_mode: 'day_only' }), /冲突/, 'active day packages still receive the original conflict checks');
    const otherChannel = uhaozu.buildTierPricesByRatios(hourPrices, { ...uhaozu.default_ratios, hour: 100 });
    assert.throws(() => applyDailyPolicy(otherChannel, uhaozu.capability, { mode: 'flat' }, money,
        { rent_mode: 'day_only' }), /冲突/, 'ZHW rent modes must not bypass other channels');

    await saveUserChannelPackageRatio(104, { channel: 'zuhaowang', ratios: expensiveHour, daily_policy: { mode: 'flat' } });
    for (const mode of ['day_only', 'hour_only']) {
        const resolved = await zuhaowang.resolveTierPrices({ user_id: 104, rule: { prices: hourPrices },
            account_row: { channel_prd_info: { zuhaowang: { rent_mode: mode } } } });
        assert.strictEqual(resolved.ready, true);
        assert.strictEqual(resolved.tiers[0].prices.hour, mode === 'day_only' ? 2 : 2000);
    }
    await assert.rejects(() => zuhaowang.resolveTierPrices({ user_id: 104, rule: { prices: hourPrices },
        account_row: { channel_prd_info: { zuhaowang: { rent_mode: 'hour_and_day' } } } }), /冲突/);

    const publisherFile = require.resolve('../price/price_publish_service');
    const cachedPublisher = require.cache[publisherFile];
    require.cache[publisherFile] = { id: publisherFile, filename: publisherFile, loaded: true, exports:
        Object.fromEntries(['Uhaozu', 'Uuzuhao', 'Zuhaowang'].map(name => [`publish${name}AccountPriceSetByUser`,
            async (userId, input, options) => ({ ok: true, userId, input, options, name })])) };
    try {
        for (const adapter of adapters) {
            const result = await adapter.publish(5, { fixture: true }, { stub: true });
            assert.strictEqual(result.ok, true);
            assert.strictEqual(result.userId, 5);
            assert.deepStrictEqual(result.input, { fixture: true });
            assert.deepStrictEqual(result.options, { stub: true });
        }
    } finally {
        if (cachedPublisher) require.cache[publisherFile] = cachedPublisher;
        else delete require.cache[publisherFile];
    }
    console.log('[PASS] independent hourly ratios: three channels, four tiers, all daily policies, ZHW active modes, legacy defaults and isolated resolution');
}

main().catch(error => { console.error(error); process.exitCode = 1; });
