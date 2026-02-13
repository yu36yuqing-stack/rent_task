const fs = require('fs');
const path = require('path');
const { fetch, ProxyAgent } = require('undici');

const DEFAULT_TOKEN = process.env.TG_BOT_TOKEN || '8458250702:AAH6jSTgyZyTTQzQMdUhs2Rwv91Neen2AFU';
const DEFAULT_CHAT_ID = process.env.TG_CHAT_ID || '6796486659';
const LOG_FILE = path.resolve(__dirname, '..', '..', 'log', 'tg_notify.log');
const MAX_LEN = 3500;
const DEFAULT_PROXY = 'http://127.0.0.1:7897';

function appendLog(line) {
    try {
        const dir = path.dirname(LOG_FILE);
        if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
        fs.appendFileSync(LOG_FILE, `${new Date().toISOString()} ${line}\n`);
    } catch (_) {
        // ignore logging failures
    }
}

async function sendTelegramMessage(message, mode = '', options = {}) {
    if (!message) return { ok: true, chunks: 0 };

    const token = String(options.token || DEFAULT_TOKEN).trim();
    const chatId = String(options.chat_id || DEFAULT_CHAT_ID).trim();
    if (!token || !chatId) {
        throw new Error('telegram token/chat_id 未配置');
    }

    const proxyCandidates = [
        options.proxy,
        process.env.TG_PROXY,
        process.env.HTTPS_PROXY,
        process.env.HTTP_PROXY,
        DEFAULT_PROXY,
        ''
    ].filter((v, idx, arr) => arr.indexOf(v) === idx);

    let sent = 0;
    for (let i = 0; i < message.length; i += MAX_LEN) {
        const chunk = message.slice(i, i + MAX_LEN);
        const params = new URLSearchParams({
            chat_id: chatId,
            text: chunk
        });
        if (mode === 'html') {
            params.set('parse_mode', 'HTML');
            params.set('disable_web_page_preview', 'true');
        }

        let sentOk = false;
        let lastError = '';
        for (const proxy of proxyCandidates) {
            try {
                const dispatcher = proxy ? new ProxyAgent(proxy) : undefined;
                const resp = await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
                    method: 'POST',
                    headers: { 'content-type': 'application/x-www-form-urlencoded' },
                    body: params.toString(),
                    dispatcher
                });
                const data = await resp.json().catch(() => ({}));
                if (!resp.ok || !data.ok) {
                    lastError = `status=${resp.status} body=${JSON.stringify(data)}`;
                    appendLog(`[FAIL] proxy=${proxy || 'DIRECT'} ${lastError}`);
                    continue;
                }
                appendLog(`[OK] proxy=${proxy || 'DIRECT'} chunk_len=${chunk.length}`);
                sentOk = true;
                break;
            } catch (err) {
                lastError = err.message || String(err);
                appendLog(`[FAIL] proxy=${proxy || 'DIRECT'} err=${lastError}`);
            }
        }

        if (!sentOk) {
            throw new Error(`telegram send failed: ${lastError}`);
        }

        sent += 1;
    }

    return { ok: true, chunks: sent };
}

if (require.main === module) {
    const message = process.argv[2] || '';
    const mode = process.argv[3] || '';
    sendTelegramMessage(message, mode)
        .then(() => process.exit(0))
        .catch((err) => {
            console.error(err.message || String(err));
            process.exit(1);
        });
}

module.exports = {
    sendTelegramMessage
};
