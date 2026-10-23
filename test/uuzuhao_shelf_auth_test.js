'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rent-shelf-auth-'));
for (const name of ['MAIN', 'RUNTIME', 'ORDER', 'STATS', 'PRICE']) process.env[`${name}_DB_FILE_PATH`] = path.join(dir, `${name}.db`);
global.fetch = async () => { throw new Error('unexpected external request'); };
const accounts = require('../database/user_game_account_db');
const db = require('../database/uuzuhao_auth_state_db');
const common = require('../common/uuzuhao_auth_state');
const online = require('../product/uuzuhao_online_auth_service');
const shelf = require('../product/uuzuhao_shelf_auth_service');
const identity = { game_account: '2766409479', game_id: '2', game_name: '和平精英' };
const product = { ...identity, status: '上架', prd_info: { prd_id: 'fixture-product' } };
const seed = (uid, key = identity) => accounts.upsertUserGameAccount({ user_id: uid, ...key,
    channel_status: { uuzuhao: '下架', uhaozu: '上架' }, channel_prd_info: { uuzuhao: { hourPrice: 2.4 } } });

async function main() {
    for (const error of [undefined, {}, { code: 12101001 }, { code: '201010027' }, { code: 500 }, { msg: '12115014' }]) {
        assert.strictEqual(common.classifyShelfAuthFailure(error), null);
    }
    for (const code of common.SHELF_AUTH_ERROR_CODES) {
        for (const error of [{ code: Number(code) }, { uuzuhao_response: { code: ` ${code} ` } }]) {
            assert.strictEqual(common.classifyShelfAuthFailure(error).error_code, code);
            assert.strictEqual(common.classifyOnlineAuthFailure(error), null, 'online endpoint must not classify shelf-only errors');
        }
        assert.strictEqual(common.pausedOnlineError({ error_code: code }).message, common.SHELF_REAUTHORIZE_MESSAGES[code]);
    }
    await seed(12);
    await seed(8);
    const otherGame = { ...identity, game_id: '1', game_name: 'WZRY' };
    await seed(12, otherGame);
    const before = await accounts.getLatestUserGameAccountByUserAndAccount(12, identity.game_account, '2');
    for (const code of common.SHELF_AUTH_ERROR_CODES) {
        let calls = 0;
        const result = await shelf.executeUuzuhaoOnShelf(12, identity, async () => {
            calls++;
            return { ok: false, code: Number(code), msg: 'fixture authorization failure' };
        });
        assert.strictEqual(result.uuzuhao_auth_state.required, true);
        assert.strictEqual(result.uuzuhao_auth_state.error_code, code);
        const state = await db.getUuzuhaoAuthState(12, identity);
        for (let i = 0; i < 3; i++) {
            const skipped = await shelf.executeUuzuhaoOnShelf(12, identity, async () => { calls++; });
            assert.strictEqual(skipped.skipped, true);
            assert.ok(skipped.msg.includes('自动补上架已暂停'));
        }
        assert.strictEqual(calls, 1, 'repeat rounds must not make new shelf requests');
        assert.strictEqual((await shelf.executeUuzuhaoOnShelf(8, identity, async () => ({ ok: true }))).ok, true);
        assert.strictEqual((await shelf.executeUuzuhaoOnShelf(12, otherGame, async () => ({ ok: true }))).ok, true);
        const onlineError = Object.assign(new Error('QQ failure'), { code: '201010027' });
        await online.recordOnlineAuthFailure(12, identity, onlineError, state.request_started_at + 100);
        assert.strictEqual(onlineError.uuzuhao_auth_state.error_code, code, 'online failure must not replace shelf recovery requirements');
        assert.strictEqual((await online.recordManualOnlineSuccess(12, identity, state.request_started_at + 200)).required, true);
        const untouched = await accounts.getLatestUserGameAccountByUserAndAccount(12, identity.game_account, '2');
        assert.deepStrictEqual(untouched.channel_status, before.channel_status);
        assert.deepStrictEqual(untouched.channel_prd_info, before.channel_prd_info);
        for (const bad of [{ ...product, prd_info: undefined }, { ...product, status: '下架' },
            { ...product, status: '未知' }, { ...product, prd_info: { prd_id: 'p', off_type: 'AUTHORIZE_ERROR' } }]) {
            assert.strictEqual(await shelf.recoverShelfAuthByProduct(12, bad, state.request_started_at + 300), null);
        }
        assert.strictEqual((await shelf.recoverShelfAuthByProduct(12, product, state.request_started_at - 1)).required, true,
            'a product pull started before the failed shelf request must not clear it');
        const after = await shelf.recoverShelfAuthByProduct(12, product, state.request_started_at + 1);
        assert.strictEqual(after.required, false);
        assert.ok(after.recovered_at);
        assert.strictEqual(await shelf.recoverShelfAuthByProduct(12, product, state.request_started_at + 2), null);
    }
    const result = await shelf.executeUuzuhaoOnShelf(12, identity, async () => ({ ok: false, code: 12101012 }));
    assert.strictEqual(result.code, 12101012);
    assert.strictEqual((await db.getUuzuhaoAuthState(12, identity)).required, false);
    assert.strictEqual(await shelf.executeUuzuhaoOnShelf(12, identity, async () => false), false);
    const thrown = Object.assign(new Error('shelf auth expired'), { code: '12115012' });
    await assert.rejects(() => shelf.executeUuzuhaoOnShelf(12, identity, async () => { throw thrown; }), error => {
        assert.strictEqual(error.uuzuhao_auth_state.required, true);
        return true;
    });
    let current = await db.getUuzuhaoAuthState(12, identity);
    await shelf.recoverShelfAuthByProduct(12, { ...product, status: '租赁中' }, current.request_started_at + 1);
    await assert.rejects(() => shelf.executeUuzuhaoOnShelf(12, identity, async () => { throw new Error('fetch failed'); }), /fetch failed/);
    assert.strictEqual((await db.getUuzuhaoAuthState(12, identity)).required, false);

    const originalFetch = global.fetch;
    const api = require('../uuzuhao/uuzuhao_api');
    const fixtureAuth = { app_key: 'fixture', app_secret: 'fixture', api_base: 'https://fixture.invalid' };
    try {
        for (const code of common.SHELF_AUTH_ERROR_CODES) {
            let requests = 0;
            global.fetch = async (url, options) => {
                assert.ok(String(url).startsWith(fixtureAuth.api_base));
                requests++;
                const body = JSON.parse(options.body);
                const response = String(url).endsWith('/list')
                    ? { code: 0, data: { productPublishList: [{ accountNo: identity.game_account, gameId: 2, productId: 'p1' }] } }
                    : { code: Number(code), msg: 'fixture shelf authorization failure' };
                if (!String(url).endsWith('/list')) assert.strictEqual(body.productId, 'p1');
                return { ok: true, status: 200, text: async () => JSON.stringify(response) };
            };
            const request = () => api.youpinOnShelf(null, identity.game_account, { ...identity, auth: fixtureAuth, with_detail: true });
            const response = await shelf.executeUuzuhaoOnShelf(8, identity, request);
            assert.strictEqual(response.uuzuhao_auth_state.error_code, code, 'actual API error parser must feed the persisted marker');
            const previousRequests = requests;
            assert.strictEqual((await shelf.executeUuzuhaoOnShelf(8, identity, request)).skipped, true);
            assert.strictEqual(requests, previousRequests, 'marked account must skip product lookup as well as shelf write');
            await shelf.recoverShelfAuthByProduct(8, product, online.onlineRequestStartedAt());
            assert.strictEqual((await db.getUuzuhaoAuthState(8, identity)).required, false);
        }
    } finally { global.fetch = originalFetch; }

    await assert.rejects(() => shelf.executeUuzuhaoOnShelf(0, identity,
        async () => { throw new Error('invalid identity must fail before sending'); }), /user_id/);
    await assert.rejects(() => shelf.executeUuzuhaoOnShelf(8, identity, async () => {
        require('child_process').execFileSync('sqlite3', [process.env.MAIN_DB_FILE_PATH,
            "UPDATE user_game_account SET is_deleted=1 WHERE user_id=8"]);
        return { ok: false, code: 12115014 };
    }), /找不到账号/, 'a failed marker write must surface rather than pretend authorization was persisted');

    const ts = Date.now() + 1000;
    await db.recordUuzuhaoAuthObservation(12, identity, { required: true, error_code: '12115014', request_started_at: ts });
    const originalRecord = db.recordUuzuhaoAuthObservation;
    let raced = false;
    db.recordUuzuhaoAuthObservation = async (uid, key, observation) => {
        raced = true;
        await originalRecord(uid, key, { required: true, error_code: '201010027', request_started_at: ts + 9 });
        return originalRecord(uid, key, observation);
    };
    delete require.cache[require.resolve('../product/uuzuhao_shelf_auth_service')];
    try {
        const raceService = require('../product/uuzuhao_shelf_auth_service');
        const newer = await raceService.recoverShelfAuthByProduct(12, product, ts + 10);
        assert.strictEqual(raced, true);
        assert.strictEqual(newer.required, true);
        assert.strictEqual(newer.error_code, '201010027', 'another failure written after recovery read must be retained atomically');
    } finally {
        db.recordUuzuhaoAuthObservation = originalRecord;
        delete require.cache[require.resolve('../product/uuzuhao_shelf_auth_service')];
    }
    await db.recordUuzuhaoAuthObservation(12, identity, { required: true, request_started_at: 9e15, error_code: '201010027' });
    assert.strictEqual(await shelf.recoverShelfAuthByProduct(12, product, 9e15 + 1), null, 'product sync must not clear old online markers');
    current = await db.recordUuzuhaoAuthObservation(12, identity, {
        required: false, request_started_at: 9e15 + 2, if_error_codes: common.SHELF_AUTH_ERROR_CODES
    });
    assert.strictEqual(current.required, true, 'conditional recovery is enforced atomically inside the transaction');
    const { executeActions, buildPlatformRowsFromUserAccounts, detectConflictsAndBuildSnapshot } = require('../action_engine/action_engine');
    const row = { ...before, uuzuhao_auth_state: { required: true, error_code: '12115014' } };
    const planned = detectConflictsAndBuildSnapshot({ ...buildPlatformRowsFromUserAccounts([row]), blacklistAccounts: new Set() });
    assert.strictEqual(planned.actions.some(a => a.type === 'on_y'), false);
    const action = { type: 'on_y', item: { ...identity, account: identity.game_account }, reason: 'fixture queued before marking' };
    const record = { actions: [], errors: [] };
    await executeActions({ user: { id: 12 }, actions: [action], runRecord: record,
        youpinOnShelf: async () => { throw new Error('paused queued action must not execute'); } });
    assert.strictEqual(record.actions[0].skipped, true);
    assert.strictEqual(record.actions[0].mode, 'waiting_authorization');
    assert.strictEqual(record.errors.length, 0);
    console.log('[PASS] shelf auth: two codes, persistence, repeated rounds, identities, timeout, queued action, recovery and stale responses');
}

main().catch(error => { console.error(error); process.exitCode = 1; });
