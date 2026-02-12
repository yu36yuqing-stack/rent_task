function detectConflictsAndBuildSnapshot({ youpinData, uhaozuData, zhwData, blacklistAccounts }) {
    const snapshot = {
        timestamp: Date.now(),
        accounts: []
    };
    const actions = [];

    const allAccounts = new Set([
        ...youpinData.map(i => i.account),
        ...uhaozuData.map(i => i.account),
        ...zhwData.map(i => i.account)
    ]);
    console.log(`[Step] 账号合并完成，总账号数=${allAccounts.size}`);

    for (const acc of allAccounts) {
        const y = youpinData.find(i => i.account === acc);
        const u = uhaozuData.find(i => i.account === acc);
        const z = zhwData.find(i => i.account === acc);

        const statY = y ? y.status : '未找到';
        const statU = u ? u.status : '未找到';
        const statZ = z ? z.status : '未找到';

        const remark = y ? y.remark : (z ? z.roleName : (u ? u.id : acc));

        snapshot.accounts.push({
            account: acc,
            remark,
            youpin: statY,
            uhaozu: statU,
            zuhaowan: statZ,
            uhaozu_debug: u ? u.reason : ''
        });

        // 规则逻辑：
        // 1. 任意一个平台为 "租赁中"，则其他所有 "上架" 的平台必须 "下架"。
        const anyRenting = (statY === '租赁中') || (statU === '租赁中') || (statZ === '租赁中');

        if (anyRenting) {
            if (statY === '上架') actions.push({ type: 'off_y', item: y, reason: `检测到出租(U:${statU}/Z:${statZ})，下架悠悠` });
            if (statU === '上架') actions.push({ type: 'off_u', item: u, reason: `检测到出租(Y:${statY}/Z:${statZ})，下架U号租` });
            if (statZ === '上架') actions.push({ type: 'off_z', item: z, reason: `检测到出租(Y:${statY}/U:${statU})，下架租号王` });
        } else {
            const isInBlacklist = blacklistAccounts.has(String(acc));
            const isSystemOff = (y && y.reason && y.reason.includes('系统')) || isInBlacklist;

            if (isSystemOff) {
                if (isInBlacklist) {
                    console.log(`[Blacklist] 命中黑名单账号: ${acc}`);
                }
                // 如果悠悠或U号租是系统下架，则其他平台也必须下架
                const reasonMsg = (acc === '3045296464')
                    ? '人工指令强制下架(游戏在线)'
                    : ((u && u.reason && u.reason.includes('检测游戏在线')) ? 'U号租检测游戏在线' : '悠悠系统下架');

                if (statY === '上架') actions.push({ type: 'off_y', item: y, reason: `${reasonMsg}，同步下架悠悠` });
                if (statU === '上架') actions.push({ type: 'off_u', item: u, reason: `${reasonMsg}，同步下架U号租` });
                if (statZ === '上架') actions.push({ type: 'off_z', item: z, reason: `${reasonMsg}，同步下架租号王` });
            } else {
                // 正常状态下：无租赁，且无系统惩罚 -> 全部上架
                if (statY === '下架') actions.push({ type: 'on_y', item: { account: acc }, reason: '无租赁，自动补上架悠悠' });
                if (statU === '下架') actions.push({ type: 'on_u', item: { account: acc }, reason: '无租赁，自动补上架U号租' });
                if (statZ === '下架') actions.push({ type: 'on_z', item: { account: acc, gameId: z ? z.gameId : 1104466820 }, reason: '无租赁，自动补上架租号王' });
            }
        }
    }

    return { snapshot, actions };
}

async function executeActions({
    actions,
    runRecord,
    youpinPage,
    uhaozuPage,
    youpinOffShelf,
    youpinOnShelf,
    uhaozuOffShelf,
    uhaozuOnShelf,
    changeZhwStatus
}) {
    console.log(`[Step] 策略计算完成，待执行操作数=${actions.length}`);
    if (actions.length === 0) return;

    console.log('ALERT_NEEDED'); // 触发通知
    console.log(`[Action] 发现 ${actions.length} 个需要处理的操作`);

    for (const action of actions) {
        console.log(`[Execute] ${action.reason} -> ${action.item.account}`);
        try {
            let success = false;

            // U号租
            if (action.type === 'off_u') success = await uhaozuOffShelf(uhaozuPage, action.item.account);
            else if (action.type === 'on_u') success = await uhaozuOnShelf(uhaozuPage, action.item.account);

            // 悠悠租号
            else if (action.type === 'off_y') success = await youpinOffShelf(youpinPage, action.item.account);
            else if (action.type === 'on_y') success = await youpinOnShelf(youpinPage, action.item.account);

            // 租号王 (API)
            else if (action.type === 'off_z') {
                // type=2 下架
                if (action.item.gameId) success = await changeZhwStatus(action.item.account, action.item.gameId, 2);
                else console.error(`[Error] 缺少 gameId，无法下架租号王 ${action.item.account}`);
            } else if (action.type === 'on_z') {
                // type=1 上架
                if (action.item.gameId) success = await changeZhwStatus(action.item.account, action.item.gameId, 1);
                else console.error(`[Error] 缺少 gameId，无法上架租号王 ${action.item.account}`);
            }

            if (success) {
                console.log(`[Result] 成功: ${action.type} -> ${action.item.account}`);
                runRecord.actions.push({ ...action, time: Date.now(), success: true });
            } else {
                console.warn(`[Result] 失败: ${action.type} -> ${action.item.account}`);
                runRecord.errors.push(`操作失败: ${action.reason} -> ${action.item.account}`);
            }
        } catch (err) {
            console.error(`[Error] 操作失败: ${err.message}`);
            runRecord.errors.push(`异常: ${err.message} (${action.item.account})`);
        }
    }
}

module.exports = {
    detectConflictsAndBuildSnapshot,
    executeActions
};
