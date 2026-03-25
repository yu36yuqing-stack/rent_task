#!/usr/bin/env node
const {
    refreshOrderStatsDailyByUser,
    refreshOrderStatsDailyForAllUsers,
    normalizeStatsRefreshRange
} = require('../stats/order_stats');

function parseArgs(argv = []) {
    const out = {};
    for (let i = 0; i < argv.length; i += 1) {
        const token = String(argv[i] || '').trim();
        if (!token.startsWith('--')) continue;
        const key = token.slice(2);
        const next = argv[i + 1];
        if (!key) continue;
        if (next === undefined || String(next).startsWith('--')) {
            out[key] = '1';
            continue;
        }
        out[key] = String(next);
        i += 1;
    }
    return out;
}

async function main() {
    const args = parseArgs(process.argv.slice(2));
    const userId = Number(args.user_id || 0);
    const gameName = String(args.game_name || '全部').trim() || '全部';
    const allUsers = ['1', 'true', 'yes', 'on'].includes(String(args.all_users || '').trim().toLowerCase());
    const options = {
        mode: 'backfill',
        days: args.days === undefined ? undefined : Number(args.days),
        start_date: args.start_date ? String(args.start_date).trim() : '',
        game_name: gameName,
        desc: 'manual rebuild by scripts/rebuild_order_stats.js'
    };
    const range = normalizeStatsRefreshRange(options);

    if (!allUsers && !userId) {
        throw new Error('请传 --all_users 1 或 --user_id <id>');
    }

    const summary = allUsers
        ? await refreshOrderStatsDailyForAllUsers(options)
        : await refreshOrderStatsDailyByUser(userId, options);

    console.log(JSON.stringify({
        ok: true,
        scope: allUsers ? 'all_users' : 'single_user',
        user_id: allUsers ? undefined : userId,
        game_name: gameName,
        refresh_range: range,
        summary
    }, null, 2));
}

main().catch((err) => {
    console.error('[rebuild_order_stats] failed:', err && err.stack ? err.stack : err);
    process.exit(1);
});
