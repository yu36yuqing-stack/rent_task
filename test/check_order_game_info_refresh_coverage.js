'use strict';

const fs = require('fs');
const path = require('path');
const root = path.resolve(__dirname, '..');
const dir = path.join(root, 'coverage/order-game-info-refresh');
const summary = JSON.parse(fs.readFileSync(path.join(dir, 'coverage-summary.json'), 'utf8'));
const files = [
    'database/order_game_info_refresh_db.js',
    'database/migrations/20261112_023_order_game_info_refresh.js',
    'order/game_info_refresh_policy.js',
    'order/game_info_refresh_service.js',
    'order/game_info_refresh_worker.js',
    'order/order.js'
];
const results = files.map(file => {
    const s = summary[path.join(root, file)];
    if (!s) throw new Error(`Missing full-file coverage: ${file}`);
    return { file, lines: s.lines.pct, branches: s.branches.pct, functions: s.functions.pct };
});
console.table(results);
fs.writeFileSync(path.join(dir, 'core-coverage.json'), JSON.stringify({
    scope: 'Six complete changed core files, not repository-wide coverage', results, total: summary.total
}, null, 2));
if (results.some(result => result.lines < 90)) process.exitCode = 1;
