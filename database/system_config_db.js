'use strict';

const { openMainDatabase } = require('./sqlite_client');

function configError(code, message) {
    return Object.assign(new Error(message), { code });
}

function normalizeKey(key) {
    if (typeof key !== 'string' || !key.trim() || /[\u0000-\u001f\u007f]/.test(key)) {
        throw configError('SYSTEM_CONFIG_INVALID_KEY', 'config key 必须是非空字符串，且不能包含控制字符');
    }
    return key.trim();
}

function serializeValue(value) {
    const ancestors = new Set();
    function validate(input) {
        if (input === null || typeof input === 'string' || typeof input === 'boolean') return;
        if (typeof input === 'number' && Number.isFinite(input)) return;
        if (!input || typeof input !== 'object') {
            throw configError('SYSTEM_CONFIG_INVALID_VALUE', 'config value 必须是可完整保存的 JSON 值');
        }
        if (ancestors.has(input)) throw configError('SYSTEM_CONFIG_INVALID_VALUE', 'config value 不能包含循环引用');
        if (!Array.isArray(input) && ![Object.prototype, null].includes(Object.getPrototypeOf(input))) {
            throw configError('SYSTEM_CONFIG_INVALID_VALUE', 'config value 仅支持 JSON 对象、数组和基本值');
        }
        if (Object.getOwnPropertySymbols(input).length) {
            throw configError('SYSTEM_CONFIG_INVALID_VALUE', 'config value 不能包含 Symbol 属性');
        }
        const toJSON = Object.getOwnPropertyDescriptor(input, 'toJSON');
        if (toJSON && (!Object.hasOwn(toJSON, 'value') || typeof toJSON.value === 'function')) {
            throw configError('SYSTEM_CONFIG_INVALID_VALUE', 'config value 不能自定义 JSON 序列化行为');
        }
        ancestors.add(input);
        if (Array.isArray(input)) {
            for (let index = 0; index < input.length; index += 1) {
                if (!Object.hasOwn(input, index)) {
                    throw configError('SYSTEM_CONFIG_INVALID_VALUE', 'config value 不能包含稀疏数组');
                }
                const descriptor = Object.getOwnPropertyDescriptor(input, index);
                if (!Object.hasOwn(descriptor, 'value')) {
                    throw configError('SYSTEM_CONFIG_INVALID_VALUE', 'config value 不能包含访问器属性');
                }
                validate(descriptor.value);
            }
            if (Object.keys(input).some(key => !/^(0|[1-9]\d*)$/.test(key) || Number(key) >= input.length)) {
                throw configError('SYSTEM_CONFIG_INVALID_VALUE', 'JSON 数组不能附带额外属性');
            }
        } else {
            for (const key of Object.keys(input)) {
                const descriptor = Object.getOwnPropertyDescriptor(input, key);
                if (!descriptor || !Object.hasOwn(descriptor, 'value')) {
                    throw configError('SYSTEM_CONFIG_INVALID_VALUE', 'config value 不能包含访问器属性');
                }
                validate(descriptor.value);
            }
        }
        ancestors.delete(input);
    }
    validate(value);
    return JSON.stringify(value);
}

function expectedIdentity(options = {}, allowCreate = true) {
    const id = options.expectedId;
    const version = options.expectedVersion;
    if (!Number.isSafeInteger(id) || !Number.isSafeInteger(version)
        || id < 0 || version < 0 || (id === 0) !== (version === 0)
        || (!allowCreate && id === 0)) {
        throw configError('SYSTEM_CONFIG_INVALID_EXPECTATION', '必须提供匹配的 expectedId 和 expectedVersion；首次创建使用 0/0');
    }
    return { id, version };
}

function run(db, sql, params = []) {
    return new Promise((resolve, reject) => db.run(sql, params, function complete(error) {
        if (error) return reject(error);
        resolve(this);
    }));
}

function get(db, sql, params = []) {
    return new Promise((resolve, reject) => db.get(sql, params, (error, row) => error ? reject(error) : resolve(row)));
}

function all(db, sql) {
    return new Promise((resolve, reject) => db.all(sql, [], (error, rows) => error ? reject(error) : resolve(rows)));
}

function close(db) {
    return new Promise((resolve, reject) => db.close(error => error ? reject(error) : resolve()));
}

function toConfig(row, key) {
    if (!row) return { found: false, id: 0, key, value: undefined, version: 0 };
    let value;
    try {
        value = JSON.parse(row.config_value);
    } catch {
        throw configError('SYSTEM_CONFIG_CORRUPT', `配置 ${row.config_key} 的存储值不是合法 JSON`);
    }
    return {
        found: true,
        id: Number(row.id),
        key: String(row.config_key),
        value,
        version: Number(row.version),
        create_date: String(row.create_date),
        modify_date: String(row.modify_date),
        is_deleted: Number(row.is_deleted),
        desc: String(row.desc)
    };
}

// Reads intentionally do not initialize the schema or recreate missing defaults.
async function getSystemConfig(inputKey) {
    const key = normalizeKey(inputKey);
    const db = openMainDatabase();
    try {
        const row = await get(db, 'SELECT * FROM system_config WHERE config_key = ? AND is_deleted = 0', [key]);
        return toConfig(row, key);
    } finally {
        await close(db);
    }
}

async function listSystemConfigs() {
    const db = openMainDatabase();
    try {
        const rows = await all(db, 'SELECT * FROM system_config WHERE is_deleted = 0 ORDER BY config_key ASC');
        return rows.map(row => toConfig(row, row.config_key));
    } finally {
        await close(db);
    }
}

async function setSystemConfig(inputKey, value, options = {}) {
    const key = normalizeKey(inputKey);
    const serialized = serializeValue(value);
    const expected = expectedIdentity(options);
    const db = openMainDatabase();
    try {
        await run(db, 'BEGIN IMMEDIATE');
        if (expected.id === 0) {
            const existing = await get(db, 'SELECT id FROM system_config WHERE config_key = ? AND is_deleted = 0', [key]);
            if (existing) throw configError('SYSTEM_CONFIG_CONFLICT', '配置已被其他操作创建，请重新查询后修改');
            await run(db, `
                INSERT INTO system_config
                    (config_key, config_value, version, create_date, modify_date, is_deleted, desc)
                VALUES (?, ?, 1, datetime('now', 'localtime'), datetime('now', 'localtime'), 0, ?)
            `, [key, serialized, String(options.desc || '')]);
        } else {
            const update = await run(db, `
                UPDATE system_config
                SET config_value = ?, version = version + 1, modify_date = datetime('now', 'localtime'),
                    desc = CASE WHEN ? IS NULL THEN desc ELSE ? END
                WHERE config_key = ? AND id = ? AND version = ? AND is_deleted = 0
            `, [serialized, options.desc === undefined ? null : String(options.desc), String(options.desc || ''),
                key, expected.id, expected.version]);
            if (update.changes !== 1) throw configError('SYSTEM_CONFIG_CONFLICT', '配置已被修改或删除，请重新查询后修改');
        }
        const row = await get(db, 'SELECT * FROM system_config WHERE config_key = ? AND is_deleted = 0', [key]);
        const saved = toConfig(row, key);
        await run(db, 'COMMIT');
        return saved;
    } catch (error) {
        await run(db, 'ROLLBACK').catch(() => {});
        throw error;
    } finally {
        await close(db);
    }
}

async function deleteSystemConfig(inputKey, options = {}) {
    const key = normalizeKey(inputKey);
    const expected = expectedIdentity(options, false);
    const db = openMainDatabase();
    try {
        const result = await run(db, `
            UPDATE system_config
            SET is_deleted = 1, version = version + 1, modify_date = datetime('now', 'localtime')
            WHERE config_key = ? AND id = ? AND version = ? AND is_deleted = 0
        `, [key, expected.id, expected.version]);
        if (result.changes !== 1) throw configError('SYSTEM_CONFIG_CONFLICT', '配置已被修改或删除，请重新查询后删除');
        return { deleted: true, id: expected.id, key, version: expected.version + 1 };
    } finally {
        await close(db);
    }
}

module.exports = { getSystemConfig, listSystemConfigs, setSystemConfig, deleteSystemConfig };
