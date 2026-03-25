#!/usr/bin/env node
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'rent-cooldown-config-'));
process.env.MAIN_DB_FILE_PATH = path.join(tempDir, 'rent_robot.db');
process.env.RUNTIME_DB_FILE_PATH = path.join(tempDir, 'rent_robot_runtime.db');

const { initOrderDb, upsertOrder } = require('../database/order_db');
const { initUserRuleDb, upsertUserRuleByName } = require('../database/user_rule_db');
const { initUserGameAccountDb } = require('../database/user_game_account_db');
const { initUserBlacklistDb } = require('../database/user_blacklist_db');
const { initUserBlacklistSourceDb, listBlacklistSourcesByUser } = require('../database/user_blacklist_source_db');
const {
    reconcileOrderCooldownEntryByUser
} = require('../order/order_cooldown');
const {
    COOLDOWN_RELEASE_RULE_NAME
} = require('../order/order_cooldown_config');

function assertEqual(actual, expected, msg) {
    if (actual !== expected) {
        throw new Error(`${msg}: expected=${expected}, actual=${actual}`);
    }
}

function assertTrue(cond, msg) {
    if (!cond) throw new Error(msg);
}

function formatDateTime(sec) {
    const d = new Date(Number(sec || 0) * 1000);
    const p = (n) => String(n).padStart(2, '0');
    return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
}

async function seedActiveOrder(userId, orderNo, gameAccount, nowSec, endOffsetSec) {
    const endSec = nowSec + endOffsetSec;
    await upsertOrder({
        user_id: userId,
        channel: 'uuzuhao',
        order_no: orderNo,
        game_id: '1',
        game_name: 'WZRY',
        game_account: gameAccount,
        role_name: `role_${gameAccount}`,
        order_status: '租赁中',
        order_amount: 12,
        rent_hour: 1,
        ren_way: '时租',
        rec_amount: 10,
        start_time: formatDateTime(nowSec - 1800),
        end_time: formatDateTime(endSec),
        create_date: formatDateTime(nowSec - 1800),
        desc: 'cooldown config smoke'
    });
    return endSec;
}

async function main() {
    const nowSec = Math.floor(Date.now() / 1000);

    await initOrderDb();
    await initUserRuleDb();
    await initUserGameAccountDb();
    await initUserBlacklistDb();
    await initUserBlacklistSourceDb();

    const defaultUserId = 101;
    const defaultEndSec = await seedActiveOrder(defaultUserId, 'ORDER_DEFAULT', 'acct_default', nowSec, 300);
    const defaultRet = await reconcileOrderCooldownEntryByUser(defaultUserId);
    assertEqual(defaultRet.hit_accounts, 1, '默认配置应命中 1 个账号');
    assertEqual(defaultRet.release_delay_min, 10, '默认释放时长应为 10 分钟');

    const defaultRows = await listBlacklistSourcesByUser(defaultUserId);
    assertEqual(defaultRows.length, 1, '默认配置应写入 1 条冷却 source');
    assertEqual(Number((defaultRows[0].detail || {}).cooldown_until), defaultEndSec + 10 * 60, '默认配置 cooldown_until 应为结束后 10 分钟');

    const customUserId = 102;
    await upsertUserRuleByName(customUserId, {
        rule_name: COOLDOWN_RELEASE_RULE_NAME,
        rule_detail: {
            release_delay_min: 30
        }
    }, {
        desc: 'cooldown config smoke'
    });
    const customEndSec = await seedActiveOrder(customUserId, 'ORDER_CUSTOM', 'acct_custom', nowSec, 300);
    const customRet = await reconcileOrderCooldownEntryByUser(customUserId);
    assertEqual(customRet.hit_accounts, 1, '自定义配置应命中 1 个账号');
    assertEqual(customRet.release_delay_min, 30, '自定义释放时长应为 30 分钟');

    const customRows = await listBlacklistSourcesByUser(customUserId);
    assertEqual(customRows.length, 1, '自定义配置应写入 1 条冷却 source');
    assertEqual(Number((customRows[0].detail || {}).cooldown_until), customEndSec + 30 * 60, '自定义 cooldown_until 应为结束后 30 分钟');
    assertTrue(String(customRows[0].reason || '') === '冷却期下架', 'reason 应为冷却期下架');

    console.log('[PASS] order_cooldown_config_smoke_test');
}

main().catch((err) => {
    console.error(`[FAIL] order_cooldown_config_smoke_test: ${err.message}`);
    process.exit(1);
});
