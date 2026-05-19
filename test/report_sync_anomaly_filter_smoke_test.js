#!/usr/bin/env node
'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'rent-report-anomaly-'));
process.env.MAIN_DB_FILE_PATH = path.join(tempRoot, 'rent_robot.db');

const { upsertOpenProductSyncAnomaly } = require('../database/product_sync_anomaly_db');
const { listUserSyncAnomaliesForReport } = require('../report/report_rent_status');

async function main() {
    const uid = 91001;
    await upsertOpenProductSyncAnomaly(uid, 'uuzuhao', {
        expected_count: 2,
        pulled_count: 0,
        missing_count: 2,
        missing_accounts: [
            { game_account: 'active_acc', game_id: '1', game_name: 'WZRY' },
            { game_account: 'sold_acc', game_id: '2', game_name: '和平精英' }
        ],
        sample_missing_text: 'WZRY/active_acc、和平精英/sold_acc',
        desc: 'seed mixed active/sold anomaly'
    });

    const rows = await listUserSyncAnomaliesForReport(uid, {
        include_account_keys: new Set(['1::active_acc'])
    });

    assert.strictEqual(rows.length, 1, '仍有在售账号缺失时应保留异常');
    assert.strictEqual(rows[0].missing_count, 1, '缺失数量应只统计在售账号');
    assert.strictEqual(rows[0].sample_missing_text, 'WZRY/active_acc', '示例账号不应包含已售账号');
    assert.deepStrictEqual(
        rows[0].missing_accounts.map((x) => `${x.game_id}::${x.game_account}`),
        ['1::active_acc'],
        'missing_accounts 应只保留在售账号'
    );

    const soldOnlyRows = await listUserSyncAnomaliesForReport(uid, {
        include_account_keys: new Set(['3::other_active'])
    });
    assert.strictEqual(soldOnlyRows.length, 0, '只缺已售账号时不应展示同步异常');

    console.log('[PASS] report_sync_anomaly_filter_smoke_test');
}

main().catch((err) => {
    console.error(`[FAIL] report_sync_anomaly_filter_smoke_test: ${err.message}`);
    process.exitCode = 1;
}).finally(() => {
    fs.rmSync(tempRoot, { recursive: true, force: true });
});
