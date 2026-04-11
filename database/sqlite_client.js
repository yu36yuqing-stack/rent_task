const path = require('path');
const fs = require('fs');
const sqlite3 = require('sqlite3').verbose();

const DB_DIR = __dirname;
const MAIN_DB_FILE = process.env.MAIN_DB_FILE_PATH
    ? path.resolve(process.env.MAIN_DB_FILE_PATH)
    : path.join(DB_DIR, 'rent_robot.db');
const RUNTIME_DB_FILE = process.env.RUNTIME_DB_FILE_PATH
    ? path.resolve(process.env.RUNTIME_DB_FILE_PATH)
    : path.join(DB_DIR, 'rent_robot_runtime.db');
const STATS_DB_FILE = process.env.STATS_DB_FILE_PATH
    ? path.resolve(process.env.STATS_DB_FILE_PATH)
    : path.join(DB_DIR, 'rent_robot_stats.db');
const PRICE_DB_FILE = process.env.PRICE_DB_FILE_PATH
    ? path.resolve(process.env.PRICE_DB_FILE_PATH)
    : path.join(DB_DIR, 'rent_robot_price.db');
const SQLITE_BUSY_TIMEOUT_MS = Number(process.env.SQLITE_BUSY_TIMEOUT_MS || 5000);
const SQLITE_JOURNAL_MODE = process.env.SQLITE_JOURNAL_MODE || 'WAL';

if (!fs.existsSync(DB_DIR)) {
    fs.mkdirSync(DB_DIR, { recursive: true });
}

function ensureDbDir(filePath) {
    const dir = path.dirname(filePath);
    if (!fs.existsSync(dir)) {
        fs.mkdirSync(dir, { recursive: true });
    }
}

function applyConnectionPragmas(db) {
    db.configure('busyTimeout', SQLITE_BUSY_TIMEOUT_MS);
    db.serialize(() => {
        db.run(`PRAGMA journal_mode=${SQLITE_JOURNAL_MODE}`);
        db.run(`PRAGMA busy_timeout=${SQLITE_BUSY_TIMEOUT_MS}`);
    });
    return db;
}

function openMainDatabase() {
    ensureDbDir(MAIN_DB_FILE);
    return applyConnectionPragmas(new sqlite3.Database(MAIN_DB_FILE));
}

function openRuntimeDatabase() {
    ensureDbDir(RUNTIME_DB_FILE);
    return applyConnectionPragmas(new sqlite3.Database(RUNTIME_DB_FILE));
}

function openStatsDatabase() {
    ensureDbDir(STATS_DB_FILE);
    return applyConnectionPragmas(new sqlite3.Database(STATS_DB_FILE));
}

function openPriceDatabase() {
    ensureDbDir(PRICE_DB_FILE);
    return applyConnectionPragmas(new sqlite3.Database(PRICE_DB_FILE));
}

function openDatabase() {
    return openMainDatabase();
}

module.exports = {
    DB_DIR,
    DB_FILE: MAIN_DB_FILE,
    MAIN_DB_FILE,
    RUNTIME_DB_FILE,
    STATS_DB_FILE,
    PRICE_DB_FILE,
    SQLITE_BUSY_TIMEOUT_MS,
    SQLITE_JOURNAL_MODE,
    openDatabase,
    openMainDatabase,
    openRuntimeDatabase,
    openStatsDatabase,
    openPriceDatabase
};
