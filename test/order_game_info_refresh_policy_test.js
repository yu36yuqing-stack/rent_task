'use strict';

const assert = require('assert');
const policyApi = require('../order/game_info_refresh_policy');
const { CONFIG_KEY, normalizeGameInfoRefreshPolicy: normalize, parseOrderTime: time,
    loadGameInfoRefreshPolicy: load, policyAllowsUser: allows,
    isRefreshOrderEligible: eligible, buildRefreshLockKey: lockKey } = policyApi;

async function main() {
    const activated = '2026-11-12 10:00:00';
    const now = time('2026-11-12 12:00:00');
    const value = { enabled: true, user_ids: [8], activated_at: activated };
    const policy = normalize(value);
    const order = { user_id: 8, channel: 'uuzuhao', order_no: 'order-1', game_id: '1',
        game_account: 'account-1', start_time: '2026-11-12 10:10:00', end_time: '2026-11-12 10:30:00', order_status: '已完成' };
    assert.strictEqual(policyApi.MIN_DURATION_SECONDS, 1200);
    assert.strictEqual(policyApi.TARGET_CHANNEL, 'uuzuhao');
    assert.strictEqual(policyApi.BUSINESS_SCENE, 'order_game_info_refresh');
    assert.strictEqual(time(activated), new Date(2026, 10, 12, 10).getTime());
    assert(Number.isFinite(time('2024-02-29T12:30:10.001Z')));
    assert(Number.isFinite(time('2026-11-12T10:00:00+08:00')));
    for (const bad of [undefined, null, 0, '', 'yesterday', '2026-11-12', '1969-12-31 12:00:00',
        '2025-02-29 12:00:00', '2026-00-01 00:00:00', '2026-13-01 00:00:00', '2026-01-00 00:00:00',
        '2026-01-32 00:00:00', '2026-11-12 24:00:00', '2026-11-12 10:60:00', '2026-11-12 10:00:60', '2026-11-12T10:00:00+25:00']) {
        assert(Number.isNaN(time(bad)), `invalid time must fail: ${String(bad)}`);
    }
    for (const bad of [null, [], '', { ...value, extra: 1 }, { ...value, enabled: 'true' },
        { ...value, user_ids: undefined }, { ...value, user_ids: [0] }, { ...value, user_ids: ['8'] },
        { ...value, user_ids: [1.5] }, { ...value, user_ids: Array(1001).fill(8) },
        { ...value, activated_at: '' }, { ...value, activated_at: 1 }, { ...value, activated_at: '2026-02-30 00:00:00' }]) {
        assert.strictEqual(normalize(bad).enabled, false);
        assert.strictEqual(normalize(bad).available, false);
    }
    assert.deepStrictEqual(normalize({ ...value, user_ids: [8, 8, 9] }).user_ids, [8, 9]);
    assert(Object.isFrozen(policy)); assert(Object.isFrozen(policy.user_ids));
    assert.throws(() => policy.user_ids.push(9), TypeError);
    const disabled = normalize({ enabled: false, user_ids: [8], activated_at: '' });
    assert(disabled.available); assert.strictEqual(disabled.reason, 'disabled');
    assert.strictEqual(disabled.activated_at, '');
    for (const p of [null, normalize(null), disabled, normalize({ ...value, user_ids: [] })]) assert.strictEqual(allows(p, 8, now), false);
    assert(allows(policy, 8, now));
    assert(allows(normalize({ ...value, user_ids: null }), 9, now));
    assert.strictEqual(allows(policy, 9, now), false);
    for (const uid of [0, -1, 'x', 1.5]) assert.strictEqual(allows(policy, uid, now), false);
    assert.strictEqual(allows(policy, 8, time(activated) - 1), false);
    assert.strictEqual(allows(policy, 8, NaN), false);
    assert.strictEqual(allows({ ...policy, activated_at_ms: NaN }, 8, now), false);
    const originalNow = Date.now;
    Date.now = () => now;
    try { assert(allows(policy, 8), 'default clock uses the same policy gate'); }
    finally { Date.now = originalNow; }

    for (const channel of ['uuzuhao', 'uhaozu', 'zuhaowang', '5e']) {
        for (const status of ['已完成', '部分完成', '已退款', '已撤单', '投诉/撤单']) {
            assert(eligible({ ...order, channel, order_status: status }, policy, { now }), `${channel}/${status} qualifies`);
        }
    }
    assert(eligible(order, policy, { now: new Date(now) }), 'exactly 20 minutes qualifies');
    Date.now = () => now;
    try { assert(eligible(order, policy), 'default clock evaluates the completed order'); }
    finally { Date.now = originalNow; }
    assert(eligible({ ...order, channel: undefined, source_channel: 'uhaozu' }, policy, { now }));
    assert(eligible({ ...order, end_time: '2026-11-12 10:30:01' }, policy, { now }));
    assert.strictEqual(eligible({ ...order, end_time: '2026-11-12 10:29:59' }, policy, { now }), false);
    for (const patch of [
        { channel: 'unknown' }, { channel: '', source_channel: '' }, { user_id: 9 },
        { order_status: '结算中' }, { order_status: '租赁中' }, { order_status: '' },
        { order_no: '' }, { game_account: '' }, { game_id: 0 }, { game_id: 'unknown' },
        { is_deleted: 1 }, { start_time: '' }, { end_time: '' },
        { end_time: '2026-11-12 12:01:00' }, { end_time: '2026-11-12 10:00:00' }
    ]) assert.strictEqual(eligible({ ...order, ...patch }, policy, { now }), false, JSON.stringify(patch));
    assert.strictEqual(eligible(null, policy, { now }), false);
    assert.strictEqual(eligible(undefined, policy, { now }), false);
    assert.strictEqual(eligible({ ...order, start_time: '2026-11-12 09:30:00' }, policy, { now }), false, 'old first-seen terminal is not historical backfill');
    assert(eligible({ ...order, start_time: '2026-11-12 09:30:00', observed_active_at: activated }, policy, { now }), 'pre-existing active order is included');
    assert.strictEqual(eligible({ ...order, start_time: '2026-11-12 09:00:00', end_time: '2026-11-12 09:50:00', observed_active_at: activated }, policy, { now }), false);
    assert.strictEqual(eligible({ ...order, start_time: '2026-11-12 09:30:00', observed_active_at: '2026-11-12 09:59:59' }, policy, { now }), false);

    const key = lockKey(order);
    assert.strictEqual(key, 'order_game_info_refresh:uuzuhao:8:uuzuhao:order-1');
    assert.notStrictEqual(key, lockKey({ ...order, business_scene: 'another_business' }));
    assert.notStrictEqual(key, lockKey({ ...order, target_channel: 'uhaozu' }));
    assert.notStrictEqual(key, lockKey({ ...order, channel: 'uhaozu' }));
    assert.notStrictEqual(key, lockKey({ ...order, user_id: 9 }));
    assert.strictEqual(lockKey({ ...order, channel: undefined, source_channel: 'uhaozu' }), 'order_game_info_refresh:uuzuhao:8:uhaozu:order-1');
    for (const bad of [{}, { ...order, business_scene: 'bad:scene' }, { ...order, target_channel: 'bad:target' },
        { ...order, user_id: 0 }, { ...order, channel: '' }, { ...order, order_no: '' }]) assert.throws(() => lockKey(bad), /刷新锁/);
    assert.throws(() => lockKey(), /刷新锁/);

    assert.strictEqual((await load({ get_config: async key => { assert.strictEqual(key, CONFIG_KEY); return { found: true, value }; } })).enabled, true);
    assert.strictEqual((await load({ get_config: async () => null })).reason, 'config_missing');
    assert.strictEqual((await load({ get_config: async () => ({ found: false }) })).reason, 'config_missing');
    const logs = [];
    assert.strictEqual((await load({ get_config: async () => { throw new Error('fixture-secret'); }, logger: { warn: text => logs.push(text) } })).reason, 'config_unavailable');
    assert.deepStrictEqual(logs, ['[GameInfoRefresh] config_unavailable']);
    assert.strictEqual((await load({ get_config: async () => { throw new Error('fixture-secret'); } })).enabled, false);
    assert.strictEqual((await load({ get_config: async () => ({ found: true, value: [] }) })).available, false);
    console.log('[PASS] order game info refresh policy: thresholds, history, terminal scope, configuration and lock isolation');
}

main().catch(error => { console.error(error); process.exitCode = 1; });
