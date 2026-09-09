#!/usr/bin/env node
'use strict';

const assert = require('assert');
const childProcess = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'rent-action-five-e-'));
const mainDbFile = path.join(tempDir, 'rent_robot.db');
process.env.MAIN_DB_FILE_PATH = mainDbFile;
process.env.SQLITE_JOURNAL_MODE = 'DELETE';
childProcess.execFileSync('sqlite3', [mainDbFile, `
CREATE TABLE IF NOT EXISTS user_game_account (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER NOT NULL DEFAULT 0,
    game_account TEXT NOT NULL DEFAULT '',
    game_id TEXT NOT NULL DEFAULT '1',
    game_name TEXT NOT NULL DEFAULT 'WZRY',
    is_deleted INTEGER NOT NULL DEFAULT 0
);
INSERT INTO user_game_account (user_id, game_account, game_id, game_name, is_deleted)
VALUES (1, 'steam_user', '4', 'CSGO', 0);
`]);

const {
    detectConflictsAndBuildSnapshot,
    executeActions,
    buildPlatformRowsFromUserAccounts
} = require('../action_engine/action_engine');
const { listRecentProductOnoffByUser } = require('../database/product_onoff_history_db');
const {
    upsertPlatformRestrict,
    listPlatformRestrictByUserAndAccounts
} = require('../database/user_platform_restrict_db');

const fiveERow = {
    user_id: 1,
    game_account: 'steam_user',
    account_remark: '5E test',
    game_id: '4',
    game_name: 'CSGO',
    channel_status: { '5e': '上架' },
    channel_prd_info: {
        '5e': {
            account_no: 'CS5819323392',
            prd_id: 'CS5819323392',
            steam_id: '76561199407966750',
            shelf_status: 'on_shelf',
            shelf_status_raw: 1,
            rent_status: 'idle',
            rent_status_raw: 0
        }
    }
};

async function main() {
    const { fiveEData } = buildPlatformRowsFromUserAccounts([fiveERow]);
    assert.strictEqual(fiveEData.length, 1);
    assert.strictEqual(fiveEData[0].account, 'steam_user');
    assert.strictEqual(fiveEData[0].account_no, 'CS5819323392');
    assert.strictEqual(fiveEData[0].steam_id, '76561199407966750');

    const blacklisted = detectConflictsAndBuildSnapshot({
        fiveEData,
        blacklistAccounts: new Set(['4::steam_user'])
    });
    assert.deepStrictEqual(blacklisted.actions.map((action) => action.type), ['off_5e']);
    assert.strictEqual(blacklisted.actions[0].item.account_no, 'CS5819323392');
    assert.strictEqual(blacklisted.actions[0].item.steam_id, '76561199407966750');

    const downFiveEData = [{ ...fiveEData[0], status: '下架' }];
    const recovered = detectConflictsAndBuildSnapshot({
        fiveEData: downFiveEData,
        blacklistAccounts: new Set()
    });
    assert.deepStrictEqual(recovered.actions.map((action) => action.type), ['on_5e']);

    const renting = detectConflictsAndBuildSnapshot({
        fiveEData: [{ ...fiveEData[0], status: '租赁中' }],
        blacklistAccounts: new Set()
    });
    assert.strictEqual(renting.actions.length, 0, '5E租赁中时不应生成上下架动作');

    const calls = [];
    const runRecord = { actions: [], errors: [] };
    await upsertPlatformRestrict(
        1,
        { game_account: 'steam_user', game_id: '4', game_name: 'CSGO' },
        '5e',
        { code: 'test_restrict' },
        '5E shelf smoke test'
    );
    await executeActions({
        user: { id: 1, account: 'five_e_test_user' },
        actions: [blacklisted.actions[0], recovered.actions[0]],
        runRecord,
        changeFiveEShelfStatus: async (item, shelfStatus) => {
            calls.push({ item, shelfStatus });
            return { ok: true, trace_id: `trace-${shelfStatus}` };
        }
    });
    assert.deepStrictEqual(calls.map((call) => call.shelfStatus), [0, 1]);
    assert.ok(calls.every((call) => call.item.account_no === 'CS5819323392'));
    assert.deepStrictEqual(runRecord.actions.map((action) => action.type), ['off_5e', 'on_5e']);
    assert.strictEqual(runRecord.errors.length, 0);
    assert.strictEqual(runRecord.action_timing.queue_timing['5e'].planned, 2);
    assert.strictEqual(runRecord.action_timing.queue_timing['5e'].success, 2);

    const history = await listRecentProductOnoffByUser(1, { limit: 10 });
    assert.deepStrictEqual(history.map((row) => row.action_type), ['off_5e', 'on_5e']);
    assert.ok(history.every((row) => row.platform === '5e'));
    const restrictRows = await listPlatformRestrictByUserAndAccounts(1, [
        { game_account: 'steam_user', game_id: '4', game_name: 'CSGO' }
    ]);
    assert.strictEqual(restrictRows.length, 0, '5E成功上架后应清理平台限制标记');

    console.log(`[PASS] action_engine_five_e_shelf_smoke_test temp_dir=${tempDir}`);
}

main().catch((error) => {
    console.error(`[FAIL] action_engine_five_e_shelf_smoke_test: ${error.message}`);
    process.exit(1);
});
