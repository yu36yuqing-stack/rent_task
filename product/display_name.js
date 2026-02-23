function resolveDisplayNameByRow(row = {}, fallbackAccount = '') {
    const acc = String(fallbackAccount || row.game_account || '').trim();
    const channelPrdInfo = row && typeof row.channel_prd_info === 'object' ? row.channel_prd_info : {};
    const uuzuhao = channelPrdInfo && typeof channelPrdInfo.uuzuhao === 'object' ? channelPrdInfo.uuzuhao : {};
    const uuzuhaoRemark = String((uuzuhao && uuzuhao.remark) || '').trim();
    if (uuzuhaoRemark) return uuzuhaoRemark;
    const roleName = String((row && row.account_remark) || row.role_name || '').trim();
    if (roleName) return roleName;
    return acc;
}

module.exports = {
    resolveDisplayNameByRow
};
