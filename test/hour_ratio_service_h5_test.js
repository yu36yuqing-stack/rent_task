'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'rent-hour-ratio-service-'));
for (const key of ['MAIN', 'PRICE', 'RUNTIME', 'ORDER', 'STATS']) {
    process.env[`${key}_DB_FILE_PATH`] = path.join(temporary, `${key}.db`);
}
process.env.H5_PORT = '0';
process.env.SHEEP_FIX_ENABLE = '0';
process.env.BL_V2_INSPECTOR_ENABLE = '0';
process.env.ORDER_COUNT_TRACE = 'false';

const { createUserByAdmin } = require('../database/user_db');
const { upsertUserGameAccount } = require('../database/user_game_account_db');
const { upsertAccountPriceLadderRule } = require('../database/account_price_ladder_rule_db');
const { getAccountPriceLadderRuntime } = require('../database/account_price_ladder_runtime_db');
const { setPriceLadderFeatureEnabled } = require('../database/price_ladder_feature_config_db');
const { getUserChannelPackageRatio } = require('../database/user_channel_package_ratio_db');
const { getPackageRatioSettingsByUser, savePackageRatioSettingsByUser, validateDailyPolicyForRules } = require('../price/package_ratio_service');
const { getPriceChannelAdapter } = require('../price/channel_adapters/channel_price_registry');
const { reconcilePendingPriceLaddersByUser, _internal } = require('../price/price_ladder_reconcile_service');
const { createAccessToken } = require('../user/auth_token');
const { bootstrap } = require('../h5/local_h5_server');
const { stopProdRiskTaskWorker } = require('../product/prod_status_guard');

const channels = ['uhaozu', 'zuhaowang', 'uuzuhao'];
const games = [['1', 'WZRY'], ['2', '和平精英'], ['3', 'CFM'], ['4', 'CSGO']];
const prices = [2, 3, 4, 5];
const defaults = channel => ({ ...getPriceChannelAdapter(channel).default_ratios });
async function seed(userId, gameId = '1', gameName = 'WZRY', rentMode = 'hour_and_day') {
    const row = { user_id: userId, game_id: gameId, game_name: gameName, game_account: 'shared-hour-account',
        channel_prd_info: {
            uhaozu: { prd_id: `u-${userId}-${gameId}`, rentalByHour: 2, rentalByNight: 8, rentalByDay: 12, rentalByWeek: 70 },
            uuzuhao: { prd_id: `y-${userId}-${gameId}`, hourPrice: 2 },
            zuhaowang: { prd_id: `z-${userId}-${gameId}`, rent_mode: rentMode }
        } };
    await upsertUserGameAccount(row);
    await upsertAccountPriceLadderRule(userId, { ...row, prices }, { expected_version: 0 });
    return row;
}

async function main() {
    const owner = await createUserByAdmin({ account: 'hour-ratio-owner', password: 'fixture-password', status: 'enabled', user_type: '内部' });
    const other = await createUserByAdmin({ account: 'hour-ratio-other', password: 'fixture-password', status: 'enabled', user_type: '内部' });
    for (const [gameId, gameName] of games) await seed(owner.id, gameId, gameName);
    await seed(other.id);

    await assert.rejects(() => getPackageRatioSettingsByUser(0), /user_id/);
    await assert.rejects(() => savePackageRatioSettingsByUser(0), /user_id/);
    await assert.rejects(() => savePackageRatioSettingsByUser(owner.id, { channel: 'unsupported' }), /不支持/);

    // No test can make a platform call, even if a future regression reaches a real publisher.
    const nativeFetch = global.fetch;
    let externalRequests = 0;
    global.fetch = (url, options) => {
        const parsed = new URL(String(url));
        if (parsed.hostname !== '127.0.0.1') {
            externalRequests += 1;
            return Promise.reject(new Error('fixture forbids external requests'));
        }
        return nativeFetch(url, options);
    };
    const server = await bootstrap();
    const base = `http://127.0.0.1:${server.address().port}`;
    const headers = { Authorization: `Bearer ${createAccessToken(owner)}`, 'Content-Type': 'application/json' };
    const request = async (body, customHeaders = headers) => {
        const response = await fetch(`${base}/api/pricing/ladder/package-ratios`, {
            headers: customHeaders, ...(body === undefined ? {} : { method: 'POST', body: JSON.stringify(body) })
        });
        return { status: response.status, json: await response.json() };
    };
    try {
        assert.strictEqual((await request(undefined, {})).status, 401);
        assert.strictEqual((await request({ channel: 'uhaozu', ratios: defaults('uhaozu') }, { 'Content-Type': 'application/json' })).status, 401);
        assert.strictEqual((await request()).json.channels.length, 3);

        const factors = { uhaozu: 1.2, zuhaowang: 1.1, uuzuhao: 0.9 };
        for (const channel of channels) {
            const result = await request({ channel, user_id: other.id, hour_ratio_editable: true,
                ratios: { ...defaults(channel), hour: factors[channel] }, expected_version: 0 });
            assert.strictEqual(result.status, 200);
            assert.strictEqual(result.json.setting.ratios.hour, factors[channel]);
            assert.strictEqual(result.json.setting.queued_count, 4);
            assert.strictEqual(result.json.setting.version, 1);
            assert.strictEqual(await getUserChannelPackageRatio(other.id, channel), null, 'body user_id cannot change another owner');
            for (const [gameId] of games) {
                const runtime = await getAccountPriceLadderRuntime(owner.id, gameId, 'shared-hour-account', channel);
                assert.strictEqual(runtime.status, 'pending');
                assert.strictEqual(runtime.trigger_source, 'package_ratio_saved');
            }
        }
        const loaded = await request();
        for (const channel of loaded.json.channels) assert.strictEqual(channel.ratios.hour, factors[channel.channel]);
        assert.strictEqual(externalRequests, 0, 'saving settings must enqueue without contacting a platform');

        const calls = [];
        const events = [];
        const logger = { log: text => events.push(text), warn: text => events.push(text) };
        const publishers = Object.fromEntries(channels.map(channel => [channel, async (_uid, input) => {
            calls.push({ channel, input });
            return { ok: true, changed: true, batch_id: `fixture-${calls.length}`, prices: input.prices };
        }]));
        const disabled = await reconcilePendingPriceLaddersByUser(owner.id, { publishers, allow_apply: true, logger });
        assert.strictEqual(disabled.pending, 12);
        assert.strictEqual(calls.length, 0, 'a saved ratio cannot enable automatic pricing');
        await setPriceLadderFeatureEnabled(owner.id, true, { expected_version: 0 });
        const applied = await reconcilePendingPriceLaddersByUser(owner.id, { publishers, allow_apply: true, logger });
        assert.strictEqual(applied.applied, 12);
        assert.strictEqual(calls.length, 12);
        const applyEvents = events.filter(text => text.startsWith('[PriceLadder][apply_start]'))
            .map(text => JSON.parse(text.slice(text.indexOf('{'))));
        assert.strictEqual(applyEvents.length, 12);
        assert(applyEvents.every(event => event.base_hour_price === 2 && event.daily_calculation.target_tier_hour_price === 2));
        for (const { channel, input } of calls) {
            assert.strictEqual(input.base_hour_price, 2);
            assert.strictEqual(input.prices.hour, Number((2 * factors[channel]).toFixed(2)));
            const adapter = getPriceChannelAdapter(channel);
            const build = adapter.buildTierPricesByRatios || adapter.buildTierPrices;
            const original = build(prices, defaults(channel))[0].prices;
            for (const key of adapter.package_keys.filter(key => key !== 'hour')) {
                assert.strictEqual(input.prices[key], original[key], `${channel}/${key} cannot compound the hourly factor`);
            }
            const runtime = await getAccountPriceLadderRuntime(owner.id, input.game_id, input.game_account, channel);
            const signature = JSON.parse(runtime.applied_price_signature);
            assert.strictEqual(signature.base_hour_price, 2);
            assert.strictEqual(signature.prices.hour, input.prices.hour);
        }
        const log = _internal.dailyCalculationLog(getPriceChannelAdapter('uhaozu'), { prices },
            { baseline: { ratios: { ...defaults('uhaozu'), hour: 1.2 }, daily_policy: { mode: 'follow' } } },
            { tier: 2, prices: { hour: 3.6, night: 12, day: 18, week: 105 } });
        assert.strictEqual(log.first_tier_hour_price, 2);
        assert.strictEqual(log.target_tier_hour_price, 3);
        assert.strictEqual(log.target_channel_hour_price, 3.6);
        assert.strictEqual(log.hour_ratio, 1.2);
        assert.strictEqual(log.target_daily_price, 18);
        assert(!Object.hasOwn(JSON.parse(_internal.priceSignature(1, { hour: 2 })), 'base_hour_price'));

        // A legacy page always submits hour=1. Only a new page can explicitly reset the factor.
        const legacy = await request({ channel: 'uhaozu', ratios: { ...defaults('uhaozu'), hour: 1 }, expected_version: 1 });
        assert.strictEqual(legacy.status, 200);
        assert.strictEqual(legacy.json.setting.ratios.hour, 1.2);
        const stale = await request({ channel: 'uhaozu', hour_ratio_editable: true,
            ratios: { ...defaults('uhaozu'), hour: 0.8 }, expected_version: 1 });
        assert.strictEqual(stale.status, 409);
        const reset = await request({ channel: 'uhaozu', hour_ratio_editable: true, ratios: defaults('uhaozu'), expected_version: 2 });
        assert.strictEqual(reset.status, 200);
        assert.strictEqual(reset.json.setting.ratios.hour, 1);
        for (const value of [0, -1, null, '', 0.00001, 0.0001]) {
            const bad = await request({ channel: 'uuzuhao', hour_ratio_editable: true,
                ratios: { ...defaults('uuzuhao'), hour: value }, expected_version: 1 });
            assert.strictEqual(bad.status, 400, `invalid or zero-after-rounding multiplier ${String(value)}`);
            assert.strictEqual((await getUserChannelPackageRatio(owner.id, 'uuzuhao')).version, 1);
        }
        const omitted = await savePackageRatioSettingsByUser(owner.id, { channel: 'uuzuhao',
            ratios: { p2: 1.8 }, hour_ratio_editable: true, expected_version: 1 });
        assert.strictEqual(omitted.ratios.hour, 0.9);
        const fakeMarker = await savePackageRatioSettingsByUser(owner.id, { channel: 'uuzuhao',
            ratios: { ...defaults('uuzuhao'), hour: 99 }, hour_ratio_editable: 'true', expected_version: 2 });
        assert.strictEqual(fakeMarker.ratios.hour, 0.9);
        const nullRatios = await savePackageRatioSettingsByUser(owner.id, { channel: 'uuzuhao', ratios: null, expected_version: 3 });
        assert.strictEqual(nullRatios.ratios.hour, 0.9);

        const dayUser = 101;
        await seed(dayUser, '1', 'WZRY', 'day_only');
        for (const [index, hour] of [100, 0.0001].entries()) {
            const result = await savePackageRatioSettingsByUser(dayUser, { channel: 'zuhaowang', hour_ratio_editable: true,
                ratios: { ...defaults('zuhaowang'), hour }, daily_policy: { mode: 'flat' }, expected_version: index });
            assert.strictEqual(result.ratios.hour, hour);
        }
        const mixedUser = 102;
        await seed(mixedUser);
        await assert.rejects(() => savePackageRatioSettingsByUser(mixedUser, { channel: 'zuhaowang', hour_ratio_editable: true,
            ratios: { ...defaults('zuhaowang'), hour: 100 }, daily_policy: { mode: 'flat' } }), /冲突/);
        assert.strictEqual(await getUserChannelPackageRatio(mixedUser, 'zuhaowang'), null, 'invalid prices cannot persist or enqueue');
        const hourUser = 103;
        await seed(hourUser, '1', 'WZRY', 'hour_only');
        assert.strictEqual((await savePackageRatioSettingsByUser(hourUser, { channel: 'zuhaowang', hour_ratio_editable: true,
            ratios: { ...defaults('zuhaowang'), hour: 100 }, daily_policy: { mode: 'decrease' } })).ratios.hour, 100);

        const uhaozu = getPriceChannelAdapter('uhaozu');
        const noLiveRule = { game_id: '1', game_account: 'not-live', game_name: 'WZRY', prices };
        assert.doesNotThrow(() => validateDailyPolicyForRules(uhaozu, defaults('uhaozu'), { mode: 'follow' }, [noLiveRule], [
            { ...noLiveRule, is_deleted: 1 }, { ...noLiveRule, asset_status: 'sold' }, { ...noLiveRule, channel_prd_info: {} }
        ]));
        assert.strictEqual(externalRequests, 0);
        console.log('[PASS] hour ratio service/H5: four games, independent channel prices, queue/activation, legacy saves, validation and identity');
    } finally {
        stopProdRiskTaskWorker();
        await new Promise(resolve => server.close(resolve));
        global.fetch = nativeFetch;
    }
}
main().catch(error => { console.error(error); process.exitCode = 1; });
