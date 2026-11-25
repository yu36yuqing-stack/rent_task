'use strict';
const { spawnSync } = require('node:child_process');
const path = require('node:path');
for (const file of [
    'stats_metrics_component_test.js', 'dashboard_operating_metrics_test.js',
    'order_stats_historical_total_scope_smoke_test.js', 'order_stats_refresh_policy_smoke_test.js',
    'rental_device_order_integration_test.js', 'rental_device_integration_test.js',
    'product_income_service_test.js'
]) {
    const result = spawnSync(process.execPath, [path.join(__dirname,file)], { stdio:'inherit' });
    if (result.status !== 0) process.exit(result.status || 1);
}
