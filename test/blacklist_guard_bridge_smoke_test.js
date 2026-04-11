#!/usr/bin/env node
'use strict';

/**
 * blacklist_guard_bridge_smoke_test.js
 *
 * 目标：
 * 1) 验证 deleteBlacklistWithGuard 在 blocked 场景会自动桥接风险事件/任务。
 * 2) 验证全程不触发真实三方查询（通过 stub probe service）。
 *
 * 运行：
 *   node test/blacklist_guard_bridge_smoke_test.js
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'rent-blacklist-guard-bridge-'));
process.env.MAIN_DB_FILE_PATH = path.join(tempDir, 'rent_robot.db');
process.env.RUNTIME_DB_FILE_PATH = path.join(tempDir, 'rent_robot_runtime.db');
process.env.ORDER_DB_FILE_PATH = path.join(tempDir, 'rent_robot_order.db');
const { openDatabase } = require('../database/sqlite_client');
const { initUserDb, createUserByAdmin } = require('../database/user_db');
const {
    initUserBlacklistDb,
    upsertUserBlacklistEntry
} = require('../database/user_blacklist_db');
const { initProdRiskEventDb } = require('../database/prod_risk_event_db');
const { initProdGuardTaskDb } = require('../database/prod_guard_task_db');

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

function assertTrue(cond, msg) {
    if (!cond) throw new Error(msg);
}

function assertEqual(actual, expected, msg) {
    if (actual !== expected) {
        throw new Error(`${msg}: expected=${expected}, actual=${actual}`);
    }
}

async function cleanupByUserId(userId) {
    const uid = Number(userId || 0);
    if (!uid) return;
    const db = openDatabase();
    try {
        await run(db, `DELETE FROM prod_guard_task WHERE user_id = ?`, [uid]);
        await run(db, `DELETE FROM prod_risk_event WHERE user_id = ?`, [uid]);
        await run(db, `DELETE FROM user_blacklist_history WHERE user_id = ?`, [uid]);
        await run(db, `DELETE FROM user_blacklist WHERE user_id = ?`, [uid]);
        await run(db, `DELETE FROM user_game_account WHERE user_id = ?`, [uid]);
        await run(db, `DELETE FROM user_platform_restrict WHERE user_id = ?`, [uid]);
        await run(db, `DELETE FROM user_rule WHERE user_id = ?`, [uid]);
        await run(db, `DELETE FROM user WHERE id = ?`, [uid]);
    } finally {
        db.close();
    }
}

async function queryOne(sql, params = []) {
    const db = openDatabase();
    try {
        return await get(db, sql, params);
    } finally {
        db.close();
    }
}

async function queryAll(sql, params = []) {
    const db = openDatabase();
    try {
        return await all(db, sql, params);
    } finally {
        db.close();
    }
}

async function main() {
    await initUserDb();
    await initUserBlacklistDb();
    await initProdRiskEventDb();
    await initProdGuardTaskDb();

    const testSuffix = `${Date.now()}`;
    const testAccount = `guard_bridge_${testSuffix}`;
    let testUser = null;

    const accOnline = `T_ON_${testSuffix}`;
    const accForbidden = `T_FB_${testSuffix}`;
    const accClear = `T_CL_${testSuffix}`;

    // Inject probe stubs before loading blacklist_release_guard.
    const probePath = require.resolve('../product/prod_probe_cache_service');
    const releaseGuardPath = require.resolve('../blacklist/blacklist_release_guard');
    delete require.cache[probePath];
    delete require.cache[releaseGuardPath];

    const onlineMap = new Map([
        [accOnline, { online: true, forbidden: false }],
        [accForbidden, { online: false, forbidden: true }],
        [accClear, { online: false, forbidden: false }]
    ]);

    require.cache[probePath] = {
        id: probePath,
        filename: probePath,
        loaded: true,
        exports: {
            queryOnlineStatusCached: async (_uid, gameAccount) => {
                const key = String(gameAccount || '').trim();
                const hit = onlineMap.get(key) || { online: false, forbidden: false };
                return { game_account: key, online: Boolean(hit.online) };
            },
            queryForbiddenStatusCached: async (_uid, gameAccount) => {
                const key = String(gameAccount || '').trim();
                const hit = onlineMap.get(key) || { online: false, forbidden: false };
                return { game_account: key, enabled: Boolean(hit.forbidden) };
            }
        }
    };
    // eslint-disable-next-line global-require
    const { deleteBlacklistWithGuard } = require('../blacklist/blacklist_release_guard');

    try {
        testUser = await createUserByAdmin({
            account: testAccount,
            password: 'Passw0rd!123',
            name: 'guard smoke',
            user_type: '内部',
            switch: {
                order_3_off: true,
                prod_guard_enabled: true
            },
            desc: 'test blacklist_guard_bridge_smoke_test'
        });
        const uid = Number(testUser.id || 0);
        assertTrue(uid > 0, '创建测试用户失败');

        // Case 1: blocked by online -> bridge risk/task
        await upsertUserBlacklistEntry(uid, { game_account: accOnline, reason: '4单下架' }, {
            source: 'test',
            operator: 'smoke',
            desc: 'seed online'
        });
        const onlineOut = await deleteBlacklistWithGuard(uid, accOnline, {
            source: 'smoke_online',
            operator: 'smoke',
            desc: 'try delete online'
        });
        assertTrue(Boolean(onlineOut && onlineOut.blocked), 'online 场景应 blocked');
        assertEqual(String(onlineOut.blocked_reason || ''), '检测在线', 'online 场景 blocked_reason 错误');
        assertTrue(Boolean(onlineOut.bridge && onlineOut.bridge.bridged), 'online 场景应桥接风控任务');

        const blOnline = await queryOne(
            `SELECT reason FROM user_blacklist WHERE user_id = ? AND game_account = ? AND is_deleted = 0 LIMIT 1`,
            [uid, accOnline]
        );
        assertEqual(String((blOnline && blOnline.reason) || ''), '检测在线', 'online 场景黑名单原因应改写为检测在线');

        const openEventsOnline = await queryAll(
            `SELECT id FROM prod_risk_event
             WHERE user_id = ? AND game_account = ? AND risk_type = 'online_non_renting' AND status = 'open' AND is_deleted = 0`,
            [uid, accOnline]
        );
        assertEqual(openEventsOnline.length, 1, 'online 场景应有 1 条 open 风险事件');
        const eventIdOnline = Number(openEventsOnline[0].id || 0);
        const taskRowsOnline = await queryAll(
            `SELECT id, status FROM prod_guard_task WHERE event_id = ? AND is_deleted = 0`,
            [eventIdOnline]
        );
        assertEqual(taskRowsOnline.length, 1, 'online 场景应有 1 条风控任务');
        assertTrue(['pending', 'watching'].includes(String(taskRowsOnline[0].status || '')), 'online 场景任务状态应为 pending/watching');

        // Case 2: blocked again (idempotent)
        const onlineOut2 = await deleteBlacklistWithGuard(uid, accOnline, {
            source: 'smoke_online',
            operator: 'smoke',
            desc: 'retry delete online'
        });
        assertTrue(Boolean(onlineOut2 && onlineOut2.blocked), 'online 重试场景应 blocked');
        assertTrue(Boolean(onlineOut2.bridge && onlineOut2.bridge.bridged), 'online 重试场景应继续桥接成功');
        const openEventsOnline2 = await queryAll(
            `SELECT id FROM prod_risk_event
             WHERE user_id = ? AND game_account = ? AND risk_type = 'online_non_renting' AND status = 'open' AND is_deleted = 0`,
            [uid, accOnline]
        );
        assertEqual(openEventsOnline2.length, 1, 'online 重试不应新增第二条 open 风险事件');

        // Case 3: blocked by forbidden
        await upsertUserBlacklistEntry(uid, { game_account: accForbidden, reason: '维护中' }, {
            source: 'test',
            operator: 'smoke',
            desc: 'seed forbidden'
        });
        const forbiddenOut = await deleteBlacklistWithGuard(uid, accForbidden, {
            source: 'smoke_forbidden',
            operator: 'smoke',
            desc: 'try delete forbidden'
        });
        assertTrue(Boolean(forbiddenOut && forbiddenOut.blocked), 'forbidden 场景应 blocked');
        assertEqual(String(forbiddenOut.blocked_reason || ''), '禁玩中', 'forbidden 场景 blocked_reason 错误');
        assertTrue(Boolean(forbiddenOut.bridge && forbiddenOut.bridge.bridged), 'forbidden 场景应桥接风控任务');

        // Case 4: not blocked -> removed
        await upsertUserBlacklistEntry(uid, { game_account: accClear, reason: '维护中' }, {
            source: 'test',
            operator: 'smoke',
            desc: 'seed clear'
        });
        const clearOut = await deleteBlacklistWithGuard(uid, accClear, {
            source: 'smoke_clear',
            operator: 'smoke',
            desc: 'try delete clear'
        });
        assertTrue(Boolean(clearOut && clearOut.removed), 'clear 场景应 removed');
        const blClear = await queryOne(
            `SELECT id FROM user_blacklist WHERE user_id = ? AND game_account = ? AND is_deleted = 0 LIMIT 1`,
            [uid, accClear]
        );
        assertTrue(!blClear, 'clear 场景黑名单应被删除');

        console.log('[PASS] blacklist_guard_bridge_smoke_test');
    } finally {
        const uid = Number(testUser && testUser.id ? testUser.id : 0);
        await cleanupByUserId(uid).catch(() => {});
    }
}

main().catch((e) => {
    console.error('[FAIL] blacklist_guard_bridge_smoke_test:', e && e.message ? e.message : e);
    process.exit(1);
});
