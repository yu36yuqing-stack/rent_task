#!/usr/bin/env node
'use strict';

const assert = require('assert');
const childProcess = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'rent-action-parallel-'));
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
`]);

const { executeActions } = require('../action_engine/action_engine');

function sleep(ms) {
    return new Promise((resolve) => setTimeout(resolve, Math.max(0, Number(ms) || 0)));
}

async function main() {
    const calls = [];
    const makeStub = (name, ms, result = true) => async () => {
        const startedAt = Date.now();
        calls.push({ name, phase: 'start', at: startedAt });
        await sleep(ms);
        const endedAt = Date.now();
        calls.push({ name, phase: 'end', at: endedAt });
        return result;
    };
    const makeYoupinOnStub = (name, ms) => async () => {
        const startedAt = Date.now();
        calls.push({ name, phase: 'start', at: startedAt });
        await sleep(ms);
        const endedAt = Date.now();
        calls.push({ name, phase: 'end', at: endedAt });
        return { ok: true, code: 0, msg: '' };
    };

    const actions = [
        { type: 'off_y', item: { account: 'acc_y1', game_id: '1', game_name: 'WZRY' }, reason: 'test off y 1' },
        { type: 'off_y', item: { account: 'acc_y2', game_id: '1', game_name: 'WZRY' }, reason: 'test off y' },
        { type: 'off_u', item: { account: 'acc_u1', game_id: '1', game_name: 'WZRY' }, reason: 'test off u' },
        { type: 'off_z', item: { account: 'acc_z1', game_id: '1', game_name: 'WZRY', gameId: 1104466820, dataId: 'z1' }, reason: 'test off z' }
    ];
    const runRecord = { actions: [], errors: [] };
    const startedAt = Date.now();
    await executeActions({
        user: { id: 0, account: 'parallel_user' },
        actions,
        runRecord,
        youpinPage: null,
        uhaozuPage: null,
        youpinOffShelf: async (_page, account) => {
            if (String(account) === 'acc_y1') return makeStub('off_y1', 80)();
            return makeStub('off_y2', 20)();
        },
        youpinOnShelf: makeYoupinOnStub('on_y', 10),
        uhaozuOffShelf: makeStub('off_u', 80),
        uhaozuOnShelf: makeStub('on_u', 80),
        uhaozuReshelfByModify: makeStub('on_u_modify', 10),
        changeZhwStatus: makeStub('off_z', 80),
        readOnly: false
    });
    const elapsed = Date.now() - startedAt;

    const at = (name, phase) => {
        const row = calls.find((x) => x.name === name && x.phase === phase);
        assert.ok(row, `missing call ${name}/${phase}`);
        return row.at;
    };

    assert.ok(elapsed < 180, `平台间应并行执行，elapsed=${elapsed}`);
    assert.ok(at('off_y2', 'start') >= at('off_y1', 'end'), '同平台 uuzuhao 动作应串行');
    assert.ok(at('off_u', 'start') < at('off_y1', 'end'), 'uhaozu 队列应与 uuzuhao 并行');
    assert.ok(at('off_z', 'start') < at('off_y1', 'end'), 'zuhaowang 队列应与 uuzuhao 并行');
    assert.deepStrictEqual(runRecord.actions.map((x) => x.plan_index), [0, 1, 2, 3], '动作结果应按原计划顺序回填');
    assert.strictEqual(runRecord.errors.length, 0, '不应产生执行错误');
    assert.strictEqual(runRecord.action_timing.mode, 'platform_parallel', '应记录平台并行模式');
    assert.strictEqual(runRecord.action_timing.queue_timing.uuzuhao.planned, 2, '应记录 uuzuhao 队列');
    assert.strictEqual(runRecord.action_timing.queue_timing.uhaozu.planned, 1, '应记录 uhaozu 队列');
    assert.strictEqual(runRecord.action_timing.queue_timing.zuhaowang.planned, 1, '应记录 zuhaowang 队列');

    console.log(`[PASS] action_engine_platform_parallel_smoke_test temp_dir=${tempDir}`);
}

main().catch((err) => {
    console.error(`[FAIL] action_engine_platform_parallel_smoke_test: ${err.message}`);
    process.exit(1);
});
