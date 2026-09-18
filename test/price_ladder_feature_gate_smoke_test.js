#!/usr/bin/env node
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const assert = require('assert');

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'rent-price-ladder-gate-'));
process.env.MAIN_DB_FILE_PATH = path.join(tempDir, 'rent_robot.db');
process.env.RUNTIME_DB_FILE_PATH = path.join(tempDir, 'rent_robot_runtime.db');
process.env.ORDER_DB_FILE_PATH = path.join(tempDir, 'rent_robot_order.db');
process.env.PRICE_DB_FILE_PATH = path.join(tempDir, 'rent_robot_price.db');
process.env.ORDER_COUNT_TRACE = 'false';

const reconcilePath = require.resolve('../price/price_ladder_reconcile_service');
assert.strictEqual(Boolean(require.cache[reconcilePath]), false);

const { syncOrdersByUser } = require('../order/order');
assert.strictEqual(Boolean(require.cache[reconcilePath]), false);

(async () => {
    const result = await syncOrdersByUser(8, {
        price_ladder_feature_state: {
            enabled: false,
            reconcile_required: false,
            version: 0
        }
    });
    assert.strictEqual(result.price_ladder.skipped, true);
    assert.strictEqual(result.price_ladder.reason, 'feature_disabled');
    assert.strictEqual(result.price_ladder_feature.enabled, false);
    assert.strictEqual(Boolean(require.cache[reconcilePath]), false);
    for (const platform of Object.values(result.platforms)) {
        assert.strictEqual(Object.prototype.hasOwnProperty.call(platform, '_price_ladder_candidates'), false);
    }
    console.log('[OK] price_ladder_feature_gate_smoke_test passed');
})().catch((error) => {
    console.error('[FAIL] price_ladder_feature_gate_smoke_test failed:', error);
    process.exit(1);
});
