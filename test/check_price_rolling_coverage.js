#!/usr/bin/env node
'use strict';

const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');
const { createCoverageMap } = require('istanbul-lib-coverage');

const root = path.resolve(__dirname, '..');
const directory = path.join(root, 'coverage/price-rolling');
const map = createCoverageMap(JSON.parse(fs.readFileSync(path.join(directory, 'coverage-final.json'), 'utf8')));
const files = [
    'database/order_db.js',
    'order/order.js',
    'order/service/order_query_service.js',
    'price/price_ladder_reconcile_service.js',
    'price/price_ladder_service.js',
    'h5/public/js/menu_price.js'
];
const core = new Set(['price/price_ladder_reconcile_service.js', 'price/price_ladder_service.js']);
const results = files.map(file => {
    const diff = spawnSync('git', ['diff', 'HEAD', '--unified=0', '--', file], { cwd: root, encoding: 'utf8' });
    if (diff.status !== 0) throw new Error(diff.stderr || `git diff failed: ${file}`);
    const changed = new Set();
    for (const match of diff.stdout.matchAll(/^@@ -\d+(?:,\d+)? \+(\d+)(?:,(\d+))? @@/gm)) {
        const start = Number(match[1]);
        const count = match[2] === undefined ? 1 : Number(match[2]);
        for (let line = start; line < start + count; line += 1) changed.add(line);
    }
    const coverage = map.fileCoverageFor(path.join(root, file));
    const lines = coverage.getLineCoverage();
    const executable = [...changed].filter(line => Object.hasOwn(lines, line));
    const missed = executable.filter(line => lines[line] === 0);
    const summary = coverage.toSummary();
    const result = {
        file, changed_total: executable.length, changed_covered: executable.length - missed.length,
        changed_percent: executable.length ? (executable.length - missed.length) * 100 / executable.length : 100,
        missed, lines: summary.lines.pct, branches: summary.branches.pct, functions: summary.functions.pct
    };
    if (result.changed_percent < 90 || (core.has(file) && result.lines < 90)) process.exitCode = 1;
    return result;
});
const total = results.reduce((sum, row) => sum + row.changed_total, 0);
const covered = results.reduce((sum, row) => sum + row.changed_covered, 0);
const report = { baseline: 'HEAD', thresholds: { each_changed_lines: 90, each_core_file_lines: 90 }, changed_total: total, changed_covered: covered, changed_percent: total ? covered * 100 / total : 100, files: results };
fs.writeFileSync(path.join(directory, 'changed-lines.json'), JSON.stringify(report, null, 2) + '\n');
console.table(results.map(row => ({ file: row.file, changed: `${row.changed_covered}/${row.changed_total}`, lines: row.lines, branches: row.branches, functions: row.functions, missed: row.missed.join(',') })));
console.log(`Changed executable lines: ${covered}/${total} = ${report.changed_percent.toFixed(2)}%`);
