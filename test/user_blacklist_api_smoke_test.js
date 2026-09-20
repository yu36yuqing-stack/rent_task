#!/usr/bin/env node
'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'user-blacklist-api-'));
process.env.MAIN_DB_FILE_PATH = path.join(tempDir, 'main.db');
process.env.RUNTIME_DB_FILE_PATH = path.join(tempDir, 'runtime.db');
process.env.ORDER_DB_FILE_PATH = path.join(tempDir, 'order.db');

const { openDatabase } = require('../database/sqlite_client');
const {
    initUserBlacklistDb,
    listBlacklistedAccountsByUser,
    listUserBlacklistByUser,
    listUserBlacklistByUserWithMeta,
    upsertUserBlacklistEntry,
    removeUserBlacklistEntry,
    hardDeleteUserBlacklistEntry
} = require('../database/user_blacklist_db');

function get(db, sql, params = []) {
    return new Promise((resolve, reject) => {
        db.get(sql, params, (err, row) => {
            if (err) return reject(err);
            resolve(row || null);
        });
    });
}

(async () => {
    await initUserBlacklistDb();
    assert.deepStrictEqual(await listBlacklistedAccountsByUser(0), []);
    assert.deepStrictEqual(await listUserBlacklistByUser(0), []);
    assert.deepStrictEqual(await listUserBlacklistByUserWithMeta(0), []);
    await assert.rejects(() => upsertUserBlacklistEntry(0, { game_account: 'bad' }), /user_id/);
    await assert.rejects(() => upsertUserBlacklistEntry(7, {}), /game_account/);

    await upsertUserBlacklistEntry(7, {
        game_account: 'soft_remove',
        game_id: '2',
        game_name: '和平精英',
        remark: 'soft role',
        reason: '维护中'
    }, { source: 'api_smoke', operator: 'tester', desc: 'insert' });
    await upsertUserBlacklistEntry(7, {
        game_account: 'soft_remove',
        game_id: '2',
        game_name: '和平精英',
        remark: 'soft role',
        reason: '维护中'
    }, {
        source: 'api_smoke',
        operator: 'tester',
        create_date: '2026-01-02 03:04:05',
        desc: 'custom create date'
    });

    const identities = await listBlacklistedAccountsByUser(7);
    const entries = await listUserBlacklistByUser(7);
    const meta = await listUserBlacklistByUserWithMeta(7);
    assert.strictEqual(identities.length, 1);
    assert.strictEqual(identities[0].game_id, '2');
    assert.strictEqual(entries[0].reason, '维护中');
    assert.strictEqual(meta[0].desc, 'custom create date');

    await assert.rejects(() => removeUserBlacklistEntry(0, 'soft_remove'), /user_id/);
    await assert.rejects(() => removeUserBlacklistEntry(7, ''), /game_account/);
    assert.strictEqual(await removeUserBlacklistEntry(7, 'missing', { game_id: '2' }), false);
    assert.strictEqual(await removeUserBlacklistEntry(7, {
        game_account: 'soft_remove',
        game_id: '2',
        game_name: '和平精英'
    }, { source: 'api_smoke', operator: 'tester', desc: 'soft delete' }), true);
    assert.strictEqual((await listUserBlacklistByUser(7)).length, 0);

    await upsertUserBlacklistEntry(7, {
        game_account: 'hard_remove',
        game_id: '1',
        game_name: 'WZRY',
        reason: '账号找回'
    }, { source: 'api_smoke', operator: 'tester' });
    await assert.rejects(() => hardDeleteUserBlacklistEntry(0, 'hard_remove'), /user_id/);
    await assert.rejects(() => hardDeleteUserBlacklistEntry(7, ''), /game_account/);
    assert.strictEqual(await hardDeleteUserBlacklistEntry(7, 'missing'), false);
    assert.strictEqual(await hardDeleteUserBlacklistEntry(7, 'hard_remove', { reason_expected: '维护中' }), false);
    assert.strictEqual(await hardDeleteUserBlacklistEntry(7, 'hard_remove', {
        reason_expected: '账号找回',
        source: 'api_smoke',
        operator: 'tester',
        desc: 'hard delete'
    }), true);

    const db = openDatabase();
    try {
        const counts = await get(db, `
            SELECT
              SUM(event_type = 'delete') AS soft_deleted,
              SUM(event_type = 'hard_delete') AS hard_deleted
            FROM user_blacklist_history
            WHERE user_id = 7
        `);
        assert.strictEqual(Number(counts.soft_deleted || 0), 1);
        assert.strictEqual(Number(counts.hard_deleted || 0), 1);
    } finally {
        db.close();
    }

    console.log(`[PASS] user_blacklist_api_smoke_test temp_dir=${tempDir}`);
})().catch((err) => {
    console.error(`[FAIL] user_blacklist_api_smoke_test: ${err.stack || err.message}`);
    process.exit(1);
});
