'use strict';

const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');
const { createCoverageMap } = require('istanbul-lib-coverage');
const root = path.resolve(__dirname, '..');
const directory = path.join(root, 'coverage/uuzuhao-online-auth/combined');
const coverage = createCoverageMap(JSON.parse(fs.readFileSync(path.join(directory, 'coverage-final.json'), 'utf8')));
const core = [
    'common/uuzuhao_auth_state.js',
    'database/uuzuhao_auth_state_db.js',
    'database/migrations/20261022_021_uuzuhao_online_auth_state.js',
    'product/uuzuhao_online_auth_service.js',
    'product/prod_probe_cache_service.js',
    'h5/public/js/ui/uuzuhao_auth_status.js'
];
let failed = false;
const results = core.map(file => {
    const summary = coverage.fileCoverageFor(path.join(root, file)).toSummary().toJSON();
    if (summary.lines.pct < 90) failed = true;
    return { file, lines: summary.lines.pct, branches: summary.branches.pct, functions: summary.functions.pct };
});
console.table(results);
const glue = ['database/user_game_account_db.js', 'product/prod_status_guard.js', 'h5/local_h5_server.js',
    'h5/public/js/menu_products.js', 'h5/public/js/app_core.js'].map(file => {
    const diff = spawnSync('git', ['diff', '--unified=0', '--', file], { cwd: root, encoding: 'utf8' });
    if (diff.status !== 0) throw new Error(diff.stderr);
    const changed = new Set();
    for (const match of diff.stdout.matchAll(/^@@ -\d+(?:,\d+)? \+(\d+)(?:,(\d+))? @@/gm)) {
        const start = Number(match[1]), count = match[2] === undefined ? 1 : Number(match[2]);
        for (let line = start; line < start + count; line++) changed.add(line);
    }
    const lineCoverage = coverage.fileCoverageFor(path.join(root, file)).getLineCoverage();
    const lines = [...changed].filter(line => Object.hasOwn(lineCoverage, line));
    const missed = lines.filter(line => lineCoverage[line] === 0);
    const percent = lines.length ? 100 * (lines.length - missed.length) / lines.length : 100;
    if (percent < 90) failed = true;
    return { file, changed_lines: lines.length, covered: lines.length - missed.length, percent, missed };
});
console.table(glue.map(row => ({ file: row.file, covered: `${row.covered}/${row.changed_lines}`, percent: row.percent, missed: row.missed.join(',') })));
fs.writeFileSync(path.join(directory, 'core-coverage.json'), JSON.stringify({ scope: 'complete core files plus changed lines in legacy integration files; not whole repository',
    minimum_lines: 90, results, legacy_integration_changed_lines: glue }, null, 2) + '\n');
if (failed) process.exitCode = 1;
