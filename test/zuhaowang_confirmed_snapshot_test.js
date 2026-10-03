'use strict';

const assert = require('assert');
const adapter = require('../price/channel_adapters/zuhaowang_price_adapter');
const { buildConfirmedZuhaowangPriceSnapshot: build, getZuhaowangDisplayHourPrice: display,
    recoverZuhaowangPriceSnapshotsByUser: recover, _internals: { recoverFromLog } } = require('../price/zuhaowang_price_snapshot_service');
const prices = { hour: 3.2, p24: 19.2, p72: 48, p168: 128 };
const account = { user_id: 8, game_id: '1', game_name: 'WZRY', game_account: 'same',
    channel_prd_info: { zuhaowang: { prd_id: 'goods', exception_msg: 'fresh', raw_status: 1 } } };
const log = { id: 2, user_id: 8, channel: 'zuhaowang', game_name: 'WZRY', game_account: 'same',
    goods_id: 'goods', publish_status: 'success', response_data: { verification_status: 'full' },
    request_data: { target_prices: prices }, after_data: { rent_mode: 'day_only', prices: { ...prices, hour: 0 } } };
const change = (info) => ({ ...account, channel_prd_info: { zuhaowang: info } });

async function main() {
    for (const value of [null, false, true, '', 'bad', Infinity, NaN, -1, {}, []]) {
        assert.strictEqual(display({ hourPrice: value }), 0);
        assert.strictEqual(display({ rent_mode: 'day_only', hour_basis: value }), 0);
    }
    assert.strictEqual(display(), 0);
    assert.strictEqual(display({ hourPrice: '2.345' }), 2.35);
    assert.strictEqual(display({ hour_price: 2.5 }), 2.5);
    assert.strictEqual(display({ obtainPrice: 2.6 }), 2.6);
    assert.strictEqual(display({ rent_mode: 'day_only', hour_basis: 3.2, hourPrice: 3.4 }), 3.2);
    assert.strictEqual(display({ rent_mode: 'day_only', hour_basis: 0, hourPrice: 3.4 }), 3.4);
    assert.strictEqual(display({ rent_mode: 'hour_only', hour_basis: 99, hourPrice: 2 }), 2);
    const hourly = adapter.pickCurrentPriceSet({ channel_prd_info: { zuhaowang: {
        prd_id: 'hourly', rent_mode: 'hour_only', hourPrice: 2, p24Price: 19.2, p72Price: 48, p168Price: 128
    } } });
    assert.deepStrictEqual(hourly.prices, { hour: 2, p24: 0, p72: 0, p168: 0 });
    assert.strictEqual(adapter.samePriceSet({ hour: 2, p24: 99, p72: 99, p168: 99 }, hourly.prices), true);
    const normal = (mode) => ({ rent_mode: mode, account_info: { priceTemplateType: 1 },
        prices: { ...prices, hour: mode === 'day_only' ? 0 : 3.2 } });
    const before = Object.freeze({ data_id: 'goods', obtainPrice: 3.4, hour_price: 8, raw_status: 1 });
    const same = build(before, 'goods', normal('day_only'), prices);
    assert.strictEqual(same.hourPrice, 8);
    assert.strictEqual(same.hour_basis, 3.2);
    assert.strictEqual(same.raw_status, 1);
    assert(!Object.hasOwn(same, 'obtainPrice'));
    assert(!Object.hasOwn(same, 'hour_price'));
    assert.strictEqual(build(before, 'new', normal('day_only'), prices).hourPrice, 0);
    assert.strictEqual(build({}, 'goods', normal('hour_and_day'), prices).hourPrice, 3.2);
    const recovered = recoverFromLog(account, log);
    assert.strictEqual(recovered.hour_basis, 3.2);
    assert.strictEqual(recovered.hourPrice, 0);
    assert.strictEqual(recovered.exception_msg, 'fresh');
    assert.strictEqual(account.channel_prd_info.zuhaowang.hour_basis, undefined);
    const existing = change({ prd_id: 'goods', rent_mode: 'day_only', hourPrice: 3.4 });
    assert.strictEqual(recoverFromLog(existing, log).hourPrice, 3.4);
    for (const patch of [{ user_id: 9 }, { channel: 'uhaozu' }, { game_account: 'other' },
        { game_name: '和平精英' }, { goods_id: 'new' }, { is_deleted: 1 }, { publish_status: 'fail' },
        { response_data: null }, { response_data: { verification_status: 'partial' } },
        { request_data: null }, { request_data: { target_prices: null } }, { after_data: null },
        { after_data: { prices: null, rent_mode: 'day_only' } },
        { after_data: { prices, rent_mode: 'unknown' } }, { request_data: { target_prices: { ...prices, hour: 0 } } }]) {
        assert.strictEqual(recoverFromLog(account, { ...log, ...patch }), null, JSON.stringify(patch));
    }
    assert.strictEqual(recoverFromLog(account, null), null);
    assert.strictEqual(recoverFromLog(change({}), log), null);
    assert.strictEqual(recoverFromLog(change({ prd_id: 'goods', rent_mode: 'hour_only' }), log), null);
    assert.strictEqual(recoverFromLog(change({ prd_id: 'goods', p24Price: 20 }), log), null);
    for (const value of [0, 20]) {
        assert.strictEqual(recoverFromLog(account, { ...log, after_data: {
            rent_mode: 'day_only', prices: { ...prices, p24: value } } }), null);
    }
    assert.strictEqual(recoverFromLog(account, { ...log, request_data: {
        target_prices: { ...prices, p24: 0 } } }), null);
    assert.strictEqual(recoverFromLog(account, { ...log, request_data: {
        target_prices: { ...prices, hour: 0.001 } } }), null);
    assert.strictEqual(recoverFromLog(account, { ...log, after_data: {
        rent_mode: 'day_only', prices: { ...prices, p24: 0.001 } } }), null);
    assert.strictEqual(recoverFromLog(account, { ...log, request_data: {
        target_prices: { ...prices, p24: 0.001 } } }), null);
    for (const mode of ['hour_only', 'hour_and_day']) {
        const active = { ...log, after_data: { prices, rent_mode: mode } };
        assert.strictEqual(recoverFromLog(account, active).hourPrice, 3.2);
        assert.strictEqual(recoverFromLog(change({ prd_id: 'goods', obtainPrice: 3.2 }), active).hourPrice, 3.2);
        assert.strictEqual(recoverFromLog(change({ prd_id: 'goods', hourPrice: 4 }), active), null);
    }
    let loads = 0;
    const load = async (uid, channel) => { loads += 1; assert.strictEqual(uid, 8); assert.strictEqual(channel, 'zuhaowang'); return [log]; };
    const skipped = [change({ prd_id: 'goods', rent_mode: 'day_only', hour_basis: 3.2 }),
        change({ prd_id: 'goods', hourPrice: 2 }), change({}),
        { ...account, user_id: 9 }, { ...account, is_deleted: 1 }, { ...account, asset_status: 'sold' },
        { ...account, channel_prd_info: null }, { ...account, channel_prd_info: {} }];
    assert.deepStrictEqual(await recover(8, skipped, { load_logs: load }), {});
    assert.strictEqual(loads, 0);
    const snapshots = await recover(8, [account, { ...account, game_id: '2', game_name: '和平精英' }, ...skipped], { load_logs: load });
    assert.deepStrictEqual(Object.keys(snapshots), ['1::same']);
    assert.strictEqual(loads, 1);
    assert.strictEqual((await recover(8, [change({ data_id: 'goods' })], { load_logs: load }))['1::same'].hour_basis, 3.2);
    assert.deepStrictEqual(await recover(8, [account], { load_logs: async () => [] }), {});
    for (const error of [new Error('fixture'), Object.assign(new Error('fixture'), { code: 'SQLITE_CORRUPT' })]) {
        assert.deepStrictEqual(await recover(8, [account], { load_logs: async () => { throw error; } }), {});
    }
    for (const uid of [0, -1, 1.2, 'bad']) await assert.rejects(() => recover(uid, []), /invalid/);
    console.log('[PASS] ZHW confirmed snapshot: basis separation, verified history, identity, modes, stale/conflicting evidence and degraded reads');
}
main().catch((error) => { console.error(error); process.exitCode = 1; });
