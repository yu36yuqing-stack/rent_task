'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'rent-hour-ratio-snapshot-'));
for (const [name, file] of Object.entries({ MAIN_DB_FILE_PATH: 'main.db', PRICE_DB_FILE_PATH: 'price.db',
    RUNTIME_DB_FILE_PATH: 'runtime.db', ORDER_DB_FILE_PATH: 'order.db', STATS_DB_FILE_PATH: 'stats.db' })) {
    process.env[name] = path.join(directory, file);
}
global.fetch = async () => { throw new Error('unexpected real network request'); };

const { upsertUserGameAccount, listUserGameAccounts } = require('../database/user_game_account_db');
const { listPricePublishItemLogsByBatchId, getPricePublishBatchLogByBatchId } = require('../database/price_publish_log_db');
const { saveUserChannelPackageRatio } = require('../database/user_channel_package_ratio_db');
const adapter = require('../price/channel_adapters/zuhaowang_price_adapter');
const { publishZuhaowangAccountPriceSetByUser: publish } = require('../price/price_publish_service');
const { normalizeZuhaowangBaseHourPrice: normalizeBase, buildConfirmedZuhaowangPriceSnapshot: build,
    getZuhaowangDisplayHourPrice: display, recoverZuhaowangPriceSnapshotsByUser: recoverHistory,
    recoverZuhaowangPriceSnapshotsFromTemplates: recoverTemplates,
    _internals: { recoverFromLog } } = require('../price/zuhaowang_price_snapshot_service');

const auth = { token_yuanbao: 'fixture', device_id: 'fixture', package_name: 'fixture' };
const target = { hour: 2.4, p24: 12, p72: 30, p168: 80 };
const oldPrices = { hour: 1.8, p24: 9, p72: 27, p168: 63 };
const clone = value => JSON.parse(JSON.stringify(value));

function template(mode, prices) {
    return { accountInfo: { priceTemplateType: 1 }, selfTemplate: {
        shortRent: { isOpen: mode !== 'day_only', obtainPrice: mode === 'day_only' ? 9.9 : prices.hour,
            discounts: [{ key: '3', selected: 1, details: [{ hour: 2, discount: 9.5 }] }],
            minHours: [{ hour: 2, isChecked: true }], minObtainPrice: 0.2, maxObtainPrice: 50 },
        longRent: { isOpen: mode !== 'hour_only', grades: ['p24', 'p72', 'p168'].map(key => ({
            key: key.slice(1), currentObtainPrice: prices[key], minObtainPrice: 0.1, maxObtainPrice: 500
        })) }
    } };
}

async function seed(userId, account, mode = 'day_only') {
    await upsertUserGameAccount({ user_id: userId, game_id: '1', game_name: 'WZRY', game_account: account,
        account_remark: 'hour ratio fixture', channel_prd_info: {
            // A fresh template, not this possibly stale cached mode, controls the request.
            zuhaowang: { prd_id: account, rent_mode: mode, hourPrice: 9.9, raw_status: 1 },
            uuzuhao: { prd_id: 'other-channel', hourPrice: 88 }
        } });
}

async function read(userId, account) {
    return (await listUserGameAccounts(userId, 1, 200)).list.find(row => row.game_account === account);
}

function identity(userId, account) {
    return { user_id: userId, game_id: '1', game_name: 'WZRY', game_account: account };
}

function emptySnapshotAccount(row, mode) {
    return { ...row, channel_prd_info: { zuhaowang: { prd_id: row.game_account, rent_mode: mode } } };
}

async function main() {
    assert.strictEqual(normalizeBase(target), 2.4, 'legacy callers retain their former basis');
    assert.strictEqual(normalizeBase(target, '2.345'), 2.35);
    assert.throws(() => normalizeBase(), /基础时租价/);
    const invalid = [null, false, true, 0, -1, '', 'bad', NaN, Infinity, {}, [], 0.001];
    const normalized = { rent_mode: 'day_only', prices: { ...target, hour: 0 }, account_info: { priceTemplateType: 1 } };
    for (const value of invalid) {
        assert.throws(() => normalizeBase(target, value), /基础时租价/);
        assert.throws(() => build({}, 'goods', normalized, target, value), /基础时租价/);
    }
    assert.strictEqual(build({}, 'goods', normalized, target, 2).hour_basis, 2);
    assert.strictEqual(build({}, 'goods', normalized, target).hour_basis, 2.4);

    let uid = 801;
    for (const mode of ['day_only', 'hour_and_day', 'hour_only']) {
        const userId = uid++;
        const account = `independent-${mode}`;
        await seed(userId, account, mode === 'day_only' ? 'hour_and_day' : 'day_only');
        const input = { ...identity(userId, account), base_hour_price: 2, prices: { ...target }, force_publish: true };
        const original = clone(input);
        const templates = [template(mode, oldPrices), template(mode, target)];
        const requests = [];
        const result = await publish(userId, input, { auth,
            get_template: async () => templates.shift(),
            change_template: async request => { requests.push(clone(request)); return { code: '0' }; } });
        assert.strictEqual(result.ok, true, JSON.stringify(result));
        assert.strictEqual(result.rent_mode, mode);
        assert.deepStrictEqual(input, original, 'publishing never mutates the original target or basis');
        assert.strictEqual(requests.length, 1);
        assert(!JSON.stringify(requests[0]).includes('base_hour_price'), 'internal basis is never sent to the platform');
        if (mode === 'day_only') {
            assert.strictEqual(requests[0].selfTemplate.shortRent, null, 'hourly renting stays disabled');
        } else {
            assert.strictEqual(requests[0].selfTemplate.shortRent.obtainPrice, 2.4, 'actual hourly price includes its own ratio');
        }
        if (mode === 'hour_only') {
            assert.strictEqual(requests[0].selfTemplate.longRent, null);
        } else {
            assert.deepStrictEqual(requests[0].selfTemplate.longRent.grades, [
                { obtainPrice: '12', key: '24' }, { obtainPrice: '30', key: '72' }, { obtainPrice: '80', key: '168' }
            ], 'day packages keep the independently calculated original-basis prices');
        }

        const row = await read(userId, account);
        const info = row.channel_prd_info.zuhaowang;
        assert.strictEqual(info.hour_basis, 2);
        assert.strictEqual(info.hourPrice, mode === 'day_only' ? 9.9 : 2.4);
        assert.strictEqual(display(info), mode === 'day_only' ? 2 : 2.4);
        assert.strictEqual(row.channel_prd_info.uuzuhao.hourPrice, 88);
        const logs = await listPricePublishItemLogsByBatchId(result.batch_id);
        assert.strictEqual(logs[0].request_data.base_hour_price, 2);
        assert.strictEqual(logs[0].request_data.target_prices.hour, 2.4);
        assert.strictEqual(logs[0].after_data.hour_basis, 2);
        assert.strictEqual(logs[0].price_target_hour, mode === 'day_only' ? 0 : 2.4);
        const batch = await getPricePublishBatchLogByBatchId(userId, result.batch_id);
        assert.strictEqual(batch.request_snapshot.base_hour_price, 2);

        const pending = emptySnapshotAccount(row, mode);
        const recovered = recoverFromLog(pending, logs[0]);
        assert.strictEqual(recovered.hour_basis, 2);
        assert.strictEqual(display(recovered), mode === 'day_only' ? 2 : 2.4);
        const history = await recoverHistory(userId, [pending], { load_logs: async () => logs });
        assert.strictEqual(history[`1::${account}`].hour_basis, 2);
        assert.strictEqual((await read(userId, account)).channel_prd_info.zuhaowang.hour_basis, 2,
            'read-only recovery does not alter the saved account');

        const legacy = clone(logs[0]);
        delete legacy.request_data.base_hour_price;
        legacy.after_data.hour_basis = 2.4;
        assert.strictEqual(recoverFromLog(pending, legacy).hour_basis, 2.4);
        delete legacy.after_data.hour_basis;
        assert.strictEqual(recoverFromLog(pending, legacy).hour_basis, 2.4);
        for (const value of invalid) {
            assert.strictEqual(recoverFromLog(pending, { ...logs[0],
                request_data: { ...logs[0].request_data, base_hour_price: value } }), null);
            assert.strictEqual(recoverFromLog(pending, { ...logs[0],
                after_data: { ...logs[0].after_data, hour_basis: value } }), null);
        }
        assert.strictEqual(recoverFromLog(pending, { ...logs[0],
            after_data: { ...logs[0].after_data, hour_basis: 3 } }), null, 'conflicting basis metadata is not trusted');
    }

    const noChangeUser = uid++;
    const noChangeAccount = 'day-only-no-change';
    await seed(noChangeUser, noChangeAccount, 'day_only');
    let changes = 0;
    const noChange = await publish(noChangeUser, { ...identity(noChangeUser, noChangeAccount),
        base_hour_price: 2, prices: { ...target, hour: 4.8 } }, { auth,
        get_template: async () => template('day_only', target), change_template: async () => { changes++; } });
    assert.strictEqual(noChange.changed, false);
    assert.strictEqual(changes, 0);
    const noChangeRow = await read(noChangeUser, noChangeAccount);
    assert.strictEqual(noChangeRow.channel_prd_info.zuhaowang.hour_basis, 2);
    assert.strictEqual(noChangeRow.channel_prd_info.zuhaowang.hourPrice, 9.9);

    const originalInfo = JSON.stringify(noChangeRow.channel_prd_info);
    const failed = await publish(noChangeUser, { ...identity(noChangeUser, noChangeAccount),
        base_hour_price: 2, prices: { ...target, p24: 13 }, force_publish: true }, { auth,
        get_template: async () => template('day_only', target), change_template: async () => ({ code: '0' }) });
    assert.strictEqual(failed.ok, false);
    assert.strictEqual(JSON.stringify((await read(noChangeUser, noChangeAccount)).channel_prd_info), originalInfo,
        'a failed readback cannot replace a confirmed basis');
    const failedLogs = await listPricePublishItemLogsByBatchId(failed.batch_id);
    assert.strictEqual(failedLogs[0].request_data.base_hour_price, 2);
    assert.strictEqual(recoverFromLog(emptySnapshotAccount(noChangeRow, 'day_only'), failedLogs[0]), null);
    let queries = 0;
    for (const value of invalid) {
        await assert.rejects(() => publish(noChangeUser, { ...identity(noChangeUser, noChangeAccount),
            base_hour_price: value, prices: target }, { auth,
            get_template: async () => { queries++; return template('day_only', target); } }), /基础时租价/);
    }
    assert.strictEqual(queries, 0, 'invalid explicit basis is rejected before any query');
    assert.strictEqual(JSON.stringify((await read(noChangeUser, noChangeAccount)).channel_prd_info), originalInfo);

    const missing = emptySnapshotAccount(noChangeRow, 'day_only');
    const runtime = { ...identity(noChangeUser, noChangeAccount), channel: 'zuhaowang', applied_tier: 2,
        applied_price_signature: JSON.stringify({ tier: 2, prices: target, base_hour_price: 2 }) };
    const getTemplate = async () => { queries++; return template('day_only', target); };
    const recoveryOptions = { get_auth: async () => auth, get_template: getTemplate };
    const restored = await recoverTemplates(noChangeUser, [missing], [runtime], recoveryOptions);
    assert.strictEqual(restored[`1::${noChangeAccount}`].hour_basis, 2);
    assert.strictEqual(display(restored[`1::${noChangeAccount}`]), 2);
    const legacyRuntime = { ...runtime, applied_price_signature: JSON.stringify({ tier: 2, prices: target }) };
    const legacyRestored = await recoverTemplates(noChangeUser, [missing], [legacyRuntime], recoveryOptions);
    assert.strictEqual(legacyRestored[`1::${noChangeAccount}`].hour_basis, 2.4);
    const previousQueries = queries;
    for (const value of invalid) {
        const bad = { ...runtime, applied_price_signature: JSON.stringify({ tier: 2, prices: target, base_hour_price: value }) };
        assert.deepStrictEqual(await recoverTemplates(noChangeUser, [missing], [bad], recoveryOptions), {});
    }
    assert.strictEqual(queries, previousQueries, 'invalid new signature never falls back to its actual hourly price');
    assert.strictEqual(JSON.stringify((await read(noChangeUser, noChangeAccount)).channel_prd_info), originalInfo);

    // Build both attempts through the actual adapter, rather than inventing a corrected target.
    for (const previousMode of ['day_only', 'hour_only', 'hour_and_day']) {
        for (const nextMode of ['day_only', 'hour_only', 'hour_and_day']) {
            if (previousMode === nextMode) continue;
            const userId = uid++;
            const account = `${previousMode}-to-${nextMode}`;
            await seed(userId, account, previousMode);
            await saveUserChannelPackageRatio(userId, { channel: 'zuhaowang',
                ratios: { hour: 1.2, p24: 6, p72: 15, p168: 40 },
                daily_policy: { mode: 'decrease', factors: [1, 0.9, 0.8, 0.7] } });
            const rule = { ...identity(userId, account), prices: [2, 3, 4, 5] };
            const beforeRow = await read(userId, account);
            const beforeInfo = clone(beforeRow.channel_prd_info);
            const firstCalculation = await adapter.resolveTierPrices({ user_id: userId, rule, account_row: beforeRow });
            assert.strictEqual(firstCalculation.ready, true);
            let modeQueries = 0;
            let modeChanges = 0;
            const first = await publish(userId, { ...identity(userId, account), tier: 2,
                base_hour_price: rule.prices[1], prices: firstCalculation.tiers[1].prices,
                computed_rent_mode: previousMode, force_publish: true }, { auth,
                get_template: async () => { modeQueries++; return template(nextMode, oldPrices); },
                change_template: async () => { modeChanges++; return { code: '0' }; } });
            assert.strictEqual(first.ok, false);
            assert.strictEqual(first.error_detail.code, 'ZUHAOWANG_RENT_MODE_CHANGED');
            assert.match(first.message, /租赁方式已变化.*重新计算/);
            assert.strictEqual(modeChanges, 0, 'a target based on a stale rental mode must never be submitted');
            assert.strictEqual(modeQueries, 1);
            const refreshed = await read(userId, account);
            assert.deepStrictEqual(refreshed.channel_prd_info, { ...beforeInfo,
                zuhaowang: { ...beforeInfo.zuhaowang, rent_mode: nextMode }
            }, 'only cached mode changes, not actual quotes, basis, status, or the other channel');
            const firstLogs = await listPricePublishItemLogsByBatchId(first.batch_id);
            assert.strictEqual(firstLogs[0].publish_status, 'fail');
            assert.strictEqual(firstLogs[0].request_data.biz_params, null);
            assert.strictEqual(firstLogs[0].request_data.computed_rent_mode, previousMode);
            const secondCalculation = await adapter.resolveTierPrices({ user_id: userId, rule, account_row: refreshed });
            assert.strictEqual(secondCalculation.ready, true);
            const secondPrices = secondCalculation.tiers[1].prices;
            assert.strictEqual(secondPrices.hour, nextMode === 'day_only' ? 3 : 3.6);
            assert.strictEqual(secondPrices.p24, nextMode === 'hour_only' ? 18 : 10.8,
                'daily policy must also be recalculated after an hourly-only mode changes');
            const nextTemplates = [template(nextMode, oldPrices), template(nextMode, secondPrices)];
            const second = await publish(userId, { ...identity(userId, account), tier: 2,
                base_hour_price: rule.prices[1], prices: secondPrices,
                computed_rent_mode: nextMode, force_publish: true }, { auth,
                get_template: async () => { modeQueries++; return nextTemplates.shift(); },
                change_template: async request => {
                    modeChanges++;
                    if (nextMode === 'day_only') assert.strictEqual(request.selfTemplate.shortRent, null);
                    else assert.strictEqual(request.selfTemplate.shortRent.obtainPrice, 3.6);
                    if (nextMode === 'hour_only') assert.strictEqual(request.selfTemplate.longRent, null);
                    else assert.strictEqual(request.selfTemplate.longRent.grades[0].obtainPrice, '10.8');
                    return { code: '0' };
                } });
            assert.strictEqual(second.ok, true, JSON.stringify(second));
            assert.strictEqual(modeChanges, 1, 'the next recalculated attempt can publish normally');
            assert.strictEqual((await read(userId, account)).channel_prd_info.zuhaowang.hour_basis, 3);
        }
    }

    const refreshUser = uid++;
    const refreshAccount = 'mode-refresh-old-id';
    await seed(refreshUser, refreshAccount, 'hour_only');
    await saveUserChannelPackageRatio(refreshUser, { channel: 'zuhaowang',
        ratios: { hour: 1.2, p24: 6, p72: 15, p168: 40 },
        daily_policy: { mode: 'decrease', factors: [1, 0.9, 0.8, 0.7] } });
    const refreshRule = { ...identity(refreshUser, refreshAccount), prices: [2, 3, 4, 5] };
    let refreshedTarget;
    let refreshChanges = 0;
    const ids = [];
    const refreshOptions = { auth, resolve_data_id: async () => 'new-mode-data-id',
        get_template: async id => {
            ids.push(id);
            if (id === refreshAccount) throw new Error('stale data id');
            assert.strictEqual(id, 'new-mode-data-id');
            return template('day_only', refreshedTarget || oldPrices);
        },
        change_template: async request => {
            refreshChanges++;
            assert.strictEqual(request.dataId, 'new-mode-data-id');
            assert.strictEqual(request.selfTemplate.shortRent, null);
            refreshedTarget = { hour: 3, ...Object.fromEntries(request.selfTemplate.longRent.grades
                .map(grade => [`p${grade.key}`, Number(grade.obtainPrice)])) };
            return { code: '0' };
        } };
    const firstRefreshRow = await read(refreshUser, refreshAccount);
    const firstRefreshPrices = (await adapter.resolveTierPrices({
        user_id: refreshUser, rule: refreshRule, account_row: firstRefreshRow
    })).tiers[1].prices;
    const mismatchAfterRefresh = await publish(refreshUser, { ...identity(refreshUser, refreshAccount),
        prices: firstRefreshPrices, base_hour_price: 3, computed_rent_mode: 'hour_only', force_publish: true }, refreshOptions);
    assert.strictEqual(mismatchAfterRefresh.error_detail.code, 'ZUHAOWANG_RENT_MODE_CHANGED');
    assert.strictEqual(refreshChanges, 0);
    const refreshRow = await read(refreshUser, refreshAccount);
    assert.strictEqual(refreshRow.channel_prd_info.zuhaowang.prd_id, refreshAccount,
        'mode refresh does not pretend that a new product identity or price has been published');
    assert.strictEqual(refreshRow.channel_prd_info.zuhaowang.rent_mode, 'day_only',
        'CAS uses the old database binding even after resolving a refreshed data id');
    const refreshPrices = (await adapter.resolveTierPrices({
        user_id: refreshUser, rule: refreshRule, account_row: refreshRow
    })).tiers[1].prices;
    const recoveredRefresh = await publish(refreshUser, { ...identity(refreshUser, refreshAccount),
        prices: refreshPrices, base_hour_price: 3, computed_rent_mode: 'day_only', force_publish: true }, refreshOptions);
    assert.strictEqual(recoveredRefresh.ok, true, JSON.stringify(recoveredRefresh));
    assert.strictEqual(refreshChanges, 1, 'a refreshed data id and changed mode must not block every future attempt');
    assert.deepStrictEqual(ids, [refreshAccount, 'new-mode-data-id', refreshAccount, 'new-mode-data-id', 'new-mode-data-id']);
    assert.strictEqual((await read(refreshUser, refreshAccount)).channel_prd_info.zuhaowang.prd_id, 'new-mode-data-id');

    for (const replaceIdentity of [false, true]) {
        const userId = uid++;
        const account = `concurrent-mode-${replaceIdentity}`;
        await seed(userId, account, 'day_only');
        let changed = 0;
        const result = await publish(userId, { ...identity(userId, account), base_hour_price: 2,
            prices: target, computed_rent_mode: 'day_only', force_publish: true }, { auth,
            get_template: async () => {
                const row = await read(userId, account);
                await upsertUserGameAccount({ ...identity(userId, account), channel_prd_info: {
                    zuhaowang: { ...row.channel_prd_info.zuhaowang, hourPrice: 4.4,
                        ...(replaceIdentity ? { prd_id: 'concurrent-new-product', rent_mode: 'hour_only' } : {}) }
                } });
                return template('hour_and_day', oldPrices);
            },
            change_template: async () => { changed++; return { code: '0' }; } });
        assert.strictEqual(result.error_detail.code, 'ZUHAOWANG_RENT_MODE_CHANGED');
        assert.strictEqual(changed, 0);
        const row = await read(userId, account);
        assert.strictEqual(row.channel_prd_info.zuhaowang.hourPrice, 4.4,
            'a mode-only refresh must preserve concurrently updated actual prices');
        assert.strictEqual(row.channel_prd_info.zuhaowang.prd_id, replaceIdentity ? 'concurrent-new-product' : account);
        assert.strictEqual(row.channel_prd_info.zuhaowang.rent_mode, replaceIdentity ? 'hour_only' : 'hour_and_day',
            'a replacement identity must not receive an old response mode');
    }
    console.log('[PASS] independent hourly basis: three rental modes, requests, verified snapshots/logs, legacy recovery, signatures and failure atomicity');
}

main().catch(error => { console.error(error); process.exitCode = 1; });
