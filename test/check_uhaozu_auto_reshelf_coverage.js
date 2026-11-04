'use strict';

const fs = require('fs');
const path = require('path');
const { createCoverageMap } = require('istanbul-lib-coverage');
const root = path.resolve(__dirname, '..');
const dir = path.join(root, 'coverage/uhaozu-auto-reshelf');
const map = createCoverageMap(JSON.parse(fs.readFileSync(path.join(dir, 'coverage-final.json'), 'utf8')));
const files = [
    'database/system_config_db.js',
    'database/migrations/20261104_022_system_config.js',
    'product/uhaozu_auto_reshelf_policy.js',
    'scripts/system_config.js',
    'action_engine/action_engine.js',
    'pipeline/user_pipeline.js'
];
const results = files.map((file) => {
    const summary = map.fileCoverageFor(path.join(root, file)).toSummary();
    return { file, lines: summary.lines.pct, branches: summary.branches.pct, functions: summary.functions.pct };
});
console.table(results);
fs.writeFileSync(path.join(dir, 'core-coverage.json'), JSON.stringify({ scope: 'six complete changed core files; not repository-wide coverage', results }, null, 2));
if (results.some((result) => result.lines < 90)) process.exitCode = 1;
