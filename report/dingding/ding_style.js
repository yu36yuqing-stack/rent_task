function shortState(s) {
    if (!s) return '未';
    return String(s)
        .replace('租赁中', '租')
        .replace('出租中', '租')
        .replace('审核失败', '审')
        .replace('上架', '上')
        .replace('下架', '下');
}

const REPORT_VERSION = 'v1.0.6';

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

function buildDingdingMessage(payload) {
    if (!payload?.ok) {
        return payload?.message || '⚠️ 暂无状态数据 (任务可能未运行)';
    }

    const owner = String(payload?.report_owner || '').trim();
    const title = owner ? `${owner} 租号状态汇报` : '租号状态汇报';

    const lines = [];
    lines.push(`📊 ${title} ${payload.hhmm}`);

    const actions = Array.isArray(payload.recentActions) ? payload.recentActions : [];
    lines.push('🛠️ 近半小时自动操作');
    if (actions.length > 0) {
        actions.slice(-6).forEach((v) => lines.push(v));
    } else {
        lines.push('• 无');
    }
    lines.push('');

    const accounts = Array.isArray(payload.accounts) ? payload.accounts : [];
    const authorizedPlatforms = normalizeAuthorizedPlatforms(payload.authorized_platforms);
    lines.push(`📋 完整账号列表 (${accounts.length}个)`);
    lines.push('');
    accounts.forEach((acc) => {
        const y = shortState(acc.youpin);
        const u = shortState(acc.uhaozu);
        const z = shortState(acc.zuhaowan);
        const icon = pickIcon(acc, authorizedPlatforms);
        const todayCount = Number(acc.today_order_count || 0);
        const onlineTag = String(acc.online_tag || '').trim();
        const onlineBadge = onlineTag ? `(${onlineTag})` : '';
        const tag = acc.suffix ? `${acc.suffix}` : '';
        const hint = String(acc.hint || '');
        lines.push(`${icon}[${todayCount}单]${onlineBadge} ${acc.remark || acc.account} Y${y}/U${u}/Z${z}${tag}${hint}`);
    });

    lines.push('');
    lines.push(payload.allNormal ? '✅ 所有状态正常 (已授权平台一致或无冲突)' : '⚠️ 检测到待修复状态');
    lines.push(`版本: ${REPORT_VERSION}`);
    return lines.join('\n');
}

module.exports = {
    buildDingdingMessage
};
