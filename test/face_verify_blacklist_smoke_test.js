#!/usr/bin/env node
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'rent-face-verify-'));
process.env.RENT_DB_DIR = tempDir;

const { initUserBlacklistDb, listUserBlacklistByUserWithMeta } = require('../database/user_blacklist_db');
const { initUserBlacklistSourceDb, listBlacklistSourcesByUserAndAccounts } = require('../database/user_blacklist_source_db');
const { reconcilePlatformFaceVerifyBlacklist, detectFaceVerifyPlatforms } = require('../pipeline/user_pipeline');

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

    console.log(`face_verify_blacklist_smoke_test passed temp_dir=${tempDir}`);
}

main().catch((err) => {
    console.error(`[FAIL] ${err.message}`);
    process.exit(1);
});
