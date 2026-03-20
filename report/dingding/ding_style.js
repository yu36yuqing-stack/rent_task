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

function nowDateTimeText() {
    const d = new Date();
    const p = (n) => String(n).padStart(2, '0');
    return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
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

    const syncAnomalies = Array.isArray(payload.sync_anomalies) ? payload.sync_anomalies : [];
    const accounts = Array.isArray(payload.accounts) ? payload.accounts : [];
    const totalPaid = accounts.reduce((sum, acc) => sum + Number(acc && acc.today_order_count || 0), 0);
    lines.push(`📈 今日订单: ${totalPaid}`);
    lines.push(`📦 商品主档总数: ${Number(payload.master_total || 0)}个`);
    lines.push('⚠️ 同步异常');
    if (syncAnomalies.length > 0) {
        syncAnomalies.slice(0, 4).forEach((row) => {
            const platform = String(row.platform || '').trim();
            const platformName = platform === 'uuzuhao' ? '悠悠'
                : platform === 'uhaozu' ? 'U号租'
                : platform === 'zuhaowang' ? '租号王'
                : platform || '未知平台';
            const sample = String(row.sample_missing_text || '').trim();
            lines.push(`• ${platformName}: 期望${Number(row.expected_count || 0)} / 拉回${Number(row.pulled_count || 0)} / 少回${Number(row.missing_count || 0)}${sample ? ` (${sample})` : ''}`);
        });
    } else {
        lines.push('• 无');
    }
    lines.push('');
    const authorizedPlatforms = normalizeAuthorizedPlatforms(payload.authorized_platforms);
    lines.push(`📋 商品主档明细 (${Number(payload.master_total || accounts.length || 0)}个)`);
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

function buildComplaintFirstHitText(payload = {}) {
    const userName = String(payload.user_name || payload.user_account || '').trim();
    const userText = userName ? `${String(payload.user_id || '')}(${userName})` : String(payload.user_id || '');
    const orderNo = String(payload.order_no || '').trim();
    const channel = String(payload.channel || '').trim();
    const gameAccount = String(payload.game_account || '').trim();
    const roleName = String(payload.role_name || '').trim();
    const complaintStatus = Number(payload.complaint_status || 0);
    const complaintId = String(payload.complaint_id || '').trim();
    const complaintTypeDesc = String(payload.complaint_type_desc || '').trim();
    const complaintContext = String(payload.complaint_context || '').trim();
    const complaintStart = String(payload.complaint_start_time || '').trim();
    const lines = [
        '⚠️ 新增投诉',
        `时间: ${nowDateTimeText()}`,
        `用户: ${userText || '-'}`,
        `渠道: ${channel || '-'}`,
        `订单号: ${orderNo || '-'}`,
        `账号: ${gameAccount || '-'}${roleName ? ` (${roleName})` : ''}`,
        `投诉状态: ${complaintStatus || '-'}`,
        `投诉ID: ${complaintId || '-'}`,
        `投诉类型: ${complaintTypeDesc || '-'}`,
        `投诉时间: ${complaintStart || '-'}`
    ];
    if (complaintContext) lines.push(`投诉内容: ${complaintContext.slice(0, 80)}${complaintContext.length > 80 ? '...' : ''}`);
    return lines.join('\n');
}

function buildBlacklistInspectorMismatchText(payload = {}) {
    const userId = Number(payload.user_id || 0);
    const userName = String(payload.user_name || payload.user_account || '').trim();
    const mode = String(payload.mode || '').trim();
    const mismatch = Array.isArray(payload.mismatch) ? payload.mismatch : [];
    const checkedAt = String(payload.checked_at || nowDateTimeText()).trim();
    const legacyTotal = Number(payload.legacy_total || 0);
    const projectedTotal = Number(payload.projected_total || 0);

    const lines = [];
    lines.push('⚠️ 黑名单巡检发现差异');
    lines.push(`时间: ${checkedAt}`);
    lines.push(`用户: ${userId || '-'}${userName ? `(${userName})` : ''}`);
    lines.push(`模式: ${mode || '-'}`);
    lines.push(`旧黑名单数: ${legacyTotal} / 新推理数: ${projectedTotal}`);
    lines.push(`差异账号数: ${mismatch.length}`);
    lines.push('');

    for (const row of mismatch.slice(0, 15)) {
        const acc = String((row && row.game_account) || '').trim() || '-';
        const oldR = String((row && row.legacy_reason) || '').trim() || '无';
        const newR = String((row && row.projected_reason) || '').trim() || '无';
        const src = String((row && row.projected_source) || '').trim();
        lines.push(`• ${acc}: 旧=${oldR} / 新=${newR}${src ? ` (${src})` : ''}`);
    }
    if (mismatch.length > 15) lines.push(`• ... 其余 ${mismatch.length - 15} 条已省略`);
    return lines.join('\n');
}

function buildBlacklistInspectorSummaryText(payload = {}) {
    const checkedAt = String(payload.checked_at || nowDateTimeText()).trim();
    const mode = String(payload.mode || '').trim();
    const usersChecked = Number(payload.users_checked || 0);
    const usersMismatch = Number(payload.users_mismatch || 0);
    const accountsMismatch = Number(payload.accounts_mismatch || 0);
    const durationMs = Number(payload.duration_ms || 0);
    return `[BlacklistInspector] checked_at=${checkedAt} mode=${mode || '-'} users_checked=${usersChecked} users_mismatch=${usersMismatch} accounts_mismatch=${accountsMismatch} duration_ms=${durationMs}`;
}

module.exports = {
    buildDingdingMessage,
    buildComplaintFirstHitText,
    buildBlacklistInspectorMismatchText,
    buildBlacklistInspectorSummaryText
};
