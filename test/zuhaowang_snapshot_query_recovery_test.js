'use strict';

const fs = require('fs'), os = require('os'), path = require('path'), assert = require('assert');
const { spawnSync } = require('child_process');
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rent-zhw-query-recovery-'));
for (const key of ['MAIN', 'PRICE', 'RUNTIME', 'ORDER', 'STATS']) process.env[`${key}_DB_FILE_PATH`] = path.join(dir, `${key}.db`);
let authRows = [{ platform: 'zuhaowang', auth_status: 'valid', channel_enabled: true,
    auth_payload: { yuanbao: { token_yuanbao: 'fixture', device_id: 'fixture', package_name: 'fixture' } } }];
require('../database/user_platform_auth_db').listUserPlatformAuth = async () => authRows;
let queries = 0;
let templateHour = 3.2;
let queryError;
const prices = { hour: 3.2, p24: 19.2, p72: 48, p168: 128 };
const template = (p = prices, day = true) => ({ accountInfo: { priceTemplateType: 1 }, selfTemplate: {
    shortRent: { isOpen: !day, obtainPrice: day ? 3.4 : p.hour },
    longRent: { isOpen: true, grades: ['p24', 'p72', 'p168'].map((key) => ({ key: key.slice(1), currentObtainPrice: p[key] })) }
} });
const query = async (id, auth, options) => {
    assert.strictEqual(id, 'goods'); assert.strictEqual(options.user_id, 8); assert(auth.token_yuanbao);
    queries += 1;
    if (queryError) throw queryError;
    return template(templateHour === 3.2 ? prices : { ...prices, p24: 30 });
};
require('../zuhaowang/zuhaowang_price_api').getPriceTemplate = query;
require('../zuhaowang/zuhaowang_price_api').changePriceTemplate = () => { throw new Error('recovery must never invoke price writes'); };
const { recoverZuhaowangPriceSnapshotsFromTemplates: recover } = require('../price/zuhaowang_price_snapshot_service');
const { recoverSnapshots: command } = require('../scripts/recover_zuhaowang_price_snapshots');
const account = { user_id: 8, game_id: '1', game_name: 'WZRY', game_account: 'same',
    account_remark: 'fresh remark', channel_prd_info: { zuhaowang: { prd_id: 'goods', raw_status: 1 } } };
const runtime = { user_id: 8, game_id: '1', game_account: 'same', channel: 'zuhaowang', applied_tier: 1,
    desired_tier: 4, desired_price_signature: JSON.stringify({ tier: 4, prices: { ...prices, hour: 99 } }),
    applied_price_signature: JSON.stringify({ tier: 1, prices }) };
const auth = { token_yuanbao: 'fixture' };
const getAuth = async (uid) => { assert.strictEqual(uid, 8); return auth; };
const options = { get_auth: getAuth, get_template: query };

async function main() {
    const invalid = [{ ...runtime, user_id: 9 }, { ...runtime, channel: 'uhaozu' }, { ...runtime, is_deleted: 1 },
        ...[0, 5, 1.5].map((applied_tier) => ({ ...runtime, applied_tier })),
        ...['bad', 'null', '{}', JSON.stringify({ tier: 2, prices }), JSON.stringify({ tier: 1 }),
            JSON.stringify({ tier: 1, prices: { ...prices, hour: 0 } }),
            JSON.stringify({ tier: 1, prices: { ...prices, p24: 0.001 } })].map((applied_price_signature) => ({ ...runtime, applied_price_signature }))];
    assert.deepStrictEqual(await recover(8, [account], invalid, options), {});
    assert.strictEqual(queries, 0);
    const snapshot = (await recover(8, [account], [runtime], options))['1::same'];
    assert.strictEqual(snapshot.hour_basis, 3.2, 'use only confirmed applied tier, never desired tier');
    assert.strictEqual(snapshot.hourPrice, 0, 'do not use the inactive remote 3.4 quote');
    assert.strictEqual(snapshot.p24Price, 19.2);
    const dataOnly = { ...account, channel_prd_info: { zuhaowang: { data_id: 'goods' } } };
    assert.strictEqual((await recover(8, [dataOnly], [runtime], options))['1::same'].hour_basis, 3.2);
    templateHour = 5;
    assert.deepStrictEqual(await recover(8, [account], [runtime], options), {});
    templateHour = 3.2;
    for (const error of [new Error('private token'), Object.assign(new Error('fixture'), { code: 'REMOTE_READ' })]) {
        queryError = error;
        assert.deepStrictEqual(await recover(8, [account], [runtime], options), {});
    }
    queryError = null;
    for (const error of [new Error('private auth'), Object.assign(new Error('fixture'), { code: 'NO_AUTH' })]) {
        assert.deepStrictEqual(await recover(8, [account], [runtime], { get_auth: async () => { throw error; } }), {});
    }
    assert.strictEqual((await recover(8, [account], [runtime]))['1::same'].hour_basis, 3.2);
    authRows = [];
    assert.deepStrictEqual(await recover(8, [account], [runtime]), {});
    authRows = [{ platform: 'zuhaowang', channel_enabled: true, auth_status: 'valid', auth_payload: { yuanbao: auth } }];

    let saves = [];
    let current = [account];
    const commandOptions = { ...options, list_auth: async () => [{ platform: 'zuhaowang', channel_enabled: true }],
        list_accounts: async () => current, list_runtimes: async () => [runtime], load_logs: async () => [],
        save: async (row) => saves.push(row) };
    const beforeQueries = queries;
    assert.strictEqual((await command({ user_id: 8 }, commandOptions)).recovered, 0);
    assert.strictEqual(queries, beforeQueries, 'default dry run never queries remote templates');
    const dry = await command({ user_id: 8, query_missing: true }, commandOptions);
    assert.strictEqual(dry.dry_run, true);
    assert.strictEqual(dry.list[0].hour_basis, 3.2);
    assert.strictEqual(saves.length, 0);
    const applied = await command({ user_id: 8, query_missing: true, apply: true }, commandOptions);
    assert.strictEqual(applied.dry_run, false);
    assert.strictEqual(saves.length, 1);
    assert.strictEqual(saves[0].channel_prd_info.zuhaowang.raw_status, 1);
    assert.strictEqual(saves[0].channel_prd_info.zuhaowang.hour_basis, 3.2);
    assert.strictEqual(saves[0].account_remark, 'fresh remark');
    assert.deepStrictEqual(Object.keys(saves[0].channel_prd_info), ['zuhaowang']);
    assert.strictEqual((await command({ user_id: 8, query_missing: true, apply: true }, { ...commandOptions,
        list_accounts: async () => [dataOnly] })).recovered, 1);
    const disabled = { ...commandOptions, list_auth: async () => [{ platform: 'zuhaowang', channel_enabled: false }] };
    const disabledQueries = queries;
    assert.strictEqual((await command({ user_id: 8, query_missing: true, apply: true }, disabled)).reason, 'channel_disabled');
    assert.strictEqual(queries, disabledQueries);
    let authCalls = 0;
    assert.strictEqual((await command({ user_id: 8, query_missing: true, apply: true }, { ...commandOptions,
        list_auth: async () => [{ platform: 'zuhaowang', channel_enabled: ++authCalls === 1 }] })).recovered, 0);
    let accountCalls = 0;
    const changedRows = [{ ...account, user_id: 9 }, { ...account, is_deleted: 1 }, { ...account, asset_status: 'sold' },
        { ...account, channel_prd_info: { zuhaowang: { prd_id: 'replacement' } } },
        { ...account, channel_prd_info: {} }, { ...account, game_id: '2' }];
    assert.strictEqual((await command({ user_id: 8, query_missing: true, apply: true }, { ...commandOptions,
        list_accounts: async () => ++accountCalls === 1 ? [account] : changedRows })).recovered, 0);
    await assert.rejects(() => command({ user_id: 0 }, commandOptions), /positive integer/);

    // Exercise the CLI's real local read/write defaults in isolated databases, without API calls.
    const { upsertUserGameAccount, listUserGameAccounts } = require('../database/user_game_account_db');
    const { createPricePublishItemLog } = require('../database/price_publish_log_db');
    await upsertUserGameAccount(account);
    await createPricePublishItemLog({ batch_id: 'cli-history', user_id: 8, channel: 'zuhaowang', game_name: 'WZRY',
        game_account: 'same', goods_id: 'goods', publish_status: 'success', response_data: { verification_status: 'full' },
        request_data: { target_prices: prices }, after_data: { rent_mode: 'day_only', prices: { ...prices, hour: 0 } } });
    for (const args of [[], ['--user-id', 'bad']]) {
        const result = spawnSync(process.execPath, ['scripts/recover_zuhaowang_price_snapshots.js', ...args], { env: process.env, encoding: 'utf8' });
        assert.strictEqual(result.status, 1);
        assert(result.stderr.includes('positive integer'));
    }
    const cli = (args) => spawnSync(process.execPath, ['scripts/recover_zuhaowang_price_snapshots.js', '--user-id', '8', ...args], { env: process.env, encoding: 'utf8' });
    const preview = cli([]);
    assert.strictEqual(preview.status, 0, preview.stderr);
    assert(preview.stdout.includes('"dry_run": true'));
    assert.strictEqual((await listUserGameAccounts(8, 1, 200)).list[0].channel_prd_info.zuhaowang.hour_basis, undefined);
    const write = cli(['--apply']);
    assert.strictEqual(write.status, 0, write.stderr);
    assert(write.stdout.includes('"dry_run": false'));
    assert.strictEqual((await listUserGameAccounts(8, 1, 200)).list[0].channel_prd_info.zuhaowang.hour_basis, 3.2);
    const noMissing = cli(['--query-missing']);
    assert.strictEqual(noMissing.status, 0, noMissing.stderr);
    await command({ user_id: 8, query_missing: true }, { ...options, list_auth: commandOptions.list_auth, list_accounts: async () => [], load_logs: async () => [] });
    console.log('[PASS] ZHW opt-in query recovery: confirmed applied prices, disabled/auth/query failures, dry-run, explicit local apply and CLI defaults');
}
main().catch((error) => { console.error(error); process.exitCode = 1; });
