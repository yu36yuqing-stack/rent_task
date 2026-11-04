#!/usr/bin/env node
'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'rent-system-config-cli-'));
for (const name of ['MAIN', 'RUNTIME', 'ORDER', 'STATS', 'PRICE']) {
    process.env[`${name}_DB_FILE_PATH`] = path.join(directory, `${name}.db`);
}
global.fetch = async () => { throw new Error('Real network calls are forbidden'); };
const networkGuard = path.join(directory, 'no-network.cjs');
fs.writeFileSync(networkGuard, [
    "global.fetch = async () => { throw new Error('Real network calls are forbidden'); };",
    "for (const name of ['http', 'https']) for (const method of ['request', 'get']) require(name)[method] = () => { throw new Error('Real network calls are forbidden'); };"
].join('\n'), { mode: 0o600 });

const sqlite3 = require('sqlite3');
const dbApi = require('../database/system_config_db');
const migration = require('../database/migrations/20261104_022_system_config');
const { parseArgs, executeConfigCommand, writeBackup } = require('../scripts/system_config');
const { UHAOZU_AUTO_RESHELF_CONFIG_KEY: policyKey } = require('../product/uhaozu_auto_reshelf_policy');
const script = path.resolve(__dirname, '../scripts/system_config.js');
const backupDirectory = path.join(directory, 'backups');
const run = (db, sql, params = []) => new Promise((resolve, reject) => {
    db.run(sql, params, function complete(error) { error ? reject(error) : resolve(this); });
});
const all = (db, sql, params = []) => new Promise((resolve, reject) => {
    db.all(sql, params, (error, rows) => error ? reject(error) : resolve(rows));
});
const get = async (db, sql, params = []) => (await all(db, sql, params))[0];
const close = db => new Promise((resolve, reject) => db.close(error => error ? reject(error) : resolve()));

function cli(args, env = {}) {
    const result = spawnSync(process.execPath, [script, ...args], {
        env: { ...process.env, ...env,
            NODE_OPTIONS: `${process.env.NODE_OPTIONS || ''} --require ${JSON.stringify(networkGuard)}`.trim() },
        encoding: 'utf8', timeout: 10000
    });
    if (result.error) throw result.error;
    assert.notStrictEqual(result.status, null, `CLI failed to exit: ${result.stderr}`);
    const content = result.status === 0 ? result.stdout : result.stderr;
    return { status: result.status, data: JSON.parse(content.trim()) };
}

function setArgs(key, value, row = {}, more = []) {
    return ['set', '--key', key, '--value', JSON.stringify(value),
        '--expected-id', String(row.id || 0), '--expected-version', String(row.version || 0),
        '--backup-dir', backupDirectory, ...more];
}

function successful(args) {
    const result = cli(args);
    assert.strictEqual(result.status, 0, JSON.stringify(result.data));
    assert.strictEqual(result.data.ok, true);
    return result.data;
}

function backup(file) {
    assert.strictEqual(fs.statSync(file).mode & 0o777, 0o600, 'backup must be private');
    return JSON.parse(fs.readFileSync(file, 'utf8'));
}

async function main() {
    for (const flag of ['help', '--help', '-h']) {
        assert.strictEqual(parseArgs([flag]).command, 'help');
    }
    assert(successful(['--help']).help.includes('--expected-version'));
    const invalidArgs = [[], ['unknown'], ['list', '--key', 'x'], ['get'], ['get', '--key'],
        ['get', '--key', '--bad'], ['get', '--key', ''], ['get', '--key', 'x', '--key', 'y'],
        ['set', '--key', 'x'], ['set', '--key', 'x', '--value', '1'],
        ['set', '--key', 'x', '--value', '1', '--expected-id', '0'],
        ['set', '--key', 'x', '--value', 'oops', '--expected-id', '0', '--expected-version', '0']];
    for (const args of invalidArgs) assert.throws(() => parseArgs(args), { code: 'SYSTEM_CONFIG_CLI_USAGE' });
    for (const number of ['-1', '01', '1.5', 'Infinity', '9007199254740992']) {
        const args = setArgs('x', 1);
        args[args.indexOf('--expected-id') + 1] = number;
        assert.throws(() => parseArgs(args), { code: 'SYSTEM_CONFIG_CLI_USAGE' });
    }
    for (const pair of [[0, 1], [1, 0]]) {
        assert.throws(() => parseArgs(setArgs('x', 1, { id: pair[0], version: pair[1] })), { code: 'SYSTEM_CONFIG_CLI_USAGE' });
    }
    const emptyBackup = setArgs('x', 1);
    emptyBackup[emptyBackup.indexOf('--backup-dir') + 1] = ' ';
    assert.throws(() => parseArgs(emptyBackup), { code: 'SYSTEM_CONFIG_CLI_USAGE' });
    assert.strictEqual(cli(['bad']).data.code, 'SYSTEM_CONFIG_CLI_USAGE');
    await assert.rejects(() => executeConfigCommand({ command: 'bad' }), { code: 'SYSTEM_CONFIG_CLI_USAGE' });

    const emptyDatabase = path.join(directory, 'before-migration.db');
    assert.notStrictEqual(cli(['get', '--key', 'missing'], { MAIN_DB_FILE_PATH: emptyDatabase }).status, 0);
    const empty = new sqlite3.Database(emptyDatabase);
    assert.strictEqual((await all(empty, "SELECT name FROM sqlite_master WHERE name='system_config'")).length, 0,
        'read command must not initialize schema or defaults');
    await close(empty);

    const db = new sqlite3.Database(process.env.MAIN_DB_FILE_PATH);
    try {
        await run(db, 'BEGIN IMMEDIATE');
        await migration.up({ db, run, get, all });
        await run(db, 'COMMIT');
    } catch (error) {
        await run(db, 'ROLLBACK');
        throw error;
    } finally { await close(db); }
    assert.strictEqual(successful(['get', '--key', 'missing']).config.found, false);
    const initial = successful(['list']).configs;
    assert(Array.isArray(initial));
    assert(initial.some(row => (row.key || row.config_key) === policyKey));

    for (const [name, value] of Object.entries({ number: 0, boolean: false, null: null,
        string: 'plain string', empty: '', array: ['x', 2], object: { enabled: true } })) {
        const key = `fixture.${name}`;
        const out = successful(setArgs(key, value));
        assert.strictEqual(out.config.version, 1);
        assert.strictEqual(out.config.found, true);
        assert.deepStrictEqual(out.config.value, value);
        assert.strictEqual(backup(out.backup_path).previous.found, false);
        assert.deepStrictEqual(successful(['get', '--key', key]).config.value, value);
    }

    const objectBefore = await dbApi.getSystemConfig('fixture.object');
    const changed = successful(setArgs(' fixture.object ', { enabled: false }, objectBefore, ['--desc', 'Fixture update']));
    assert.deepStrictEqual(backup(changed.backup_path).previous.value, { enabled: true });
    assert.strictEqual(changed.config.version, objectBefore.version + 1);
    assert.strictEqual(changed.config.desc, 'Fixture update');
    const filesBeforeConflict = fs.readdirSync(backupDirectory).length;
    const stale = cli(setArgs('fixture.object', 'must not overwrite', objectBefore));
    assert.notStrictEqual(stale.status, 0);
    assert.strictEqual(stale.data.code, 'SYSTEM_CONFIG_CONFLICT');
    assert.strictEqual(fs.readdirSync(backupDirectory).length, filesBeforeConflict,
        'stale requests must fail before creating a backup');
    assert.deepStrictEqual((await dbApi.getSystemConfig('fixture.object')).value, { enabled: false });

    const blocked = path.join(directory, 'not-a-directory');
    fs.writeFileSync(blocked, 'fixture');
    const blockedArgs = setArgs('fixture.object', 'must not save', changed.config);
    blockedArgs[blockedArgs.indexOf('--backup-dir') + 1] = blocked;
    assert.notStrictEqual(cli(blockedArgs).status, 0, 'backup failure must prevent saving');
    assert.deepStrictEqual((await dbApi.getSystemConfig('fixture.object')).value, { enabled: false });

    let policyBefore = await dbApi.getSystemConfig(policyKey);
    const edited = successful(setArgs(policyKey, { reasons: [' 账号人脸识别： ', '账号人脸识别', '商品开启禁玩，已自动下架'] }, policyBefore));
    assert.deepStrictEqual(edited.config.value.reasons, ['账号人脸识别：', '商品开启禁玩，已自动下架']);
    policyBefore = edited.config;
    for (const value of [null, false, 0, [], {}, { reasons: [false] }, { reasons: [''] }, { reasons: [], extra: true }]) {
        const filesBefore = fs.readdirSync(backupDirectory).length;
        const result = cli(setArgs(policyKey, value, policyBefore));
        assert.strictEqual(result.data.code, 'INVALID_UHAOZU_RESHELF_CONFIG');
        assert.notStrictEqual(result.status, 0);
        assert.strictEqual(fs.readdirSync(backupDirectory).length, filesBefore);
        assert.deepStrictEqual((await dbApi.getSystemConfig(policyKey)).value, policyBefore.value);
    }
    assert.deepStrictEqual(successful(setArgs(policyKey, { reasons: [] }, policyBefore)).config.value, { reasons: [] });

    const originalHome = os.homedir;
    os.homedir = () => path.join(directory, 'fixture-home');
    try {
        const args = setArgs('fixture.default-backup', true);
        args.splice(args.indexOf('--backup-dir'), 2);
        const result = await executeConfigCommand(parseArgs(args));
        assert(result.backup_path.startsWith(path.join(directory, 'fixture-home', 'Library', 'Application Support', 'rent_task', 'config-backups')));
        backup(result.backup_path);
    } finally { os.homedir = originalHome; }

    const raceBefore = await dbApi.getSystemConfig('fixture.boolean');
    let raceBackup;
    await assert.rejects(() => executeConfigCommand(parseArgs(setArgs('fixture.boolean', 'stale', raceBefore)), {
        async writeBackup(previous, key, backupDir) {
            raceBackup = writeBackup(previous, key, backupDir);
            await dbApi.setSystemConfig(key, 'concurrent update', { expectedId: previous.id, expectedVersion: previous.version });
            return raceBackup;
        }
    }), error => error.code === 'SYSTEM_CONFIG_CONFLICT' && error.backup_path === raceBackup);
    assert.strictEqual(backup(raceBackup).previous.value, false);
    assert.strictEqual((await dbApi.getSystemConfig('fixture.boolean')).value, 'concurrent update');

    const beforeDelete = await dbApi.getSystemConfig('fixture.number');
    await dbApi.deleteSystemConfig('fixture.number', { expectedId: beforeDelete.id, expectedVersion: beforeDelete.version });
    const rebuilt = await dbApi.setSystemConfig('fixture.number', 'recreated', { expectedId: 0, expectedVersion: 0 });
    assert.notStrictEqual(rebuilt.id, beforeDelete.id);
    assert.strictEqual(rebuilt.version, beforeDelete.version);
    assert.strictEqual(cli(setArgs('fixture.number', 'stale ABA edit', beforeDelete)).data.code, 'SYSTEM_CONFIG_CONFLICT');
    assert.strictEqual((await dbApi.getSystemConfig('fixture.number')).value, 'recreated');

    console.log('[PASS] system config CLI: query/create/update, JSON values, private backups, preflight and transaction CAS, invalid arguments, Uhaozu validation, ABA and read-only schema behavior');
}

main().catch(error => { console.error(error); process.exitCode = 1; });
