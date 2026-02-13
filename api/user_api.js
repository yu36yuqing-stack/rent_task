#!/usr/bin/env node
const {
    initUserDb,
    createUserByAdmin,
    verifyUserLogin,
    listActiveUsers,
    USER_TYPE_ADMIN
} = require('../database/user_db');
const { initUserGameAccountDb, listUserGameAccounts } = require('../database/user_game_account_db');
const { initUserBlacklistDb } = require('../database/user_blacklist_db');
const {
    initUserPlatformAuthDb,
    upsertUserPlatformAuth,
    listUserPlatformAuth
} = require('../database/user_platform_auth_db');
const {
    initUserSessionDb,
    createRefreshSession,
    revokeRefreshSession
} = require('../database/user_session_db');
const {
    createAccessToken,
    createOpaqueRefreshToken,
    REFRESH_TTL_SEC
} = require('../user/auth_token');
const { requireAccessToken } = require('./auth_middleware');
const { syncUserAccountsByAuth } = require('../product/product');

function parseArgs(argv) {
    const out = {};
    for (let i = 0; i < argv.length; i += 1) {
        const cur = argv[i];
        if (!cur.startsWith('--')) continue;
        const key = cur.slice(2);
        const value = argv[i + 1] && !argv[i + 1].startsWith('--') ? argv[++i] : 'true';
        out[key] = value;
    }
    return out;
}

function toBool(v) {
    return ['1', 'true', 'yes', 'on'].includes(String(v || '').toLowerCase());
}

async function initAll() {
    await initUserDb();
    await initUserGameAccountDb();
    await initUserBlacklistDb();
    await initUserPlatformAuthDb();
    await initUserSessionDb();
}

async function ensureAdminIfProvided(actorToken) {
    const token = String(actorToken || '').trim();
    if (!token) return { bypass: true, actor: null };
    const { user } = await requireAccessToken({ access_token: token });
    if (String(user.user_type || '') !== USER_TYPE_ADMIN) {
        throw new Error('当前操作需要管理员权限');
    }
    return { bypass: false, actor: user };
}

async function cmdInitDb() {
    await initAll();
    return { ok: true, command: 'init-db' };
}

async function cmdCreateUser(args) {
    await initAll();
    const auth = await ensureAdminIfProvided(args.actor_access_token);

    const row = await createUserByAdmin({
        account: args.account,
        password: args.password,
        name: args.name || '',
        phone: args.phone || '',
        notify_config: args.notify_config || '{}',
        user_type: args.user_type || 'external',
        status: args.status || 'enabled',
        desc: args.desc || ''
    });

    return {
        ok: true,
        command: 'create-user',
        bootstrap_mode: auth.bypass,
        actor: auth.actor ? { id: auth.actor.id, account: auth.actor.account } : null,
        user: row
    };
}

async function cmdLogin(args) {
    await initAll();
    const result = await verifyUserLogin(args.account, args.password);
    if (!result.ok) {
        return { ok: false, command: 'login', reason: result.reason };
    }

    const accessToken = createAccessToken(result.user);
    const refreshToken = createOpaqueRefreshToken();
    await createRefreshSession(result.user.id, refreshToken, REFRESH_TTL_SEC, 'login issue refresh token');

    return {
        ok: true,
        command: 'login',
        user: result.user,
        access_token: accessToken,
        refresh_token: refreshToken,
        access_ttl_sec: Number(process.env.ACCESS_TOKEN_TTL_SEC || 1800),
        refresh_ttl_sec: REFRESH_TTL_SEC
    };
}

async function cmdLogout(args) {
    await initAll();
    const token = String(args.refresh_token || '').trim();
    if (!token) throw new Error('refresh_token 不能为空');
    const ok = await revokeRefreshSession(token);
    return { ok: true, command: 'logout', revoked: ok };
}

async function cmdMe(args) {
    await initAll();
    const { user } = await requireAccessToken(args);
    return { ok: true, command: 'me', user };
}

async function cmdListUsers(args) {
    await initAll();
    const { user } = await requireAccessToken(args);
    if (String(user.user_type || '') !== USER_TYPE_ADMIN) {
        throw new Error('当前操作需要管理员权限');
    }
    const list = await listActiveUsers();
    return { ok: true, command: 'list-users', total: list.length, data: list };
}

async function cmdPlatformAuthUpsert(args) {
    await initAll();
    const { user } = await requireAccessToken(args);
    const row = await upsertUserPlatformAuth({
        user_id: user.id,
        platform: args.platform,
        auth_type: args.auth_type,
        auth_payload: args.auth_payload,
        auth_status: args.auth_status || 'valid',
        expire_at: args.expire_at || '',
        desc: args.desc || ''
    });
    return { ok: true, command: 'platform-auth-upsert', data: row };
}

async function cmdPlatformAuthList(args) {
    await initAll();
    const { user } = await requireAccessToken(args);
    const includePayload = toBool(args.with_payload);
    const rows = await listUserPlatformAuth(user.id, { with_payload: includePayload });
    return { ok: true, command: 'platform-auth-list', total: rows.length, data: rows };
}

async function cmdAccountsSync(args) {
    await initAll();
    const { user } = await requireAccessToken(args);
    const result = await syncUserAccountsByAuth(user.id);
    return { ok: true, command: 'accounts-sync', ...result };
}

async function cmdAccountsList(args) {
    await initAll();
    const { user } = await requireAccessToken(args);
    const page = Number(args.page || 1);
    const pageSize = Number(args.page_size || 50);
    const rows = await listUserGameAccounts(user.id, page, pageSize);
    return { ok: true, command: 'accounts-list', ...rows };
}

function printHelp() {
    console.log('Usage:');
    console.log('  node api/user_api.js init-db');
    console.log('  node api/user_api.js create-user --account u1 --password p1 --user_type admin');
    console.log('  node api/user_api.js login --account u1 --password p1');
    console.log('  node api/user_api.js logout --refresh_token <token>');
    console.log('  node api/user_api.js me --access_token <token>');
    console.log('  node api/user_api.js list-users --access_token <admin_access_token>');
    console.log('  node api/user_api.js platform-auth-upsert --access_token <token> --platform zuhaowang --auth_type token --auth_payload "{...}"');
    console.log('  node api/user_api.js platform-auth-list --access_token <token> [--with_payload true]');
    console.log('  node api/user_api.js accounts-sync --access_token <token>');
    console.log('  node api/user_api.js accounts-list --access_token <token> [--page 1 --page_size 50]');
    console.log('');
    console.log('Notes:');
    console.log('  1) create-user 支持引导模式：不带 actor_access_token 时允许直接创建首批账号。');
    console.log('  2) 为避免影响当前主流程，USER_MODE_ENABLED 默认为 false，不自动接管 rent_robot_main。');
}

async function main() {
    const cmd = process.argv[2] || 'help';
    const args = parseArgs(process.argv.slice(3));

    if (cmd === 'help') {
        printHelp();
        return;
    }

    let result;
    if (cmd === 'init-db') result = await cmdInitDb(args);
    else if (cmd === 'create-user') result = await cmdCreateUser(args);
    else if (cmd === 'login') result = await cmdLogin(args);
    else if (cmd === 'logout') result = await cmdLogout(args);
    else if (cmd === 'me') result = await cmdMe(args);
    else if (cmd === 'list-users') result = await cmdListUsers(args);
    else if (cmd === 'platform-auth-upsert') result = await cmdPlatformAuthUpsert(args);
    else if (cmd === 'platform-auth-list') result = await cmdPlatformAuthList(args);
    else if (cmd === 'accounts-sync') result = await cmdAccountsSync(args);
    else if (cmd === 'accounts-list') result = await cmdAccountsList(args);
    else throw new Error(`unknown command: ${cmd}`);

    console.log(JSON.stringify(result, null, 2));
}

main().catch((err) => {
    console.error(JSON.stringify({ ok: false, error: err.message }));
    process.exit(1);
});
