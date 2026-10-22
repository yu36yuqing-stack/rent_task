'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rent-online-auth-state-'));
for (const name of ['MAIN', 'RUNTIME', 'ORDER', 'STATS', 'PRICE']) {
    process.env[`${name}_DB_FILE_PATH`] = path.join(dir, `${name}.db`);
}
const common = require('../common/uuzuhao_auth_state');
const accounts = require('../database/user_game_account_db');
const { openDatabase } = require('../database/sqlite_client');
const { getUuzuhaoAuthState: read, recordUuzuhaoAuthObservation: record } = require('../database/uuzuhao_auth_state_db');
const service = require('../product/uuzuhao_online_auth_service');
const identity = { game_account: '2256481878', game_id: '1', game_name: 'WZRY' };
function sql(statement, params = []) {
    const db = openDatabase();
    return new Promise((resolve, reject) => db.run(statement, params, function (error) {
        db.close();
        if (error) reject(error); else resolve(this);
    }));
}
async function seed(userId = 16, gameId = '1') {
    return accounts.upsertUserGameAccount({ user_id: userId, ...identity, game_id: gameId,
        game_name: gameId === '2' ? 'HPJY' : 'WZRY', channel_status: { uuzuhao: '上架' } });
}

async function main() {
    for (const input of [undefined, null, '', 'bad', '[]', [], 1, false]) {
        assert.deepStrictEqual(common.normalizeUuzuhaoAuthState(input), { required: false });
    }
    assert.deepStrictEqual(common.normalizeUuzuhaoAuthState('{"required":true}'), { required: true });
    assert.strictEqual(common.normalizeUuzuhaoAuthState({ required: 'false' }).required, false);
    for (const error of [{ code: 201010027 }, { uuzuhao_response: { code: '201010027' } },
        { code: '-50000', message: '***-50000***:QQ鉴权失败，请稍候再试。' },
        { uuzuhao_response: { code: -50000, msg: 'QQ鉴权失败' } }]) {
        assert.strictEqual(common.classifyOnlineAuthFailure(error).reason, 'QQ鉴权失败');
    }
    for (const error of [undefined, {}, { code: '85004', message: '访问超时' },
        { code: -50000, message: '其他错误' }, { message: 'code=201010027' }, { code: '12101001' }]) {
        assert.strictEqual(common.classifyOnlineAuthFailure(error), null);
    }
    const paused = common.pausedOnlineError({ required: true });
    assert.strictEqual(paused.code, common.AUTHORIZATION_PAUSED);
    assert.ok(paused.message.includes('重新授权'));
    assert.strictEqual(paused.uuzuhao_auth_state.required, true);
    assert.ok(service.onlineRequestStartedAt() > 0);

    await seed();
    await seed(12);
    await seed(16, '2');
    assert.strictEqual((await read(16, identity)).required, false);
    assert.strictEqual((await read(16, { ...identity, game_account: 'missing' })).required, false);
    await assert.rejects(() => read(0, identity), /user_id/);
    await assert.rejects(() => read(16, {}), /game_account/);
    await assert.rejects(() => record(16, identity, { request_started_at: NaN }), /request_started_at/);
    await assert.rejects(() => record(16, { account: 'missing' }, { request_started_at: 1 }), /找不到账号/);

    const error = Object.assign(new Error('code=201010027, msg=查询失败'), { code: '201010027' });
    const first = await service.recordOnlineAuthFailure(16, identity, error, 100);
    assert.strictEqual(first.required, true);
    assert.strictEqual(error.uuzuhao_auth_state.required, true);
    assert.strictEqual(first.error_code, '201010027');
    assert.ok(first.first_failed_at);
    const markedRow = await accounts.getLatestUserGameAccountByUserAndAccount(16, identity.game_account, '1');
    assert.ok(Math.abs(Date.now() - Date.parse(markedRow.modify_date.replace(' ', 'T') + '+08:00')) < 10000,
        'account modify_date must retain the existing Beijing-time convention');
    assert.strictEqual((await read(12, identity)).required, false);
    assert.strictEqual((await read(16, { ...identity, game_id: '2' })).required, false);
    await assert.rejects(() => service.assertOnlineAuthAllowed(16, identity), { code: common.AUTHORIZATION_PAUSED });
    assert.strictEqual((await service.assertOnlineAuthAllowed(16, identity, { manual: true })).required, true);
    assert.strictEqual(await service.recordOnlineAuthFailure(16, identity, new Error('fetch failed'), 105), null);
    const repeat = await record(16, identity, { required: true, request_started_at: 110, error_code: '201010027', reason: 'QQ鉴权失败' });
    assert.strictEqual(repeat.first_failed_at, first.first_failed_at);
    assert.ok(repeat.version > first.version);

    await seed();
    const afterSync = await accounts.getLatestUserGameAccountByUserAndAccount(16, identity.game_account, '1');
    assert.strictEqual(afterSync.uuzuhao_auth_state.required, true, 'product sync must preserve the marker');
    assert.strictEqual(afterSync.channel_status.uuzuhao, '上架');
    const recovered = await service.recordManualOnlineSuccess(16, identity, 200);
    assert.strictEqual(recovered.required, false);
    assert.ok(recovered.recovered_at);
    assert.strictEqual((await record(16, identity, { required: true, request_started_at: 150 })).required, false,
        'older in-flight failure must not re-block a later successful manual check');
    await record(16, identity, { required: true, request_started_at: 300 });
    assert.strictEqual((await service.recordManualOnlineSuccess(16, identity, 250)).required, true,
        'older success must not clear a newer failure');
    await service.recordManualOnlineSuccess(16, identity, 350);
    const again = await record(16, identity, { required: true, request_started_at: 400 });
    assert.strictEqual(again.required, true);
    assert.strictEqual(again.error_code, '');

    const source = require.resolve('../database/uuzuhao_auth_state_db');
    delete require.cache[source];
    assert.strictEqual((await require(source).getUuzuhaoAuthState(16, identity)).required, true, 'marker survives module reload');
    await sql('ALTER TABLE user_game_account ADD COLUMN fixture_extra TEXT');
    const rebuildDb = openDatabase();
    try { await accounts._internal.reorderUserGameAccountColumnsIfNeeded(rebuildDb); } finally { rebuildDb.close(); }
    assert.strictEqual((await read(16, identity)).required, true, 'legacy column rebuild must preserve authorization state');
    await sql("UPDATE user_game_account SET uuzuhao_auth_state='bad' WHERE user_id=16 AND game_id='1'");
    assert.strictEqual((await read(16, identity)).required, false);

    await sql('ALTER TABLE user_game_account DROP COLUMN uuzuhao_auth_state');
    delete require.cache[require.resolve('../database/user_game_account_db')];
    const migration = require('../database/migrations/20261022_021_uuzuhao_online_auth_state');
    await migration.up();
    await migration.up();
    assert.strictEqual((await read(16, identity)).required, false, 'legacy schema migrates idempotently');
    console.log('[PASS] online auth state: classification, persistence, migration, sync, identity isolation and response ordering');
}
main().catch(error => { console.error(error); process.exitCode = 1; });
