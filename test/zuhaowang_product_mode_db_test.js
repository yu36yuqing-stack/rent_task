'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'rent-zhw-mode-cas-'));
for (const key of ['MAIN', 'RUNTIME', 'ORDER', 'STATS', 'PRICE']) process.env[`${key}_DB_FILE_PATH`] = path.join(temporary, `${key}.db`);
const { openMainDatabase } = require('../database/sqlite_client');
const { upsertUserGameAccount } = require('../database/user_game_account_db');
const { updateZuhaowangRentMode: update } = require('../database/zuhaowang_product_mode_db');

async function sql(statement, params = []) {
    const db = openMainDatabase();
    try {
        return await new Promise((resolve, reject) => db.all(statement, params, (error, rows) => error ? reject(error) : resolve(rows)));
    } finally { await new Promise(resolve => db.close(resolve)); }
}

async function main() {
    for (const [userId, gameId, name] of [[1, '1', 'WZRY'], [1, '2', '和平精英'], [2, '1', 'WZRY']]) {
        await upsertUserGameAccount({ user_id: userId, game_id: gameId, game_name: name, game_account: 'shared',
            channel_prd_info: { zuhaowang: { prd_id: 'old-product', rent_mode: 'day_only', hour_basis: 2, p24Price: 9,
                nested: { keep: 'value' } }, uuzuhao: { prd_id: 'other', hourPrice: 99 } } });
    }
    const identity = { game_id: '1', game_account: 'shared' };
    const read = () => sql('SELECT user_id,game_id,channel_prd_info FROM user_game_account ORDER BY user_id,game_id');
    const before = await read();
    for (const args of [[0, identity, 'old-product', 'hour_only', 'day_only'],
        [1.5, identity, 'old-product', 'hour_only', 'day_only'], [1, null, 'old-product', 'hour_only', 'day_only'],
        [1, { game_account: 'shared' }, 'old-product', 'hour_only', 'day_only'],
        [1, { game_id: '1' }, 'old-product', 'hour_only', 'day_only'],
        [1, identity, '', 'hour_only', 'day_only'], [1, identity, 'old-product', 'invalid', 'day_only']]) {
        assert.strictEqual(await update(...args), false);
    }
    assert.strictEqual(await update(1, identity, 'wrong-product', 'hour_only', 'day_only'), false);
    assert.strictEqual(await update(1, identity, 'old-product', 'hour_only', 'hour_and_day'), false);
    assert.deepStrictEqual(await read(), before);

    // A price changed since the publisher read the row: JSON patch must keep the newer value.
    await sql("UPDATE user_game_account SET channel_prd_info=json_set(channel_prd_info,'$.zuhaowang.p24Price',13) WHERE user_id=1 AND game_id='1'");
    assert.strictEqual(await update(1, identity, 'old-product', ' hour_and_day ', 'day_only'), true);
    const after = await read();
    const changed = JSON.parse(after[0].channel_prd_info);
    assert.strictEqual(changed.zuhaowang.rent_mode, 'hour_and_day');
    assert.strictEqual(changed.zuhaowang.p24Price, 13);
    assert.strictEqual(changed.zuhaowang.hour_basis, 2);
    assert.deepStrictEqual(changed.zuhaowang.nested, { keep: 'value' });
    assert.deepStrictEqual(changed.uuzuhao, { prd_id: 'other', hourPrice: 99 });
    assert.deepStrictEqual(after.slice(1), before.slice(1), 'other game and owner remain untouched');
    assert.strictEqual(await update(1, identity, 'old-product', 'hour_only', 'day_only'), false, 'late observation cannot revert newer mode');

    await sql("UPDATE user_game_account SET channel_prd_info=json_set(channel_prd_info,'$.zuhaowang.prd_id','','$.zuhaowang.data_id','fallback') WHERE user_id=1 AND game_id='1'");
    assert.strictEqual(await update(1, identity, 'fallback', 'hour_only', 'hour_and_day'), true);
    await sql("UPDATE user_game_account SET asset_status='sold' WHERE user_id=1 AND game_id='1'");
    assert.strictEqual(await update(1, identity, 'fallback', 'day_only', 'hour_only'), false);
    await sql("UPDATE user_game_account SET asset_status='active',is_deleted=1 WHERE user_id=1 AND game_id='1'");
    assert.strictEqual(await update(1, identity, 'fallback', 'day_only', 'hour_only'), false);
    await sql("UPDATE user_game_account SET is_deleted=0,channel_prd_info='invalid-json' WHERE user_id=1 AND game_id='1'");
    assert.strictEqual(await update(1, identity, 'fallback', 'day_only', 'hour_only'), false);
    await sql("UPDATE user_game_account SET channel_prd_info='{}' WHERE user_id=1 AND game_id='1'");
    assert.strictEqual(await update(1, identity, 'fallback', 'day_only', ''), false);
    await sql("UPDATE user_game_account SET channel_prd_info=? WHERE user_id=1 AND game_id='1'", [JSON.stringify({ zuhaowang: { data_id: 'fallback' } })]);
    assert.strictEqual(await update(1, identity, 'fallback', 'day_only'), true, 'missing legacy mode supports an empty expected value');
    await sql('DROP TABLE user_game_account');
    await assert.rejects(() => update(1, identity, 'fallback', 'day_only', 'day_only'), /no such table/);
    console.log('[PASS] atomic ZHW mode refresh: identity, CAS, concurrent price preservation, legacy metadata, invalid JSON and SQL failures');
}
main().catch(error => { console.error(error); process.exitCode = 1; });
