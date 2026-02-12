function esc(v) {
    return String(v ?? '')
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;');
}

function shortState(s) {
    if (!s) return '未';
    return String(s)
        .replace('租赁中', '租')
        .replace('出租中', '租')
        .replace('审核失败', '审核失败')
        .replace('上架', '上')
        .replace('下架', '下');
}

function pickIcon(acc) {
    const y = acc.youpin;
    const u = acc.uhaozu;
    const z = acc.zuhaowan;
    const anyRent = [y, u, z].includes('租赁中');
    const allUp = y === '上架' && u === '上架' && z === '上架';
    const allDown = y === '下架' && u === '下架' && z === '下架';

    if (anyRent) return '💰';
    if (allUp) return '✅';
    if (allDown) return '⬇️';
    return '⚠️';
}

function buildTelegramMessage(payload) {
    if (!payload?.ok) {
        return payload?.message || '⚠️ 暂无状态数据 (任务可能未运行)';
    }

    let msg = '';
    msg += `<b>📊 租号状态汇报</b> <code>${esc(payload.hhmm)}</code>\n`;

    if (Array.isArray(payload.recentActions) && payload.recentActions.length > 0) {
        msg += '<b>🛠️ 近1小时自动操作</b>\n';
        msg += `${payload.recentActions.slice(-8).map(esc).join('\n')}\n\n`;
    } else {
        msg += '<b>🛠️ 近1小时自动操作</b>\n';
        msg += '• 无\n\n';
    }

    const accounts = Array.isArray(payload.accounts) ? payload.accounts : [];
    msg += `<b>📋 完整账号列表</b> <code>(${esc(accounts.length)}个)</code>\n\n`;
    accounts.forEach((acc) => {
        const y = shortState(acc.youpin);
        const u = shortState(acc.uhaozu);
        const z = shortState(acc.zuhaowan);
        const icon = pickIcon(acc);
        msg += `${esc(icon)} <b>${esc(acc.remark || acc.account)}</b>: `;
        msg += `Y[<code>${esc(y)}</code>] U[<code>${esc(u)}</code>] Z[<code>${esc(z)}</code>]`;
        msg += `${esc(acc.suffix || '')}${esc(acc.hint || '')}\n`;
    });

    msg += '\n';
    msg += payload.allNormal
        ? '✅ 所有状态正常 (三方一致或无冲突)'
        : '⚠️ 检测到待修复状态';
    return msg;
}

module.exports = {
    buildTelegramMessage
};
