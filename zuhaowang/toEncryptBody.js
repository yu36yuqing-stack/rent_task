const crypto = require('crypto');

const RAW_PUBLIC_KEY = 'MIGfMA0GCSqGSIb3DQEBAQUAA4GNADCBiQKBgQC6UvDgMAbCgnKhXqR3mzXbsGnyJz0+SWwDBGBWrniBRC8+dZ68aNsC7yTBQsl6TyS8qPVtyfenrdsqCY6qhSKlGyw9zeFWk7ijhaRlAOnrDvGj78JWkpPtJIi22IdC2hZg+9s4xpOVcwYAfF1gimRV+JOMuO+NEZZz0Z6W2zXFkwIDAQAB';

function formatPublicKeyPem(rawKey = RAW_PUBLIC_KEY) {
    const key = String(rawKey || '').trim();
    return `-----BEGIN PUBLIC KEY-----\n${key}\n-----END PUBLIC KEY-----`;
}

function generateRandomKey(length = 16) {
    const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
    let out = '';
    for (let i = 0; i < length; i += 1) {
        out += chars.charAt(Math.floor(Math.random() * chars.length));
    }
    return out;
}

function encryptAES(payload, keyStr) {
    const key = Buffer.from(String(keyStr || ''), 'utf8');
    const iv = Buffer.from(String(keyStr || ''), 'utf8');
    const cipher = crypto.createCipheriv('aes-128-cbc', key, iv);
    let encrypted = cipher.update(JSON.stringify(payload), 'utf8', 'base64');
    encrypted += cipher.final('base64');
    return encrypted;
}

function encryptRSA(aesKey, rawPublicKey = RAW_PUBLIC_KEY) {
    const pem = formatPublicKeyPem(rawPublicKey);
    const buffer = Buffer.from(String(aesKey || ''), 'utf8');
    const encrypted = crypto.publicEncrypt({
        key: pem,
        padding: crypto.constants.RSA_PKCS1_PADDING
    }, buffer);
    return encrypted.toString('base64');
}

function buildEncryptedBody(bizParams = {}, options = {}) {
    const sessionKey = generateRandomKey(Number(options.key_length || 16));
    const internalPayload = {
        // App 反编译 + Frida 抓包确认：这里使用小写 key
        param: JSON.stringify(bizParams || {}),
        timestamp: Number(options.timestamp || Date.now())
    };
    const data = encryptAES(internalPayload, sessionKey);
    const ak = encryptRSA(sessionKey, options.public_key || RAW_PUBLIC_KEY);
    return { ak, data };
}

module.exports = {
    RAW_PUBLIC_KEY,
    formatPublicKeyPem,
    generateRandomKey,
    encryptAES,
    encryptRSA,
    buildEncryptedBody
};
