'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rent-operation-lock-'));
process.env.RUNTIME_DB_FILE_PATH = path.join(dir, 'runtime.db');
const { OPERATIONS, buildOperationLockKey, withUuzuhaoOperationLock: withLock } = require('../common/uuzuhao_operation_lock');
const { releaseOwnedLock } = require('../database/lock_db');
const identity = { user_id: 8, game_id: '1', game_account: 'fixture-account' };
const { LOGIN_REVOKE: revoke, PLATFORM_REAUTHORIZE: recover } = OPERATIONS;

async function main() {
    const key = buildOperationLockKey(revoke, identity);
    assert(!key.includes(identity.game_account), 'lock key must not expose account values');
    assert.strictEqual(key, buildOperationLockKey(revoke, { ...identity, game_id: 1 }));
    assert.notStrictEqual(key, buildOperationLockKey(recover, identity));
    for (const changed of [{ user_id: 9 }, { game_id: 2 }, { game_account: 'other' }]) {
        assert.notStrictEqual(key, buildOperationLockKey(revoke, { ...identity, ...changed }));
    }
    for (const invalid of [{ user_id: 0 }, { user_id: 1.5 }, { game_id: 0 }, { game_id: 1.5 },
        { game_account: '' }, { game_account: 123 }]) {
        assert.throws(() => buildOperationLockKey(revoke, { ...identity, ...invalid }), /操作锁缺少/);
    }
    assert.throws(() => buildOperationLockKey(revoke), /操作锁缺少/);
    assert.throws(() => buildOperationLockKey('unrecognized', identity), /操作类型/);
    await assert.rejects(withLock(revoke, identity, null), /执行函数/);

    let release, entered;
    const ready = new Promise(resolve => { entered = resolve; });
    const held = new Promise(resolve => { release = resolve; });
    const first = withLock(revoke, identity, async () => { entered(); await held; return 'revoke done'; });
    await ready;
    try {
        const duplicate = await withLock(revoke, identity, () => assert.fail('duplicate must not run'));
        assert.deepStrictEqual(duplicate, { acquired: false });
        assert.strictEqual(await releaseOwnedLock(key, 'wrong-owner'), false);
        assert.strictEqual((await withLock(revoke, identity, () => assert.fail('wrong owner cannot release'))).acquired, false);
        // The first API is still in flight when the other operation completes.
        assert.deepStrictEqual(await withLock(recover, identity, async () => 'recover done'), { acquired: true, value: 'recover done' });
        for (const changed of [{ user_id: 9 }, { game_id: 2 }, { game_account: 'other' }]) {
            assert.strictEqual((await withLock(revoke, { ...identity, ...changed }, async () => true)).value, true);
        }
    } finally { release(); }
    assert.deepStrictEqual(await first, { acquired: true, value: 'revoke done' });
    const failure = new Error('fixture request failure');
    await assert.rejects(withLock(revoke, identity, async () => { throw failure; }), error => error === failure);
    assert.strictEqual((await withLock(revoke, identity, async () => 'after failure')).value, 'after failure');
    console.log('[PASS] operation locks: cross-operation concurrency, same-operation exclusion, ownership, isolation and exception release');
}

main().catch(error => { console.error(error); process.exitCode = 1; })
    .finally(() => fs.rmSync(dir, { recursive: true, force: true }));
