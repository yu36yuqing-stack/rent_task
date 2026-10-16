#!/usr/bin/env node
'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'rent-price-count-mode-db-'));
for (const kind of ['MAIN', 'RUNTIME', 'ORDER', 'STATS', 'PRICE']) {
    process.env[`${kind}_DB_FILE_PATH`] = path.join(tempDir, `${kind.toLowerCase()}.db`);
}

const { openPriceDatabase } = require('../database/sqlite_client');
const {
    initPriceLadderFeatureConfigDb,
    getPriceLadderFeatureConfig,
    setPriceLadderFeatureEnabled,
    markPriceLadderFeatureReconciled,
    _internal: { run, get, all, nowText, toConfig }
} = require('../database/price_ladder_feature_config_db');
const migration = require('../database/migrations/20261016_020_price_ladder_count_mode');

function close(db) {
    return new Promise((resolve, reject) => db.close(err => err ? reject(err) : resolve()));
}

async function main() {
    const db = openPriceDatabase();
    try {
        // Reproduce a deployed schema that predates the new count mode column.
        await run(db, `CREATE TABLE price_ladder_feature_config (
            id INTEGER PRIMARY KEY AUTOINCREMENT, user_id INTEGER NOT NULL,
            enabled INTEGER NOT NULL DEFAULT 0, reconcile_required INTEGER NOT NULL DEFAULT 0,
            version INTEGER NOT NULL DEFAULT 1, create_date TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
            modify_date TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP, is_deleted INTEGER NOT NULL DEFAULT 0,
            desc TEXT NOT NULL DEFAULT '')`);
        await run(db, `INSERT INTO price_ladder_feature_config (user_id, enabled, version, desc)
            VALUES (8, 1, 4, 'existing enabled owner'), (9, 0, 3, 'existing disabled owner')`);
        await run(db, `INSERT INTO price_ladder_feature_config (user_id, enabled, reconcile_required, version)
            VALUES (12, 1, 1, 2)`);
        assert.strictEqual(migration.version, '20261016_020');
        assert.strictEqual(migration.use_transaction, false);
        await migration.up();
        await migration.up();
        await Promise.all([initPriceLadderFeatureConfigDb(), initPriceLadderFeatureConfigDb()]);
        const columns = await all(db, 'PRAGMA table_info(price_ladder_feature_config)');
        assert.strictEqual(columns.filter(column => column.name === 'count_mode').length, 1);
        assert.strictEqual(columns.filter(column => column.name === 'reconcile_reason').length, 1);
        let enabled = await getPriceLadderFeatureConfig(8);
        const disabled = await getPriceLadderFeatureConfig(9);
        assert.strictEqual(enabled.enabled, true);
        assert.strictEqual(enabled.version, 4);
        assert.strictEqual(enabled.count_mode, 'rolling_24h');
        assert.strictEqual(enabled.reconcile_required, false);
        assert.strictEqual(enabled.reconcile_reason, '');
        assert.strictEqual(enabled.desc, 'existing enabled owner');
        assert.strictEqual(disabled.enabled, false);
        assert.strictEqual(disabled.version, 3);
        assert.strictEqual(disabled.count_mode, 'rolling_24h');

        enabled = await setPriceLadderFeatureEnabled(8, true, { expected_version: 4, count_mode: 'business_day' });
        assert.strictEqual(enabled.count_mode, 'business_day');
        assert.strictEqual(enabled.enabled, true);
        assert.strictEqual(enabled.version, 5);
        assert.strictEqual(enabled.reconcile_required, true);
        assert.strictEqual(enabled.reconcile_reason, 'count_mode_changed');
        assert.strictEqual(await markPriceLadderFeatureReconciled(8, 4), false);
        assert.strictEqual((await getPriceLadderFeatureConfig(8)).reconcile_reason, 'count_mode_changed');
        assert.strictEqual(await markPriceLadderFeatureReconciled(8, 5), true);
        assert.strictEqual((await getPriceLadderFeatureConfig(8)).reconcile_reason, '');

        // Old clients omit count_mode; they must preserve the owner's current mode.
        enabled = await setPriceLadderFeatureEnabled(8, true, { expected_version: 5 });
        assert.strictEqual(enabled.count_mode, 'business_day');
        assert.strictEqual(enabled.reconcile_required, false);
        enabled = await setPriceLadderFeatureEnabled(8, true, { expected_version: 6, count_mode: 'business_day' });
        assert.strictEqual(enabled.reconcile_required, false);
        assert.strictEqual(enabled.version, 7);

        const raced = await Promise.allSettled([
            setPriceLadderFeatureEnabled(8, true, { expected_version: 7, count_mode: 'rolling_24h' }),
            setPriceLadderFeatureEnabled(8, true, { expected_version: 7, count_mode: 'business_day' })
        ]);
        assert.strictEqual(raced.filter(result => result.status === 'fulfilled').length, 1);
        const rejected = raced.find(result => result.status === 'rejected');
        assert.strictEqual(rejected.reason.code, 'PRICE_LADDER_VERSION_CONFLICT');
        const raceWinner = raced.find(result => result.status === 'fulfilled').value;
        assert.strictEqual(raceWinner.version, 8);
        assert.strictEqual(raceWinner.enabled, true);
        assert.strictEqual(raceWinner.reconcile_required, raceWinner.count_mode !== 'business_day');

        let savedDisabled = await setPriceLadderFeatureEnabled(9, false, { expected_version: 3, count_mode: 'business_day' });
        assert.strictEqual(savedDisabled.enabled, false);
        assert.strictEqual(savedDisabled.reconcile_required, false);
        assert.strictEqual(savedDisabled.reconcile_reason, '');
        assert.strictEqual(savedDisabled.count_mode, 'business_day');
        savedDisabled = await setPriceLadderFeatureEnabled(9, true, { expected_version: 4 });
        assert.strictEqual(savedDisabled.count_mode, 'business_day');
        assert.strictEqual(savedDisabled.reconcile_required, true);
        assert.strictEqual(savedDisabled.reconcile_reason, 'feature_enabled');
        savedDisabled = await setPriceLadderFeatureEnabled(9, false, { expected_version: 5 });
        assert.strictEqual(savedDisabled.count_mode, 'business_day');
        assert.strictEqual(savedDisabled.reconcile_required, false);
        assert.strictEqual(savedDisabled.reconcile_reason, '');
        assert.strictEqual(await markPriceLadderFeatureReconciled(9, 6), false);

        const fresh = await getPriceLadderFeatureConfig(10);
        assert.strictEqual(fresh.count_mode, 'rolling_24h');
        assert.strictEqual(fresh.version, 0);
        assert.strictEqual(fresh.enabled, false);
        const inserted = await setPriceLadderFeatureEnabled(10, true, { expected_version: 0 });
        assert.strictEqual(inserted.count_mode, 'rolling_24h');
        assert.strictEqual(inserted.reconcile_required, true);
        assert.strictEqual(inserted.reconcile_reason, 'feature_enabled');
        const activationStillPending = await setPriceLadderFeatureEnabled(10, true, { count_mode: 'business_day' });
        assert.strictEqual(activationStillPending.reconcile_reason, 'feature_enabled');
        const legacyPending = await setPriceLadderFeatureEnabled(12, true, { expected_version: 2, count_mode: 'business_day' });
        assert.strictEqual(legacyPending.reconcile_reason, 'feature_enabled');
        assert.strictEqual(legacyPending.reconcile_required, true);
        assert.strictEqual(await markPriceLadderFeatureReconciled(12, 3), true);
        const changed = await setPriceLadderFeatureEnabled(12, true, { expected_version: 3, count_mode: 'rolling_24h' });
        assert.strictEqual(changed.reconcile_reason, 'count_mode_changed');
        const unchanged = await setPriceLadderFeatureEnabled(12, true, { expected_version: 4, count_mode: 'rolling_24h' });
        assert.strictEqual(unchanged.reconcile_reason, 'count_mode_changed');
        assert.strictEqual(unchanged.reconcile_required, true);
        assert.strictEqual(await markPriceLadderFeatureReconciled(12, 4), false);
        assert.strictEqual((await getPriceLadderFeatureConfig(12)).reconcile_reason, 'count_mode_changed');
        assert.strictEqual(await markPriceLadderFeatureReconciled(12, 5), true);
        assert.strictEqual((await getPriceLadderFeatureConfig(12)).reconcile_reason, '');
        let explicit = await setPriceLadderFeatureEnabled(11, false, { count_mode: 'business_day', desc: ' saved ' });
        assert.strictEqual(explicit.count_mode, 'business_day');
        assert.strictEqual(explicit.desc, 'saved');
        explicit = await setPriceLadderFeatureEnabled(11, false, { count_mode: '' });
        assert.strictEqual(explicit.count_mode, 'rolling_24h');

        const beforeInvalid = await getPriceLadderFeatureConfig(8);
        await assert.rejects(setPriceLadderFeatureEnabled(8, false, { count_mode: 'midnight' }), /count_mode|计数/);
        assert.deepStrictEqual(await getPriceLadderFeatureConfig(8), beforeInvalid);
        await assert.rejects(setPriceLadderFeatureEnabled(8, true, { expected_version: -1 }), /expected_version/);
        await assert.rejects(setPriceLadderFeatureEnabled(8, true, { expected_version: 'oops' }), /expected_version/);
        await assert.rejects(setPriceLadderFeatureEnabled(0, true), /user_id/);
        await assert.rejects(getPriceLadderFeatureConfig(0), /user_id/);
        assert.strictEqual(await markPriceLadderFeatureReconciled(0, 1), false);
        assert.strictEqual(await markPriceLadderFeatureReconciled(8, 0), false);
        assert.strictEqual(toConfig().count_mode, 'rolling_24h');
        assert.match(nowText(), /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/);
        await assert.rejects(run(db, 'INVALID SQL'), /syntax/);
        await assert.rejects(get(db, 'SELECT * FROM missing_table'), /missing_table/);
        await assert.rejects(all(db, 'SELECT * FROM missing_table'), /missing_table/);
    } finally {
        await close(db);
    }
    console.log('[OK] price_ladder_count_mode_db_test passed');
}

main().catch(error => {
    console.error('[FAIL] price_ladder_count_mode_db_test failed:', error);
    process.exitCode = 1;
});
