'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rent-system-config-db-'));
for (const name of ['MAIN', 'RUNTIME', 'ORDER', 'STATS', 'PRICE']) {
    process.env[`${name}_DB_FILE_PATH`] = path.join(dir, `${name}.db`);
}
global.fetch = async () => { throw new Error('External network is not allowed in configuration tests'); };

const { openMainDatabase } = require('../database/sqlite_client');
const config = require('../database/system_config_db');
const migration = require('../database/migrations/20261104_022_system_config');
const run = (db, sql, params = []) => new Promise((resolve, reject) => db.run(sql, params, function done(error) {
    if (error) return reject(error);
    resolve(this);
}));
const all = (db, sql, params = []) => new Promise((resolve, reject) => db.all(sql, params, (error, rows) => error ? reject(error) : resolve(rows)));
const close = db => new Promise((resolve, reject) => db.close(error => error ? reject(error) : resolve()));
const create = (key, value, options = {}) => config.setSystemConfig(key, value, { expectedId: 0, expectedVersion: 0, ...options });
const expected = row => ({ expectedId: row.id, expectedVersion: row.version });
const seedKey = 'uhaozu.auto_reshelf_reasons';
const query = async (sql, params = []) => {
    const db = openMainDatabase();
    try { return await all(db, sql, params); } finally { await close(db); }
};
async function mutate(sql, params = []) {
    const db = openMainDatabase();
    try { return await run(db, sql, params); } finally { await close(db); }
}
async function migrate() {
    const db = openMainDatabase();
    try {
        await run(db, 'BEGIN IMMEDIATE');
        await migration.up({ db, run });
        await run(db, 'COMMIT');
    } catch (error) {
        await run(db, 'ROLLBACK');
        throw error;
    } finally { await close(db); }
}

async function main() {
    // Reads do not create tables or populate defaults, including before migration.
    await assert.rejects(config.getSystemConfig(seedKey), /no such table/);
    await assert.rejects(config.listSystemConfigs(), /no such table/);
    assert.deepStrictEqual(await query("SELECT name FROM sqlite_master WHERE type='table' AND name='system_config'"), []);
    await migrate();
    const seeded = await config.getSystemConfig(seedKey);
    assert.strictEqual(seeded.found, true);
    assert.strictEqual(seeded.version, 1);
    assert.deepStrictEqual(seeded.value, { reasons: [
        '检测游戏在线，请确认游戏离线后手动上架', '账号人脸识别', '商品开启禁玩,已自动下架'
    ] });
    assert.strictEqual(seeded.is_deleted, 0);
    assert(seeded.create_date && seeded.modify_date && seeded.desc);
    const columns = (await query('PRAGMA table_info(system_config)')).map(row => row.name);
    for (const field of ['id', 'config_key', 'config_value', 'version', 'create_date', 'modify_date', 'is_deleted', 'desc']) {
        assert(columns.includes(field), `Required column: ${field}`);
    }
    await migrate();
    assert.strictEqual((await config.getSystemConfig(seedKey)).id, seeded.id);
    const edited = await config.setSystemConfig(seedKey, { reasons: [] }, { ...expected(seeded), desc: 'operator override' });
    await migrate();
    assert.deepStrictEqual(await config.getSystemConfig(seedKey), edited, 'Migration must preserve existing edits');
    await config.deleteSystemConfig(seedKey, expected(edited));
    await migrate();
    assert.strictEqual((await config.getSystemConfig(seedKey)).found, false, 'Migration must not revive a deleted key');
    assert.strictEqual((await query('SELECT COUNT(*) AS count FROM system_config WHERE config_key=?', [seedKey]))[0].count, 1);

    const missing = await config.getSystemConfig('missing.scene');
    assert.deepStrictEqual(missing, { found: false, id: 0, key: 'missing.scene', value: undefined, version: 0 });
    assert.strictEqual((await query('SELECT COUNT(*) AS count FROM system_config WHERE config_key=?', ['missing.scene']))[0].count, 0);

    // The generic store preserves every JSON value, including falsy values and shared references.
    const values = [null, false, 0, '', true, -3.25, 'quote \' " 中文', [], {}, [1, null, false], { reasons: ['A'], enabled: false }];
    for (let index = 0; index < values.length; index += 1) {
        const row = await create(`json.${index}`, values[index]);
        assert.strictEqual(row.found, true);
        assert.strictEqual(row.version, 1);
        assert.deepStrictEqual(row.value, values[index]);
        assert.deepStrictEqual((await config.getSystemConfig(row.key)).value, values[index]);
    }
    const shared = { enabled: true };
    assert.deepStrictEqual((await create('json.shared', [shared, shared])).value, [shared, shared]);
    const nullPrototype = Object.assign(Object.create(null), { count: 0 });
    assert.deepStrictEqual((await create('json.null-prototype', nullPrototype)).value, { count: 0 });
    const quotedKey = "scene.'; DROP TABLE system_config; --";
    assert.strictEqual((await create(`  ${quotedKey}  `, 'safe')).key, quotedKey);
    assert.strictEqual((await config.getSystemConfig(`  ${quotedKey} `)).value, 'safe');
    const list = await config.listSystemConfigs();
    assert.deepStrictEqual(list.map(row => row.key), [...list.map(row => row.key)].sort());
    assert(!list.some(row => row.key === seedKey));

    const current = await create('cas.scene', { count: 1 }, { desc: 'keep description' });
    const next = await config.setSystemConfig(current.key, { count: 2 }, expected(current));
    assert.strictEqual(next.id, current.id);
    assert.strictEqual(next.version, 2);
    assert.strictEqual(next.desc, 'keep description');
    const clearDesc = await config.setSystemConfig(next.key, false, { ...expected(next), desc: '' });
    assert.strictEqual(clearDesc.desc, '');
    await assert.rejects(create('cas.scene', 3), { code: 'SYSTEM_CONFIG_CONFLICT' });
    await assert.rejects(config.setSystemConfig(current.key, 99, expected(current)), { code: 'SYSTEM_CONFIG_CONFLICT' });
    await assert.rejects(config.deleteSystemConfig(current.key, expected(current)), { code: 'SYSTEM_CONFIG_CONFLICT' });
    await assert.rejects(config.setSystemConfig('wrong.key', 99, expected(clearDesc)), { code: 'SYSTEM_CONFIG_CONFLICT' });
    const racers = await Promise.allSettled([
        config.setSystemConfig(clearDesc.key, 'first', expected(clearDesc)),
        config.setSystemConfig(clearDesc.key, 'second', expected(clearDesc))
    ]);
    assert.strictEqual(racers.filter(row => row.status === 'fulfilled').length, 1);
    assert.strictEqual(racers.find(row => row.status === 'rejected').reason.code, 'SYSTEM_CONFIG_CONFLICT');
    const winner = await config.getSystemConfig(clearDesc.key);
    assert.strictEqual(winner.version, clearDesc.version + 1);
    assert(['first', 'second'].includes(winner.value));
    const deletion = await config.deleteSystemConfig(winner.key, expected(winner));
    assert.deepStrictEqual(deletion, { deleted: true, id: winner.id, key: winner.key, version: winner.version + 1 });
    assert.strictEqual((await config.getSystemConfig(winner.key)).found, false);
    const rebuilt = await create(winner.key, 'rebuilt');
    assert(rebuilt.id > winner.id);
    assert.strictEqual(rebuilt.version, 1);
    await assert.rejects(config.setSystemConfig(current.key, 'old editor', expected(current)), { code: 'SYSTEM_CONFIG_CONFLICT' });
    await assert.rejects(config.deleteSystemConfig(current.key, expected(current)), { code: 'SYSTEM_CONFIG_CONFLICT' });
    assert.strictEqual((await config.getSystemConfig(current.key)).value, 'rebuilt');

    // Two first-time editors cannot silently replace each other's initial values.
    const inserts = await Promise.allSettled([create('create.race', 1), create('create.race', 2)]);
    assert.strictEqual(inserts.filter(row => row.status === 'fulfilled').length, 1);
    assert.strictEqual(inserts.find(row => row.status === 'rejected').reason.code, 'SYSTEM_CONFIG_CONFLICT');

    for (const key of ['', '   ', 0, null, undefined, 'invalid\nkey', 'invalid\u0000key']) {
        await assert.rejects(config.getSystemConfig(key), { code: 'SYSTEM_CONFIG_INVALID_KEY' });
        await assert.rejects(create(key, {}), { code: 'SYSTEM_CONFIG_INVALID_KEY' });
        await assert.rejects(config.deleteSystemConfig(key, expected(rebuilt)), { code: 'SYSTEM_CONFIG_INVALID_KEY' });
    }
    for (const options of [{}, { expectedId: 0 }, { expectedId: 1, expectedVersion: 0 },
        { expectedId: 0, expectedVersion: 1 }, { expectedId: -1, expectedVersion: -1 },
        { expectedId: '1', expectedVersion: 1 }, { expectedId: 1.5, expectedVersion: 1 },
        { expectedId: 1, expectedVersion: Number.MAX_SAFE_INTEGER + 1 }]) {
        await assert.rejects(config.setSystemConfig('expectation.scene', {}, options), { code: 'SYSTEM_CONFIG_INVALID_EXPECTATION' });
    }
    await assert.rejects(config.deleteSystemConfig('missing.scene'), { code: 'SYSTEM_CONFIG_INVALID_EXPECTATION' });
    await assert.rejects(config.deleteSystemConfig('missing.scene', { expectedId: 0, expectedVersion: 0 }), { code: 'SYSTEM_CONFIG_INVALID_EXPECTATION' });
    const cycle = {}; cycle.self = cycle;
    const symbolProperty = { [Symbol('unsupported')]: true };
    const accessor = {}; Object.defineProperty(accessor, 'secret', { enumerable: true, get() { throw new Error('Getter must not run'); } });
    const arrayAccessor = [1]; Object.defineProperty(arrayAccessor, 0, { get() { throw new Error('Array getter must not run'); } });
    const arrayProperties = [1]; arrayProperties.extra = true;
    const customSerializer = {}; Object.defineProperty(customSerializer, 'toJSON', { value() { throw new Error('toJSON must not run'); } });
    for (const value of [undefined, NaN, Infinity, -Infinity, 1n, Symbol('unsupported'), () => {},
        { value: undefined }, { value: NaN }, [undefined], new Date(), new Map(), cycle, symbolProperty,
        accessor, arrayAccessor, arrayProperties, new Array(2), customSerializer]) {
        await assert.rejects(create('invalid.value', value), { code: 'SYSTEM_CONFIG_INVALID_VALUE' });
    }
    assert.strictEqual((await config.getSystemConfig('invalid.value')).found, false);

    // Storage checks protect even direct SQL writers; API failures keep the previous value intact.
    await assert.rejects(mutate("INSERT INTO system_config(config_key,config_value) VALUES('broken','not-json')"), /CHECK constraint failed/);
    await assert.rejects(mutate("INSERT INTO system_config(config_key,config_value) VALUES('   ','{}')"), /CHECK constraint failed/);
    await assert.rejects(mutate("INSERT INTO system_config(config_key,config_value,version) VALUES('broken.version','{}',0)"), /CHECK constraint failed/);
    await assert.rejects(mutate('INSERT INTO system_config(config_key,config_value) VALUES(?,?)', [rebuilt.key, '{}']), /UNIQUE constraint failed/);
    await mutate("CREATE TRIGGER fail_config_update BEFORE UPDATE ON system_config BEGIN SELECT RAISE(ABORT,'fixture blocked update'); END");
    await assert.rejects(config.setSystemConfig(rebuilt.key, 'must rollback', expected(rebuilt)), /fixture blocked update/);
    assert.deepStrictEqual(await config.getSystemConfig(rebuilt.key), rebuilt);
    await mutate('DROP TRIGGER fail_config_update');

    const corruptDb = openMainDatabase();
    try {
        await run(corruptDb, 'PRAGMA ignore_check_constraints = ON');
        await run(corruptDb, "INSERT INTO system_config(config_key,config_value) VALUES('corrupt.fixture','not-json')");
    } finally { await close(corruptDb); }
    await assert.rejects(config.getSystemConfig('corrupt.fixture'), { code: 'SYSTEM_CONFIG_CORRUPT' });
    await assert.rejects(config.listSystemConfigs(), { code: 'SYSTEM_CONFIG_CORRUPT' });
    await mutate("DELETE FROM system_config WHERE config_key='corrupt.fixture'");

    // The migration participates in its caller's transaction, including DDL and seed data.
    await mutate('DROP TABLE system_config');
    const transactionDb = openMainDatabase();
    try {
        await run(transactionDb, 'BEGIN IMMEDIATE');
        await migration.up({ db: transactionDb, run });
        assert.strictEqual((await all(transactionDb, 'SELECT COUNT(*) AS count FROM system_config'))[0].count, 1);
        await run(transactionDb, 'ROLLBACK');
    } finally { await close(transactionDb); }
    assert.deepStrictEqual(await query("SELECT name FROM sqlite_master WHERE name='system_config'"), []);
    await migrate();
    assert.strictEqual((await config.getSystemConfig(seedKey)).version, 1);
    console.log('[PASS] system configuration JSON fidelity, CAS concurrency/ABA, migration idempotency/rollback, and read-only defaults');
}

main().catch(error => { console.error(error); process.exitCode = 1; });
