'use strict';

const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');
const { createCoverageMap } = require('istanbul-lib-coverage');
const root = path.resolve(__dirname, '..');
const output = path.join(root, 'coverage/hour-ratio/code');
const map = createCoverageMap(JSON.parse(fs.readFileSync(path.join(output, 'coverage-final.json'), 'utf8')));
const core = [
    'database/zuhaowang_product_mode_db.js',
    'price/channel_package_ratio.js', 'price/package_ratio_service.js',
    'price/channel_adapters/uhaozu_price_adapter.js', 'price/channel_adapters/uuzuhao_price_adapter.js',
    'price/channel_adapters/zuhaowang_price_adapter.js', 'price/daily_price_policy.js',
    'price/zuhaowang_price_snapshot_service.js', 'price/price_publish_service.js',
    'price/price_ladder_reconcile_service.js', 'h5/public/js/ui/daily_price_policy.js'
];
const files = [...core, 'h5/local_h5_server.js', 'h5/public/js/menu_price.js'];
const results = files.map(file => {
    const coverage = map.fileCoverageFor(path.join(root, file));
    const lines = coverage.getLineCoverage();
    const summary = coverage.toSummary();
    const diff = spawnSync('git', ['diff', 'HEAD', '--unified=0', '--', file], { cwd: root, encoding: 'utf8' });
    if (diff.status !== 0) throw new Error(diff.stderr || `git diff failed: ${file}`);
    const changed = new Set();
    for (const match of diff.stdout.matchAll(/^@@ -\d+(?:,\d+)? \+(\d+)(?:,(\d+))? @@/gm)) {
        const count = match[2] === undefined ? 1 : Number(match[2]);
        for (let line = Number(match[1]); line < Number(match[1]) + count; line++) changed.add(line);
    }
    if (spawnSync('git', ['ls-files', '--error-unmatch', file], { cwd: root, encoding: 'utf8' }).status !== 0) {
        for (const line of Object.keys(lines)) changed.add(Number(line));
    }
    const executable = [...changed].filter(line => Object.hasOwn(lines, line));
    const missed = executable.filter(line => !lines[line]);
    const percent = executable.length ? 100 * (executable.length - missed.length) / executable.length : 100;
    if (percent < 90 || (core.includes(file) && summary.lines.pct < 90)) process.exitCode = 1;
    return { file, scope: core.includes(file) ? 'whole core file + changed lines' : 'changed lines (legacy large file)',
        changed_covered: executable.length - missed.length, changed_total: executable.length, changed_percent: percent,
        lines: summary.lines.pct, branches: summary.branches.pct, functions: summary.functions.pct, missed };
});
const total = results.reduce((sum, row) => sum + row.changed_total, 0);
const covered = results.reduce((sum, row) => sum + row.changed_covered, 0);
const coreMap = createCoverageMap({});
for (const file of core) coreMap.addFileCoverage(map.fileCoverageFor(path.join(root, file)));
const report = { baseline: 'HEAD', threshold: 90, changed_total: total, changed_covered: covered,
    changed_percent: total ? covered * 100 / total : 100, core_summary: coreMap.getCoverageSummary().toJSON(),
    included_scope_summary: map.getCoverageSummary().toJSON(), files: results };
fs.writeFileSync(path.join(output, 'changed-lines.json'), JSON.stringify(report, null, 2) + '\n');
console.table(results.map(row => ({ file: row.file, changed: `${row.changed_covered}/${row.changed_total}`,
    lines: row.lines, branches: row.branches, functions: row.functions, missed: row.missed.join(',') })));
console.log(`Changed executable lines: ${covered}/${total} = ${report.changed_percent.toFixed(2)}%`);
