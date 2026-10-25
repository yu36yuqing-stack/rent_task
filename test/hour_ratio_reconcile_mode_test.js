'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'rent-hour-ratio-reconcile-mode-'));
for (const key of ['MAIN', 'RUNTIME', 'ORDER', 'STATS', 'PRICE']) process.env[`${key}_DB_FILE_PATH`] = path.join(temporary, `${key}.db`);
process.env.ORDER_COUNT_TRACE = 'false';
global.fetch = async () => { throw new Error('fixture forbids real network calls'); };
const { upsertUserGameAccount, listUserGameAccounts } = require('../database/user_game_account_db');
const { upsertAccountPriceLadderRule } = require('../database/account_price_ladder_rule_db');
const { getAccountPriceLadderRuntime } = require('../database/account_price_ladder_runtime_db');
const { setPriceLadderFeatureEnabled } = require('../database/price_ladder_feature_config_db');
const { saveUserChannelPackageRatio } = require('../database/user_channel_package_ratio_db');
const { initializePriceLadderRuntimeOnRuleSave, reconcilePendingPriceLaddersByUser } = require('../price/price_ladder_reconcile_service');
const { publishZuhaowangAccountPriceSetByUser } = require('../price/price_publish_service');
const adapter = require('../price/channel_adapters/zuhaowang_price_adapter');
const policy = { mode: 'decrease', factors: [0.9, 0.8, 0.7, 0.6] };
const basis = [2, 2.2, 2.4, 2.6];
const now = new Date('2026-10-25T15:00:00+08:00');
const logger = { log() {}, warn() {} };

function template(mode, prices) {
    return { accountInfo: { priceTemplateType: 1 }, selfTemplate: {
        shortRent: { isOpen: mode !== 'day_only', obtainPrice: prices.hour, minHours: [], discounts: [] },
        longRent: { isOpen: mode !== 'hour_only', grades: ['24', '72', '168'].map(key => ({ key,
            currentObtainPrice: prices[`p${key}`], minObtainPrice: 0.1, maxObtainPrice: 1000 })) }
    } };
}

async function main() {
    for (const [index, [cachedMode, actualMode]] of [['day_only', 'hour_and_day'], ['hour_only', 'day_only']].entries()) {
        const uid = 901 + index;
        const identity = { game_id: '1', game_name: 'WZRY', game_account: `mode-${index}` };
        await upsertUserGameAccount({ user_id: uid, ...identity, channel_prd_info: {
            zuhaowang: { prd_id: `goods-${index}`, rent_mode: cachedMode, hour_basis: 2,
                hourPrice: 1.8, p24Price: 9, p72Price: 27, p168Price: 63 }
        } });
        const rule = await upsertAccountPriceLadderRule(uid, { ...identity, prices: basis }, { expected_version: 0 });
        await saveUserChannelPackageRatio(uid, { channel: 'zuhaowang', ratios: { ...adapter.default_ratios, hour: 1.2 }, daily_policy: policy });
        await setPriceLadderFeatureEnabled(uid, true, { expected_version: 0 });
        await initializePriceLadderRuntimeOnRuleSave(uid, rule, { now });
        let actual = { hour: 1.8, p24: 9, p72: 27, p168: 63 };
        let publisherCalls = 0;
        let modifications = 0;
        const publisher = async (userId, input) => {
            publisherCalls += 1;
            assert.strictEqual(input.base_hour_price, 2);
            assert.strictEqual(input.computed_rent_mode, publisherCalls === 1 ? cachedMode : actualMode);
            return publishZuhaowangAccountPriceSetByUser(userId, input, {
                auth: { token_yuanbao: 'fixture', device_id: 'fixture', package_name: 'fixture' },
                get_template: async () => template(actualMode, actual),
                change_template: async request => {
                    modifications += 1;
                    if (actualMode === 'day_only') assert.strictEqual(request.selfTemplate.shortRent, null);
                    if (request.selfTemplate.shortRent) actual.hour = request.selfTemplate.shortRent.obtainPrice;
                    if (request.selfTemplate.longRent) {
                        for (const grade of request.selfTemplate.longRent.grades) actual[`p${grade.key}`] = Number(grade.obtainPrice);
                    }
                    return { code: '0' };
                }
            });
        };
        const first = await reconcilePendingPriceLaddersByUser(uid, { now, allow_apply: true, publishers: { zuhaowang: publisher }, logger });
        assert.strictEqual(first.failed, 1);
        assert.strictEqual(first.applied, 0);
        assert.strictEqual(modifications, 0, 'stale-mode prices must not reach the platform');
        const failed = await getAccountPriceLadderRuntime(uid, '1', identity.game_account, 'zuhaowang');
        assert.strictEqual(failed.applied_tier, 0);
        assert.strictEqual(failed.retry_count, 1);
        assert.match(failed.last_error, /租赁方式已变化/);
        assert.strictEqual(failed.next_retry_at, '2026-10-25 15:30:00');
        const row = (await listUserGameAccounts(uid, 1, 20)).list[0];
        assert.strictEqual(row.channel_prd_info.zuhaowang.rent_mode, actualMode);
        assert.strictEqual(row.channel_prd_info.zuhaowang.hourPrice, 1.8);
        assert.strictEqual(row.channel_prd_info.zuhaowang.p24Price, 9);

        await reconcilePendingPriceLaddersByUser(uid, { now: new Date(now.getTime() + 5 * 60000), allow_apply: true,
            publishers: { zuhaowang: publisher }, logger });
        assert.strictEqual(publisherCalls, 1, 'mode refresh preserves the existing retry backoff');
        const second = await reconcilePendingPriceLaddersByUser(uid, { now: new Date(now.getTime() + 31 * 60000), allow_apply: true,
            publishers: { zuhaowang: publisher }, logger });
        assert.strictEqual(second.applied, 1, JSON.stringify({ second, actual,
            runtime: await getAccountPriceLadderRuntime(uid, '1', identity.game_account, 'zuhaowang') }));
        assert.strictEqual(modifications, 1);
        assert.strictEqual(publisherCalls, 2);
        assert.strictEqual(actual.p24, 8.1, 'fresh day-capable mode applies the original-base daily policy');
        if (actualMode !== 'day_only') assert.strictEqual(actual.hour, 2.4);
        const applied = await getAccountPriceLadderRuntime(uid, '1', identity.game_account, 'zuhaowang');
        assert.strictEqual(applied.status, 'applied');
        assert.strictEqual(applied.retry_count, 0);
        assert.strictEqual(JSON.parse(applied.applied_price_signature).base_hour_price, 2);
    }
    console.log('[PASS] ZHW stale modes: no wrong writes, atomic refresh, unchanged backoff and successful fresh recalculation');
}
main().catch(error => { console.error(error); process.exitCode = 1; });
