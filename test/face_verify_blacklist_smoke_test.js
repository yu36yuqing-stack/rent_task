#!/usr/bin/env node
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'rent-face-verify-'));
process.env.MAIN_DB_FILE_PATH = path.join(tempDir, 'rent_robot.db');
process.env.RUNTIME_DB_FILE_PATH = path.join(tempDir, 'rent_robot_runtime.db');
process.env.ORDER_DB_FILE_PATH = path.join(tempDir, 'rent_robot_order.db');

const { initUserBlacklistDb, listUserBlacklistByUserWithMeta } = require('../database/user_blacklist_db');
const { initUserBlacklistSourceDb, listBlacklistSourcesByUserAndAccounts } = require('../database/user_blacklist_source_db');
const { reconcilePlatformFaceVerifyBlacklist, detectFaceVerifyPlatforms } = require('../pipeline/user_pipeline');
const { manualRemoveBlacklistMode2 } = require('../blacklist/blacklist_manual_remove_v2');
const { upsertSourceAndReconcile } = require('../blacklist/blacklist_source_gateway');

function fail(msg) {
    console.error(`[FAIL] ${msg}`);
    process.exit(1);
}

function pass(msg) {
    console.log(`[PASS] ${msg}`);
}

function assertEqual(actual, expected, msg) {
    if (actual !== expected) fail(`${msg} | expected=${JSON.stringify(expected)} actual=${JSON.stringify(actual)}`);
    pass(msg);
}

async function getSource(userId, account, source) {
    const rows = await listBlacklistSourcesByUserAndAccounts(userId, [{ game_account: account, game_id: '1' }], { active_only: false });
    return rows.find((row) => row.source === source) || null;
}

function faceRow(account, platforms = ['uhaozu']) {
    return {
        game_id: '1',
        game_name: 'WZRY',
        game_account: account,
        channel_prd_info: {
            ...(platforms.includes('uhaozu') ? { uhaozu: { audit_reason: '账号人脸识别' } } : {}),
            ...(platforms.includes('zuhaowang') ? { zuhaowang: { exception_msg: '账号人脸识别' } } : {})
        }
    };
}

async function main() {
    const userId = 99991;
    const account = 'face_verify_test_001';
    const gameId = '1';
    const gameName = 'WZRY';

    await initUserBlacklistDb();
    await initUserBlacklistSourceDb();

    const hitRows = [{
        game_id: gameId,
        game_name: gameName,
        game_account: account,
        channel_prd_info: {
            uhaozu: {
                audit_reason: '账号人脸识别'
            }
        }
    }];
    const hits = detectFaceVerifyPlatforms(hitRows[0]);
    assertEqual(hits.length, 1, 'should detect one face verify hit');
    assertEqual(String(hits[0].platform || ''), 'uhaozu', 'should detect uhaozu face verify');

    const first = await reconcilePlatformFaceVerifyBlacklist(userId, hitRows, console);
    assertEqual(Number(first.activated || 0), 1, 'should activate face verify blacklist');

    const blRows = await listUserBlacklistByUserWithMeta(userId);
    const bl = blRows.find((row) => String(row.game_account || '') === account);
    assertEqual(Boolean(bl), true, 'legacy blacklist projection should exist');
    assertEqual(String((bl && bl.reason) || ''), '人脸识别', 'legacy blacklist reason should be 人脸识别');

    const sourceRows = await listBlacklistSourcesByUserAndAccounts(userId, [{ game_account: account, game_id: gameId, game_name: gameName }], { active_only: false });
    const source = sourceRows.find((row) => String(row.source || '') === 'platform_face_verify');
    assertEqual(Boolean(source && source.active), true, 'source should stay active after hit');

    const releaseRows = [{
        game_id: gameId,
        game_name: gameName,
        game_account: account,
        channel_prd_info: {}
    }];
    const expiredSource = {
        ...source,
        active: true,
        expire_at: '2000-01-01 00:00:00'
    };
    const dbRows = sourceRows.map((row) => row.id === expiredSource.id ? expiredSource : row);
    const target = dbRows.find((row) => String(row.source || '') === 'platform_face_verify');
    const { upsertBlacklistSource } = require('../database/user_blacklist_source_db');
    await upsertBlacklistSource(userId, { game_account: account, game_id: gameId, game_name: gameName }, 'platform_face_verify', {
        active: true,
        reason: '人脸识别',
        priority: 800,
        expire_at: target.expire_at,
        detail: target.detail || {}
    }, { desc: 'seed expired source for smoke' });

    const released = await reconcilePlatformFaceVerifyBlacklist(userId, releaseRows, console);
    assertEqual(Number(released.released || 0), 1, 'should release expired face verify blacklist');

    const afterSourceRows = await listBlacklistSourcesByUserAndAccounts(userId, [{ game_account: account, game_id: gameId, game_name: gameName }], { active_only: false });
    const afterSource = afterSourceRows.find((row) => String(row.source || '') === 'platform_face_verify');
    assertEqual(Boolean(afterSource && afterSource.active), false, 'source should be inactive after ttl release');

    const single = 'face_verify_manual_single';
    await reconcilePlatformFaceVerifyBlacklist(userId, [faceRow(single)], console);
    const singleRemove = await manualRemoveBlacklistMode2(userId, single);
    assertEqual(singleRemove.removed, true, 'manual remove should clear sole face source');
    assertEqual(Boolean((await getSource(userId, single, 'platform_face_verify')).detail.manual_suppressed_platforms.includes('uhaozu')), true, 'manual remove should mark uhaozu face source');
    const singleResync = await reconcilePlatformFaceVerifyBlacklist(userId, [faceRow(single)], console);
    assertEqual(singleResync.activated, 0, 'uhaozu face should not reactivate after manual remove');
    assertEqual(Boolean((await getSource(userId, single, 'platform_face_verify')).active), false, 'suppressed face source should remain inactive');
    await manualRemoveBlacklistMode2(userId, single);
    assertEqual((await getSource(userId, single, 'platform_face_verify')).detail.manual_suppressed_platforms.includes('uhaozu'), true, 'repeated manual remove should preserve suppression marker');

    const noPriorFace = 'face_verify_no_prior_face';
    const noPriorKey = { game_account: noPriorFace, game_id: '1', game_name: 'WZRY' };
    await upsertSourceAndReconcile(userId, noPriorKey, 'manual_maintenance', { active: true, reason: '维护中' });
    await manualRemoveBlacklistMode2(userId, noPriorFace);
    assertEqual(await getSource(userId, noPriorFace, 'platform_face_verify'), null, 'removing unrelated blacklist should not pre-suppress future face hits');
    const firstFace = await reconcilePlatformFaceVerifyBlacklist(userId, [faceRow(noPriorFace)], console);
    assertEqual(firstFace.activated, 1, 'first-ever uhaozu face hit should still blacklist');

    const layered = 'face_verify_manual_layered';
    const layeredKey = { game_account: layered, game_id: '1', game_name: 'WZRY' };
    await reconcilePlatformFaceVerifyBlacklist(userId, [faceRow(layered)], console);
    await upsertSourceAndReconcile(userId, layeredKey, 'manual_maintenance', { active: true, reason: '维护中' });
    await upsertSourceAndReconcile(userId, layeredKey, 'order_cooldown', { active: true, reason: '冷却期下架' });
    const layeredRemove = await manualRemoveBlacklistMode2(userId, layered);
    assertEqual(layeredRemove.cleared_sources.includes('manual_maintenance'), true, 'manual remove should clear highest priority source');
    assertEqual(layeredRemove.cleared_sources.includes('platform_face_verify'), true, 'manual remove should also clear hidden uhaozu face source');
    assertEqual(layeredRemove.blocked, true, 'remaining cooldown source should keep account blacklisted');
    assertEqual(layeredRemove.winner_source, 'order_cooldown', 'remaining source should become winner');
    await reconcilePlatformFaceVerifyBlacklist(userId, [faceRow(layered)], console);
    assertEqual(Boolean((await getSource(userId, layered, 'platform_face_verify')).active), false, 'hidden face source should not reactivate');

    await upsertSourceAndReconcile(userId, layeredKey, 'manual_block', { active: true, reason: '人工下架' });
    await reconcilePlatformFaceVerifyBlacklist(userId, [faceRow(layered)], console);
    assertEqual(Boolean((await getSource(userId, layered, 'manual_block')).active), true, 'manual re-add should remain effective');
    assertEqual(Boolean((await getSource(userId, layered, 'platform_face_verify')).active), false, 'manual re-add should not reset face suppression');

    const mixed = 'face_verify_manual_mixed';
    await reconcilePlatformFaceVerifyBlacklist(userId, [faceRow(mixed, ['uhaozu', 'zuhaowang'])], console);
    await manualRemoveBlacklistMode2(userId, mixed);
    const mixedResync = await reconcilePlatformFaceVerifyBlacklist(userId, [faceRow(mixed, ['uhaozu', 'zuhaowang'])], console);
    assertEqual(mixedResync.activated, 1, 'other platform face hit should still activate source');
    const mixedSource = await getSource(userId, mixed, 'platform_face_verify');
    assertEqual(mixedSource.detail.platforms.join(','), 'zuhaowang', 'resync should filter only uhaozu face hit');
    assertEqual(mixedSource.detail.manual_suppressed_platforms.includes('uhaozu'), true, 'resync should preserve suppression marker');

    const otherOnly = 'face_verify_other_only';
    await reconcilePlatformFaceVerifyBlacklist(userId, [faceRow(otherOnly, ['zuhaowang'])], console);
    await manualRemoveBlacklistMode2(userId, otherOnly);
    const otherResync = await reconcilePlatformFaceVerifyBlacklist(userId, [faceRow(otherOnly, ['zuhaowang'])], console);
    assertEqual(otherResync.activated, 1, 'manual remove must not suppress non-uhaozu face source');

    console.log(`face_verify_blacklist_smoke_test passed temp_dir=${tempDir}`);
}

main().catch((err) => {
    console.error(`[FAIL] ${err.message}`);
    process.exit(1);
});
