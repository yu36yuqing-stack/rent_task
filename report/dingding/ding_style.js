function shortState(s) {
    if (!s) return '未';
    return String(s)
        .replace('租赁中', '租')
        .replace('出租中', '租')
        .replace('审核失败', '审')
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

function buildDingdingMessage(payload) {
    if (!payload?.ok) {
        return payload?.message || '⚠️ 暂无状态数据 (任务可能未运行)';
    }

    const lines = [];
    lines.push(`📊 租号状态汇报 ${payload.hhmm}`);

    const actions = Array.isArray(payload.recentActions) ? payload.recentActions : [];
    lines.push('🛠️ 近1小时自动操作');
    if (actions.length > 0) {
        actions.slice(-6).forEach((v) => lines.push(v));
    } else {
        lines.push('• 无');
    }
    lines.push('');

    const accounts = Array.isArray(payload.accounts) ? payload.accounts : [];
    lines.push(`📋 完整账号列表 (${accounts.length}个)`);
    lines.push('');
    accounts.forEach((acc) => {
        const y = shortState(acc.youpin);
        const u = shortState(acc.uhaozu);
        const z = shortState(acc.zuhaowan);
        const icon = pickIcon(acc);
        const tag = acc.suffix ? ` ${acc.suffix.replace(/[()]/g, '')}` : '';
        const hint = String(acc.hint || '');
        lines.push(`${icon} ${acc.remark || acc.account} Y${y}/U${u}/Z${z}${tag}${hint}`);
    });

    lines.push('');
    lines.push(payload.allNormal ? '✅ 所有状态正常 (三方一致或无冲突)' : '⚠️ 检测到待修复状态');
    return lines.join('\n');
}

module.exports = {
    buildDingdingMessage
};
