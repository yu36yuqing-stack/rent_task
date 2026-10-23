'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rent-shelf-auth-chain-'));
for (const name of ['MAIN', 'RUNTIME', 'ORDER', 'STATS', 'PRICE']) process.env[`${name}_DB_FILE_PATH`] = path.join(dir, `${name}.db`);
global.fetch = async () => { throw new Error('unexpected external request'); };
const accountDb = require('../database/user_game_account_db');
const { getUuzuhaoAuthState, recordUuzuhaoAuthObservation } = require('../database/uuzuhao_auth_state_db');
const api = require('../uuzuhao/uuzuhao_api');
const authDb = require('../database/user_platform_auth_db');
const orderRules = require('../order/service/order_rule_service');
const orderQuery = require('../order/service/order_query_service');
const auth = { app_key: 'fixture', app_secret: 'fixture', api_base: 'https://fixture.invalid' };
authDb.listUserPlatformAuth = async () => [{ platform: 'uuzuhao', auth_status: 'valid', channel_enabled: true, auth_payload: auth },
    { platform: 'uhaozu', auth_status: 'valid', channel_enabled: true, auth_payload: { cookie: 'fixture' } }];
orderRules.releaseOrderCooldownBlacklistByUser = async () => ({ skipped: true });
orderQuery.listLinkedOrderAccountsByUser = async () => [];
let code = 12115014;
let shelfCalls = 0;
let otherShelfCalls = 0;
let pullFailure = false;
let onPull = null;
let goods = [];
api.youpinOnShelf = async () => { shelfCalls++; return { ok: code === 0, code, msg: 'fixture auth failure' }; };
api.collectYoupinData = async () => {
    if (pullFailure) throw new Error('fixture product pull failure');
    if (onPull) await onPull();
    return { data: goods };
};
require('../uhaozu/uhaozu_api').collectUhaozuData = async () => ({ data: [] });
require('../uhaozu/uhaozu_api').uhaozuOnShelf = async () => { otherShelfCalls++; return true; };
const engine = require('../action_engine/action_engine');
const { syncUserAccountsByAuth } = require('../product/product');
const key = { game_account: 'same-account', game_id: '1', game_name: 'WZRY' };
const seed = (uid, extra = {}) => accountDb.upsertUserGameAccount({ user_id: uid, ...key,
    channel_status: { uuzuhao: '下架', uhaozu: '下架' },
    channel_prd_info: { uuzuhao: { prd_id: 'p1', hourPrice: 2.4 }, uhaozu: { prd_id: 'u1' } }, ...extra });
const rows = async uid => (await accountDb.listUserGameAccounts(uid, 1, 200)).list;
const run = async uid => engine.executeUserActionsIfNeeded({ user: { id: uid, account: 'fixture' }, rows: await rows(uid) });
const product = (status, offType = '') => ({ account: key.game_account, id: 'p1', status,
    raw: { gameId: '1', roleName: 'fixture', offType, productHourRentPrice: 2.4 } });

async function main() {
    await seed(8);
    await seed(12);
    const first = await run(8);
    assert.strictEqual(shelfCalls, 1);
    assert.strictEqual(otherShelfCalls, 1, 'other channel continues despite uuzuhao authorization failure');
    assert.strictEqual((await getUuzuhaoAuthState(8, key)).error_code, '12115014');
    assert(first.errors.length > 0);
    for (let i = 0; i < 2; i++) await run(8);
    assert.strictEqual(shelfCalls, 1, 'the real action planning path must suppress repeated on_y actions');
    code = 12115012;
    await run(12);
    assert.strictEqual(shelfCalls, 2);
    assert.strictEqual((await getUuzuhaoAuthState(12, key)).error_code, '12115012');
    goods = [product('下架', 'AUTHORIZE_ERROR')];
    await syncUserAccountsByAuth(8);
    assert.strictEqual((await getUuzuhaoAuthState(8, key)).required, true);
    goods = [product('上架', 'ACCOUNT_ERROR')];
    await syncUserAccountsByAuth(8);
    assert.strictEqual((await getUuzuhaoAuthState(8, key)).required, true, 'an active-looking row with an authorization error is not recovery');
    pullFailure = true;
    await syncUserAccountsByAuth(8);
    assert.strictEqual((await getUuzuhaoAuthState(8, key)).required, true, 'failed pull cannot clear a marker using stored product data');
    pullFailure = false;
    goods = [product('上架')];
    await syncUserAccountsByAuth(8);
    assert.strictEqual((await getUuzuhaoAuthState(8, key)).required, false);
    assert.strictEqual((await getUuzuhaoAuthState(12, key)).required, true, 'sync recovery is user scoped');
    assert.strictEqual((await rows(8))[0].channel_prd_info.uuzuhao.hourPrice, 2.4);
    assert.strictEqual((await rows(8))[0].channel_status.uhaozu, '下架');
    await seed(8, { channel_status: { uuzuhao: '下架' } });
    code = 0;
    const recoveredRun = await run(8);
    assert.strictEqual(recoveredRun.errors.length, 0);
    assert.strictEqual(shelfCalls, 3, 'a recovered identity is eligible for new shelf requests');
    goods = [product('租赁中')];
    await syncUserAccountsByAuth(12);
    assert.strictEqual((await getUuzuhaoAuthState(12, key)).required, false);

    onPull = async () => recordUuzuhaoAuthObservation(8, key, {
        required: true, error_code: '12115014', reason: 'newer failure', request_started_at: Date.now() + 10000
    });
    goods = [product('上架')];
    await syncUserAccountsByAuth(8);
    assert.strictEqual((await getUuzuhaoAuthState(8, key)).required, true, 'late successful pull cannot erase a newer shelf failure');
    console.log('[PASS] shelf auth integration: real planner/executor, repeat rounds, user isolation, other channel, product sync and recovery ordering');
}

main().catch(error => { console.error(error); process.exitCode = 1; });
