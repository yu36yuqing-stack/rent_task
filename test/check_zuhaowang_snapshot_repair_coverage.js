'use strict';

const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');
const { createCoverageMap } = require('istanbul-lib-coverage');
const root = path.resolve(__dirname, '..');
const directory = path.join(root, 'coverage/zuhaowang-snapshot-repair');
const map = createCoverageMap(JSON.parse(fs.readFileSync(path.join(directory, 'coverage-final.json'), 'utf8')));
const core = 'price/zuhaowang_price_snapshot_service.js';
const files = [core, 'scripts/recover_zuhaowang_price_snapshots.js', 'price/channel_adapters/zuhaowang_price_adapter.js',
    'price/price_publish_service.js', 'database/price_publish_log_db.js',
    'price/product_channel_price_service.js', 'product/zuhaowang_price_snapshot.js', 'product/product.js'];
const results = files.map((file) => {
    const coverage = map.fileCoverageFor(path.join(root, file));
    const lines = coverage.getLineCoverage();
    const summary = coverage.toSummary();
    const diff = spawnSync('git', ['diff', 'HEAD', '--unified=0', '--', file], { cwd: root, encoding: 'utf8' });
    if (diff.status !== 0) throw new Error(diff.stderr);
    const changed = new Set();
    for (const match of diff.stdout.matchAll(/^@@ -\d+(?:,\d+)? \+(\d+)(?:,(\d+))? @@/gm)) {
        const count = match[2] === undefined ? 1 : Number(match[2]);
        for (let line = Number(match[1]); line < Number(match[1]) + count; line += 1) changed.add(line);
    }
    const selected = file === core || file === 'scripts/recover_zuhaowang_price_snapshots.js'
        ? Object.keys(lines).map(Number) : [...changed].filter((line) => Object.hasOwn(lines, line));
    const missed = selected.filter((line) => !lines[line]);
    const pct = selected.length ? 100 * (selected.length - missed.length) / selected.length : 100;
    if (!selected.length || pct < 90 || summary.lines.pct < 90) process.exitCode = 1;
    return { file, changed_total: selected.length, changed_covered: selected.length - missed.length,
        changed_percent: pct, missed, lines: summary.lines.pct, branches: summary.branches.pct, functions: summary.functions.pct };
});
const total = results.reduce((sum, row) => sum + row.changed_total, 0);
const covered = results.reduce((sum, row) => sum + row.changed_covered, 0);
fs.writeFileSync(path.join(directory, 'changed-lines.json'), JSON.stringify({ baseline: 'HEAD; new core full file',
    threshold: 90, changed_total: total, changed_covered: covered, changed_percent: covered * 100 / total, files: results }, null, 2) + '\n');
console.table(results);
