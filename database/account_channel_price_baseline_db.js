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

function toBaseline(row = {}) {
    return {
        id: Number(row.id || 0),
        user_id: Number(row.user_id || 0),
        game_id: String(row.game_id || '').trim(),
        game_name: String(row.game_name || '').trim(),
        game_account: String(row.game_account || '').trim(),
        channel: String(row.channel || '').trim(),
        goods_id: String(row.goods_id || '').trim(),
        prices: {
            hour: Number(row.price_hour || 0),
            night: Number(row.price_night || 0),
            day: Number(row.price_day || 0),
            week: Number(row.price_week || 0)
        },
        version: Number(row.version || 0),
        source_sync_time: String(row.source_sync_time || '').trim(),
        create_date: String(row.create_date || '').trim(),
        modify_date: String(row.modify_date || '').trim(),
        is_deleted: Number(row.is_deleted || 0),
        desc: String(row.desc || '').trim()
    };
}

async function initAccountChannelPriceBaselineDb() {
    const db = openPriceDatabase();
    try {
        await run(db, `
            CREATE TABLE IF NOT EXISTS account_channel_price_baseline (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                user_id INTEGER NOT NULL,
                game_id TEXT NOT NULL,
                game_name TEXT NOT NULL,
                game_account TEXT NOT NULL,
                channel TEXT NOT NULL,
                goods_id TEXT NOT NULL DEFAULT '',
                price_hour REAL NOT NULL,
                price_night REAL NOT NULL DEFAULT 0,
                price_day REAL NOT NULL DEFAULT 0,
                price_week REAL NOT NULL DEFAULT 0,
                version INTEGER NOT NULL DEFAULT 1,
                source_sync_time TEXT NOT NULL DEFAULT '',
                create_date TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
                modify_date TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
                is_deleted INTEGER NOT NULL DEFAULT 0,
                desc TEXT NOT NULL DEFAULT ''
            )
        `);
        await run(db, `
            CREATE UNIQUE INDEX IF NOT EXISTS uq_account_channel_price_baseline_alive
            ON account_channel_price_baseline(user_id, game_id, game_account, channel)
            WHERE is_deleted = 0
        `);
        await run(db, `
            CREATE INDEX IF NOT EXISTS idx_account_channel_price_baseline_user_game
            ON account_channel_price_baseline(user_id, game_id, channel, is_deleted)
        `);
    } finally {
        db.close();
    }
}

async function getAccountChannelPriceBaseline(userId, gameId, gameAccount, channel) {
    await initAccountChannelPriceBaselineDb();
    const uid = Number(userId || 0);
    const gid = String(gameId || '').trim();
    const account = String(gameAccount || '').trim();
    const channelName = String(channel || '').trim();
    if (!uid || !gid || !account || !channelName) return null;
    const db = openPriceDatabase();
    try {
        const row = await get(db, `
            SELECT *
            FROM account_channel_price_baseline
            WHERE user_id = ? AND game_id = ? AND game_account = ? AND channel = ? AND is_deleted = 0
            LIMIT 1
        `, [uid, gid, account, channelName]);
        return row ? toBaseline(row) : null;
    } finally {
        db.close();
    }
}

async function saveAccountChannelPriceBaseline(userId, input = {}, options = {}) {
    await initAccountChannelPriceBaselineDb();
    const uid = Number(userId || 0);
    const gameId = String(input.game_id || '').trim();
    const gameName = String(input.game_name || '').trim();
    const gameAccount = String(input.game_account || '').trim();
    const channel = String(input.channel || '').trim();
    const prices = input.prices && typeof input.prices === 'object' ? input.prices : {};
    const normalized = {
        hour: Number(prices.hour || 0),
        night: Number(prices.night || 0),
        day: Number(prices.day || 0),
        week: Number(prices.week || 0)
    };
    if (!uid) throw new Error('user_id 不合法');
    if (!gameId || !gameName || !gameAccount || !channel) throw new Error('价格基准账号信息不完整');
    if (!Number.isFinite(normalized.hour) || normalized.hour <= 0) throw new Error('基准时租价不合法');
    if ([normalized.night, normalized.day, normalized.week].some((value) => !Number.isFinite(value) || value < 0)) {
        throw new Error('基准套餐价格不合法');
    }

    const db = openPriceDatabase();
    try {
        const exists = await get(db, `
            SELECT id
            FROM account_channel_price_baseline
            WHERE user_id = ? AND game_id = ? AND game_account = ? AND channel = ? AND is_deleted = 0
            LIMIT 1
        `, [uid, gameId, gameAccount, channel]);
        const now = nowText();
        if (exists && options.replace !== true) {
            const row = await get(db, 'SELECT * FROM account_channel_price_baseline WHERE id = ?', [Number(exists.id)]);
            return toBaseline(row || {});
        }
        if (exists) {
            await run(db, `
                UPDATE account_channel_price_baseline
                SET game_name = ?, goods_id = ?, price_hour = ?, price_night = ?, price_day = ?, price_week = ?,
                    version = version + 1, source_sync_time = ?, modify_date = ?, desc = ?
                WHERE id = ?
            `, [
                gameName,
                String(input.goods_id || '').trim(),
                normalized.hour,
                normalized.night,
                normalized.day,
                normalized.week,
                String(input.source_sync_time || now).trim(),
                now,
                String(options.desc || input.desc || '').trim(),
                Number(exists.id)
            ]);
        } else {
            await run(db, `
                INSERT INTO account_channel_price_baseline
                (user_id, game_id, game_name, game_account, channel, goods_id, price_hour, price_night, price_day, price_week,
                 version, source_sync_time, create_date, modify_date, is_deleted, desc)
                VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?, ?, 0, ?)
            `, [
                uid,
                gameId,
                gameName,
                gameAccount,
                channel,
                String(input.goods_id || '').trim(),
                normalized.hour,
                normalized.night,
                normalized.day,
                normalized.week,
                String(input.source_sync_time || now).trim(),
                now,
                now,
                String(options.desc || input.desc || '').trim()
            ]);
        }
        const row = await get(db, `
            SELECT *
            FROM account_channel_price_baseline
            WHERE user_id = ? AND game_id = ? AND game_account = ? AND channel = ? AND is_deleted = 0
            LIMIT 1
        `, [uid, gameId, gameAccount, channel]);
        return toBaseline(row || {});
    } finally {
        db.close();
    }
}

module.exports = {
    initAccountChannelPriceBaselineDb,
    getAccountChannelPriceBaseline,
    saveAccountChannelPriceBaseline,
    _internal: {
        nowText,
        toBaseline,
        run,
        get
    }
};
