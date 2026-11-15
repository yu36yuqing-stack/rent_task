'use strict';
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');
const { createCoverageMap } = require('istanbul-lib-coverage');
const root = path.resolve(__dirname, '..');
const directory = path.join(root, 'coverage/uuzuhao-reauthorize');
const coverage = createCoverageMap(JSON.parse(fs.readFileSync(path.join(directory, 'coverage-final.json'))));
const core = ['uuzuhao/uuzuhao_api.js', 'database/uuzuhao_reauthorize_db.js',
    'product/uuzuhao_reauthorize_service.js', 'order/auth_revoke_task_service.js', 'h5/public/js/ui/uuzuhao_auth_status.js'];
const results = core.map(file => ({ file, ...coverage.fileCoverageFor(path.join(root, file)).toSummary().toJSON() }));
let failed = results.some(result => result.lines.pct < 90);
const glue = ['h5/public/js/menu_products.js', 'h5/local_h5_server.js'].map(file => {
    const diff = spawnSync('git', ['diff', '--unified=0', '--', file], { cwd: root, encoding: 'utf8' });
    if (diff.status !== 0) throw new Error(diff.stderr);
    const changed = new Set();
    for (const match of diff.stdout.matchAll(/^@@ -\d+(?:,\d+)? \+(\d+)(?:,(\d+))? @@/gm)) {
        const start = Number(match[1]), count = match[2] === undefined ? 1 : Number(match[2]);
        for (let line = start; line < start + count; line++) changed.add(line);
    }
    const lines = coverage.fileCoverageFor(path.join(root, file)).getLineCoverage();
    const relevant = [...changed].filter(line => Object.hasOwn(lines, line));
    const missed = relevant.filter(line => !lines[line]);
    const percent = relevant.length ? 100 * (relevant.length - missed.length) / relevant.length : 100;
    if (percent < 90) failed = true;
    return { file, changed_lines: relevant.length, covered: relevant.length - missed.length, percent, missed };
});
const changedCore = core.map(file => {
    const lines = coverage.fileCoverageFor(path.join(root, file)).getLineCoverage();
    const tracked = spawnSync('git', ['ls-files', '--error-unmatch', file], { cwd: root });
    const changed = new Set();
    if (tracked.status !== 0) Object.keys(lines).forEach(line => changed.add(Number(line)));
    else {
        const diff = spawnSync('git', ['diff', '--unified=0', '--', file], { cwd: root, encoding: 'utf8' });
        if (diff.status !== 0) throw new Error(diff.stderr);
        for (const match of diff.stdout.matchAll(/^@@ -\d+(?:,\d+)? \+(\d+)(?:,(\d+))? @@/gm)) {
            const start = Number(match[1]), count = match[2] === undefined ? 1 : Number(match[2]);
            for (let line = start; line < start + count; line++) changed.add(line);
        }
    }
    const relevant = [...changed].filter(line => Object.hasOwn(lines, line));
    const missed = relevant.filter(line => !lines[line]);
    const percent = relevant.length ? 100 * (relevant.length - missed.length) / relevant.length : 100;
    if (percent < 90) failed = true;
    return { file, changed_lines: relevant.length, covered: relevant.length - missed.length, percent, missed };
});
console.table(results.map(r => ({ file: r.file, lines: r.lines.pct, branches: r.branches.pct, functions: r.functions.pct })));
console.table([...changedCore, ...glue]);
fs.writeFileSync(path.join(directory, 'scope-coverage.json'), JSON.stringify({
    scope: 'five complete core files; changed-line coverage for all seven runtime files; not whole repository', results, glue,
    changed_lines: [...changedCore, ...glue]
}, null, 2));
if (failed) process.exitCode = 1;
