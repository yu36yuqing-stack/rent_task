'use strict';

const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');
const { createCoverageMap } = require('istanbul-lib-coverage');
const root = path.resolve(__dirname, '..');
const directory = path.join(root, 'coverage/zuhaowang-product-price');
const map = createCoverageMap(JSON.parse(fs.readFileSync(path.join(directory, 'coverage-final.json'), 'utf8')));
const core = 'product/zuhaowang_price_snapshot.js';
const results = [core, 'product/product.js'].map((file) => {
    const coverage = map.fileCoverageFor(path.join(root, file));
    const lines = coverage.getLineCoverage();
    const summary = coverage.toSummary();
    const changed = new Set();
    const diff = spawnSync('git', ['diff', 'HEAD', '--unified=0', '--', file], { cwd: root, encoding: 'utf8' });
    if (diff.status !== 0) throw new Error(diff.stderr);
    for (const match of diff.stdout.matchAll(/^@@ -\d+(?:,\d+)? \+(\d+)(?:,(\d+))? @@/gm)) {
        const start = Number(match[1]);
        const count = match[2] === undefined ? 1 : Number(match[2]);
        for (let line = start; line < start + count; line += 1) changed.add(line);
    }
    const selected = file === core ? Object.keys(lines).map(Number) : [...changed].filter((line) => Object.hasOwn(lines, line));
    if (file === core && !selected.length) throw new Error('Core coverage is missing');
    const missed = selected.filter((line) => !lines[line]);
    const percent = selected.length ? (selected.length - missed.length) * 100 / selected.length : 100;
    if (percent < 90 || summary.lines.pct < 90) process.exitCode = 1;
    return { file, changed_total: selected.length, changed_covered: selected.length - missed.length,
        changed_percent: percent, missed, lines: summary.lines.pct, branches: summary.branches.pct, functions: summary.functions.pct };
});
const total = results.reduce((sum, row) => sum + row.changed_total, 0);
const covered = results.reduce((sum, row) => sum + row.changed_covered, 0);
fs.writeFileSync(path.join(directory, 'changed-lines.json'), JSON.stringify({ baseline: 'HEAD (new core in full)',
    threshold: 90, changed_total: total, changed_covered: covered, changed_percent: covered * 100 / total, files: results }, null, 2) + '\n');
console.table(results);
