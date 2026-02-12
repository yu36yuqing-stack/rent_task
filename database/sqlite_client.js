const path = require('path');
const fs = require('fs');
const sqlite3 = require('sqlite3').verbose();

const DB_DIR = __dirname;
const DB_FILE = path.join(DB_DIR, 'rent_robot.db');

if (!fs.existsSync(DB_DIR)) {
    fs.mkdirSync(DB_DIR, { recursive: true });
}

function openDatabase() {
    return new sqlite3.Database(DB_FILE);
}

module.exports = {
    DB_DIR,
    DB_FILE,
    openDatabase
};

