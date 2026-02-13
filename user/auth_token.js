const crypto = require('crypto');

const ACCESS_TTL_SEC = Number(process.env.ACCESS_TOKEN_TTL_SEC || 1800);
const REFRESH_TTL_SEC = Number(process.env.REFRESH_TOKEN_TTL_SEC || 2592000);
const ACCESS_SECRET = String(process.env.JWT_ACCESS_SECRET || 'rent_task_access_secret_dev_only').trim();

function b64urlEncode(input) {
    return Buffer.from(input)
        .toString('base64')
        .replace(/\+/g, '-')
        .replace(/\//g, '_')
        .replace(/=+$/g, '');
}

function b64urlDecode(input) {
    const raw = String(input).replace(/-/g, '+').replace(/_/g, '/');
    const pad = raw.length % 4 === 0 ? '' : '='.repeat(4 - (raw.length % 4));
    return Buffer.from(raw + pad, 'base64').toString('utf8');
}

function nowSec() {
    return Math.floor(Date.now() / 1000);
}

function signPayload(payloadObj) {
    const json = JSON.stringify(payloadObj);
    const body = b64urlEncode(json);
    const sig = crypto.createHmac('sha256', ACCESS_SECRET).update(body).digest('hex');
    return `${body}.${sig}`;
}

function parseSignedToken(token) {
    const raw = String(token || '');
    const parts = raw.split('.');
    if (parts.length !== 2) throw new Error('token 格式不合法');
    const [body, sig] = parts;
    const expect = crypto.createHmac('sha256', ACCESS_SECRET).update(body).digest('hex');
    if (!crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(expect))) {
        throw new Error('token 签名无效');
    }
    const payload = JSON.parse(b64urlDecode(body));
    if (!payload || typeof payload !== 'object') throw new Error('token payload 无效');
    if (!payload.exp || Number(payload.exp) < nowSec()) throw new Error('token 已过期');
    return payload;
}

function createAccessToken(user) {
    const iat = nowSec();
    const payload = {
        typ: 'access',
        iat,
        exp: iat + ACCESS_TTL_SEC,
        user_id: Number(user.id),
        user_type: String(user.user_type || ''),
        account: String(user.account || '')
    };
    return signPayload(payload);
}

function createOpaqueRefreshToken() {
    return crypto.randomBytes(32).toString('hex');
}

module.exports = {
    ACCESS_TTL_SEC,
    REFRESH_TTL_SEC,
    createAccessToken,
    parseSignedToken,
    createOpaqueRefreshToken
};
