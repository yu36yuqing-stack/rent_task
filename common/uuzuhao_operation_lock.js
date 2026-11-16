'use strict';

const crypto = require('crypto');
const { tryAcquireLock, releaseOwnedLock } = require('../database/lock_db');

const OPERATIONS = Object.freeze({
    LOGIN_REVOKE: 'login_revoke',
    PLATFORM_REAUTHORIZE: 'platform_reauthorize'
});
const LEASE_SECONDS = 120;

function buildOperationLockKey(operation, identity = {}) {
    if (!Object.values(OPERATIONS).includes(operation)) throw new Error('未知的悠悠操作类型');
    const uid = Number(identity.user_id);
    const gameId = Number(identity.game_id);
    const account = typeof identity.game_account === 'string' ? identity.game_account.trim() : '';
    if (!Number.isSafeInteger(uid) || uid <= 0 || !Number.isSafeInteger(gameId) || gameId <= 0 || !account) {
        throw new Error('操作锁缺少有效用户、游戏或账号');
    }
    const digest = crypto.createHash('sha256').update(`${uid}|${gameId}|${account}`).digest('hex');
    return `uuzuhao_operation:${operation}:${digest}`;
}

// Only duplicate executions of the same operation contend; the two APIs are independent.
async function withUuzuhaoOperationLock(operation, identity, work) {
    if (typeof work !== 'function') throw new TypeError('操作锁需要执行函数');
    const key = buildOperationLockKey(operation, identity);
    const owner = `pid=${process.pid} token=${crypto.randomUUID()}`;
    if (!(await tryAcquireLock(key, LEASE_SECONDS, owner)).acquired) return { acquired: false };
    try { return { acquired: true, value: await work() }; }
    finally { await releaseOwnedLock(key, owner); }
}

module.exports = { OPERATIONS, buildOperationLockKey, withUuzuhaoOperationLock };
