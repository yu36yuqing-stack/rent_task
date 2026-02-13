#!/usr/bin/env node
const path = require('path');
const {
    initBlacklistDb,
    getActiveBlacklist,
    upsertBlacklistEntry,
    removeBlacklistEntry,
    exportBlacklistToFile
} = require('../database/blacklist_db');

const TASK_DIR = path.resolve(__dirname, '..');
const BLACKLIST_FILE = path.join(TASK_DIR, 'config', 'blacklist.json');

function parseArgs(argv) {
    const out = {};
    for (let i = 0; i < argv.length; i += 1) {
        const cur = argv[i];
        if (!cur.startsWith('--')) continue;
        const k = cur.slice(2);
        const v = argv[i + 1] && !argv[i + 1].startsWith('--') ? argv[++i] : 'true';
        out[k] = v;
    }
    return out;
}

async function main() {
    const cmd = process.argv[2] || 'help';
    const args = parseArgs(process.argv.slice(3));
    await initBlacklistDb();

    if (cmd === 'help') {
        console.log('Usage:');
        console.log('  node api/blacklist_api.js sync-file (disabled)');
        console.log('  node api/blacklist_api.js list');
        console.log('  node api/blacklist_api.js upsert --account 123 --remark 名称 --reason 原因 --create_time "2026-02-12 12:00" --action off');
        console.log('  node api/blacklist_api.js remove --account 123');
        console.log('  node api/blacklist_api.js export-file');
        return;
    }

    if (cmd === 'sync-file') {
        console.log(JSON.stringify({
            ok: false,
            command: cmd,
            error: 'sync-file disabled: 现阶段不再从文件加载黑名单'
        }));
        return;
    }

    if (cmd === 'list') {
        const list = await getActiveBlacklist();
        console.log(JSON.stringify({ ok: true, count: list.length, data: list }, null, 2));
        return;
    }

    if (cmd === 'upsert') {
        const row = await upsertBlacklistEntry({
            account: args.account,
            remark: args.remark || '',
            reason: args.reason || '',
            create_time: args.create_time || '',
            action: args.action || 'off'
        }, {
            source: String(args.source || 'openclaw_telegram'),
            operator: String(args.operator || 'openclaw'),
            desc: String(args.desc || 'telegram upsert')
        });
        await exportBlacklistToFile(BLACKLIST_FILE);
        console.log(JSON.stringify({ ok: true, command: cmd, data: row }));
        return;
    }

    if (cmd === 'remove') {
        const ok = await removeBlacklistEntry(args.account, {
            source: String(args.source || 'openclaw_telegram'),
            operator: String(args.operator || 'openclaw'),
            desc: String(args.desc || 'telegram remove')
        });
        await exportBlacklistToFile(BLACKLIST_FILE);
        console.log(JSON.stringify({ ok: true, command: cmd, removed: ok }));
        return;
    }

    if (cmd === 'export-file') {
        const count = await exportBlacklistToFile(BLACKLIST_FILE);
        console.log(JSON.stringify({ ok: true, command: cmd, count }));
        return;
    }

    throw new Error(`unknown command: ${cmd}`);
}

main().catch((err) => {
    console.error(JSON.stringify({ ok: false, error: err.message }));
    process.exit(1);
});
