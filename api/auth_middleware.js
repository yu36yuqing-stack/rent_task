const { parseSignedToken } = require('../user/auth_token');
const { getActiveUserById } = require('../database/user_db');

async function parseAccessTokenOrThrow(token) {
    const payload = parseSignedToken(String(token || '').trim());
    const user = await getActiveUserById(payload.user_id);
    if (!user) throw new Error('用户不存在或已删除');
    if (String(user.status || 'enabled') !== 'enabled') throw new Error('用户已禁用');
    return { payload, user };
}

async function requireAccessToken(args = {}) {
    const token = String(args.access_token || '').trim();
    if (!token) throw new Error('access_token 不能为空');
    return parseAccessTokenOrThrow(token);
}

module.exports = {
    parseAccessTokenOrThrow,
    requireAccessToken
};
