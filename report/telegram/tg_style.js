function esc(v) {
    return String(v ?? '')
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;');
}

const REPORT_VERSION = 'v1.0.6';

function shortState(s) {
    if (!s) return '未';
    return String(s)
        .replace('租赁中', '租')
        .replace('出租中', '租')
        .replace('审核失败', '审核失败')
        .replace('上架', '上')
        .replace('下架', '下');
}

function normalizeAuthorizedPlatforms(input) {
    const all = ['uuzuhao', 'uhaozu', 'zuhaowang'];
    const arr = Array.isArray(input) ? input : [];
    const out = [];
    for (const p of arr) {
        const v = String(p || '').trim().toLowerCase();
        if (v === 'uuzuhao' || v === 'uhaozu' || v === 'zuhaowang') {
            if (!out.includes(v)) out.push(v);
        }
    }
    return out.length > 0 ? out : all;
}

function pickIcon(acc, authorizedPlatforms = []) {
    const y = acc.youpin;
    const u = acc.uhaozu;
    const z = acc.zuhaowan;
    const stateByPlatform = {
        uuzuhao: y,
        uhaozu: u,
        zuhaowang: z
    };
    const states = normalizeAuthorizedPlatforms(authorizedPlatforms)
        .map((p) => stateByPlatform[p])
        .filter((s) => s !== '');
    const anyRent = states.includes('租赁中');
    const allUp = states.length > 0 && states.every((s) => s === '上架');
    const allDown = states.length > 0 && states.every((s) => s === '下架');

    if (anyRent) return '💰';
    if (allUp) return '✅';
    if (allDown) return '⬇️';
    return '⚠️';
}

function normalizeSuffixText(suffix) {
    const raw = String(suffix || '').trim();
    if (!raw) return '';
    const noBracket = raw.replace(/^\((.*)\)$/, '$1').trim();
    const text = noBracket.replace('已按黑名单强制下架', '已按黑名单规则下架');
    if (!text) return '';
    return text.startsWith('🔸') ? ` ${text}` : ` 🔸${text}`;
}

function buildTelegramMessage(payload) {
    if (!payload?.ok) {
        return payload?.message || '⚠️ 暂无状态数据 (任务可能未运行)';
    }

    const owner = String(payload?.report_owner || '').trim();
    const title = owner ? `${owner} 租号状态汇报` : '租号状态汇报';

    let msg = '';
    msg += `<b>📊 ${esc(title)}</b> <code>${esc(payload.hhmm)}</code>\n`;

    if (Array.isArray(payload.recentActions) && payload.recentActions.length > 0) {
        msg += '<b>🛠️ 近半小时自动操作</b>\n';
        msg += `${payload.recentActions.slice(-8).map(esc).join('\n')}\n\n`;
    } else {
        msg += '<b>🛠️ 近半小时自动操作</b>\n';
        msg += '• 无\n\n';
    }

    const accounts = Array.isArray(payload.accounts) ? payload.accounts : [];
    const authorizedPlatforms = normalizeAuthorizedPlatforms(payload.authorized_platforms);
    msg += `<b>📋 完整账号列表</b> <code>(${esc(accounts.length)}个)</code>\n\n`;
    accounts.forEach((acc) => {
        const y = shortState(acc.youpin);
        const u = shortState(acc.uhaozu);
        const z = shortState(acc.zuhaowan);
        const icon = pickIcon(acc, authorizedPlatforms);
        const todayCount = Number(acc.today_order_count || 0);
        const onlineTag = String(acc.online_tag || '').trim();
        const onlineBadge = onlineTag ? `(${onlineTag})` : '';
        const suffix = normalizeSuffixText(acc.suffix);
        msg += `${esc(icon)}<code>[${esc(todayCount)}单]</code>${esc(onlineBadge)} <b>${esc(acc.remark || acc.account)}</b>: `;
        msg += `Y[<code>${esc(y)}</code>] U[<code>${esc(u)}</code>] Z[<code>${esc(z)}</code>]`;
        msg += `${esc(suffix)}${esc(acc.hint || '')}\n`;
    });

    msg += '\n';
    msg += payload.allNormal
        ? '✅ 所有状态正常 (已授权平台一致或无冲突)'
        : '⚠️ 检测到待修复状态';
    msg += `\n<code>版本: ${esc(REPORT_VERSION)}</code>`;
    return msg;
}

module.exports = {
    buildTelegramMessage
};
