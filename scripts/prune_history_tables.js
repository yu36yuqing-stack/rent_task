#!/usr/bin/env node
'use strict';

const { pruneUserBlacklistHistory } = require('../database/user_blacklist_db');
const { pruneProductOnoffHistory } = require('../database/product_onoff_history_db');

function parseArgs(argv = []) {
    const out = { retain_days: 30 };
    for (let i = 0; i < argv.length; i += 1) {
        const key = String(argv[i] || '').trim();
        const value = String(argv[i + 1] || '').trim();
        if ((key === '--retain_days' || key === '--retain-days') && value) {
            out.retain_days = Math.max(1, Number(value || 30) || 30);
            i += 1;
        }
    }
    return out;
}

async function main() {
    const args = parseArgs(process.argv.slice(2));
    let blacklist = null;
    let blacklistError = '';
    try {
        blacklist = await pruneUserBlacklistHistory({ retain_days: args.retain_days });
    } catch (err) {
        blacklistError = String(err && err.message ? err.message : err);
    }
    const onoff = await pruneProductOnoffHistory({ retain_days: args.retain_days });
    process.stdout.write(JSON.stringify({
        ok: !blacklistError,
        retain_days: args.retain_days,
        results: {
            user_blacklist_history: blacklist,
            product_onoff_history: onoff
        },
        warnings: blacklistError ? {
            user_blacklist_history: blacklistError
        } : {}
    }));
}

main().catch((err) => {
    console.error(JSON.stringify({
        ok: false,
        error: String(err && err.message ? err.message : err)
    }));
    process.exit(1);
});
