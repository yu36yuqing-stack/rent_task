'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'rent-daily-publish-'));
for (const name of ['MAIN', 'PRICE', 'RUNTIME', 'ORDER', 'STATS']) {
    process.env[`${name}_DB_FILE_PATH`] = path.join(temp, `${name}.db`);
}
const { upsertUserGameAccount } = require('../database/user_game_account_db');
const { saveUserChannelPackageRatio } = require('../database/user_channel_package_ratio_db');
const { listPricePublishItemLogsByBatchId } = require('../database/price_publish_log_db');
const { getPriceChannelAdapter } = require('../price/channel_adapters/channel_price_registry');
const { _internal: { publishVerificationLog } } = require('../price/price_ladder_reconcile_service');
const {
    publishUhaozuAccountPriceSetByUser,
    publishUuzuhaoAccountPriceSetByUser,
    publishZuhaowangAccountPriceSetByUser
} = require('../price/price_publish_service');

function template(prices, dayOnly) {
    return {
        accountInfo: { priceTemplateType: 1, dataId: 'z' },
        selfTemplate: {
            shortRent: { isOpen: !dayOnly, obtainPrice: prices.hour,
                discounts: [], minHours: [{ hour: 2, isChecked: true }] },
            longRent: { isOpen: true, grades: ['p24', 'p72', 'p168'].map((key, i) => ({
                key: String([24, 72, 168][i]), currentObtainPrice: prices[key],
                minObtainPrice: 0.1, maxObtainPrice: 1000
            })) }
        }
    };
}

async function main() {
    const uid = 92;
    await upsertUserGameAccount({ user_id: uid, game_id: '1', game_name: 'WZRY',
        game_account: 'daily-publish', channel_prd_info: {
            uhaozu: { prd_id: 'u' }, uuzuhao: { prd_id: 'y', minRentHour: 2 },
            zuhaowang: { prd_id: 'z' }
        } });
    for (const scenario of ['flat', 'decrease', 'discounted']) {
        const mode = scenario === 'discounted' ? 'decrease' : scenario;
        const policy = scenario === 'discounted' ? { mode, factors: [0.95, 0.9, 0.85, 0.85] } : { mode };
        for (const channel of ['uhaozu', 'uuzuhao', 'zuhaowang']) {
            const adapter = getPriceChannelAdapter(channel);
            await saveUserChannelPackageRatio(uid, { channel, ratios: adapter.default_ratios,
                daily_policy: policy });
            const resolved = await adapter.resolveTierPrices({ user_id: uid,
                rule: { prices: [2, 2.1, 2.2, 2.3] } });
            const target = resolved.tiers[3].prices;
            const dailyKey = channel === 'uhaozu' ? 'day' : 'p24';
            const build = adapter.buildTierPricesByRatios || adapter.buildTierPrices;
            const base = build([2], adapter.default_ratios)[0].prices[dailyKey];
            const normalize = adapter.normalizePackagePrice || ((key, value) => Number(value.toFixed(2)));
            const expectedDaily = normalize(dailyKey, base * (scenario === 'discounted' ? 0.85 : mode === 'flat' ? 1 : 0.9));
            assert.strictEqual(target[dailyKey], expectedDaily);
            if (channel === 'uhaozu') {
                assert.strictEqual(target.night, mode === 'decrease'
                    ? normalize('night', 8 * (policy.factors ? policy.factors[3] : 0.9)) : 9.2);
                assert.strictEqual(target.hour, 2.3);
                assert.strictEqual(target.week, 80.5);
            }
            const input = { game_id: '1', game_name: 'WZRY', game_account: 'daily-publish',
                prices: target, tier: 4, force_publish: true, trigger_source: 'package_ratio_saved' };
            let result;
            if (channel === 'uhaozu') {
                let current = { rentalByHour: 2, rentalByNight: 8, rentalByDay: 12, rentalByWeek: 70 };
                result = await publishUhaozuAccountPriceSetByUser(uid, input, {
                    auth: { cookie: 'fixture' },
                    query_goods: async () => ({ info: current }),
                    modify_goods: async (id, payload) => {
                        assert.strictEqual(id, 'u');
                        assert.strictEqual(payload.info.rentalByDay, expectedDaily);
                        assert.strictEqual(payload.info.rentalByHour, target.hour);
                        assert.strictEqual(payload.info.rentalByNight, target.night);
                        assert.strictEqual(payload.info.rentalByWeek, target.week);
                        current = { ...payload.info };
                        return { payload, result: { success: true } };
                    }
                });
            } else if (channel === 'uuzuhao') {
                let hourPrice = 2;
                result = await publishUuzuhaoAccountPriceSetByUser(uid, input, {
                    auth: { app_key: 'fixture', app_secret: 'fixture' },
                    query_product: async () => ({ productId: 'y', hourPrice, minRentHour: 2 }),
                    modify_price: async (id, payload) => {
                        assert.strictEqual(id, 'y');
                        assert.strictEqual(payload.p24Price, expectedDaily);
                        assert.strictEqual(payload.hourPrice, target.hour);
                        for (const key of ['p2', 'p3', 'p5', 'p7', 'p9', 'p10', 'p168']) {
                            assert.strictEqual(payload[`${key}Price`], target[key]);
                            const first = build([2],adapter.default_ratios)[0].prices[key];
                            const expected = mode === 'decrease' && key !== 'p168'
                                ? normalize(key,first * (policy.factors ? policy.factors[3] : 0.9))
                                : normalize(key,2.3 * adapter.default_ratios[key]);
                            assert.strictEqual(payload[`${key}Price`],expected);
                        }
                        hourPrice = payload.hourPrice;
                        return { raw: { code: 0 }, hour_price: hourPrice };
                    },
                    readback_delays_ms: [0]
                });
                assert.strictEqual(result.verification_status, 'partial',
                    'missing remote package readback must not be reported as full verification');
            } else {
                const dayOnly = mode === 'decrease';
                let current = { hour: 2, p24: 9, p72: 27, p168: 63 };
                result = await publishZuhaowangAccountPriceSetByUser(uid, input, {
                    auth: { token_yuanbao: 'fixture' },
                    get_template: async () => template(current, dayOnly),
                    change_template: async payload => {
                        assert.strictEqual(payload.dataId, 'z');
                        assert.deepStrictEqual(payload.selfTemplate.longRent.grades, [
                            { obtainPrice: String(expectedDaily), key: '24' },
                            { obtainPrice: String(target.p72), key: '72' },
                            { obtainPrice: String(target.p168), key: '168' }
                        ]);
                        assert.strictEqual(payload.selfTemplate.shortRent === null, dayOnly);
                        current = { ...target };
                        return { code: '0', desc: 'ok' };
                    }
                });
                assert.strictEqual(result.rent_mode, dayOnly ? 'day_only' : 'hour_and_day');
            }
            assert.strictEqual(result.ok, true, JSON.stringify(result));
            const verification = publishVerificationLog(adapter, result, target);
            assert.strictEqual(verification.verification_status, channel === 'uuzuhao' ? 'partial' : 'full');
            if (channel === 'uuzuhao') {
                assert.deepStrictEqual(verification.verified_price_keys, ['hour']);
                assert.deepStrictEqual(verification.readback_prices, { hour: target.hour });
            } else {
                assert.strictEqual(verification.readback_prices[dailyKey], expectedDaily);
                if (channel === 'zuhaowang' && result.rent_mode === 'day_only') {
                    assert(!verification.verified_price_keys.includes('hour'));
                }
            }
            const logs = await listPricePublishItemLogsByBatchId(result.batch_id);
            assert.strictEqual(logs.length, 1);
            assert.strictEqual(logs[0].publish_status, 'success');
            if (channel !== 'uuzuhao') assert.strictEqual(logs[0].price_after_day, expectedDaily);
            else assert.strictEqual(logs[0].request_data.target_prices.p24, expectedDaily);
        }
    }
    console.log('[PASS] daily policy -> 3 real publishers with stub APIs: request prices, logs, readback and ZHW rental modes');
}

main().catch(error => { console.error(error); process.exitCode = 1; });
