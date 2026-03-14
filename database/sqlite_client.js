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

if (!fs.existsSync(DB_DIR)) {
    fs.mkdirSync(DB_DIR, { recursive: true });
}

function ensureDbDir(filePath) {
    const dir = path.dirname(filePath);
    if (!fs.existsSync(dir)) {
        fs.mkdirSync(dir, { recursive: true });
    }
}

function openMainDatabase() {
    ensureDbDir(MAIN_DB_FILE);
    return new sqlite3.Database(MAIN_DB_FILE);
}

function openRuntimeDatabase() {
    ensureDbDir(RUNTIME_DB_FILE);
    return new sqlite3.Database(RUNTIME_DB_FILE);
}

function openDatabase() {
    return openMainDatabase();
}

module.exports = {
    DB_DIR,
    DB_FILE: MAIN_DB_FILE,
    MAIN_DB_FILE,
    RUNTIME_DB_FILE,
    openDatabase,
    openMainDatabase,
    openRuntimeDatabase
};
