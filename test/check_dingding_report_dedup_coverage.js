#!/usr/bin/env node
'use strict';

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');
const { createCoverageMap } = require('istanbul-lib-coverage');

const root = path.resolve(__dirname, '..');
const coverageDir = path.join(root, 'coverage/dingding-report-dedup');
const baseline = process.argv[2];
const manifestPath = path.join(__dirname, 'fixtures/dingding_report_dedup_changed_lines.json');
const manifest = baseline ? {} : JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
const coverage = createCoverageMap(JSON.parse(fs.readFileSync(path.join(coverageDir, 'coverage-final.json'), 'utf8')));
const existingFiles = [
    'report/report_rent_status.js',
    'report/dingding/ding_style.js',
    'pipeline/user_pipeline.js',
    'rent_robot_main.js',
    'h5/local_h5_server.js'
];

const results = [];
for (const file of existingFiles) {
    const absolutePath = path.join(root, file);
    const hash = crypto.createHash('sha256').update(fs.readFileSync(absolutePath)).digest('hex');
    if (baseline) {
        const diff = spawnSync('git', [
            'diff', '--no-index', '--unified=0', '--', path.join(baseline, file), absolutePath
        ], { encoding: 'utf8' });
        if (![0, 1].includes(diff.status)) throw new Error(diff.stderr || `diff failed: ${file}`);
        const changedLines = new Set();
        for (const match of diff.stdout.matchAll(/^@@ -\d+(?:,\d+)? \+(\d+)(?:,(\d+))? @@/gm)) {
            const start = Number(match[1]);
            const count = match[2] === undefined ? 1 : Number(match[2]);
            for (let line = start; line < start + count; line += 1) changedLines.add(line);
        }
        manifest[file] = { hash, changed_lines: [...changedLines] };
    }
    if (!manifest[file] || manifest[file].hash !== hash) {
        throw new Error(`Coverage manifest is stale: ${file}`);
    }
    const lineCoverage = coverage.fileCoverageFor(absolutePath).getLineCoverage();
    const executable = manifest[file].changed_lines.filter((line) => Object.hasOwn(lineCoverage, line));
    const missed = executable.filter((line) => lineCoverage[line] === 0);
    results.push({
        file,
        changed_executable: executable.length,
        covered: executable.length - missed.length,
        missed
    });
}

if (baseline) {
    fs.mkdirSync(path.dirname(manifestPath), { recursive: true });
    fs.writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
}

const total = results.reduce((sum, row) => sum + row.changed_executable, 0);
const covered = results.reduce((sum, row) => sum + row.covered, 0);
const changedLinePercent = total > 0 ? (covered * 100) / total : 100;
const servicePath = path.join(root, 'report/dingding/ding_report_dedup.js');
const serviceSummary = coverage.fileCoverageFor(servicePath).toSummary();
const serviceCoverage = {
    lines: serviceSummary.lines.pct,
    branches: serviceSummary.branches.pct,
    functions: serviceSummary.functions.pct,
    statements: serviceSummary.statements.pct
};
const report = {
    thresholds: { changed_lines: 90, service_lines: 90, service_functions: 90, service_branches: 80 },
    changed_lines: { covered, total, percent: changedLinePercent, files: results },
    service: serviceCoverage
};
fs.writeFileSync(path.join(coverageDir, 'changed-lines.json'), `${JSON.stringify(report, null, 2)}\n`);

console.table(results.map((row) => ({
    file: row.file,
    covered: `${row.covered}/${row.changed_executable}`,
    missed: row.missed.join(',')
})));
console.log(`Changed executable lines: ${covered}/${total} = ${changedLinePercent.toFixed(2)}%`);
console.log(`Dedup service: lines=${serviceCoverage.lines}% branches=${serviceCoverage.branches}% functions=${serviceCoverage.functions}% statements=${serviceCoverage.statements}%`);

if (
    changedLinePercent < report.thresholds.changed_lines
    || serviceCoverage.lines < report.thresholds.service_lines
    || serviceCoverage.functions < report.thresholds.service_functions
    || serviceCoverage.branches < report.thresholds.service_branches
) {
    process.exitCode = 1;
}
