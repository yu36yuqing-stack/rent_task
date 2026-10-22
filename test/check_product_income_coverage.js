'use strict';

const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');
const { createCoverageMap } = require('istanbul-lib-coverage');
const root = path.resolve(__dirname, '..');
const directory = path.join(root, 'coverage/product-rent-income/code');
const coverage = createCoverageMap(JSON.parse(fs.readFileSync(path.join(directory, 'coverage-final.json'), 'utf8')));
const core = new Set(['database/product_income_db.js', 'stats/product_income_service.js',
    'stats/historical_income.js', 'h5/public/js/ui/product_income_summary.js']);
const files = [...core, 'stats/order_stats.js', 'h5/local_h5_server.js', 'h5/public/js/menu_products.js'];
const results = files.map(file => {
    const data = coverage.fileCoverageFor(path.join(root, file));
    const lines = data.getLineCoverage();
    const changed = new Set();
    if (core.has(file)) {
        for (const line of Object.keys(lines)) changed.add(Number(line));
    } else {
        const diff = spawnSync('git', ['diff', 'HEAD', '--unified=0', '--', file], { cwd: root, encoding: 'utf8' });
        if (diff.status !== 0) throw new Error(diff.stderr || `diff failed: ${file}`);
        for (const hunk of diff.stdout.matchAll(/^@@ -\d+(?:,\d+)? \+(\d+)(?:,(\d+))? @@/gm)) {
            const start = Number(hunk[1]);
            const count = hunk[2] === undefined ? 1 : Number(hunk[2]);
            for (let line = start; line < start + count; line += 1) if (Object.hasOwn(lines, line)) changed.add(line);
        }
    }
    if (!changed.size) throw new Error(`No changed/core executable lines measured: ${file}`);
    const missed = [...changed].filter(line => !lines[line]);
    const percent = (changed.size - missed.length) * 100 / changed.size;
    const summary = data.toSummary();
    if (percent < 90 || (core.has(file) && summary.lines.pct < 90)) process.exitCode = 1;
    return { file, selected: core.has(file) ? 'whole new core file' : 'changed lines vs HEAD',
        changed_total: changed.size, changed_covered: changed.size - missed.length,
        changed_percent: percent, missed, lines: summary.lines.pct,
        branches: summary.branches.pct, functions: summary.functions.pct };
});
const total = results.reduce((sum, row) => sum + row.changed_total, 0);
const covered = results.reduce((sum, row) => sum + row.changed_covered, 0);
const report = { baseline: 'HEAD; untracked new core measured in full', threshold: 90,
    changed_total: total, changed_covered: covered, changed_percent: covered * 100 / total, files: results };
fs.writeFileSync(path.join(directory, 'changed-lines.json'), JSON.stringify(report, null, 2) + '\n');
console.table(results.map(row => ({ file: row.file, scope: row.selected,
    covered: `${row.changed_covered}/${row.changed_total}`, lines: row.lines,
    branches: row.branches, functions: row.functions, missed: row.missed.join(',') })));
console.log(`Selected executable lines: ${covered}/${total} = ${report.changed_percent.toFixed(2)}%`);
