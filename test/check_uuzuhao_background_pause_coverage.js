#!/usr/bin/env node
'use strict';

// Measure changed executable lines against a pre-edit working-tree snapshot,
// not HEAD: this repository also contains unrelated uncommitted changes.
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { spawnSync } = require('child_process');
const { createCoverageMap } = require('istanbul-lib-coverage');
const root = path.resolve(__dirname, '..');
const dir = path.join(root, 'coverage/uuzuhao-background-pause');
const baseline = process.argv[2];
const manifestPath = path.join(__dirname, 'fixtures/uuzuhao_background_pause_changed_lines.json');
const manifest = baseline ? {} : JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
const coverage = createCoverageMap(JSON.parse(fs.readFileSync(path.join(dir, 'coverage-final.json'), 'utf8')));
const files = [
    'product/prod_channel_status.js', 'product/prod_probe_cache_service.js', 'product/prod_status_guard.js',
    'blacklist/blacklist_release_guard.js', 'blacklist/blacklist_manual_remove_v2.js',
    'database/runtime_task_db.js', 'order/auth_revoke_task_service.js', 'action_engine/action_engine.js',
    'h5/local_h5_server.js', 'h5/public/js/menu_products.js', 'report/dingding/ding_style.js'
];
const results = [];
for (const file of files) {
    const hash = crypto.createHash('sha256').update(fs.readFileSync(path.join(root, file))).digest('hex');
    if (baseline) {
        const diff = spawnSync('git', ['diff', '--no-index', '--unified=0', '--', path.join(baseline, file), path.join(root, file)], { encoding: 'utf8' });
        if (![0, 1].includes(diff.status)) throw new Error(diff.stderr);
        const changed = new Set();
        for (const match of diff.stdout.matchAll(/^@@ -\d+(?:,\d+)? \+(\d+)(?:,(\d+))? @@/gm)) {
            const start = Number(match[1]);
            const count = match[2] === undefined ? 1 : Number(match[2]);
            for (let i = start; i < start + count; i++) changed.add(i);
        }
        manifest[file] = { hash, changed_lines: [...changed] };
    }
    if (!manifest[file] || manifest[file].hash !== hash) throw new Error(`Coverage manifest is stale: ${file}; regenerate against the pre-edit snapshot`);
    const lineCoverage = coverage.fileCoverageFor(path.join(root, file)).getLineCoverage();
    const lines = manifest[file].changed_lines.filter((line) => Object.hasOwn(lineCoverage, line));
    const missed = lines.filter((line) => lineCoverage[line] === 0);
    results.push({ file, changed_executable: lines.length, covered: lines.length - missed.length, missed });
}
if (baseline) {
    fs.mkdirSync(path.dirname(manifestPath), { recursive: true });
    fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2) + '\n');
}
const total = results.reduce((sum, row) => sum + row.changed_executable, 0);
const hit = results.reduce((sum, row) => sum + row.covered, 0);
const percent = total ? 100 * hit / total : 0;
const report = { metric: 'changed executable line coverage', threshold: 90, covered: hit, total, percent, files: results };
fs.writeFileSync(path.join(dir, 'changed-lines.json'), JSON.stringify(report, null, 2));
console.table(results.map((row) => ({ file: row.file, covered: `${row.covered}/${row.changed_executable}`, missed: row.missed.join(',') })));
console.log(`Changed executable lines: ${hit}/${total} = ${percent.toFixed(2)}% (required >=90%)`);
if (percent < 90) process.exitCode = 1;
