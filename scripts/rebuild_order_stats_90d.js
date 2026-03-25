#!/usr/bin/env node
const { refreshOrderStatsDailyForAllUsers } = require('../stats/order_stats');

async function main() {
    const summary = await refreshOrderStatsDailyForAllUsers({
        mode: 'backfill',
        days: 90,
        game_name: '全部',
        desc: 'rebuild 90d after stats db migration'
    });
    console.log(JSON.stringify({
        ok: true,
        days: 90,
        summary
    }, null, 2));
}

main().catch((err) => {
    console.error('[rebuild_order_stats_90d] failed:', err && err.stack ? err.stack : err);
    process.exit(1);
});
