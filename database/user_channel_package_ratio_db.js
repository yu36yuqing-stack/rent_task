'use strict';

const { openPriceDatabase } = require('./sqlite_client');

function nowText() {
    const d = new Date();
    const p = (n) => String(n).padStart(2, '0');
    return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
}

function run(db, sql, params = []) {
    return new Promise((resolve, reject) => {
        db.run(sql, params, function onRun(err) {
            if (err) return reject(err);
            resolve(this);
        });
    });
}

function get(db, sql, params = []) {
    return new Promise((resolve, reject) => {
        db.get(sql, params, (err, row) => {
            if (err) return reject(err);
            resolve(row || null);
        });
    });
}

function all(db, sql, params = []) {
    return new Promise((resolve, reject) => {
        db.all(sql, params, (err, rows) => {
            if (err) return reject(err);
            resolve(rows || []);
        });
    });
}

function parseRatios(value) {
    try {
        const parsed = JSON.parse(String(value || '{}'));
        return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {};
    } catch {
        return {};
    }
}

function toRatioConfig(row = {}) {
    return {
        id: Number(row.id || 0),
        user_id: Number(row.user_id || 0),
        channel: String(row.channel || '').trim(),
        ratios: parseRatios(row.ratios_json),
        version: Number(row.version || 0),
        create_date: String(row.create_date || '').trim(),
        modify_date: String(row.modify_date || '').trim(),
        is_deleted: Number(row.is_deleted || 0),
        desc: String(row.desc || '').trim()
    };
}

async function initUserChannelPackageRatioDb() {
    const db = openPriceDatabase();
    try {
        await run(db, `
            CREATE TABLE IF NOT EXISTS user_channel_package_ratio (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                user_id INTEGER NOT NULL,
                channel TEXT NOT NULL,
                ratios_json TEXT NOT NULL DEFAULT '{}',
                version INTEGER NOT NULL DEFAULT 1,
                create_date TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
                modify_date TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
                is_deleted INTEGER NOT NULL DEFAULT 0,
                desc TEXT NOT NULL DEFAULT ''
            )
        `);
        await run(db, `
            CREATE UNIQUE INDEX IF NOT EXISTS uq_user_channel_package_ratio_alive
            ON user_channel_package_ratio(user_id, channel)
            WHERE is_deleted = 0
        `);
        await run(db, `
            CREATE INDEX IF NOT EXISTS idx_user_channel_package_ratio_user
            ON user_channel_package_ratio(user_id, is_deleted)
        `);
    } finally {
        db.close();
    }
}

async function getUserChannelPackageRatio(userId, channel) {
    await initUserChannelPackageRatioDb();
    const uid = Number(userId || 0);
    const name = String(channel || '').trim();
    if (!uid || !name) return null;
    const db = openPriceDatabase();
    try {
        const row = await get(db, `
            SELECT * FROM user_channel_package_ratio
            WHERE user_id = ? AND channel = ? AND is_deleted = 0
            LIMIT 1
        `, [uid, name]);
        return row ? toRatioConfig(row) : null;
    } finally {
        db.close();
    }
}

async function listUserChannelPackageRatios(userId) {
    await initUserChannelPackageRatioDb();
    const uid = Number(userId || 0);
    if (!uid) return [];
    const db = openPriceDatabase();
    try {
        const rows = await all(db, `
            SELECT * FROM user_channel_package_ratio
            WHERE user_id = ? AND is_deleted = 0
            ORDER BY id ASC
        `, [uid]);
        return rows.map(toRatioConfig);
    } finally {
        db.close();
    }
}

async function saveUserChannelPackageRatio(userId, input = {}, options = {}) {
    await initUserChannelPackageRatioDb();
    const uid = Number(userId || 0);
    const channel = String(input.channel || '').trim();
    const ratios = input.ratios && typeof input.ratios === 'object' && !Array.isArray(input.ratios)
        ? input.ratios
        : null;
    const expectedVersion = options.expected_version === undefined || options.expected_version === null
        ? null
        : Number(options.expected_version);
    if (!uid) throw new Error('user_id 不合法');
    if (!channel) throw new Error('channel 不能为空');
    if (!ratios) throw new Error('ratios 必须是对象');
    if (expectedVersion !== null && (!Number.isInteger(expectedVersion) || expectedVersion < 0)) {
        throw new Error('expected_version 不合法');
    }

    const db = openPriceDatabase();
    try {
        const exists = await get(db, `
            SELECT * FROM user_channel_package_ratio
            WHERE user_id = ? AND channel = ? AND is_deleted = 0
            LIMIT 1
        `, [uid, channel]);
        const currentVersion = Number(exists && exists.version || 0);
        if (expectedVersion !== null && expectedVersion !== currentVersion) {
            const error = new Error('套餐倍率配置已变化，请刷新后重试');
            error.code = 'PRICE_LADDER_VERSION_CONFLICT';
            throw error;
        }
        const now = nowText();
        const ratiosJson = JSON.stringify(ratios);
        if (exists) {
            await run(db, `
                UPDATE user_channel_package_ratio
                SET ratios_json = ?, version = version + 1, modify_date = ?, desc = ?
                WHERE id = ?
            `, [ratiosJson, now, String(options.desc || input.desc || '').trim(), Number(exists.id)]);
        } else {
            await run(db, `
                INSERT INTO user_channel_package_ratio
                (user_id, channel, ratios_json, version, create_date, modify_date, is_deleted, desc)
                VALUES (?, ?, ?, 1, ?, ?, 0, ?)
            `, [uid, channel, ratiosJson, now, now, String(options.desc || input.desc || '').trim()]);
        }
        const row = await get(db, `
            SELECT * FROM user_channel_package_ratio
            WHERE user_id = ? AND channel = ? AND is_deleted = 0
            LIMIT 1
        `, [uid, channel]);
        return toRatioConfig(row || {});
    } finally {
        db.close();
    }
}

module.exports = {
    initUserChannelPackageRatioDb,
    getUserChannelPackageRatio,
    listUserChannelPackageRatios,
    saveUserChannelPackageRatio,
    _internal: { nowText, parseRatios, toRatioConfig, run, get, all }
};
