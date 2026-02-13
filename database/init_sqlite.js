const { openDatabase, DB_FILE } = require('./sqlite_client');
const { initUserDb } = require('./user_db');
const { initUserGameAccountDb } = require('./user_game_account_db');
const { initUserPlatformAuthDb } = require('./user_platform_auth_db');
const { initUserSessionDb } = require('./user_session_db');

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

async function main() {
    await initUserDb();
    await initUserGameAccountDb();
    await initUserPlatformAuthDb();
    await initUserSessionDb();

    const db = openDatabase();
    try {
        await run(db, `
            CREATE TABLE IF NOT EXISTS health_check (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                tag TEXT NOT NULL,
                created_at DATETIME DEFAULT CURRENT_TIMESTAMP
            )
        `);
        await run(db, `INSERT INTO health_check(tag) VALUES (?)`, ['init_ok']);
        const row = await get(db, `SELECT COUNT(*) AS total FROM health_check`);
        console.log(`[SQLite] 连接成功 db=${DB_FILE}`);
        console.log(`[SQLite] health_check total=${row?.total ?? 0}`);
    } finally {
        db.close();
    }
}

main().catch((err) => {
    console.error('[SQLite] 初始化失败:', err.message);
    process.exit(1);
});
