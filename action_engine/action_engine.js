const { listUserPlatformAuth } = require('../database/user_platform_auth_db');
const { buildAuthMap } = require('../user/user');
const { youpinOffShelf, youpinOnShelf } = require('../uuzuhao/uuzuhao_api');
const { uhaozuOffShelf, uhaozuOnShelf } = require('../uhaozu/uhaozu_api');
const { changeStatus: changeZhwStatus } = require('../zuhaowang/zuhaowang_api');
const {
    buildPlatformStatusNorm,
    isOnAllowedByCode
} = require('../product/prod_channel_status');
const { appendProductOnoffHistory } = require('../database/product_onoff_history_db');
const {
    RESTRICT_REASON,
    upsertPlatformRestrict,
    removePlatformRestrict,
    listPlatformRestrictByUserAndAccounts
} = require('../database/user_platform_restrict_db');

function detectConflictsAndBuildSnapshot({
    youpinData,
    uhaozuData,
    zhwData,
    blacklistAccounts,
    platformRestrictSet = new Set(),
    platformStatusNormMap = {}
}) {
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
        const normByAcc = platformStatusNormMap && typeof platformStatusNormMap === 'object'
            ? (platformStatusNormMap[acc] || {})
            : {};
        const canAutoOnY = isOnAllowedByCode(String((normByAcc.uuzuhao && normByAcc.uuzuhao.code) || ''));
        const canAutoOnU = isOnAllowedByCode(String((normByAcc.uhaozu && normByAcc.uhaozu.code) || ''));
        const canAutoOnZ = isOnAllowedByCode(String((normByAcc.zuhaowang && normByAcc.zuhaowang.code) || ''));

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
                if (statY === '下架' && !platformRestrictSet.has(`${acc}::uuzuhao`) && canAutoOnY) {
                    actions.push({ type: 'on_y', item: { account: acc }, reason: '无租赁，自动补上架悠悠' });
                }
                if (statU === '下架' && !platformRestrictSet.has(`${acc}::uhaozu`) && canAutoOnU) {
                    actions.push({ type: 'on_u', item: { account: acc }, reason: '无租赁，自动补上架U号租' });
                }
                if (statZ === '下架' && !platformRestrictSet.has(`${acc}::zuhaowang`) && canAutoOnZ) {
                    actions.push({ type: 'on_z', item: { account: acc, gameId: z ? z.gameId : 1104466820 }, reason: '无租赁，自动补上架租号王' });
                }
            }
        }
    }

    return { snapshot, actions };
}

async function executeActions({
    user,
    actions,
    runRecord,
    youpinPage,
    uhaozuPage,
    youpinOffShelf,
    youpinOnShelf,
    uhaozuOffShelf,
    uhaozuOnShelf,
    changeZhwStatus,
    readOnly = false
}) {
    console.log(`[Step] 策略计算完成，待执行操作数=${actions.length}`);
    if (actions.length === 0) return;

    console.log('ALERT_NEEDED'); // 触发通知
    console.log(`[Action] 发现 ${actions.length} 个需要处理的操作`);
    if (readOnly) {
        console.log('[Action] 当前为只读模式：阻断上下架执行，仅记录动作');
    }

    for (const action of actions) {
        console.log(`[Execute] ${action.reason} -> ${action.item.account}`);
        try {
            if (readOnly) {
                runRecord.actions.push({ ...action, time: Date.now(), success: true, skipped: true, mode: 'read_only' });
                await appendProductOnoffHistory({
                    user_id: user && user.id,
                    user_account: user && user.account,
                    action_type: action.type,
                    game_account: action.item && action.item.account,
                    reason: action.reason,
                    success: true,
                    skipped: true,
                    mode: 'read_only',
                    event_time: Date.now(),
                    desc: 'sync read_only skip'
                });
                console.log(`[Result] 已跳过(只读): ${action.type} -> ${action.item.account}`);
                continue;
            }

            let success = false;
            let detail = { code: 0, msg: '' };
            const platform = action.type.endsWith('_y')
                ? 'uuzuhao'
                : action.type.endsWith('_u')
                ? 'uhaozu'
                : action.type.endsWith('_z')
                ? 'zuhaowang'
                : '';

            // U号租
            if (action.type === 'off_u') success = await uhaozuOffShelf(uhaozuPage, action.item.account);
            else if (action.type === 'on_u') success = await uhaozuOnShelf(uhaozuPage, action.item.account);

            // 悠悠租号
            else if (action.type === 'off_y') success = await youpinOffShelf(youpinPage, action.item.account);
            else if (action.type === 'on_y') {
                const out = await youpinOnShelf(youpinPage, action.item.account, { with_detail: true });
                success = Boolean(out && out.ok);
                detail = out && typeof out === 'object' ? { code: Number(out.code || 0), msg: String(out.msg || '') } : { code: 0, msg: '' };
            }

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
                if (platform && action.type.startsWith('on_')) {
                    await removePlatformRestrict(
                        user && user.id,
                        action.item && action.item.account,
                        platform,
                        'auto clear by on success'
                    ).catch(() => {});
                }
                runRecord.actions.push({ ...action, time: Date.now(), success: true });
                await appendProductOnoffHistory({
                    user_id: user && user.id,
                    user_account: user && user.account,
                    action_type: action.type,
                    game_account: action.item && action.item.account,
                    reason: action.reason,
                    success: true,
                    skipped: false,
                    mode: '',
                    event_time: Date.now(),
                    desc: 'sync action success'
                });
            } else {
                console.warn(`[Result] 失败: ${action.type} -> ${action.item.account}`);
                if (platform === 'uuzuhao' && action.type === 'on_y' && Number(detail.code || 0) === 12101012) {
                    await upsertPlatformRestrict(
                        user && user.id,
                        action.item && action.item.account,
                        'uuzuhao',
                        {
                            platform: 'uuzuhao',
                            code: 12101012,
                            msg: String(detail.msg || '仅卖家下架状态支持直接上架'),
                            event_time: Date.now()
                        },
                        `platform block code=12101012 msg=${String(detail.msg || '')}`
                    ).catch(() => {});
                    await appendProductOnoffHistory({
                        user_id: user && user.id,
                        user_account: user && user.account,
                        action_type: action.type,
                        platform: 'uuzuhao',
                        game_account: action.item && action.item.account,
                        reason: RESTRICT_REASON,
                        success: false,
                        skipped: true,
                        mode: 'platform_restrict',
                        event_time: Date.now(),
                        desc: `code=12101012 msg=${String(detail.msg || '')}`
                    });
                }
                runRecord.errors.push(`操作失败: ${action.reason} -> ${action.item.account}`);
            }
        } catch (err) {
            console.error(`[Error] 操作失败: ${err.message}`);
            runRecord.errors.push(`异常: ${err.message} (${action.item.account})`);
        }
    }
}

function buildPlatformRowsFromUserAccounts(rows = []) {
    const youpinData = [];
    const uhaozuData = [];
    const zhwData = [];

    for (const row of rows) {
        const account = String(row.game_account || '').trim();
        if (!account) continue;
        const status = row && typeof row.channel_status === 'object' ? row.channel_status : {};
        const prd = row && typeof row.channel_prd_info === 'object' ? row.channel_prd_info : {};

        const y = String(status.uuzuhao || '').trim();
        if (y) {
            youpinData.push({
                account,
                status: y,
                remark: String(row.account_remark || account)
            });
        }

        const u = String(status.uhaozu || '').trim();
        if (u) {
            uhaozuData.push({
                account,
                status: u,
                reason: ''
            });
        }

        const z = String(status.zuhaowang || '').trim();
        if (z) {
            zhwData.push({
                account,
                status: z,
                gameId: Number((prd.zuhaowang && (prd.zuhaowang.game_id || prd.zuhaowang.gameId)) || 0)
            });
        }
    }

    return { youpinData, uhaozuData, zhwData };
}

function buildPlatformStatusNormMapByAccount(rows = []) {
    const out = {};
    for (const row of rows) {
        const account = String((row && row.game_account) || '').trim();
        if (!account) continue;
        const channelStatus = row && typeof row.channel_status === 'object' ? row.channel_status : {};
        const channelPrdInfo = row && typeof row.channel_prd_info === 'object' ? row.channel_prd_info : {};
        out[account] = buildPlatformStatusNorm(channelStatus, channelPrdInfo, {});
    }
    return out;
}

async function executeUserActionsIfNeeded({
    user,
    rows,
    blacklistSet = new Set(),
    actionEnabled = true,
    readOnly = false
}) {
    if (!actionEnabled) return { planned: 0, actions: [], errors: [] };
    if (!user || !user.id) throw new Error('user 缺失或不合法');

    const authRows = await listUserPlatformAuth(user.id, { with_payload: true });
    const authMap = buildAuthMap(authRows);
    const { youpinData, uhaozuData, zhwData } = buildPlatformRowsFromUserAccounts(rows);
    const platformStatusNormMap = buildPlatformStatusNormMapByAccount(rows);
    const accounts = [...new Set((rows || []).map((r) => String((r && r.game_account) || '').trim()).filter(Boolean))];
    const restrictRows = await listPlatformRestrictByUserAndAccounts(user.id, accounts);
    const platformRestrictSet = new Set(
        restrictRows.map((r) => `${String(r.game_account || '').trim()}::${String(r.platform || '').trim()}`).filter(Boolean)
    );

    // 平台状态已恢复（上架/租赁中）时，自动清理限制标记，避免“平台限制上架”残留卡住。
    for (const row of rows || []) {
        const acc = String((row && row.game_account) || '').trim();
        const st = row && typeof row.channel_status === 'object' ? row.channel_status : {};
        if (!acc) continue;
        const y = String(st.uuzuhao || '').trim();
        const u = String(st.uhaozu || '').trim();
        const z = String(st.zuhaowang || '').trim();
        if (['上架', '租赁中', '出租中'].includes(y) && platformRestrictSet.has(`${acc}::uuzuhao`)) {
            await removePlatformRestrict(user.id, acc, 'uuzuhao', `auto clear by status=${y}`).catch(() => {});
            platformRestrictSet.delete(`${acc}::uuzuhao`);
        }
        if (['上架', '租赁中', '出租中'].includes(u) && platformRestrictSet.has(`${acc}::uhaozu`)) {
            await removePlatformRestrict(user.id, acc, 'uhaozu', `auto clear by status=${u}`).catch(() => {});
            platformRestrictSet.delete(`${acc}::uhaozu`);
        }
        if (['上架', '租赁中', '出租中'].includes(z) && platformRestrictSet.has(`${acc}::zuhaowang`)) {
            await removePlatformRestrict(user.id, acc, 'zuhaowang', `auto clear by status=${z}`).catch(() => {});
            platformRestrictSet.delete(`${acc}::zuhaowang`);
        }
    }
    const { actions } = detectConflictsAndBuildSnapshot({
        youpinData,
        uhaozuData,
        zhwData,
        blacklistAccounts: blacklistSet,
        platformRestrictSet,
        platformStatusNormMap
    });

    const requiredPlatforms = new Set();
    for (const action of actions) {
        const type = String(action && action.type || '');
        if (type.endsWith('_y')) requiredPlatforms.add('uuzuhao');
        else if (type.endsWith('_u')) requiredPlatforms.add('uhaozu');
        else if (type.endsWith('_z')) requiredPlatforms.add('zuhaowang');
    }
    for (const platform of requiredPlatforms) {
        const auth = authMap[platform];
        if (!auth || typeof auth !== 'object') {
            throw new Error(`${platform} 授权缺失，已阻断执行，避免混用非用户凭据`);
        }
    }

    const runRecord = { actions: [], errors: [] };
    await executeActions({
        user,
        actions,
        runRecord,
        youpinPage: null,
        uhaozuPage: null,
        youpinOffShelf: (_page, account) => {
            const auth = authMap.uuzuhao;
            if (!auth) return false;
            return youpinOffShelf(null, account, { auth });
        },
        youpinOnShelf: (_page, account) => {
            const auth = authMap.uuzuhao;
            if (!auth) return false;
            return youpinOnShelf(null, account, { auth, with_detail: true });
        },
        uhaozuOffShelf: (_page, account) => {
            const auth = authMap.uhaozu;
            if (!auth) return false;
            return uhaozuOffShelf(null, account, { auth });
        },
        uhaozuOnShelf: (_page, account) => {
            const auth = authMap.uhaozu;
            if (!auth) return false;
            return uhaozuOnShelf(null, account, { auth });
        },
        changeZhwStatus: (account, gameId, type) => {
            const auth = authMap.zuhaowang;
            if (!auth) return false;
            return changeZhwStatus(account, gameId, type, auth);
        },
        readOnly
    });

    return {
        planned: actions.length,
        actions: Array.isArray(runRecord.actions) ? runRecord.actions : [],
        errors: Array.isArray(runRecord.errors) ? runRecord.errors : []
    };
}

module.exports = {
    detectConflictsAndBuildSnapshot,
    executeActions,
    buildPlatformRowsFromUserAccounts,
    executeUserActionsIfNeeded
};
