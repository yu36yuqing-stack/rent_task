'use strict';

const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');
const { createCoverageMap } = require('istanbul-lib-coverage');
const root = path.resolve(__dirname, '..');
const directory = path.join(root, 'coverage/product-channel-price');
const map = createCoverageMap(JSON.parse(fs.readFileSync(path.join(directory, 'coverage-final.json'), 'utf8')));
const core = ['price/product_channel_price_service.js', 'h5/public/js/ui/channel_price_summary.js'];
const files = [...core, 'h5/local_h5_server.js', 'h5/public/js/menu_products.js'];
const results = files.map((file) => {
    const diff = spawnSync('git', ['diff', 'HEAD', '--unified=0', '--', file], { cwd: root, encoding: 'utf8' });
    if (diff.status !== 0) throw new Error(diff.stderr);
    const changed = new Set();
    for (const match of diff.stdout.matchAll(/^@@ -\d+(?:,\d+)? \+(\d+)(?:,(\d+))? @@/gm)) {
        const start = Number(match[1]);
        const count = match[2] === undefined ? 1 : Number(match[2]);
        for (let line = start; line < start + count; line += 1) changed.add(line);
    }
    const coverage = map.fileCoverageFor(path.join(root, file));
    const summary = coverage.toSummary();
    const lineCoverage = coverage.getLineCoverage();
    // New core modules are measured in full, including untracked files.
    const selected = core.includes(file) ? Object.keys(lineCoverage).map(Number) : [...changed].filter((line) => Object.hasOwn(lineCoverage, line));
    if (core.includes(file) && !selected.length) throw new Error(`No core code measured: ${file}`);
    const missed = selected.filter((line) => !lineCoverage[line]);
    const percent = selected.length ? (selected.length - missed.length) * 100 / selected.length : 100;
    if (percent < 90 || (core.includes(file) && summary.lines.pct < 90)) process.exitCode = 1;
    return { file, changed_total: selected.length, changed_covered: selected.length - missed.length,
        changed_percent: percent, missed, lines: summary.lines.pct, branches: summary.branches.pct, functions: summary.functions.pct };
});
const total = results.reduce((sum, row) => sum + row.changed_total, 0);
const covered = results.reduce((sum, row) => sum + row.changed_covered, 0);
const report = { baseline: 'HEAD (new modules in full)', threshold: 90, changed_total: total,
    changed_covered: covered, changed_percent: covered * 100 / total, files: results };
fs.writeFileSync(path.join(directory, 'changed-lines.json'), JSON.stringify(report, null, 2) + '\n');
console.table(results);
