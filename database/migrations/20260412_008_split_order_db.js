const { openOrderDatabase } = require('../sqlite_client');
const { _internal: orderInternal } = require('../order_db');
const { initOrderDetailDb } = require('../order_detail_db');
const { initOrderComplaintDb } = require('../order_complaint_db');

const ORDER_MAIN_BACKUP_TABLE = 'order_main_legacy_backup';
const ORDER_DETAIL_MAIN_BACKUP_TABLE = 'order_detail_main_legacy_backup';
const ORDER_COMPLAINT_MAIN_BACKUP_TABLE = 'order_complaint_main_legacy_backup';

function runLocal(db, sql, params = []) {
    return new Promise((resolve, reject) => {
        db.run(sql, params, function onRun(err) {
            if (err) return reject(err);
            resolve(this);
        });
    });
}

function allLocal(db, sql, params = []) {
    return new Promise((resolve, reject) => {
        db.all(sql, params, (err, rows) => {
            if (err) return reject(err);
            resolve(rows || []);
        });
    });
}

function quoteIdent(name) {
    return `"${String(name || '').replace(/"/g, '""')}"`;
}

async function tableExists(db, name, get) {
    const row = await get(db, `
        SELECT name
        FROM sqlite_master
        WHERE type = 'table' AND name = ?
        LIMIT 1
    `, [String(name || '')]);
    return Boolean(row && row.name);
}

async function tableColumns(db, name, all) {
    const rows = await all(db, `PRAGMA table_info(${quoteIdent(name)})`);
    return rows.map((row) => String((row && row.name) || '').trim()).filter(Boolean);
}

async function freezeSourceTable(mainDb, liveTable, backupTable, helpers) {
    const { get, run } = helpers;
    if (await tableExists(mainDb, backupTable, get)) return backupTable;
    if (!(await tableExists(mainDb, liveTable, get))) return '';
    await run(mainDb, `ALTER TABLE ${quoteIdent(liveTable)} RENAME TO ${quoteIdent(backupTable)}`);
    return backupTable;
}

async function copyRowsIntoOrderDb(sourceDb, targetDb, sourceTable, targetTable, sourceHelpers) {
    const { all } = sourceHelpers;
    if (!sourceTable) return 0;
    const sourceColumns = await tableColumns(sourceDb, sourceTable, all);
    const targetColumns = await tableColumns(targetDb, targetTable, allLocal);
    const columns = targetColumns.filter((name) => sourceColumns.includes(name));
    if (columns.length === 0) return 0;

    const rows = await all(sourceDb, `
        SELECT ${columns.map(quoteIdent).join(', ')}
        FROM ${quoteIdent(sourceTable)}
        ORDER BY id ASC
    `);
    for (const row of rows) {
        await runLocal(targetDb, `
            INSERT OR REPLACE INTO ${quoteIdent(targetTable)}
            (${columns.map(quoteIdent).join(', ')})
            VALUES (${columns.map(() => '?').join(', ')})
        `, columns.map((name) => row[name]));
    }
    return rows.length;
}

module.exports = {
    version: '20260412_008',
    name: 'split_order_db',
    desc: 'move order tables from main db into dedicated order db',
    use_transaction: false,
    async up({ db, run, get, all }) {
        const sourceHelpers = { run, get, all };
        const orderDb = openOrderDatabase();
        try {
            await orderInternal.ensureOrderTableBase(orderDb);
            await orderInternal.ensureOrderIndexes(orderDb);
            await initOrderDetailDb();
            await initOrderComplaintDb();

            const frozenOrderTable = await freezeSourceTable(db, 'order', ORDER_MAIN_BACKUP_TABLE, sourceHelpers);
            const frozenOrderDetailTable = await freezeSourceTable(db, 'order_detail', ORDER_DETAIL_MAIN_BACKUP_TABLE, sourceHelpers);
            const frozenOrderComplaintTable = await freezeSourceTable(db, 'order_complaint', ORDER_COMPLAINT_MAIN_BACKUP_TABLE, sourceHelpers);

            await copyRowsIntoOrderDb(db, orderDb, frozenOrderTable, 'order', sourceHelpers);
            await orderInternal.normalizeOrderTableData(orderDb);
            await orderInternal.ensureOrderIndexes(orderDb);

            await copyRowsIntoOrderDb(db, orderDb, frozenOrderDetailTable, 'order_detail', sourceHelpers);
            await copyRowsIntoOrderDb(db, orderDb, frozenOrderComplaintTable, 'order_complaint', sourceHelpers);
        } finally {
            orderDb.close();
        }
    }
};
