const { openDatabase } = require('./sqlite_client');

function nowText(input = null) {
    const d = input instanceof Date ? input : new Date();
    const p = (n) => String(n).padStart(2, '0');
    return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
}

async function pruneProductOnoffHistory(options = {}) {
    const retainDays = Math.max(1, Number(options.retain_days || options.retainDays || 30));
    const cutoffMs = Date.now() - retainDays * 24 * 3600 * 1000;
    const cutoffText = nowText(new Date(cutoffMs));
    const db = openDatabase();
    try {
        const tableRow = await all(db, `
            SELECT name
            FROM sqlite_master
            WHERE type = 'table' AND name = 'product_onoff_history'
            LIMIT 1
        `);
        if (!tableRow || tableRow.length <= 0) {
            return {
                retain_days: retainDays,
                cutoff_ms: cutoffMs,
                cutoff_text: cutoffText,
                before: 0,
                after: 0,
                deleted: 0
            };
        }
        const beforeRows = await all(db, `SELECT COUNT(*) AS total FROM product_onoff_history`);
        const before = Number((((beforeRows || [])[0] || {}).total) || 0);
        await run(db, 'BEGIN IMMEDIATE');
        try {
            await run(db, `
                CREATE TABLE product_onoff_history_prune_tmp (
                    id INTEGER PRIMARY KEY AUTOINCREMENT,
                    user_id INTEGER NOT NULL,
                    user_account TEXT NOT NULL DEFAULT '',
                    action_type TEXT NOT NULL DEFAULT '',
                    platform TEXT NOT NULL DEFAULT '',
                    game_account TEXT NOT NULL DEFAULT '',
                    reason TEXT NOT NULL DEFAULT '',
                    success INTEGER NOT NULL DEFAULT 0,
                    skipped INTEGER NOT NULL DEFAULT 0,
                    mode TEXT NOT NULL DEFAULT '',
                    event_time INTEGER NOT NULL DEFAULT 0,
                    create_date TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
                    modify_date TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
                    is_deleted INTEGER NOT NULL DEFAULT 0,
                    desc TEXT NOT NULL DEFAULT '',
                    game_id TEXT NOT NULL DEFAULT '1',
                    game_name TEXT NOT NULL DEFAULT 'WZRY'
                )
            `);
            await run(db, `
                INSERT INTO product_onoff_history_prune_tmp
                (user_id, user_account, action_type, platform, game_account, reason, success, skipped, mode, event_time, create_date, modify_date, is_deleted, desc, game_id, game_name)
                SELECT user_id, user_account, action_type, platform, game_account, reason, success, skipped, mode, event_time, create_date, modify_date, is_deleted, desc, game_id, game_name
                FROM product_onoff_history NOT INDEXED
                WHERE (
                    COALESCE(event_time, 0) > 0
                    AND event_time >= ?
                ) OR (
                    COALESCE(event_time, 0) <= 0
                    AND (
                        COALESCE(modify_date, create_date, '') = ''
                        OR datetime(COALESCE(modify_date, create_date)) >= datetime(?)
                    )
                )
            `, [cutoffMs, cutoffText]);
            await run(db, `DROP TABLE product_onoff_history`);
            await run(db, `ALTER TABLE product_onoff_history_prune_tmp RENAME TO product_onoff_history`);
            await run(db, `
                CREATE INDEX IF NOT EXISTS idx_product_onoff_history_user_time
                ON product_onoff_history(user_id, event_time, is_deleted)
            `);
            await run(db, 'COMMIT');
        } catch (err) {
            await run(db, 'ROLLBACK').catch(() => {});
            throw err;
        }
        const afterRows = await all(db, `SELECT COUNT(*) AS total FROM product_onoff_history`);
        const after = Number((((afterRows || [])[0] || {}).total) || 0);
        return {
            retain_days: retainDays,
            cutoff_ms: cutoffMs,
            cutoff_text: cutoffText,
            before,
            after,
            deleted: Math.max(0, before - after)
        };
    } finally {
        db.close();
    }
}

function run(db, sql, params = []) {
    return new Promise((resolve, reject) => {
        db.run(sql, params, function onRun(err) {
            if (err) return reject(err);
            resolve(this);
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

function detectPlatformByActionType(actionType) {
    const t = String(actionType || '');
    if (t.endsWith('_y')) return 'uuzuhao';
    if (t.endsWith('_u')) return 'uhaozu';
    if (t.endsWith('_z')) return 'zuhaowang';
    return '';
}

async function initProductOnoffHistoryDb() {
    const db = openDatabase();
    try {
        await run(db, `
            CREATE TABLE IF NOT EXISTS product_onoff_history (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                user_id INTEGER NOT NULL,
                user_account TEXT NOT NULL DEFAULT '',
                action_type TEXT NOT NULL DEFAULT '',
                platform TEXT NOT NULL DEFAULT '',
                game_account TEXT NOT NULL DEFAULT '',
                game_id TEXT NOT NULL DEFAULT '1',
                game_name TEXT NOT NULL DEFAULT 'WZRY',
                reason TEXT NOT NULL DEFAULT '',
                success INTEGER NOT NULL DEFAULT 0,
                skipped INTEGER NOT NULL DEFAULT 0,
                mode TEXT NOT NULL DEFAULT '',
                event_time INTEGER NOT NULL DEFAULT 0,
                create_date TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
                modify_date TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
                is_deleted INTEGER NOT NULL DEFAULT 0,
                desc TEXT NOT NULL DEFAULT ''
            )
        `);
        const cols = await all(db, `PRAGMA table_info("product_onoff_history")`);
        const hasGameId = cols.some((x) => String(x.name || '').trim() === 'game_id');
        const hasGameName = cols.some((x) => String(x.name || '').trim() === 'game_name');
        if (!hasGameId) await run(db, `ALTER TABLE product_onoff_history ADD COLUMN game_id TEXT NOT NULL DEFAULT '1'`);
        if (!hasGameName) await run(db, `ALTER TABLE product_onoff_history ADD COLUMN game_name TEXT NOT NULL DEFAULT 'WZRY'`);
        // 仅对“同一用户+同一账号当前只存在一个游戏归属”的历史动作做安全回填；
        // 连体号/多游戏歧义记录不在这里强行猜测，避免写错历史维度。
        await run(db, `
            UPDATE product_onoff_history
            SET game_id = (
                SELECT uga.game_id
                FROM user_game_account uga
                WHERE uga.user_id = product_onoff_history.user_id
                  AND uga.game_account = product_onoff_history.game_account
                  AND uga.is_deleted = 0
                GROUP BY uga.user_id, uga.game_account
                HAVING COUNT(DISTINCT uga.game_id) = 1
            )
            WHERE is_deleted = 0
              AND TRIM(COALESCE(game_account, '')) <> ''
              AND (
                TRIM(COALESCE(game_id, '')) = ''
                OR (
                    game_id = '1'
                    AND EXISTS (
                        SELECT 1
                        FROM user_game_account uga2
                        WHERE uga2.user_id = product_onoff_history.user_id
                          AND uga2.game_account = product_onoff_history.game_account
                          AND uga2.game_id <> '1'
                          AND uga2.is_deleted = 0
                    )
                )
              )
              AND EXISTS (
                SELECT 1
                FROM user_game_account uga3
                WHERE uga3.user_id = product_onoff_history.user_id
                  AND uga3.game_account = product_onoff_history.game_account
                  AND uga3.is_deleted = 0
                GROUP BY uga3.user_id, uga3.game_account
                HAVING COUNT(DISTINCT uga3.game_id) = 1
              )
        `);
        await run(db, `
            UPDATE product_onoff_history
            SET game_name = COALESCE((
                SELECT uga.game_name
                FROM user_game_account uga
                WHERE uga.user_id = product_onoff_history.user_id
                  AND uga.game_account = product_onoff_history.game_account
                  AND uga.game_id = product_onoff_history.game_id
                  AND uga.is_deleted = 0
                ORDER BY uga.id DESC
                LIMIT 1
            ), game_name, 'WZRY')
            WHERE is_deleted = 0
              AND TRIM(COALESCE(game_account, '')) <> ''
              AND TRIM(COALESCE(game_id, '')) <> ''
        `);
        await run(db, `
            CREATE INDEX IF NOT EXISTS idx_product_onoff_history_user_time
            ON product_onoff_history(user_id, event_time, is_deleted)
        `);
    } finally {
        db.close();
    }
}

async function appendProductOnoffHistory(input = {}) {
    await initProductOnoffHistoryDb();
    const userId = Number(input.user_id || 0);
    if (!userId) return false;

    const actionType = String(input.action_type || '').trim();
    if (!actionType) return false;

    const ts = Number(input.event_time || Date.now());
    const db = openDatabase();
    try {
        await run(db, `
            INSERT INTO product_onoff_history
            (user_id, user_account, action_type, platform, game_account, game_id, game_name, reason, success, skipped, mode, event_time, create_date, modify_date, is_deleted, desc)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, ?)
        `, [
            userId,
            String(input.user_account || '').trim(),
            actionType,
            String(input.platform || detectPlatformByActionType(actionType)).trim(),
            String(input.game_account || '').trim(),
            String(input.game_id || '1').trim() || '1',
            String(input.game_name || 'WZRY').trim() || 'WZRY',
            String(input.reason || '').trim(),
            Number(input.success ? 1 : 0),
            Number(input.skipped ? 1 : 0),
            String(input.mode || '').trim(),
            ts,
            nowText(),
            nowText(),
            String(input.desc || '').trim()
        ]);
        return true;
    } finally {
        db.close();
    }
}

async function listRecentProductOnoffByUser(userId, options = {}) {
    await initProductOnoffHistoryDb();
    const uid = Number(userId || 0);
    if (!uid) return [];
    const windowMs = Math.max(60 * 1000, Number(options.window_ms || 3600 * 1000));
    const limit = Math.max(1, Number(options.limit || 8));
    const since = Date.now() - windowMs;

    const db = openDatabase();
    try {
        const rows = await all(db, `
            SELECT user_id, user_account, action_type, platform, game_account, game_id, game_name, reason, success, skipped, mode, event_time
            FROM product_onoff_history
            WHERE user_id = ? AND is_deleted = 0 AND event_time >= ?
            ORDER BY event_time DESC
            LIMIT ?
        `, [uid, since, limit]);
        return rows.reverse();
    } finally {
        db.close();
    }
}

module.exports = {
    initProductOnoffHistoryDb,
    appendProductOnoffHistory,
    listRecentProductOnoffByUser,
    pruneProductOnoffHistory
};
