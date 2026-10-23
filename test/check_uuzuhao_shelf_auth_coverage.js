'use strict';

const fs = require('fs');
const path = require('path');
const { createCoverageMap } = require('istanbul-lib-coverage');
const root = path.resolve(__dirname, '..');
const dir = path.join(root, 'coverage/uuzuhao-shelf-auth/code');
const map = createCoverageMap(JSON.parse(fs.readFileSync(path.join(dir, 'coverage-final.json'), 'utf8')));
const files = ['common/uuzuhao_auth_state.js', 'database/uuzuhao_auth_state_db.js',
    'product/uuzuhao_online_auth_service.js', 'product/uuzuhao_shelf_auth_service.js',
    'product/product.js', 'action_engine/action_engine.js', 'h5/public/js/ui/uuzuhao_auth_status.js'];
const results = files.map(file => {
    const summary = map.fileCoverageFor(path.join(root, file)).toSummary();
    return { file, lines: summary.lines.pct, branches: summary.branches.pct, functions: summary.functions.pct };
});
console.table(results);
fs.writeFileSync(path.join(dir, 'core-coverage.json'), JSON.stringify({ scope: 'seven complete changed runtime files; not whole repository', results }, null, 2) + '\n');
if (results.some(result => result.lines < 90)) process.exitCode = 1;
