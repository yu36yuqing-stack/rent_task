'use strict';

const assert = require('assert');
let auths = [];
let runtimes = [];
let authError;
let runtimeError;
const calls = { auth: 0, runtime: 0 };
const warnings = [];
console.warn = (message) => warnings.push(message);

for (const [file, exports] of [
    ['../database/user_platform_auth_db', { listUserPlatformAuth: async (uid, options) => {
        assert.strictEqual(uid, 12);
        assert.strictEqual(options.with_payload, false);
        calls.auth += 1;
        if (authError) throw authError;
        return auths;
    } }],
    ['../database/account_price_ladder_runtime_db', { listAccountPriceLadderRuntimesByUser: async (uid) => {
        assert.strictEqual(uid, 12);
        calls.runtime += 1;
        if (runtimeError) throw runtimeError;
        return runtimes;
    } }]
]) {
    const id = require.resolve(file);
    require.cache[id] = { id, filename: id, loaded: true, exports };
}

const { getProductChannelPriceSummaries: summarize } = require('../price/product_channel_price_service');
const { listEnabledPriceChannelAdapters } = require('../price/channel_adapters/channel_price_registry');
for (const adapter of listEnabledPriceChannelAdapters()) {
    adapter.resolveTierPrices = () => { throw new Error('display must not calculate/publish target prices'); };
}
const channels = {
    uhaozu: { prd_id: 'u-1', rentalByHour: '2.345' },
    uuzuhao: { product_id: 'y-1', hour_price: '2.6' },
    zuhaowang: { data_id: 'z-1', hour_price: 3.1, rent_mode: 'hour_only' }
};
const account = { user_id: 12, game_id: '1', game_account: 'same-account', channel_prd_info: channels };
const runtime = (channel, tier, overrides = {}) => ({
    user_id: 12, game_id: '1', game_account: 'same-account', channel,
    applied_tier: tier, desired_tier: 4, status: 'failed', last_error: 'private-error', ...overrides
});

async function main() {
    for (const uid of [0, -1, 1.5, 'bad', undefined]) await assert.rejects(() => summarize(uid), /user_id/);
    assert.deepStrictEqual(await summarize(12), {});
    assert.deepStrictEqual(await summarize(12, [null, {}, { ...account, user_id: 99 },
        { ...account, is_deleted: 1 }, { ...account, asset_status: 'sold' }]), {});
    assert.deepStrictEqual(calls, { auth: 0, runtime: 0 });

    runtimes = [runtime('uhaozu', 3), runtime('uuzuhao', '1'), runtime('zuhaowang', 2),
        runtime('uhaozu', 4, { game_id: '2' }), runtime('uuzuhao', 4, { user_id: 99 }),
        runtime('zuhaowang', 4, { is_deleted: 1 }), { user_id: 12, channel: 'uhaozu', applied_tier: 4 }];
    const original = JSON.stringify(account);
    const out = await summarize('12', [account, { ...account, game_id: '2' },
        { game_account: 'unlinked', channel_prd_info: {} }]);
    assert.deepStrictEqual(out['1::same-account'], {
        uhaozu: { current_tier: 3, hour_price: 2.35 },
        zuhaowang: { current_tier: 2, hour_price: 3.1 },
        uuzuhao: { current_tier: 1, hour_price: 2.6 }
    });
    assert.strictEqual(out['2::same-account'].uhaozu.current_tier, 4);
    assert.strictEqual(out['2::same-account'].uuzuhao.current_tier, 0);
    assert.deepStrictEqual(out['1::unlinked'], {});
    assert.strictEqual(JSON.stringify(account), original);
    assert.deepStrictEqual(calls, { auth: 1, runtime: 1 });
    assert(!JSON.stringify(out).includes('private-error'));
    assert(!JSON.stringify(out).includes('desired_tier'));
    const dayOnly = { ...account, channel_prd_info: { ...channels,
        zuhaowang: { data_id: 'z-1', rent_mode: 'day_only', hourPrice: 3.4, hour_basis: 3.2 } } };
    assert.strictEqual((await summarize(12, [dayOnly]))['1::same-account'].zuhaowang.hour_price, 3.2);
    dayOnly.channel_prd_info.zuhaowang.hour_basis = 2.5;
    assert.strictEqual((await summarize(12, [dayOnly]))['1::same-account'].zuhaowang.hour_price, 2.5);
    assert.strictEqual(account.channel_prd_info.zuhaowang.hour_price, 3.1);

    for (const tier of [0, -1, 5, 1.5, 'bad', undefined]) {
        runtimes = [runtime('uhaozu', tier)];
        const result = await summarize(12, [account]);
        assert.strictEqual(result['1::same-account'].uhaozu.current_tier, 0);
    }
    for (const status of ['idle', 'pending', 'blocked', 'failed', 'success']) {
        runtimes = [runtime('uhaozu', 2, { status })];
        assert.strictEqual((await summarize(12, [account]))['1::same-account'].uhaozu.current_tier, 2);
    }
    for (const price of [undefined, 0, -1, 'bad', Infinity]) {
        const row = { ...account, channel_prd_info: { uhaozu: { prd_id: 'id', rentalByHour: price } } };
        assert.strictEqual((await summarize(12, [row]))['1::same-account'].uhaozu.hour_price, null);
    }
    auths = [{ platform: 'uhaozu', channel_enabled: false }, { platform: 'uuzuhao', channel_enabled: true }];
    assert.strictEqual((await summarize(12, [account]))['1::same-account'].uhaozu, undefined);
    auths = [];
    runtimeError = Object.assign(new Error('sensitive-message'), { code: 'SQLITE_CORRUPT' });
    assert.deepStrictEqual((await summarize(12, [account]))['1::same-account'].uhaozu,
        { current_tier: 0, hour_price: 2.35 });
    runtimeError = new Error('sensitive-message');
    await summarize(12, [account]);
    assert(warnings.some((message) => message.includes('stage=runtime error_code=SQLITE_CORRUPT')));
    assert(warnings.some((message) => message.includes('error_code=READ_FAILED')));
    runtimeError = null;
    for (const error of [new Error('private'), Object.assign(new Error('private'), { code: 'SQLITE_BUSY' })]) {
        authError = error;
        const before = calls.runtime;
        assert.deepStrictEqual(await summarize(12, [account]), {});
        assert.strictEqual(calls.runtime, before);
    }
    assert(warnings.some((message) => message.includes('stage=auth error_code=SQLITE_BUSY')));
    assert(!warnings.some((message) => /sensitive-message|private/.test(message)));
    console.log('[PASS] product_channel_price_service: identity, batching, snapshots, tiers, disable and failures');
}

main().catch((error) => { console.error(error); process.exitCode = 1; });
