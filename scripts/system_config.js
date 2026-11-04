#!/usr/bin/env node
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { getSystemConfig, listSystemConfigs, setSystemConfig } = require('../database/system_config_db');
const {
    UHAOZU_AUTO_RESHELF_CONFIG_KEY,
    validateUhaozuAutoReshelfValue
} = require('../product/uhaozu_auto_reshelf_policy');

const HELP = [
    'node scripts/system_config.js list',
    'node scripts/system_config.js get --key <scene>',
    'node scripts/system_config.js set --key <scene> --value <JSON> --expected-id <id> --expected-version <version> [--desc <text>] [--backup-dir <path>]',
    '新建配置使用 --expected-id 0 --expected-version 0；更新时使用 get 返回的 id/version。',
    '该命令读取当前数据库，不自动建表或执行迁移；MAIN_DB_FILE_PATH 可指定目标主库。'
].join('\n');

function usageError(message) {
    const error = new Error(message);
    error.code = 'SYSTEM_CONFIG_CLI_USAGE';
    return error;
}

function parseNonNegativeInteger(value, name) {
    if (!/^(0|[1-9]\d*)$/.test(value) || !Number.isSafeInteger(Number(value))) {
        throw usageError(`${name} 必须是非负安全整数`);
    }
    return Number(value);
}

function parseArgs(argv = []) {
    if (argv.length === 1 && ['help', '--help', '-h'].includes(argv[0])) return { command: 'help' };
    const command = argv[0];
    const allowed = {
        list: [],
        get: ['--key'],
        set: ['--key', '--value', '--expected-id', '--expected-version', '--desc', '--backup-dir']
    }[command];
    if (!allowed) throw usageError('请选择 list、get 或 set 命令，使用 --help 查看用法');
    const flags = new Map();
    for (let index = 1; index < argv.length; index += 2) {
        const name = argv[index];
        if (!allowed.includes(name)) throw usageError('不支持的参数，请使用 --help 查看用法');
        if (flags.has(name)) throw usageError(`参数重复: ${name}`);
        const value = argv[index + 1];
        if (typeof value !== 'string' || value.startsWith('--')) throw usageError(`参数缺少值: ${name}`);
        flags.set(name, value);
    }
    if (command === 'list') return { command };
    const key = String(flags.get('--key') || '').trim();
    if (!key) throw usageError('--key 不能为空');
    if (command === 'get') return { command, key };
    for (const name of ['--value', '--expected-id', '--expected-version']) {
        if (!flags.has(name)) throw usageError(`缺少参数: ${name}`);
    }
    let value;
    try { value = JSON.parse(flags.get('--value')); } catch { throw usageError('--value 必须是合法 JSON'); }
    const expectedId = parseNonNegativeInteger(flags.get('--expected-id'), '--expected-id');
    const expectedVersion = parseNonNegativeInteger(flags.get('--expected-version'), '--expected-version');
    if ((expectedId === 0) !== (expectedVersion === 0)) throw usageError('新建必须使用 id/version 0/0，更新必须提供正整数 id/version');
    const backupDirectory = flags.get('--backup-dir');
    if (backupDirectory !== undefined && !backupDirectory.trim()) throw usageError('--backup-dir 不能为空');
    return { command, key, value, expectedId, expectedVersion,
        desc: String(flags.get('--desc') || '').trim(),
        backupDirectory: backupDirectory === undefined ? undefined : path.resolve(backupDirectory) };
}

function writeBackup(previous, key, directory) {
    const backupDirectory = directory || path.join(os.homedir(), 'Library', 'Application Support', 'rent_task', 'config-backups');
    fs.mkdirSync(backupDirectory, { recursive: true, mode: 0o700 });
    const stamp = new Date().toISOString().replace(/[:.]/g, '-');
    const file = path.join(backupDirectory, `system-config-${stamp}-${crypto.randomUUID()}.json`);
    fs.writeFileSync(file, JSON.stringify({ format_version: 1, saved_at: new Date().toISOString(),
        config_key: key, previous }, null, 2), { encoding: 'utf8', flag: 'wx', mode: 0o600 });
    return file;
}

async function executeConfigCommand(input, dependencies = {}) {
    if (input.command === 'help') return { ok: true, help: HELP };
    if (input.command === 'list') {
        const configs = await (dependencies.listConfigs || listSystemConfigs)();
        return { ok: true, configs };
    }
    if (input.command === 'get') {
        const config = await (dependencies.getConfig || getSystemConfig)(input.key);
        return { ok: true, config };
    }
    if (input.command !== 'set') throw usageError('请选择 list、get 或 set 命令');
    const value = input.key === UHAOZU_AUTO_RESHELF_CONFIG_KEY
        ? validateUhaozuAutoReshelfValue(input.value) : input.value;
    const previous = await (dependencies.getConfig || getSystemConfig)(input.key);
    const id = previous.found ? previous.id : 0;
    const version = previous.found ? previous.version : 0;
    if (id !== input.expectedId || version !== input.expectedVersion) {
        const error = new Error('配置已变化，请重新查询 id/version 后再提交');
        error.code = 'SYSTEM_CONFIG_CONFLICT';
        throw error;
    }
    const backupPath = await (dependencies.writeBackup || writeBackup)(previous, input.key, input.backupDirectory);
    try {
        const config = await (dependencies.setConfig || setSystemConfig)(input.key, value, {
            expectedId: input.expectedId, expectedVersion: input.expectedVersion, desc: input.desc
        });
        return { ok: true, config, backup_path: backupPath };
    } catch (error) {
        error.backup_path = backupPath;
        throw error;
    }
}

if (require.main === module) {
    Promise.resolve().then(() => executeConfigCommand(parseArgs(process.argv.slice(2))))
        .then((result) => process.stdout.write(`${JSON.stringify(result, null, 2)}\n`))
        .catch((error) => {
            process.stderr.write(`${JSON.stringify({ ok: false, code: error.code || 'SYSTEM_CONFIG_CLI_FAILED',
                error: error.message, ...(error.backup_path ? { backup_path: error.backup_path } : {}) }, null, 2)}\n`);
            process.exitCode = 1;
        });
}

module.exports = { parseArgs, executeConfigCommand, writeBackup };
