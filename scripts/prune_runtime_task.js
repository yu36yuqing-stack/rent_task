#!/usr/bin/env node
'use strict';

const {
    DEFAULT_RETENTION_DAYS,
    runRuntimeTaskPrune,
    getRuntimeTaskPruneDashboard
} = require('../maintenance/runtime_task_prune_service');

function parseArgs(argv = []) {
    const out = {
        retention_days: DEFAULT_RETENTION_DAYS,
        trigger_type: 'manual_script',
        trigger_user_id: 0,
        list: false
    };
    for (let i = 0; i < argv.length; i += 1) {
        const key = String(argv[i] || '').trim();
        const value = String(argv[i + 1] || '').trim();
        if ((key === '--retention-days' || key === '--retain-days' || key === '--retention_days') && value) {
            out.retention_days = Math.max(1, Number(value || DEFAULT_RETENTION_DAYS) || DEFAULT_RETENTION_DAYS);
            i += 1;
        } else if ((key === '--trigger-user-id' || key === '--trigger_user_id') && value) {
            out.trigger_user_id = Math.max(0, Number(value || 0) || 0);
            i += 1;
        } else if (key === '--list') {
            out.list = true;
        }
    }
    return out;
}

async function main() {
    const args = parseArgs(process.argv.slice(2));
    if (args.list) {
        const dashboard = await getRuntimeTaskPruneDashboard({ limit: 20 });
        process.stdout.write(JSON.stringify({ ok: true, dashboard }, null, 2));
        return;
    }
    const out = await runRuntimeTaskPrune({
        trigger_type: args.trigger_type,
        trigger_user_id: args.trigger_user_id,
        retention_days: args.retention_days
    });
    process.stdout.write(JSON.stringify(out, null, 2));
}

main().catch((err) => {
    console.error(JSON.stringify({
        ok: false,
        error: String(err && err.message ? err.message : err),
        code: String(err && err.code || '')
    }, null, 2));
    process.exit(1);
});
