'use strict';

const fs = require('fs');
const path = require('path');
const { createCoverageMap } = require('istanbul-lib-coverage');
const libReport = require('istanbul-lib-report');
const reports = require('istanbul-reports');
const base = path.resolve(__dirname, '../coverage/uuzuhao-online-auth');
const coverage = createCoverageMap(JSON.parse(fs.readFileSync(path.join(base, 'code/coverage-final.json'), 'utf8')));
coverage.merge(JSON.parse(fs.readFileSync(path.join(base, 'browser-coverage.json'), 'utf8')));
const context = libReport.createContext({ dir: path.join(base, 'combined'), coverageMap: coverage });
for (const reporter of ['json', 'json-summary', 'html', 'text']) reports.create(reporter).execute(context);
