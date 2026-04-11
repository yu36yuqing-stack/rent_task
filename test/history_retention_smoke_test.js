#!/usr/bin/env node
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'rent-history-retention-'));
process.env.MAIN_DB_FILE_PATH = path.join(tempDir, 'rent_robot.db');
process.env.RUNTIME_DB_FILE_PATH = path.join(tempDir, 'rent_robot_runtime.db');
process.env.ORDER_DB_FILE_PATH = path.join(tempDir, 'rent_robot_order.db');

const { openDatabase } = require('../database/sqlite_client');
const { initUserGameAccountDb } = require('../database/user_game_account_db');
const { initUserBlacklistDb, pruneUserBlacklistHistory } = require('../database/user_blacklist_db');
const { initProductOnoffHistoryDb, pruneProductOnoffHistory } = require('../database/product_onoff_history_db');

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

function assertEqual(actual, expected, msg) {
    if (actual !== expected) {
        throw new Error(`${msg}: expected=${expected}, actual=${actual}`);
    }
}

function toDateTimeText(date) {
    const p = (n) => String(n).padStart(2, '0');
    return `${date.getFullYear()}-${p(date.getMonth() + 1)}-${p(date.getDate())} ${p(date.getHours())}:${p(date.getMinutes())}:${p(date.getSeconds())}`;
}

async function main() {
    await initUserGameAccountDb();
    await initUserBlacklistDb();
    await initProductOnoffHistoryDb();

    const oldDate = new Date(Date.now() - 40 * 24 * 3600 * 1000);
    const newDate = new Date(Date.now() - 5 * 24 * 3600 * 1000);
    const oldText = toDateTimeText(oldDate);
    const newText = toDateTimeText(newDate);

    const db = openDatabase();
    try {
        await run(db, `
            INSERT INTO user_blacklist_history
            (user_id, event_type, game_account, before_data, after_data, source, operator, create_date, modify_date, is_deleted, desc, game_id, game_name)
            VALUES
            (1, 'old', 'acc_old', '{}', '{}', 'smoke', 'smoke', ?, ?, 0, '', '1', 'WZRY'),
            (1, 'new', 'acc_new', '{}', '{}', 'smoke', 'smoke', ?, ?, 0, '', '1', 'WZRY')
        `, [oldText, oldText, newText, newText]);

        await run(db, `
            INSERT INTO product_onoff_history
            (user_id, user_account, action_type, platform, game_account, game_id, game_name, reason, success, skipped, mode, event_time, create_date, modify_date, is_deleted, desc)
            VALUES
            (1, 'u1', 'off_y', 'uuzuhao', 'acc_old', '1', 'WZRY', 'old', 1, 0, 'smoke', ?, ?, ?, 0, ''),
            (1, 'u1', 'off_y', 'uuzuhao', 'acc_new', '1', 'WZRY', 'new', 1, 0, 'smoke', ?, ?, ?, 0, '')
        `, [oldDate.getTime(), oldText, oldText, newDate.getTime(), newText, newText]);
    } finally {
        db.close();
    }

    const blacklistRet = await pruneUserBlacklistHistory({ retain_days: 30 });
    const onoffRet = await pruneProductOnoffHistory({ retain_days: 30 });
    assertEqual(Number(blacklistRet.deleted || 0), 1, 'blacklist history 应只删除 1 条旧数据');
    assertEqual(Number(onoffRet.deleted || 0), 1, 'product onoff history 应只删除 1 条旧数据');

    const verifyDb = openDatabase();
    try {
        const blCount = await get(verifyDb, `SELECT COUNT(*) AS total FROM user_blacklist_history`);
        const onoffCount = await get(verifyDb, `SELECT COUNT(*) AS total FROM product_onoff_history`);
        assertEqual(Number((blCount && blCount.total) || 0), 1, 'blacklist history 应保留最近 30 天数据');
        assertEqual(Number((onoffCount && onoffCount.total) || 0), 1, 'product onoff history 应保留最近 30 天数据');
    } finally {
        verifyDb.close();
    }

    console.log(`[PASS] history_retention_smoke_test temp_dir=${tempDir}`);
}

main().catch((err) => {
    console.error(`[FAIL] history_retention_smoke_test: ${err.message}`);
    process.exit(1);
});
