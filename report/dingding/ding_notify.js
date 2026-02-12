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

async function sendDingdingMessage(message) {
    const webhook = loadWebhook();
    const secret = loadSecret();
    const url = resolveWebhookUrl(webhook, secret);
    const text = String(message || '').trim();
    if (!text) return false;

    const body = {
        msgtype: 'text',
        text: { content: text }
    };

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
    sendDingdingMessage
};
