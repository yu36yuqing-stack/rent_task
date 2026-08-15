const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const zlib = require('zlib');

const { pruneApplicationLogs } = require('../maintenance/log_retention_service');

function readGzip(filePath) {
    return zlib.gunzipSync(fs.readFileSync(filePath)).toString('utf8');
}

(async () => {
    const logDir = fs.mkdtempSync(path.join(os.tmpdir(), 'log-retention-'));
    const active = path.join(logDir, 'rent_robot_main.log');
    fs.writeFileSync(active, [
        '[2026-08-08T00:00:00.000Z] [INFO] old record',
        'old stack line',
        '[2026-08-10T12:00:00.000Z] [INFO] recent record',
        'recent stack line',
        '[2026-08-16T08:00:00.000Z] [INFO] current record'
    ].join('\n') + '\n');

    const first = await pruneApplicationLogs({
        log_dir: logDir,
        files: ['rent_robot_main.log'],
        retention_days: 7,
        now: new Date('2026-08-16T12:00:00.000Z')
    });
    assert.strictEqual(first.processed_files, 1);
    assert.strictEqual(first.deleted_rows, 2);
    assert.strictEqual(fs.readFileSync(active, 'utf8'), '');

    const archive = path.join(logDir, 'archive', 'rent_robot_main.log.history.log.gz');
    const firstHistory = readGzip(archive);
    assert.ok(!firstHistory.includes('old record'));
    assert.ok(!firstHistory.includes('old stack line'));
    assert.ok(firstHistory.includes('recent record'));
    assert.ok(firstHistory.includes('recent stack line'));
    assert.ok(firstHistory.includes('current record'));

    fs.appendFileSync(active, '[2026-08-17T08:00:00.000Z] [INFO] next record\n');
    const second = await pruneApplicationLogs({
        log_dir: logDir,
        files: ['rent_robot_main.log'],
        retention_days: 7,
        now: new Date('2026-08-18T00:00:00.000Z')
    });
    assert.strictEqual(second.deleted_rows, 2);
    const secondHistory = readGzip(archive);
    assert.strictEqual((secondHistory.match(/recent record/g) || []).length, 0);
    assert.strictEqual((secondHistory.match(/current record/g) || []).length, 1);
    assert.strictEqual((secondHistory.match(/next record/g) || []).length, 1);

    const workDir = path.join(logDir, '.retention_work');
    fs.writeFileSync(path.join(workDir, 'rent_robot_main.log.consumed'), '[2026-08-18T01:00:00.000Z] consumed snapshot\n');
    fs.writeFileSync(
        path.join(workDir, 'rent_robot_main.log.history.next.gz'),
        zlib.gzipSync(`${secondHistory}[2026-08-18T02:00:00.000Z] committed before crash\n`)
    );
    fs.appendFileSync(active, '[2026-08-18T03:00:00.000Z] active after crash\n');
    await pruneApplicationLogs({
        log_dir: logDir,
        files: ['rent_robot_main.log'],
        retention_days: 7,
        now: new Date('2026-08-18T04:00:00.000Z')
    });
    const recoveredHistory = readGzip(archive);
    assert.ok(recoveredHistory.includes('committed before crash'));
    assert.ok(recoveredHistory.includes('active after crash'));
    assert.ok(!recoveredHistory.includes('consumed snapshot'));
    assert.strictEqual(fs.existsSync(path.join(workDir, 'rent_robot_main.log.consumed')), false);

    console.log(`[PASS] log_retention_smoke_test temp_dir=${logDir}`);
})().catch((err) => {
    console.error(`[FAIL] log_retention_smoke_test: ${err.stack || err.message}`);
    process.exit(1);
});
