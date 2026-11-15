'use strict';
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');
const { createCoverageMap } = require('istanbul-lib-coverage');
const libReport = require('istanbul-lib-report');
const reports = require('istanbul-reports');
const root = path.resolve(__dirname, '..');
const output = path.join(root, 'coverage/order-search');
const map = createCoverageMap(JSON.parse(fs.readFileSync(path.join(output, 'code/coverage-final.json'))));
map.merge(JSON.parse(fs.readFileSync(path.join(output, 'browser-coverage.json'))));
const core = ['order/order_search.js', 'database/order_search_account_db.js',
    'h5/public/js/ui/order_search.js', 'order/order.js'];
const summaries = core.map(file => ({ file, ...map.fileCoverageFor(path.join(root, file)).toSummary().toJSON() }));
let failed = summaries.some(row => row.lines.pct < 90);
const glue = ['h5/public/js/app_core.js', 'h5/public/js/menu_orders.js', 'h5/local_h5_server.js'].map(file => {
    const baseline = path.join(output, 'baseline', file);
    const args = fs.existsSync(baseline) ? ['diff', '--no-index', '--unified=0', '--', baseline, path.join(root, file)]
        : ['diff', 'HEAD', '--unified=0', '--', file];
    const diff = spawnSync('git', args, { cwd: root, encoding: 'utf8' });
    if (![0, 1].includes(diff.status)) throw new Error(diff.stderr);
    const changed = new Set();
    for (const match of diff.stdout.matchAll(/^@@ -\d+(?:,\d+)? \+(\d+)(?:,(\d+))? @@/gm)) {
        const start = Number(match[1]), count = match[2] === undefined ? 1 : Number(match[2]);
        for (let line = start; line < start + count; line++) changed.add(line);
    }
    const coverage = map.fileCoverageFor(path.join(root, file));
    const lines = coverage.getLineCoverage();
    const executable = [...changed].filter(line => Object.hasOwn(lines, line));
    const missed = executable.filter(line => !lines[line]);
    const pct = executable.length ? (executable.length - missed.length) * 100 / executable.length : 100;
    if (pct < 90) failed = true;
    return { file, baseline: fs.existsSync(baseline) ? 'pre-feature source snapshot' : 'HEAD',
        changed_lines: executable.length, covered: executable.length - missed.length, percent: pct,
        missed, whole_file: coverage.toSummary().toJSON() };
});
const coreMap = createCoverageMap({});
core.forEach(file => coreMap.addFileCoverage(map.fileCoverageFor(path.join(root, file))));
fs.writeFileSync(path.join(output, 'coverage-final.json'), JSON.stringify(map.toJSON()));
fs.writeFileSync(path.join(output, 'scope-coverage.json'), JSON.stringify({
    scope: 'four complete core files; changed executable lines for three integration files; not repository-wide coverage',
    core: summaries, core_total: coreMap.getCoverageSummary().toJSON(), glue
}, null, 2));
const context = libReport.createContext({ dir: path.join(output, 'html'), coverageMap: map });
reports.create('html').execute(context);
console.table(summaries.map(row => ({ file: row.file, lines: row.lines.pct, branches: row.branches.pct, functions: row.functions.pct })));
console.table(glue.map(row => ({ file: row.file, covered: `${row.covered}/${row.changed_lines}`, percent: row.percent, missed: row.missed.join(',') })));
if (failed) process.exitCode = 1;
