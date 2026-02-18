const {
    initUserPlatformAuthDb,
    upsertUserPlatformAuth,
    listUserPlatformAuth
} = require('../../database/user_platform_auth_db');

const CHANNEL_CONFIG = [
    {
        platform: 'uuzuhao',
        name: '悠悠租号',
        mode: '用户填写',
        required_keys: ['app_key', 'app_secret']
    },
    {
        platform: 'zuhaowang',
        name: '租号王',
        mode: '模拟客户端登录',
        required_keys: ['token_get', 'token_post', 'device_id', 'package_name']
    },
    {
        platform: 'uhaozu',
        name: 'U号租',
        mode: '模拟PC商家后台登录',
        required_keys: ['cookie']
    }
];

const PLATFORM_OPTIONS = [
    { value: 'zuhaowang', label: '租号王' },
    { value: 'zuhaowang-yuanbao', label: '租号王(元宝)' },
    { value: 'uhaozu', label: 'U号租' },
    { value: 'uuzuhao', label: '悠悠租号' }
];

const AUTH_STATUS_OPTIONS = [
    { value: 'valid', label: '有效' },
    { value: 'expired', label: '已过期' },
    { value: 'revoked', label: '已撤销' }
];

const AUTH_TYPE_OPTIONS = [
    { value: 'token', label: 'Token' },
    { value: 'cookie', label: 'Cookie' },
    { value: 'session', label: 'Session' }
];

function toBool(v) {
    return ['1', 'true', 'yes', 'on'].includes(String(v || '').trim().toLowerCase());
}

function maskSecret(v) {
    const raw = String(v || '').trim();
    if (!raw) return '';
    if (raw.length <= 6) return '***';
    return `${raw.slice(0, 3)}***${raw.slice(-3)}`;
}

function toChannelView(rows = []) {
    const map = new Map();
    for (const row of Array.isArray(rows) ? rows : []) {
        const key = String((row && row.platform) || '').trim();
        if (!key) continue;
        map.set(key, row);
    }

    return CHANNEL_CONFIG.map((c) => {
        const row = map.get(c.platform) || null;
        const payload = row && row.auth_payload && typeof row.auth_payload === 'object' ? row.auth_payload : {};
        const key_values = c.required_keys.map((k) => ({
            key: k,
            masked_value: maskSecret(payload[k])
        }));
        const authStatus = row ? String(row.auth_status || '') : '';
        const hasAuth = Boolean(row) && authStatus === 'valid';
        return {
            platform: c.platform,
            name: c.name,
            mode: c.mode,
            authorized: hasAuth,
            auth_status: authStatus || 'none',
            button_text: hasAuth ? '修改授权' : '新增授权',
            key_values
        };
    });
}

function createAuthBff(deps = {}) {
    const requireAuth = deps.requireAuth;
    const readJsonBody = deps.readJsonBody;
    const json = deps.json;

    if (typeof requireAuth !== 'function' || typeof readJsonBody !== 'function' || typeof json !== 'function') {
        throw new Error('createAuthBff 缺少必要依赖: requireAuth/readJsonBody/json');
    }

    async function handleGetPlatformAuthList(req, res, urlObj) {
        const user = await requireAuth(req);
        const includePayload = toBool(urlObj.searchParams.get('with_payload'));
        const rows = await listUserPlatformAuth(user.id, { with_payload: true });
        const channels = toChannelView(rows);
        return json(res, 200, {
            ok: true,
            data: channels,
            rows: includePayload ? rows : undefined,
            options: {
                platform: PLATFORM_OPTIONS,
                auth_type: AUTH_TYPE_OPTIONS,
                auth_status: AUTH_STATUS_OPTIONS
            }
        });
    }

    async function handleUpsertPlatformAuth(req, res) {
        const user = await requireAuth(req);
        const body = await readJsonBody(req);
        const row = await upsertUserPlatformAuth({
            user_id: user.id,
            platform: String(body.platform || '').trim(),
            auth_type: String(body.auth_type || '').trim(),
            auth_payload: body.auth_payload,
            auth_status: String(body.auth_status || 'valid').trim(),
            expire_at: String(body.expire_at || '').trim(),
            desc: String(body.desc || 'h5 auth bff upsert').trim()
        });
        return json(res, 200, { ok: true, data: row });
    }

    async function init() {
        await initUserPlatformAuthDb();
    }

    return {
        init,
        handleGetPlatformAuthList,
        handleUpsertPlatformAuth
    };
}

module.exports = {
    createAuthBff
};
