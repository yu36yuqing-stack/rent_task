const { openDatabase } = require('./sqlite_client');

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
            resolve(row);
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

function toNumberSafe(value, defaultValue = 0) {
    const n = Number(value);
    return Number.isFinite(n) ? n : defaultValue;
}

function toMoney2(value) {
    const n = Number(value);
    if (!Number.isFinite(n)) return 0;
    return Number(n.toFixed(2));
}

function toDateTimeText(value) {
    if (value === null || value === undefined || value === '') return '';
    if (typeof value === 'string' && /\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}/.test(value)) {
        return value.slice(0, 19);
    }
    const n = Number(value);
    if (!Number.isFinite(n) || n <= 0) return '';
    const ms = n > 1e12 ? n : n * 1000;
    const d = new Date(ms);
    if (Number.isNaN(d.getTime())) return '';
    const p = (x) => String(x).padStart(2, '0');
    return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
}

function normalizeOrderStatusForStore(value) {
    const raw = String(value ?? '').trim();
    if (!raw) return '';
    if (raw === '租赁中' || raw === '已完成' || raw === '部分完成' || raw === '已撤单' || raw === '退款中' || raw === '已退款' || raw === '结算中' || raw === '投诉/撤单') return raw;
    const n = Number(raw);
    if (!Number.isFinite(n)) return raw;
    if (n === 3000) return '租赁中';
    if (n === 4000) return '已完成';
    if (n === 4100) return '退款中';
    if (n === 4200) return '已退款';
    if (n === 8000) return '结算中';
    if (n === 9900) return '投诉/撤单';
    return raw;
}

async function tableExists(db, name) {
    const row = await get(db, `
        SELECT name FROM sqlite_master
        WHERE type='table' AND name = ?
        LIMIT 1
    `, [name]);
    return Boolean(row && row.name);
}

async function tableColumns(db, name) {
    const rows = await all(db, `PRAGMA table_info("${name}")`);
    return rows.map((r) => String(r.name || ''));
}

async function migrateFromLegacyUserOrderTable(db) {
    const hasLegacy = await tableExists(db, 'user_order');
    if (!hasLegacy) return;

    const legacyCols = await tableColumns(db, 'user_order');
    const hasRentHour = legacyCols.includes('rent_hour');
    const hasRenHour = legacyCols.includes('ren_hour');
    const rentExpr = hasRentHour ? 'COALESCE(rent_hour, 0)' : (hasRenHour ? 'COALESCE(ren_hour, 0)' : '0');

    const orderCols = await tableColumns(db, 'order');
    const createColForInsert = orderCols.includes('create_date') ? 'create_date' : 'create_time';
    const hasRenWayInOrder = orderCols.includes('ren_way');

    const rows = await all(db, `
        SELECT
            user_id, channel, order_no, game_id, game_name, game_account, role_name,
            order_status, create_time, order_amount, rec_amount, start_time, end_time,
            ${rentExpr} AS rent_hour,
            modify_date, is_deleted, desc
        FROM user_order
    `);

    for (const row of rows) {
        await run(db, `
            INSERT OR REPLACE INTO "order"
            (user_id, channel, order_no, game_id, game_name, game_account, role_name, order_status, order_amount, rent_hour, ${hasRenWayInOrder ? 'ren_way,' : ''} rec_amount, start_time, end_time, ${createColForInsert}, modify_date, is_deleted, desc)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ${hasRenWayInOrder ? '?, ' : ''}?, ?, ?, ?, ?, ?, ?)
        `, [
            Number(row.user_id || 0),
            String(row.channel || '').trim().toLowerCase(),
            String(row.order_no || '').trim(),
            String(row.game_id ?? '').trim(),
            String(row.game_name || 'WZRY').trim() || 'WZRY',
            String(row.game_account || '').trim(),
            String(row.role_name || '').trim(),
            normalizeOrderStatusForStore(row.order_status),
            toMoney2(row.order_amount),
            toNumberSafe(row.rent_hour, 0),
            ...(hasRenWayInOrder ? [String(row.ren_way || '')] : []),
            toNumberSafe(row.rec_amount, 0),
            toDateTimeText(row.start_time),
            toDateTimeText(row.end_time),
            toDateTimeText(row.create_time),
            String(row.modify_date || nowText()),
            Number(row.is_deleted || 0),
            String(row.desc || '')
        ]);
    }

    await run(db, `DROP TABLE IF EXISTS user_order`);
}

async function rebuildOrderTableToTargetSchemaIfNeeded(db) {
    const expected = [
        'id',
        'user_id',
        'channel',
        'order_no',
        'game_id',
        'game_name',
        'game_account',
        'role_name',
        'order_status',
        'order_amount',
        'rent_hour',
        'ren_way',
        'rec_amount',
        'start_time',
        'end_time',
        'create_date',
        'modify_date',
        'is_deleted',
        'desc'
    ];
    const cols = await tableColumns(db, 'order');
    const same = cols.length === expected.length && cols.every((name, i) => name === expected[i]);
    if (same) return;

    await run(db, `ALTER TABLE "order" RENAME TO order_old`);
    await run(db, `
        CREATE TABLE "order" (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            user_id INTEGER NOT NULL,
            channel TEXT NOT NULL DEFAULT '',
            order_no TEXT NOT NULL DEFAULT '',
            game_id TEXT NOT NULL DEFAULT '',
            game_name TEXT NOT NULL DEFAULT 'WZRY',
            game_account TEXT NOT NULL DEFAULT '',
            role_name TEXT NOT NULL DEFAULT '',
            order_status TEXT NOT NULL DEFAULT '',
            order_amount REAL NOT NULL DEFAULT 0,
            rent_hour INTEGER NOT NULL DEFAULT 0,
            ren_way TEXT NOT NULL DEFAULT '',
            rec_amount REAL NOT NULL DEFAULT 0,
            start_time TEXT NOT NULL DEFAULT '',
            end_time TEXT NOT NULL DEFAULT '',
            create_date TEXT NOT NULL DEFAULT '',
            modify_date TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
            is_deleted INTEGER NOT NULL DEFAULT 0,
            desc TEXT NOT NULL DEFAULT ''
        )
    `);

    const oldCols = await tableColumns(db, 'order_old');
    const hasRentHour = oldCols.includes('rent_hour');
    const hasRenHour = oldCols.includes('ren_hour');
    const rentExpr = hasRentHour ? 'COALESCE(rent_hour, 0)' : (hasRenHour ? 'COALESCE(ren_hour, 0)' : '0');
    const hasRenWay = oldCols.includes('ren_way');
    const renWayExpr = hasRenWay ? 'COALESCE(ren_way, \'\')' : '\'\'';
    const hasCreateDate = oldCols.includes('create_date');
    const createExpr = hasCreateDate ? 'create_date' : 'create_time';

    const rows = await all(db, `
        SELECT
            user_id, channel, order_no, game_id, game_name, game_account, role_name,
            order_status, ${createExpr} AS create_raw, order_amount, rec_amount, start_time, end_time,
            ${rentExpr} AS rent_hour,
            ${renWayExpr} AS ren_way,
            modify_date, is_deleted, desc
        FROM order_old
    `);
    for (const row of rows) {
        await run(db, `
            INSERT INTO "order"
            (user_id, channel, order_no, game_id, game_name, game_account, role_name, order_status, order_amount, rent_hour, ren_way, rec_amount, start_time, end_time, create_date, modify_date, is_deleted, desc)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `, [
            Number(row.user_id || 0),
            String(row.channel || '').trim().toLowerCase(),
            String(row.order_no || '').trim(),
            String(row.game_id ?? '').trim(),
            String(row.game_name || 'WZRY').trim() || 'WZRY',
            String(row.game_account || '').trim(),
            String(row.role_name || '').trim(),
            normalizeOrderStatusForStore(row.order_status),
            toMoney2(row.order_amount),
            toNumberSafe(row.rent_hour, 0),
            String(row.ren_way || ''),
            toNumberSafe(row.rec_amount, 0),
            toDateTimeText(row.start_time),
            toDateTimeText(row.end_time),
            toDateTimeText(row.create_raw),
            String(row.modify_date || nowText()),
            Number(row.is_deleted || 0),
            String(row.desc || '')
        ]);
    }
    await run(db, `DROP TABLE order_old`);
}

async function initOrderDb() {
    const db = openDatabase();
    try {
        await run(db, `
            CREATE TABLE IF NOT EXISTS "order" (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                user_id INTEGER NOT NULL,
                channel TEXT NOT NULL DEFAULT '',
                order_no TEXT NOT NULL DEFAULT '',
                game_id TEXT NOT NULL DEFAULT '',
                game_name TEXT NOT NULL DEFAULT 'WZRY',
                game_account TEXT NOT NULL DEFAULT '',
                role_name TEXT NOT NULL DEFAULT '',
                order_status TEXT NOT NULL DEFAULT '',
                order_amount REAL NOT NULL DEFAULT 0,
                rent_hour INTEGER NOT NULL DEFAULT 0,
                ren_way TEXT NOT NULL DEFAULT '',
                rec_amount REAL NOT NULL DEFAULT 0,
                start_time TEXT NOT NULL DEFAULT '',
                end_time TEXT NOT NULL DEFAULT '',
                create_date TEXT NOT NULL DEFAULT '',
                modify_date TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
                is_deleted INTEGER NOT NULL DEFAULT 0,
                desc TEXT NOT NULL DEFAULT ''
            )
        `);

        await migrateFromLegacyUserOrderTable(db);
        await rebuildOrderTableToTargetSchemaIfNeeded(db);

        await run(db, `
            CREATE UNIQUE INDEX IF NOT EXISTS uq_order_alive
            ON "order"(user_id, channel, order_no, is_deleted)
        `);
        await run(db, `
            CREATE INDEX IF NOT EXISTS idx_order_user_time
            ON "order"(user_id, create_date, is_deleted)
        `);
        await run(db, `
            CREATE INDEX IF NOT EXISTS idx_order_channel_time
            ON "order"(channel, create_date, is_deleted)
        `);
        await run(db, `
            UPDATE "order"
            SET game_name = 'WZRY', modify_date = ?
            WHERE channel = 'uuzuhao'
              AND is_deleted = 0
              AND (game_name = '王者荣耀' OR UPPER(game_name) = 'WZRY')
        `, [nowText()]);
        await run(db, `
            UPDATE "order"
            SET order_status = CASE
                WHEN order_status IN ('租赁中', '已完成', '部分完成', '已撤单', '退款中', '已退款', '结算中', '投诉/撤单') THEN order_status
                WHEN order_status IN ('50', 50) THEN '已完成'
                WHEN order_status IN ('52', 52) THEN '部分完成'
                WHEN order_status IN ('60', 60) THEN '已撤单'
                WHEN order_status IN ('3000', 3000) THEN '租赁中'
                WHEN order_status IN ('4000', 4000) THEN '已完成'
                WHEN order_status IN ('4100', 4100) THEN '退款中'
                WHEN order_status IN ('4200', 4200) THEN '已退款'
                WHEN order_status IN ('8000', 8000) THEN '结算中'
                WHEN order_status IN ('9900', 9900) THEN '投诉/撤单'
                WHEN TRIM(CAST(order_status AS TEXT)) = '' THEN ''
                ELSE CAST(order_status AS TEXT)
            END,
            modify_date = ?
            WHERE is_deleted = 0
        `, [nowText()]);
        await run(db, `
            UPDATE "order"
            SET order_amount = ROUND(COALESCE(order_amount, 0), 2),
                modify_date = ?
            WHERE is_deleted = 0
        `, [nowText()]);
        await run(db, `
            UPDATE "order"
            SET ren_way = CASE
                WHEN TRIM(COALESCE(ren_way, '')) <> '' THEN ren_way
                WHEN channel = 'uuzuhao' THEN '时租'
                ELSE ''
            END,
            modify_date = ?
            WHERE is_deleted = 0
        `, [nowText()]);
    } finally {
        db.close();
    }
}

function normalizeOrder(input = {}) {
    const userId = Number(input.user_id || 0);
    const channel = String(input.channel || '').trim().toLowerCase();
    const orderNo = String(input.order_no || '').trim();
    const gameId = String(input.game_id ?? '').trim();
    const gameName = String(input.game_name || 'WZRY').trim() || 'WZRY';
    const gameAccount = String(input.game_account || '').trim();
    const roleName = String(input.role_name || '').trim();
    const orderStatus = normalizeOrderStatusForStore(input.order_status);
    const createDate = toDateTimeText(input.create_date ?? input.create_time);
    const orderAmount = toMoney2(input.order_amount);
    const rentHour = Number(input.rent_hour ?? input.ren_hour ?? 0);
    const renWay = String(input.ren_way || '').trim();
    const recAmount = Number(input.rec_amount || 0);
    const startTime = toDateTimeText(input.start_time);
    const endTime = toDateTimeText(input.end_time);
    const desc = String(input.desc || '').trim();

    if (!userId) throw new Error('user_id 不合法');
    if (!channel) throw new Error('channel 不能为空');
    if (!orderNo) throw new Error('order_no 不能为空');

    return {
        user_id: userId,
        channel,
        order_no: orderNo,
        game_id: gameId,
        game_name: gameName,
        game_account: gameAccount,
        role_name: roleName,
        order_status: orderStatus,
        order_amount: orderAmount,
        rent_hour: Number.isFinite(rentHour) ? rentHour : 0,
        ren_way: renWay,
        rec_amount: Number.isFinite(recAmount) ? recAmount : 0,
        start_time: startTime,
        end_time: endTime,
        create_date: createDate,
        desc
    };
}

async function upsertOrder(input = {}) {
    await initOrderDb();
    const row = normalizeOrder(input);
    const db = openDatabase();
    try {
        const existed = await get(db, `
            SELECT id
            FROM "order"
            WHERE user_id = ? AND channel = ? AND order_no = ? AND is_deleted = 0
            LIMIT 1
        `, [row.user_id, row.channel, row.order_no]);

        if (!existed) {
            await run(db, `
                INSERT INTO "order"
                (user_id, channel, order_no, game_id, game_name, game_account, role_name, order_status, order_amount, rent_hour, ren_way, rec_amount, start_time, end_time, create_date, modify_date, is_deleted, desc)
                VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, ?)
            `, [
                row.user_id,
                row.channel,
                row.order_no,
                row.game_id,
                row.game_name,
                row.game_account,
                row.role_name,
                row.order_status,
                row.order_amount,
                row.rent_hour,
                row.ren_way,
                row.rec_amount,
                row.start_time,
                row.end_time,
                row.create_date,
                nowText(),
                row.desc
            ]);
        } else {
            await run(db, `
                UPDATE "order"
                SET game_id = ?, game_name = ?, game_account = ?, role_name = ?,
                    order_status = ?, order_amount = ?, rent_hour = ?, ren_way = ?, rec_amount = ?,
                    start_time = ?, end_time = ?, create_date = ?, modify_date = ?, desc = ?
                WHERE id = ?
            `, [
                row.game_id,
                row.game_name,
                row.game_account,
                row.role_name,
                row.order_status,
                row.order_amount,
                row.rent_hour,
                row.ren_way,
                row.rec_amount,
                row.start_time,
                row.end_time,
                row.create_date,
                nowText(),
                row.desc,
                Number(existed.id)
            ]);
        }
    } finally {
        db.close();
    }
}

async function listOrders(userId, page = 1, pageSize = 50) {
    await initOrderDb();
    const uid = Number(userId || 0);
    if (!uid) throw new Error('user_id 不合法');

    const p = Math.max(1, Number(page || 1));
    const ps = Math.min(500, Math.max(1, Number(pageSize || 50)));
    const offset = (p - 1) * ps;

    const db = openDatabase();
    try {
        const totalRow = await get(db, `
            SELECT COUNT(*) AS total
            FROM "order"
            WHERE user_id = ? AND is_deleted = 0
        `, [uid]);
        const list = await all(db, `
            SELECT *
            FROM "order"
            WHERE user_id = ? AND is_deleted = 0
            ORDER BY create_date DESC, id DESC
            LIMIT ? OFFSET ?
        `, [uid, ps, offset]);
        return {
            page: p,
            page_size: ps,
            total: Number(totalRow?.total || 0),
            list
        };
    } finally {
        db.close();
    }
}

function todayDateText() {
    const d = new Date();
    const p = (n) => String(n).padStart(2, '0');
    return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

async function listTodayOrderCountByAccounts(userId, gameAccounts = [], dateText = '') {
    await initOrderDb();
    const uid = Number(userId || 0);
    if (!uid) throw new Error('user_id 不合法');

    const uniq = Array.from(new Set((Array.isArray(gameAccounts) ? gameAccounts : [])
        .map((x) => String(x || '').trim())
        .filter(Boolean)));
    if (uniq.length === 0) return {};

    const day = String(dateText || todayDateText()).slice(0, 10);
    const placeholders = uniq.map(() => '?').join(',');
    const db = openDatabase();
    try {
        const rows = await all(db, `
            SELECT game_account, COUNT(*) AS cnt
            FROM "order"
            WHERE user_id = ?
              AND is_deleted = 0
              AND game_account IN (${placeholders})
              AND substr(start_time, 1, 10) = ?
            GROUP BY game_account
        `, [uid, ...uniq, day]);
        const out = {};
        for (const row of rows) {
            const acc = String(row.game_account || '').trim();
            if (!acc) continue;
            out[acc] = Number(row.cnt || 0);
        }
        return out;
    } finally {
        db.close();
    }
}

async function listTodayPaidOrderCountByAccounts(userId, gameAccounts = [], dateText = '') {
    await initOrderDb();
    const uid = Number(userId || 0);
    if (!uid) throw new Error('user_id 不合法');

    const uniq = Array.from(new Set((Array.isArray(gameAccounts) ? gameAccounts : [])
        .map((x) => String(x || '').trim())
        .filter(Boolean)));
    if (uniq.length === 0) return {};

    const day = String(dateText || todayDateText()).slice(0, 10);
    const dayStart6 = `${day} 06:00:00`;
    const placeholders = uniq.map(() => '?').join(',');
    const db = openDatabase();
    try {
        const rows = await all(db, `
            SELECT game_account, COUNT(*) AS cnt
            FROM "order"
            WHERE user_id = ?
              AND is_deleted = 0
              AND game_account IN (${placeholders})
              AND (
                  COALESCE(order_status, '') IN ('租赁中', '出租中')
                  OR (
                      COALESCE(order_status, '') NOT IN ('租赁中', '出租中')
                      AND end_time >= ?
                      AND end_time < datetime(?, '+1 day')
                      AND COALESCE(rec_amount, 0) > 0
                  )
              )
            GROUP BY game_account
        `, [uid, ...uniq, dayStart6, dayStart6]);
        const out = {};
        for (const row of rows) {
            const acc = String(row.game_account || '').trim();
            if (!acc) continue;
            out[acc] = Number(row.cnt || 0);
        }
        return out;
    } finally {
        db.close();
    }
}

module.exports = {
    initOrderDb,
    upsertOrder,
    listOrders,
    listTodayOrderCountByAccounts,
    listTodayPaidOrderCountByAccounts,
    // 兼容旧调用名
    initUserOrderDb: initOrderDb,
    upsertUserOrder: upsertOrder,
    listUserOrders: listOrders
};
