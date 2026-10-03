'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rent-zhw-history-db-'));
process.env.PRICE_DB_FILE_PATH = path.join(dir, 'price.db');
const { createPricePublishItemLog: create, listLatestSuccessfulPriceSnapshotsByUser: latest } = require('../database/price_publish_log_db');
const { openPriceDatabase } = require('../database/sqlite_client');
const input = { batch_id: 'first', user_id: 8, channel: 'zuhaowang', game_name: 'WZRY',
    game_account: 'same', goods_id: 'goods', publish_status: 'success',
    response_data: { verification_status: 'full' }, request_data: { target_prices: { hour: 3.2 } } };
async function main() {
    for (const uid of [0, -1, 1.5, 'bad']) assert.deepStrictEqual(await latest(uid, 'zuhaowang'), []);
    assert.deepStrictEqual(await latest(8, ''), []);
    assert.deepStrictEqual(await latest(8, undefined), []);
    assert(!fs.existsSync(process.env.PRICE_DB_FILE_PATH));
    assert.deepStrictEqual(await latest(8, 'zuhaowang'), []);
    for (const patch of [{}, { batch_id: 'newer' }, { batch_id: 'failed', publish_status: 'fail' },
        { batch_id: 'other-user', user_id: 9 }, { batch_id: 'other-channel', channel: 'uhaozu' },
        { batch_id: 'other-game', game_name: '和平精英' }, { batch_id: 'other-goods', goods_id: 'new' }]) await create({ ...input, ...patch });
    const rows = await latest(8, ' zuhaowang ');
    assert.strictEqual(rows.length, 3);
    assert.strictEqual(rows.find((r) => r.game_name === 'WZRY' && r.goods_id === 'goods').batch_id, 'newer');
    assert(rows.some((r) => r.game_name === '和平精英'));
    assert(rows.some((r) => r.goods_id === 'new'));
    assert.strictEqual(rows[0].response_data.verification_status, 'full');
    assert.strictEqual(rows[0].request_data.target_prices.hour, 3.2);
    assert(rows.every((r) => r.user_id === 8 && r.channel === 'zuhaowang'));
    const db = openPriceDatabase();
    await new Promise((resolve, reject) => db.run("UPDATE price_publish_item_log SET is_deleted=1 WHERE batch_id='newer'", (e) => e ? reject(e) : resolve()));
    await new Promise((resolve) => db.close(resolve));
    assert.strictEqual((await latest(8, 'zuhaowang')).find((r) => r.game_name === 'WZRY' && r.goods_id === 'goods').batch_id, 'first');
    console.log('[PASS] ZHW historical snapshot DB: latest successful per user/game/account/product, failures, soft deletion, parsed evidence and invalid inputs');
}
main().catch((error) => { console.error(error); process.exitCode = 1; });
