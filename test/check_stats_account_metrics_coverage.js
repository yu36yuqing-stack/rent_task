'use strict';
const fs = require('node:fs');
const path = require('node:path');
const { createCoverageMap } = require('istanbul-lib-coverage');
const { createContext } = require('istanbul-lib-report');
const reports = require('istanbul-reports');

const root = path.resolve(__dirname,'..');
const dir = path.join(root,'coverage/stats-account-metrics');
const map = createCoverageMap(JSON.parse(fs.readFileSync(path.join(dir,'code/coverage-final.json'))));
map.merge(JSON.parse(fs.readFileSync(path.join(dir,'ui/coverage.json'))));
const context = createContext({dir:path.join(dir,'merged'),coverageMap:map});
for(const format of ['text','json-summary','json','html'])reports.create(format).execute(context);
for(const name of ['stats/dashboard_metrics.js','stats/order_stats.js',
    'h5/public/js/ui/stats_metrics.js','h5/public/js/menu_stats.js']) {
    const summary=map.fileCoverageFor(path.join(root,name)).toSummary();
    if(summary.lines.pct<90)throw new Error(name+' full-file line coverage below 90%: '+summary.lines.pct);
}
console.log('PASS all four full core files exceed 90% line coverage');
