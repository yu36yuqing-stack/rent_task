#!/usr/bin/env node
'use strict';

const { _internals } = require('../uuzuhao/uuzuhao_api');

function assertEqual(actual, expected, msg) {
    if (actual !== expected) {
        throw new Error(`${msg}: expected=${expected}, actual=${actual}`);
    }
}

function run() {
    assertEqual(_internals.resolveGameIdByName('WZRY'), 1, 'WZRY 应映射到 1');
    assertEqual(_internals.resolveGameIdByName('和平精英'), 2, '和平精英 应映射到 2');
    assertEqual(_internals.resolveGameIdByName('CFM'), 3, 'CFM 应映射到 3');
    assertEqual(_internals.resolveGameIdByName('穿越火线'), 3, '穿越火线 应映射到 3');
    assertEqual(_internals.resolveGameIdByName('枪战王者'), 3, '枪战王者 应映射到 3');
    console.log('[PASS] uuzuhao_game_mapping_smoke_test');
}

run();
