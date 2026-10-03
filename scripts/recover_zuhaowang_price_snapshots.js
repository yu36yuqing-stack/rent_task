'use strict';

const { listAllUserGameAccountsByUser } = require('../product/product');
const { listAccountPriceLadderRuntimesByUser } = require('../database/account_price_ladder_runtime_db');
const { listUserPlatformAuth } = require('../database/user_platform_auth_db');
const { upsertUserGameAccount } = require('../database/user_game_account_db');
const { recoverZuhaowangPriceSnapshotsByUser, recoverZuhaowangPriceSnapshotsFromTemplates } = require('../price/zuhaowang_price_snapshot_service');
const FIELDS = ['hourPrice', 'p24Price', 'p72Price', 'p168Price', 'hour_basis', 'rent_mode', 'price_template_type'];

async function recoverSnapshots(input, options = {}) {
    const uid = Number(input.user_id);
    if (!Number.isInteger(uid) || uid <= 0) throw new Error('--user-id must be a positive integer');
    const auths = await (options.list_auth || listUserPlatformAuth)(uid, { with_payload: false });
    if (auths.some((row) => row.platform === 'zuhaowang' && row.channel_enabled === false)) {
        return { user_id: uid, skipped: true, reason: 'channel_disabled', list: [] };
    }
    const listAccounts = options.list_accounts || listAllUserGameAccountsByUser;
    const accounts = await listAccounts(uid);
    const snapshots = await recoverZuhaowangPriceSnapshotsByUser(uid, accounts, options);
    if (input.query_missing === true) {
        const unresolved = accounts.filter((row) => !snapshots[`${row.game_id}::${row.game_account}`]);
        const runtimes = await (options.list_runtimes || listAccountPriceLadderRuntimesByUser)(uid);
        Object.assign(snapshots, await recoverZuhaowangPriceSnapshotsFromTemplates(uid, unresolved, runtimes, options));
    }
    const list = [];
    const current = input.apply === true ? await listAccounts(uid) : accounts;
    for (const row of current) {
        const snapshot = snapshots[`${row.game_id}::${row.game_account}`];
        const info = row.channel_prd_info && row.channel_prd_info.zuhaowang;
        if (Number(row.user_id) !== uid || !snapshot || !info || Number(row.is_deleted || 0) || row.asset_status === 'sold'
            || String(info.prd_id || info.data_id) !== snapshot.prd_id) continue;
        if (input.apply === true) {
            const latestAuths = await (options.list_auth || listUserPlatformAuth)(uid, { with_payload: false });
            if (latestAuths.some((auth) => auth.platform === 'zuhaowang' && auth.channel_enabled === false)) continue;
            const patch = { ...info };
            for (const field of FIELDS) patch[field] = snapshot[field];
            await (options.save || upsertUserGameAccount)({ user_id: uid, game_id: row.game_id,
                game_name: row.game_name, game_account: row.game_account, account_remark: row.account_remark,
                channel_prd_info: { zuhaowang: patch }, desc: 'recover confirmed zuhaowang price snapshot' });
        }
        list.push({ game_id: row.game_id, game_account: row.game_account, goods_id: snapshot.prd_id,
            hour_basis: snapshot.hour_basis, mode: snapshot.rent_mode });
    }
    return { user_id: uid, dry_run: input.apply !== true, recovered: list.length, list };
}

if (require.main === module) {
    const args = process.argv.slice(2);
    const uidIndex = args.indexOf('--user-id');
    recoverSnapshots({ user_id: uidIndex < 0 ? 0 : args[uidIndex + 1], apply: args.includes('--apply'),
        query_missing: args.includes('--query-missing') }).then((result) => console.log(JSON.stringify(result, null, 2)))
        .catch((error) => { console.error(error.message); process.exitCode = 1; });
}

module.exports = { recoverSnapshots };
