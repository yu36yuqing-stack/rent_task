#!/usr/bin/env node
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'rent-cooldown-release-'));
process.env.MAIN_DB_FILE_PATH = path.join(tempDir, 'rent_robot.db');
process.env.RUNTIME_DB_FILE_PATH = path.join(tempDir, 'rent_robot_runtime.db');

const { initUserBlacklistDb, listUserBlacklistByUser } = require('../database/user_blacklist_db');
const { initUserBlacklistSourceDb, upsertBlacklistSource, listBlacklistSourcesByUser } = require('../database/user_blacklist_source_db');
const { initUserGameAccountDb } = require('../database/user_game_account_db');
const { initUserPlatformAuthDb, upsertUserPlatformAuth } = require('../database/user_platform_auth_db');
const { initOrderSyncDb, setLastSyncTimestamp } = require('../database/order_sync_db');
const { releaseOrderCooldownBlacklistByUser } = require('../order/order_cooldown');

function assertEqual(actual, expected, msg) {
    if (actual !== expected) {
        throw new Error(`${msg}: expected=${expected}, actual=${actual}`);
    }
}

function assertTrue(cond, msg) {
    if (!cond) throw new Error(msg);
}

async function main() {
    const userId = 8;
    const gameAccount = '67309130';
    const cooldownUntilSec = 1773475670;

    await initUserBlacklistDb();
    await initUserBlacklistSourceDb();
    await initUserGameAccountDb();
    await initUserPlatformAuthDb();
    await initOrderSyncDb();

    await upsertUserPlatformAuth({
        user_id: userId,
        platform: 'uuzuhao',
        auth_type: 'token',
        auth_payload: { app_key: 'k', app_secret: 's' },
        auth_status: 'valid',
        desc: 'cooldown smoke auth'
    });
    await setLastSyncTimestamp(userId, 'uuzuhao', Math.floor(Date.now() / 1000), 'cooldown smoke sync');

    await upsertBlacklistSource(userId, gameAccount, 'order_cooldown', {
        active: true,
        reason: '冷却期下架',
        priority: 500,
        expire_at: '2026-03-14 08:07:50',
        detail: {
            source_order_no: 'RP177346786977423490',
            source_channel: 'uuzuhao',
            cooldown_until: cooldownUntilSec
        }
    }, {
        desc: 'cooldown smoke source'
    });

    assertEqual((await listUserBlacklistByUser(userId)).length, 0, '前置条件失败: 不应依赖 legacy 黑名单行');

    const ret = await releaseOrderCooldownBlacklistByUser(userId, {
        fresh_window_sec: 3600
    });
    assertTrue(!ret.skipped, 'release 不应被跳过');
    assertEqual(ret.total_cooldown_rows, 1, '应识别 source 表里的冷却期行');
    assertEqual(ret.released, 1, '到期冷却期应被自动释放');
    assertEqual(ret.pending, 0, '不应残留 pending');

    const rows = await listBlacklistSourcesByUser(userId, { active_only: false });
    const cooldown = rows.find((x) => x.game_account === gameAccount && x.source === 'order_cooldown');
    assertTrue(Boolean(cooldown), '应保留 source 行');
    assertEqual(Boolean(cooldown.active), false, 'source 行应被置为 inactive');
    assertEqual(String(((cooldown.detail || {}).released_by) || ''), 'cooldown_until', '应记录自动释放来源');

    console.log('[PASS] order_cooldown_release_smoke_test');
}

main().catch((err) => {
    console.error(`[FAIL] order_cooldown_release_smoke_test: ${err.message}`);
    process.exit(1);
});
