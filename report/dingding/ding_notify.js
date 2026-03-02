const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const TASK_DIR = path.resolve(__dirname, '..', '..');
const CONFIG_FILE = path.join(TASK_DIR, 'config', 'config.json');

function readJson(file, fallback) {
    try {
        if (!fs.existsSync(file)) return fallback;
        return JSON.parse(fs.readFileSync(file, 'utf8'));
    } catch {
        return fallback;
    }
}

function loadWebhook() {
    const cfg = readJson(CONFIG_FILE, {});
    const webhook = String(cfg.dingding_webhook || '').trim();
    if (!webhook) throw new Error('dingding_webhook 未配置');
    return webhook;
}

function loadSecret() {
    const cfg = readJson(CONFIG_FILE, {});
    return String(cfg.dingding_secret || '').trim();
}

function resolveWebhookUrl(raw, secret) {
    const base = /^https?:\/\//i.test(raw)
        ? raw
        : `https://oapi.dingtalk.com/robot/send?access_token=${encodeURIComponent(raw)}`;
    if (!secret) return base;

    const ts = String(Date.now());
    const toSign = `${ts}\n${secret}`;
    const sign = crypto.createHmac('sha256', secret).update(toSign).digest('base64');
    const u = new URL(base);
    u.searchParams.set('timestamp', ts);
    u.searchParams.set('sign', sign);
    return u.toString();
}

function normalizeAtMobiles(input) {
    const list = Array.isArray(input)
        ? input
        : String(input || '').split(',');
    const out = [];
    for (const one of list) {
        const raw = String(one || '').trim();
        if (!raw) continue;
        const digits = raw.replace(/\D+/g, '');
        if (!digits) continue;
        const mobile = digits.startsWith('86') && digits.length === 13
            ? digits.slice(2)
            : digits;
        if (!/^\d{11}$/.test(mobile)) continue;
        if (!out.includes(mobile)) out.push(mobile);
    }
    return out;
}

function normalizeAtUserIds(input) {
    const list = Array.isArray(input)
        ? input
        : String(input || '').split(',');
    const out = [];
    for (const one of list) {
        const id = String(one || '').trim();
        if (!id) continue;
        if (!out.includes(id)) out.push(id);
    }
    return out;
}

function normalizeAtMode(modeText = '') {
    const v = String(modeText || '').trim().toLowerCase();
    if (v === 'all') return 'all';
    if (v === 'owner') return 'owner';
    if (v === 'none') return 'none';
    return '';
}

function resolveDingdingAtOptions(dingCfg = {}, scene = '') {
    const cfg = dingCfg && typeof dingCfg === 'object' ? dingCfg : {};
    const sceneKey = String(scene || '').trim();
    const scenePrefix = sceneKey ? `${sceneKey}_` : '';

    const sceneMode = normalizeAtMode(cfg[`${scenePrefix}at_mode`]);
    const globalMode = normalizeAtMode(cfg.at_mode);
    const fallbackMode = sceneKey !== 'complaint'
        ? normalizeAtMode(cfg.complaint_at_mode)
        : '';
    const mode = sceneMode || globalMode || fallbackMode;

    const sceneMobiles = normalizeAtMobiles(cfg[`${scenePrefix}at_mobiles`]);
    const globalMobiles = normalizeAtMobiles(cfg.at_mobiles);
    const fallbackMobiles = sceneKey !== 'complaint'
        ? normalizeAtMobiles(cfg.complaint_at_mobiles)
        : [];
    const mobiles = sceneMobiles.length > 0
        ? sceneMobiles
        : (globalMobiles.length > 0 ? globalMobiles : fallbackMobiles);

    const sceneUserIds = normalizeAtUserIds(cfg[`${scenePrefix}at_user_ids`]);
    const globalUserIds = normalizeAtUserIds(cfg.at_user_ids);
    const userIds = sceneUserIds.length > 0 ? sceneUserIds : globalUserIds;

    if (mode === 'all') return { at_all: true };
    if (mode === 'none') return {};
    if (mode === 'owner' || mobiles.length > 0 || userIds.length > 0) {
        return {
            at_mobiles: mobiles,
            at_user_ids: userIds
        };
    }
    return {};
}

async function sendDingdingMessage(message, options = {}) {
    const webhook = String(options.webhook || '').trim() || loadWebhook();
    const secret = String(options.secret || '').trim() || loadSecret();
    const url = resolveWebhookUrl(webhook, secret);
    const text = String(message || '').trim();
    if (!text) return false;

    const body = {
        msgtype: 'text',
        text: { content: text }
    };
    const atMobiles = normalizeAtMobiles(options && options.at_mobiles);
    const atUserIds = normalizeAtUserIds(options && options.at_user_ids);
    const atAll = Boolean(options && options.at_all === true);
    if (atAll || atMobiles.length > 0 || atUserIds.length > 0) {
        body.at = {
            isAtAll: atAll,
            atMobiles,
            atUserIds
        };
    }

    const res = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json; charset=utf-8' },
        body: JSON.stringify(body)
    });
    const respText = await res.text();
    if (!res.ok) throw new Error(`HTTP ${res.status}: ${respText.slice(0, 200)}`);

    let data = {};
    try {
        data = respText ? JSON.parse(respText) : {};
    } catch {
        throw new Error(`钉钉返回非JSON: ${respText.slice(0, 200)}`);
    }
    if (Number(data.errcode || 0) !== 0) {
        throw new Error(`errcode=${data.errcode}, errmsg=${data.errmsg || ''}`);
    }
    return true;
}

module.exports = {
    sendDingdingMessage,
    resolveDingdingAtOptions
};
