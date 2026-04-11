const {
    openMainDatabase,
    openRuntimeDatabase,
    openStatsDatabase,
    openPriceDatabase,
    MAIN_DB_FILE,
    RUNTIME_DB_FILE,
    STATS_DB_FILE,
    PRICE_DB_FILE
} = require('./sqlite_client');
const { initUserDb } = require('./user_db');
const { initUserGameAccountDb } = require('./user_game_account_db');
const {
    initAccountCostRecordDb
} = require('./account_cost_record_db');
const { initUserPlatformAuthDb } = require('./user_platform_auth_db');
const { initUserPlatformRestrictDb } = require('./user_platform_restrict_db');
const { initUserSessionDb } = require('./user_session_db');
const { initUserRuleDb } = require('./user_rule_db');
const { initOrderDb } = require('./order_db');
const { initOrderSyncDb } = require('./order_sync_db');
const { initOrderStatsDailyDb } = require('./order_stats_daily_db');
const { initOrderStatsCostDailyDb } = require('./order_stats_cost_daily_db');
const { initOrderStatsWeeklySnapshotDb } = require('./order_stats_weekly_snapshot_db');
const { initOrderStatsJobStateDb } = require('./order_stats_job_state_db');
const { initOrderComplaintDb } = require('./order_complaint_db');
const { initOrderDetailDb } = require('./order_detail_db');
const { initLockDb } = require('./lock_db');
const { initUserPriceRuleDb } = require('./user_price_rule_db');
const { initPricePublishLogDb } = require('./price_publish_log_db');
const { ensureMigrationsReady } = require('./migration_runner');

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
    await ensureMigrationsReady({ logger: console });
    await initUserDb();
    await initUserGameAccountDb();
    await initAccountCostRecordDb();
    await initUserPlatformAuthDb();
    await initUserPlatformRestrictDb();
    await initUserSessionDb();
    await initUserRuleDb();
    await initOrderDb();
    await initOrderSyncDb();
    await initOrderStatsDailyDb();
    await initOrderStatsCostDailyDb();
    await initOrderStatsWeeklySnapshotDb();
    await initOrderStatsJobStateDb();
    await initOrderComplaintDb();
    await initOrderDetailDb();
    await initLockDb();
    await initUserPriceRuleDb();
    await initPricePublishLogDb();

    const mainDb = openMainDatabase();
    const runtimeDb = openRuntimeDatabase();
    const statsDb = openStatsDatabase();
    const priceDb = openPriceDatabase();
    try {
        await run(mainDb, `
            CREATE TABLE IF NOT EXISTS health_check (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                tag TEXT NOT NULL,
                created_at DATETIME DEFAULT CURRENT_TIMESTAMP
            )
        `);
        await run(mainDb, `INSERT INTO health_check(tag) VALUES (?)`, ['init_ok']);
        const mainRow = await get(mainDb, `SELECT COUNT(*) AS total FROM health_check`);
        console.log(`[SQLite] 主库连接成功 db=${MAIN_DB_FILE}`);
        console.log(`[SQLite] main health_check total=${mainRow?.total ?? 0}`);

        await run(runtimeDb, `
            CREATE TABLE IF NOT EXISTS runtime_health_check (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                tag TEXT NOT NULL,
                created_at DATETIME DEFAULT CURRENT_TIMESTAMP
            )
        `);
        await run(runtimeDb, `INSERT INTO runtime_health_check(tag) VALUES (?)`, ['init_ok']);
        const runtimeRow = await get(runtimeDb, `SELECT COUNT(*) AS total FROM runtime_health_check`);
        console.log(`[SQLite] 运行时库连接成功 db=${RUNTIME_DB_FILE}`);
        console.log(`[SQLite] runtime_health_check total=${runtimeRow?.total ?? 0}`);

        await run(statsDb, `
            CREATE TABLE IF NOT EXISTS stats_health_check (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                tag TEXT NOT NULL,
                created_at DATETIME DEFAULT CURRENT_TIMESTAMP
            )
        `);
        await run(statsDb, `INSERT INTO stats_health_check(tag) VALUES (?)`, ['init_ok']);
        const statsRow = await get(statsDb, `SELECT COUNT(*) AS total FROM stats_health_check`);
        console.log(`[SQLite] 统计库连接成功 db=${STATS_DB_FILE}`);
        console.log(`[SQLite] stats_health_check total=${statsRow?.total ?? 0}`);

        await run(priceDb, `
            CREATE TABLE IF NOT EXISTS price_health_check (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                tag TEXT NOT NULL,
                created_at DATETIME DEFAULT CURRENT_TIMESTAMP
            )
        `);
        await run(priceDb, `INSERT INTO price_health_check(tag) VALUES (?)`, ['init_ok']);
        const priceRow = await get(priceDb, `SELECT COUNT(*) AS total FROM price_health_check`);
        console.log(`[SQLite] 价格库连接成功 db=${PRICE_DB_FILE}`);
        console.log(`[SQLite] price_health_check total=${priceRow?.total ?? 0}`);
    } finally {
        mainDb.close();
        runtimeDb.close();
        statsDb.close();
        priceDb.close();
    }
}

main().catch((err) => {
    console.error('[SQLite] 初始化失败:', err.message);
    process.exit(1);
});
