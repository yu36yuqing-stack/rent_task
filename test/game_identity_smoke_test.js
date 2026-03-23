#!/usr/bin/env node
'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const sqlite3 = require('sqlite3').verbose();

const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'rent-task-game-identity-'));
const mainDbFile = path.join(tempRoot, 'rent_robot.db');
const runtimeDbFile = path.join(tempRoot, 'rent_robot_runtime.db');
const statsDbFile = path.join(tempRoot, 'rent_robot_stats.db');

process.env.MAIN_DB_FILE_PATH = mainDbFile;
process.env.RUNTIME_DB_FILE_PATH = runtimeDbFile;
process.env.STATS_DB_FILE_PATH = statsDbFile;

function openSqlite(file) {
    return new sqlite3.Database(file);
}

function run(db, sql, params = []) {
    return new Promise((resolve, reject) => {
        db.run(sql, params, function onRun(err) {
            if (err) return reject(err);
            resolve(this);
        });
    });
}

function get(db, sql, params = []) {
    return new Promise((resolve, reject) => {
        db.get(sql, params, (err, row) => {
            if (err) return reject(err);
            resolve(row || null);
        });
    });
}

function all(db, sql, params = []) {
    return new Promise((resolve, reject) => {
        db.all(sql, params, (err, rows) => {
            if (err) return reject(err);
            resolve(rows || []);
        });
    });
}

async function closeDb(db) {
    await new Promise((resolve, reject) => {
        db.close((err) => {
            if (err) return reject(err);
            resolve();
        });
    });
}

const {
    initUserGameAccountDb,
    upsertUserGameAccount,
    listAccountRemarksByUserAndIdentities
} = require('../database/user_game_account_db');
const {
    initUserPlatformRestrictDb,
    upsertPlatformRestrict,
    removePlatformRestrict,
    listPlatformRestrictByUserAndAccounts
} = require('../database/user_platform_restrict_db');
const {
    initProductOnoffHistoryDb,
    appendProductOnoffHistory
} = require('../database/product_onoff_history_db');
const { buildRecentActionsForUser } = require('../report/report_rent_status');

async function testPlatformRestrictMigrationAndIsolation() {
    const userId = 101;
    await initUserGameAccountDb();
    await upsertUserGameAccount({
        user_id: userId,
        game_account: 'legacy_only_account',
        game_id: '2',
        game_name: '和平精英',
        account_remark: 'legacy-remark'
    });
    await upsertUserGameAccount({
        user_id: userId,
        game_account: 'multi_game_legacy_account',
        game_id: '1',
        game_name: 'WZRY',
        account_remark: 'multi-wzry'
    });
    await upsertUserGameAccount({
        user_id: userId,
        game_account: 'multi_game_legacy_account',
        game_id: '3',
        game_name: 'CFM',
        account_remark: 'multi-cfm'
    });

    const db = openSqlite(mainDbFile);
    try {
        await run(db, `DROP TABLE IF EXISTS user_platform_restrict`);
        await run(db, `
            CREATE TABLE user_platform_restrict (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                user_id INTEGER NOT NULL,
                game_account TEXT NOT NULL DEFAULT '',
                platform TEXT NOT NULL DEFAULT '',
                reason TEXT NOT NULL DEFAULT '',
                detail TEXT NOT NULL DEFAULT '{}',
                create_date TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
                modify_date TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
                is_deleted INTEGER NOT NULL DEFAULT 0,
                desc TEXT NOT NULL DEFAULT ''
            )
        `);
        await run(db, `
            INSERT INTO user_platform_restrict
            (user_id, game_account, platform, reason, detail, create_date, modify_date, is_deleted, desc)
            VALUES (?, ?, 'uuzuhao', '平台限制上架', '{}', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP, 0, 'legacy row')
        `, [userId, 'legacy_only_account']);
        await run(db, `ALTER TABLE user_platform_restrict ADD COLUMN game_id TEXT NOT NULL DEFAULT '1'`);
        await run(db, `ALTER TABLE user_platform_restrict ADD COLUMN game_name TEXT NOT NULL DEFAULT 'WZRY'`);
        await run(db, `
            INSERT INTO user_platform_restrict
            (user_id, game_account, game_id, game_name, platform, reason, detail, create_date, modify_date, is_deleted, desc)
            VALUES (?, ?, '3', 'CFM', 'uuzuhao', '平台限制上架', '{}', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP, 0, 'multi legacy real gid')
        `, [userId, 'multi_game_legacy_account']);
        await run(db, `
            INSERT INTO user_platform_restrict
            (user_id, game_account, game_id, game_name, platform, reason, detail, create_date, modify_date, is_deleted, desc)
            VALUES (?, ?, '1', 'WZRY', 'uuzuhao', '平台限制上架', '{}', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP, 0, 'multi legacy default gid')
        `, [userId, 'multi_game_legacy_account']);
    } finally {
        await closeDb(db);
    }

    await initUserPlatformRestrictDb();

    const db2 = openSqlite(mainDbFile);
    try {
        const cols = await all(db2, `PRAGMA table_info("user_platform_restrict")`);
        assert(cols.some((x) => x.name === 'game_id'), 'user_platform_restrict 缺少 game_id');
        assert(cols.some((x) => x.name === 'game_name'), 'user_platform_restrict 缺少 game_name');

        const migrated = await get(db2, `
            SELECT game_id, game_name
            FROM user_platform_restrict
            WHERE user_id = ? AND game_account = ?
            LIMIT 1
        `, [userId, 'legacy_only_account']);
        assert(migrated, '未找到迁移后的 legacy row');
        assert.strictEqual(String(migrated.game_id), '2', 'legacy 限挂记录 game_id 回填错误');
        assert.strictEqual(String(migrated.game_name), '和平精英', 'legacy 限挂记录 game_name 回填错误');

        const multiRows = await all(db2, `
            SELECT game_id, game_name
            FROM user_platform_restrict
            WHERE user_id = ? AND game_account = ?
            ORDER BY id ASC
        `, [userId, 'multi_game_legacy_account']);
        assert.deepStrictEqual(
            multiRows.map((x) => `${x.game_id}:${x.game_name}`),
            ['3:CFM', '1:WZRY'],
            '多游戏账号的历史限挂记录不应被强行回填到其他游戏'
        );

        const idxCols = await all(db2, `PRAGMA index_info("uq_user_platform_restrict_active")`);
        assert.deepStrictEqual(
            idxCols.map((x) => x.name),
            ['user_id', 'game_id', 'game_account', 'platform'],
            '平台限挂唯一索引未切到 game identity'
        );
    } finally {
        await closeDb(db2);
    }

    await upsertPlatformRestrict(userId, {
        game_account: 'cross_game_account',
        game_id: '1',
        game_name: 'WZRY'
    }, 'uuzuhao', { source: 'case-1' }, 'gid=1');
    await upsertPlatformRestrict(userId, {
        game_account: 'cross_game_account',
        game_id: '2',
        game_name: '和平精英'
    }, 'uuzuhao', { source: 'case-2' }, 'gid=2');

    let rows = await listPlatformRestrictByUserAndAccounts(userId, [
        { game_account: 'cross_game_account', game_id: '1', game_name: 'WZRY' },
        { game_account: 'cross_game_account', game_id: '2', game_name: '和平精英' }
    ]);
    assert.strictEqual(rows.length, 2, '同账号跨游戏限挂应并存两条');

    const removed = await removePlatformRestrict(userId, {
        game_account: 'cross_game_account',
        game_id: '1',
        game_name: 'WZRY'
    }, 'uuzuhao', 'remove gid=1');
    assert.strictEqual(removed, true, '删除指定游戏限挂应返回 true');

    rows = await listPlatformRestrictByUserAndAccounts(userId, [
        { game_account: 'cross_game_account', game_id: '1', game_name: 'WZRY' },
        { game_account: 'cross_game_account', game_id: '2', game_name: '和平精英' }
    ]);
    assert.strictEqual(rows.length, 1, '删除一个游戏维度后应只剩一条');
    assert.strictEqual(rows[0].game_id, '2', '应保留未删除的游戏维度记录');
}

async function testProductOnoffMigrationBackfill() {
    const userId = 202;
    await initUserGameAccountDb();
    await upsertUserGameAccount({
        user_id: userId,
        game_account: 'single_game_acc',
        game_id: '2',
        game_name: '和平精英',
        account_remark: 'single-remark'
    });
    await upsertUserGameAccount({
        user_id: userId,
        game_account: 'multi_game_acc',
        game_id: '1',
        game_name: 'WZRY',
        account_remark: 'multi-wzry'
    });
    await upsertUserGameAccount({
        user_id: userId,
        game_account: 'multi_game_acc',
        game_id: '3',
        game_name: 'CFM',
        account_remark: 'multi-cfm'
    });

    const db = openSqlite(mainDbFile);
    try {
        await run(db, `DROP TABLE IF EXISTS product_onoff_history`);
        await run(db, `
            CREATE TABLE product_onoff_history (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                user_id INTEGER NOT NULL,
                user_account TEXT NOT NULL DEFAULT '',
                action_type TEXT NOT NULL DEFAULT '',
                platform TEXT NOT NULL DEFAULT '',
                game_account TEXT NOT NULL DEFAULT '',
                reason TEXT NOT NULL DEFAULT '',
                success INTEGER NOT NULL DEFAULT 0,
                skipped INTEGER NOT NULL DEFAULT 0,
                mode TEXT NOT NULL DEFAULT '',
                event_time INTEGER NOT NULL DEFAULT 0,
                create_date TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
                modify_date TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
                is_deleted INTEGER NOT NULL DEFAULT 0,
                desc TEXT NOT NULL DEFAULT ''
            )
        `);
        await run(db, `
            INSERT INTO product_onoff_history
            (user_id, user_account, action_type, platform, game_account, reason, success, skipped, mode, event_time, create_date, modify_date, is_deleted, desc)
            VALUES (?, 'u1', 'off_y', 'uuzuhao', 'single_game_acc', 'single', 1, 0, 'auto', ?, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP, 0, '')
        `, [userId, Date.now() - 2000]);
        await run(db, `
            INSERT INTO product_onoff_history
            (user_id, user_account, action_type, platform, game_account, reason, success, skipped, mode, event_time, create_date, modify_date, is_deleted, desc)
            VALUES (?, 'u1', 'off_y', 'uuzuhao', 'multi_game_acc', 'multi', 1, 0, 'auto', ?, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP, 0, '')
        `, [userId, Date.now() - 1000]);
    } finally {
        await closeDb(db);
    }

    await initProductOnoffHistoryDb();

    const db2 = openSqlite(mainDbFile);
    try {
        const rows = await all(db2, `
            SELECT game_account, game_id, game_name
            FROM product_onoff_history
            WHERE user_id = ?
            ORDER BY game_account ASC
        `, [userId]);
        const byAccount = Object.fromEntries(rows.map((x) => [x.game_account, x]));
        assert.strictEqual(String(byAccount.single_game_acc.game_id), '2', '唯一归属账号应回填到唯一 game_id');
        assert.strictEqual(String(byAccount.single_game_acc.game_name), '和平精英', '唯一归属账号应回填正确 game_name');
        assert.strictEqual(String(byAccount.multi_game_acc.game_id), '1', '多游戏账号不应被强猜到非默认 game_id');
    } finally {
        await closeDb(db2);
    }
}

async function testRemarksAndRecentActionsStaySeparatedByGame() {
    const userId = 303;
    await initUserGameAccountDb();
    await initProductOnoffHistoryDb();

    await upsertUserGameAccount({
        user_id: userId,
        game_account: 'same_acc',
        game_id: '1',
        game_name: 'WZRY',
        account_remark: '王者账号'
    });
    await upsertUserGameAccount({
        user_id: userId,
        game_account: 'same_acc',
        game_id: '2',
        game_name: '和平精英',
        account_remark: '吃鸡账号'
    });

    const remarkMap = await listAccountRemarksByUserAndIdentities(userId, [
        { game_account: 'same_acc', game_id: '1', game_name: 'WZRY' },
        { game_account: 'same_acc', game_id: '2', game_name: '和平精英' }
    ]);
    assert.strictEqual(remarkMap['1::same_acc'], '王者账号', 'WZRY remark 错误');
    assert.strictEqual(remarkMap['2::same_acc'], '吃鸡账号', '和平精英 remark 错误');

    const now = Date.now();
    await appendProductOnoffHistory({
        user_id: userId,
        user_account: 'user303',
        action_type: 'off_y',
        platform: 'uuzuhao',
        game_account: 'same_acc',
        game_id: '1',
        game_name: 'WZRY',
        reason: '王者下架',
        success: true,
        event_time: now - 2000
    });
    await appendProductOnoffHistory({
        user_id: userId,
        user_account: 'user303',
        action_type: 'off_y',
        platform: 'uuzuhao',
        game_account: 'same_acc',
        game_id: '2',
        game_name: '和平精英',
        reason: '吃鸡下架',
        success: true,
        event_time: now - 1000
    });

    const actions = await buildRecentActionsForUser(userId, { window_ms: 10 * 60 * 1000, limit: 8 });
    assert.strictEqual(actions.length, 2, '最近动作应按 game_id + game_account 分成两条');
    assert(actions.some((x) => x.includes('王者账号')), '最近动作缺少 WZRY remark');
    assert(actions.some((x) => x.includes('吃鸡账号')), '最近动作缺少 和平精英 remark');
  }

async function main() {
    try {
        await testPlatformRestrictMigrationAndIsolation();
        await testProductOnoffMigrationBackfill();
        await testRemarksAndRecentActionsStaySeparatedByGame();
        console.log('[PASS] game_identity_smoke_test');
    } catch (err) {
        console.error(`[FAIL] game_identity_smoke_test: ${err.message}`);
        process.exitCode = 1;
    } finally {
        fs.rmSync(tempRoot, { recursive: true, force: true });
    }
}

main();
