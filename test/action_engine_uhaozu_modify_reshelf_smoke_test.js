#!/usr/bin/env node
'use strict';

const { detectConflictsAndBuildSnapshot } = require('../action_engine/action_engine');

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

function main() {
    const gameId = 'CJZC001';
    const account = '2874231439';
    const identityKey = `${gameId}::${account}`;
    const out = detectConflictsAndBuildSnapshot({
        youpinData: [{
            account,
            game_id: gameId,
            game_name: '和平精英',
            status: '上架',
            remark: 'test'
        }],
        uhaozuData: [{
            account,
            game_id: gameId,
            game_name: '和平精英',
            status: '下架',
            reason: '',
            prd_id: '1132393091',
            platform_game_id: gameId
        }],
        zhwData: [{
            account,
            game_id: gameId,
            game_name: '和平精英',
            status: '上架',
            gameId: 1106467070,
            dataId: '90855352'
        }],
        blacklistAccounts: new Set(),
        platformRestrictSet: new Set(),
        platformStatusNormMap: {
            [identityKey]: {
                uuzuhao: { code: 'listed', reason: '' },
                uhaozu: { code: 'auth_abnormal', reason: '检测游戏在线，请确认游戏离线后手动上架' },
                zuhaowang: { code: 'listed', reason: '' }
            }
        }
    });

    assertEqual(Array.isArray(out.actions), true, 'actions should be array');
    assertEqual(out.actions.length, 1, 'should plan one action');
    assertEqual(String(out.actions[0].type || ''), 'on_u_modify', 'should use modify reshelf action');
    assertEqual(String((out.actions[0].item || {}).prd_id || ''), '1132393091', 'should carry goods id');
    console.log('action_engine_uhaozu_modify_reshelf_smoke_test passed');
}

main();
