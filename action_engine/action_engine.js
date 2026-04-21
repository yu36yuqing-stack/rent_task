const { listUserPlatformAuth } = require('../database/user_platform_auth_db');
const { buildAuthMap } = require('../user/user');
const { youpinOffShelf, youpinOnShelf } = require('../uuzuhao/uuzuhao_api');
const { uhaozuOffShelf, uhaozuOnShelf, uhaozuReshelfByModify } = require('../uhaozu/uhaozu_api');
const { changeStatus: changeZhwStatus } = require('../zuhaowang/zuhaowang_api');
const {
    buildPlatformStatusNorm,
    isOnAllowedByCode,
    isUhaozuOnlineDetectReason
} = require('../product/prod_channel_status');
const { appendProductOnoffHistory } = require('../database/product_onoff_history_db');
const {
    RESTRICT_REASON,
    upsertPlatformRestrict,
    removePlatformRestrict,
    listPlatformRestrictByUserAndAccounts
} = require('../database/user_platform_restrict_db');

function accountKeyOf(gameId, account) {
    return `${String(gameId || '1').trim() || '1'}::${String(account || '').trim()}`;
}

function sleep(ms) {
    return new Promise((resolve) => setTimeout(resolve, Math.max(0, Number(ms) || 0)));
}

function isActiveShelfStatus(status) {
    const s = String(status || '').trim();
    return s === '上架' || s === '租赁中' || s === '出租中';
}

function isUhaozuOnlineDetectSoftBlock(norm = {}) {
    const code = String((norm && norm.code) || '').trim();
    const reason = String((norm && norm.reason) || '').trim();
    if (code !== 'auth_abnormal') return false;
    return isUhaozuOnlineDetectReason(reason);
}

function platformFromActionType(type = '') {
    const text = String(type || '').trim();
    if (text === 'off_y' || text === 'on_y') return 'uuzuhao';
    if (text === 'off_u' || text === 'on_u' || text === 'on_u_modify') return 'uhaozu';
    if (text === 'off_z' || text === 'on_z') return 'zuhaowang';
    return '';
}

function shouldUseUhaozuModifyReshelf({ statY, statZ, ignoreUhaozuOnlineDetect }) {
    if (!ignoreUhaozuOnlineDetect) return false;
    const peerStatuses = [statY, statZ].filter((status) => String(status || '').trim() !== '未找到');
    if (peerStatuses.length === 0) return false;
    return peerStatuses.every((status) => isActiveShelfStatus(status));
}

async function clearPlatformRestrictReliable({
    userId,
    account,
    gameId = '1',
    gameName = 'WZRY',
    platform,
    desc,
    logger = console,
    runErrors = null,
    maxRetries = 3,
    baseDelayMs = 60
}) {
    const uid = Number(userId || 0);
    const acc = String(account || '').trim();
    const gid = String(gameId || '1').trim() || '1';
    const pf = String(platform || '').trim();
    if (!uid || !acc || !pf) {
        const msg = `[RestrictClear] invalid_args user_id=${uid} game_id=${gid} account=${acc} platform=${pf}`;
        logger.error(msg);
        if (Array.isArray(runErrors)) runErrors.push(msg);
        return { ok: false, attempts: 0, last_error: 'invalid_args' };
    }

    const retryCount = Math.max(1, Number(maxRetries) || 1);
    let lastErr = '';
    let stillActive = true;
    for (let attempt = 1; attempt <= retryCount; attempt += 1) {
        try {
            const restrictKey = { game_account: acc, game_id: gid, game_name: gameName };
            await removePlatformRestrict(uid, restrictKey, pf, `${String(desc || '').trim()}#attempt=${attempt}`);
            const remains = await listPlatformRestrictByUserAndAccounts(uid, [restrictKey]);
            stillActive = remains.some((r) => String(r.game_account || '').trim() === acc && String(r.game_id || '').trim() === gid && String(r.platform || '').trim() === pf);
            if (!stillActive) {
                if (attempt > 1) {
                    logger.warn(`[RestrictClear] recovered user_id=${uid} game_id=${gid} account=${acc} platform=${pf} attempts=${attempt}`);
                }
                return { ok: true, attempts: attempt, last_error: '' };
            }
            lastErr = 'still_active_after_remove';
            logger.warn(`[RestrictClear] verify_still_active user_id=${uid} game_id=${gid} account=${acc} platform=${pf} attempt=${attempt}`);
        } catch (e) {
            const msg = String(e && e.message ? e.message : e || 'clear_failed');
            lastErr = msg;
            logger.warn(`[RestrictClear] clear_error user_id=${uid} game_id=${gid} account=${acc} platform=${pf} attempt=${attempt} err=${msg}`);
        }
        if (attempt < retryCount) {
            await sleep(baseDelayMs * Math.pow(2, attempt - 1));
        }
    }

    const failMsg = `[RestrictClear] failed user_id=${uid} game_id=${gid} account=${acc} platform=${pf} last_error=${lastErr || 'unknown'}`;
    logger.error(failMsg);
    if (Array.isArray(runErrors)) runErrors.push(failMsg);
    return { ok: false, attempts: retryCount, last_error: lastErr || 'unknown', still_active: stillActive };
}

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

    const identityMap = new Map();
    const upsertByIdentity = (item = {}, platform) => {
        const acc = String(item.account || '').trim();
        const gid = String(item.game_id || '1').trim() || '1';
        if (!acc) return;
        const key = accountKeyOf(gid, acc);
        const cur = identityMap.get(key) || {
            key,
            account: acc,
            game_id: gid,
            game_name: String(item.game_name || 'WZRY').trim() || 'WZRY',
            youpin: null,
            uhaozu: null,
            zhw: null
        };
        if (platform === 'uuzuhao') cur.youpin = item;
        else if (platform === 'uhaozu') cur.uhaozu = item;
        else if (platform === 'zuhaowang') cur.zhw = item;
        identityMap.set(key, cur);
    };
    for (const item of youpinData) upsertByIdentity(item, 'uuzuhao');
    for (const item of uhaozuData) upsertByIdentity(item, 'uhaozu');
    for (const item of zhwData) upsertByIdentity(item, 'zuhaowang');

    console.log(`[Step] 账号合并完成，总账号数=${identityMap.size}`);

    for (const one of identityMap.values()) {
        const acc = String(one.account || '').trim();
        const identityKey = String(one.key || accountKeyOf(one.game_id, acc));
        const y = one.youpin;
        const u = one.uhaozu;
        const z = one.zhw;

        const statY = y ? y.status : '未找到';
        const statU = u ? u.status : '未找到';
        const statZ = z ? z.status : '未找到';

        const remark = y ? y.remark : (z ? z.roleName : (u ? u.id : acc));

        snapshot.accounts.push({
            game_id: String(one.game_id || '1').trim() || '1',
            game_name: String(one.game_name || 'WZRY').trim() || 'WZRY',
            account: acc,
            remark,
            youpin: statY,
            uhaozu: statU,
            zuhaowan: statZ,
            uhaozu_debug: u ? u.reason : ''
        });

        const isInBlacklist = blacklistAccounts.has(identityKey);
        if (isInBlacklist) {
            console.log(`[Blacklist] 命中黑名单账号: ${identityKey}`);
            if (y && isActiveShelfStatus(statY)) {
                actions.push({ type: 'off_y', item: y, reason: '黑名单命中，强制下架悠悠' });
            }
            if (u && isActiveShelfStatus(statU)) {
                actions.push({ type: 'off_u', item: u, reason: '黑名单命中，强制下架U号租' });
            }
            if (z && isActiveShelfStatus(statZ)) {
                actions.push({ type: 'off_z', item: z, reason: '黑名单命中，强制下架租号王' });
            }
            continue;
        }

        // 规则逻辑：
        // 1. 任意一个平台为 "租赁中"，则其他所有 "上架" 的平台必须 "下架"。
        const anyRenting = (statY === '租赁中') || (statU === '租赁中') || (statZ === '租赁中');
        const normByAcc = platformStatusNormMap && typeof platformStatusNormMap === 'object'
            ? (platformStatusNormMap[identityKey] || {})
            : {};
        const uNorm = normByAcc.uhaozu && typeof normByAcc.uhaozu === 'object' ? normByAcc.uhaozu : {};
        const ignoreUhaozuOnlineDetect = isUhaozuOnlineDetectSoftBlock(uNorm);
        const canAutoOnY = isOnAllowedByCode(String((normByAcc.uuzuhao && normByAcc.uuzuhao.code) || ''));
        const canAutoOnU = isOnAllowedByCode(String((uNorm && uNorm.code) || '')) || ignoreUhaozuOnlineDetect;
        const canAutoOnZ = isOnAllowedByCode(String((normByAcc.zuhaowang && normByAcc.zuhaowang.code) || ''));

        if (anyRenting) {
            if (statY === '上架') actions.push({ type: 'off_y', item: y, reason: `检测到出租(U:${statU}/Z:${statZ})，下架悠悠` });
            if (statU === '上架') actions.push({ type: 'off_u', item: u, reason: `检测到出租(Y:${statY}/Z:${statZ})，下架U号租` });
            if (statZ === '上架') actions.push({ type: 'off_z', item: z, reason: `检测到出租(Y:${statY}/U:${statU})，下架租号王` });
        } else {
            const isSystemOff = Boolean(y && y.reason && y.reason.includes('系统'));

            if (isSystemOff) {
                // 如果悠悠或U号租是系统下架，则其他平台也必须下架
                const reasonMsg = (acc === '3045296464')
                    ? '人工指令强制下架(游戏在线)'
                    : ((u && u.reason && u.reason.includes('检测游戏在线')) ? 'U号租检测游戏在线' : '悠悠系统下架');

                if (statY === '上架') actions.push({ type: 'off_y', item: y, reason: `${reasonMsg}，同步下架悠悠` });
                if (statU === '上架') actions.push({ type: 'off_u', item: u, reason: `${reasonMsg}，同步下架U号租` });
                if (statZ === '上架') actions.push({ type: 'off_z', item: z, reason: `${reasonMsg}，同步下架租号王` });
            } else {
                // 正常状态下：无租赁，且无系统惩罚 -> 全部上架
                if (statY === '下架' && !platformRestrictSet.has(`${identityKey}::uuzuhao`) && canAutoOnY) {
                    actions.push({
                        type: 'on_y',
                        item: { account: acc, game_id: one.game_id, game_name: one.game_name },
                        reason: '无租赁，自动补上架悠悠'
                    });
                }
                if (u && !isActiveShelfStatus(statU) && !platformRestrictSet.has(`${identityKey}::uhaozu`) && canAutoOnU) {
                    const useModifyReshelf = shouldUseUhaozuModifyReshelf({
                        statY,
                        statZ,
                        ignoreUhaozuOnlineDetect
                    });
                    actions.push({
                        type: useModifyReshelf ? 'on_u_modify' : 'on_u',
                        item: {
                            account: acc,
                            game_id: one.game_id,
                            game_name: one.game_name,
                            goods_id: u.prd_id || '',
                            prd_id: u.prd_id || '',
                            platform_game_id: u.platform_game_id || ''
                        },
                        reason: useModifyReshelf
                            ? '无租赁，其他平台已上架，U号租检测在线时改用改价接口原价补上架'
                            : ignoreUhaozuOnlineDetect
                            ? '无租赁，忽略U号租检测在线并自动补上架'
                            : '无租赁，自动补上架U号租'
                    });
                }
                if (statZ === '下架' && !platformRestrictSet.has(`${identityKey}::zuhaowang`) && canAutoOnZ) {
                    actions.push({
                        type: 'on_z',
                        item: {
                            account: acc,
                            game_id: one.game_id,
                            game_name: one.game_name,
                            gameId: z ? z.gameId : 1104466820,
                            dataId: z ? z.dataId : ''
                        },
                        reason: '无租赁，自动补上架租号王'
                    });
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
    uhaozuReshelfByModify,
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
                    game_id: action.item && action.item.game_id,
                    game_name: action.item && action.item.game_name,
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
            const platform = platformFromActionType(action.type);

            // U号租
            if (action.type === 'off_u') success = await uhaozuOffShelf(uhaozuPage, action.item.account, action.item);
            else if (action.type === 'on_u') success = await uhaozuOnShelf(uhaozuPage, action.item.account, action.item);
            else if (action.type === 'on_u_modify') success = await uhaozuReshelfByModify(uhaozuPage, action.item.account, action.item);

            // 悠悠租号
            else if (action.type === 'off_y') success = await youpinOffShelf(youpinPage, action.item.account, action.item);
            else if (action.type === 'on_y') {
                const out = await youpinOnShelf(youpinPage, action.item.account, {
                    ...action.item,
                    with_detail: true
                });
                success = Boolean(out && out.ok);
                detail = out && typeof out === 'object' ? { code: Number(out.code || 0), msg: String(out.msg || '') } : { code: 0, msg: '' };
            }

            // 租号王 (API)
            else if (action.type === 'off_z') {
                // type=2 下架
                if (action.item.gameId) success = await changeZhwStatus(action.item.account, action.item.gameId, 2, action.item.dataId);
                else console.error(`[Error] 缺少 gameId，无法下架租号王 ${action.item.account}`);
            } else if (action.type === 'on_z') {
                // type=1 上架
                if (action.item.gameId) success = await changeZhwStatus(action.item.account, action.item.gameId, 1, action.item.dataId);
                else console.error(`[Error] 缺少 gameId，无法上架租号王 ${action.item.account}`);
            }

            if (success) {
                console.log(`[Result] 成功: ${action.type} -> ${action.item.account}`);
                if (platform && action.type.startsWith('on_')) {
                    await clearPlatformRestrictReliable({
                        userId: user && user.id,
                        account: action.item && action.item.account,
                        gameId: action.item && action.item.game_id,
                        gameName: action.item && action.item.game_name,
                        platform,
                        desc: 'auto clear by on success',
                        logger: console,
                        runErrors: runRecord && Array.isArray(runRecord.errors) ? runRecord.errors : null
                    });
                }
                runRecord.actions.push({ ...action, time: Date.now(), success: true });
                await appendProductOnoffHistory({
                    user_id: user && user.id,
                    user_account: user && user.account,
                    action_type: action.type,
                    game_account: action.item && action.item.account,
                    game_id: action.item && action.item.game_id,
                    game_name: action.item && action.item.game_name,
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
                        {
                            game_account: action.item && action.item.account,
                            game_id: action.item && action.item.game_id,
                            game_name: action.item && action.item.game_name
                        },
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
                        game_id: action.item && action.item.game_id,
                        game_name: action.item && action.item.game_name,
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
            const youpinPrd = prd && typeof prd.uuzuhao === 'object' ? prd.uuzuhao : {};
            youpinData.push({
                account,
                game_id: String((row && row.game_id) || '1').trim() || '1',
                game_name: String((row && row.game_name) || 'WZRY').trim() || 'WZRY',
                status: y,
                remark: String(row.account_remark || account),
                prd_id: String(youpinPrd.prd_id || youpinPrd.id || '').trim(),
                platform_game_id: String(youpinPrd.game_id || youpinPrd.gameId || '').trim()
            });
        }

        const u = String(status.uhaozu || '').trim();
        if (u) {
            const uhaozuPrd = prd && typeof prd.uhaozu === 'object' ? prd.uhaozu : {};
            uhaozuData.push({
                account,
                game_id: String((row && row.game_id) || '1').trim() || '1',
                game_name: String((row && row.game_name) || 'WZRY').trim() || 'WZRY',
                status: u,
                reason: '',
                prd_id: String(uhaozuPrd.prd_id || uhaozuPrd.id || '').trim(),
                platform_game_id: String(uhaozuPrd.game_id || uhaozuPrd.gameId || '').trim()
            });
        }

        const z = String(status.zuhaowang || '').trim();
        if (z) {
            zhwData.push({
                account,
                game_id: String((row && row.game_id) || '1').trim() || '1',
                game_name: String((row && row.game_name) || 'WZRY').trim() || 'WZRY',
                status: z,
                gameId: Number((prd.zuhaowang && (prd.zuhaowang.game_id || prd.zuhaowang.gameId)) || 0),
                dataId: String((prd.zuhaowang && (prd.zuhaowang.prd_id || prd.zuhaowang.id)) || '').trim()
            });
        }
    }

    return { youpinData, uhaozuData, zhwData };
}

function buildPlatformStatusNormMapByAccount(rows = []) {
    const out = {};
    for (const row of rows) {
        const account = String((row && row.game_account) || '').trim();
        const gameId = String((row && row.game_id) || '1').trim() || '1';
        if (!account) continue;
        const channelStatus = row && typeof row.channel_status === 'object' ? row.channel_status : {};
        const channelPrdInfo = row && typeof row.channel_prd_info === 'object' ? row.channel_prd_info : {};
        out[accountKeyOf(gameId, account)] = buildPlatformStatusNorm(channelStatus, channelPrdInfo, {});
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

    const authRows = (await listUserPlatformAuth(user.id, { with_payload: true }))
        .filter((row) => row.channel_enabled !== false);
    const authMap = buildAuthMap(authRows);
    const { youpinData, uhaozuData, zhwData } = buildPlatformRowsFromUserAccounts(rows);
    const platformStatusNormMap = buildPlatformStatusNormMapByAccount(rows);
    const accounts = Array.from(new Map((rows || [])
        .map((r) => {
            const acc = String((r && r.game_account) || '').trim();
            const gid = String((r && r.game_id) || '1').trim() || '1';
            const gname = String((r && r.game_name) || 'WZRY').trim() || 'WZRY';
            return [`${gid}::${acc}`, { game_account: acc, game_id: gid, game_name: gname }];
        })
        .filter(([key, x]) => Boolean(x.game_account) && !key.endsWith('::'))).values());
    const restrictRows = await listPlatformRestrictByUserAndAccounts(user.id, accounts);
    const platformRestrictSet = new Set(
        restrictRows
            .map((r) => `${String(r.game_id || '1').trim() || '1'}::${String(r.game_account || '').trim()}::${String(r.platform || '').trim()}`)
            .filter(Boolean)
    );
    const preCleanupErrors = [];
    const cleanupStats = { attempted: 0, cleared: 0, failed: 0 };

    // 平台状态已恢复（上架/租赁中）时，自动清理限制标记，避免“平台限制上架”残留卡住。
    for (const row of rows || []) {
        const acc = String((row && row.game_account) || '').trim();
        const gid = String((row && row.game_id) || '1').trim() || '1';
        const gname = String((row && row.game_name) || 'WZRY').trim() || 'WZRY';
        const st = row && typeof row.channel_status === 'object' ? row.channel_status : {};
        if (!acc) continue;
        const y = String(st.uuzuhao || '').trim();
        const u = String(st.uhaozu || '').trim();
        const z = String(st.zuhaowang || '').trim();
        if (['上架', '租赁中', '出租中'].includes(y) && platformRestrictSet.has(`${gid}::${acc}::uuzuhao`)) {
            cleanupStats.attempted += 1;
            const out = await clearPlatformRestrictReliable({
                userId: user.id,
                account: acc,
                gameId: gid,
                gameName: gname,
                platform: 'uuzuhao',
                desc: `auto clear by status=${y}`,
                logger: console,
                runErrors: preCleanupErrors
            });
            if (out.ok) {
                cleanupStats.cleared += 1;
                platformRestrictSet.delete(`${gid}::${acc}::uuzuhao`);
            } else {
                cleanupStats.failed += 1;
            }
        }
        if (['上架', '租赁中', '出租中'].includes(u) && platformRestrictSet.has(`${gid}::${acc}::uhaozu`)) {
            cleanupStats.attempted += 1;
            const out = await clearPlatformRestrictReliable({
                userId: user.id,
                account: acc,
                gameId: gid,
                gameName: gname,
                platform: 'uhaozu',
                desc: `auto clear by status=${u}`,
                logger: console,
                runErrors: preCleanupErrors
            });
            if (out.ok) {
                cleanupStats.cleared += 1;
                platformRestrictSet.delete(`${gid}::${acc}::uhaozu`);
            } else {
                cleanupStats.failed += 1;
            }
        }
        if (['上架', '租赁中', '出租中'].includes(z) && platformRestrictSet.has(`${gid}::${acc}::zuhaowang`)) {
            cleanupStats.attempted += 1;
            const out = await clearPlatformRestrictReliable({
                userId: user.id,
                account: acc,
                gameId: gid,
                gameName: gname,
                platform: 'zuhaowang',
                desc: `auto clear by status=${z}`,
                logger: console,
                runErrors: preCleanupErrors
            });
            if (out.ok) {
                cleanupStats.cleared += 1;
                platformRestrictSet.delete(`${gid}::${acc}::zuhaowang`);
            } else {
                cleanupStats.failed += 1;
            }
        }
    }
    if (cleanupStats.attempted > 0) {
        console.log(`[RestrictClear] precheck user_id=${user.id} attempted=${cleanupStats.attempted} cleared=${cleanupStats.cleared} failed=${cleanupStats.failed}`);
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
        const platform = platformFromActionType(type);
        if (platform) requiredPlatforms.add(platform);
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
        youpinOffShelf: (_page, account, item = {}) => {
            const auth = authMap.uuzuhao;
            if (!auth) return false;
            return youpinOffShelf(null, account, { auth, ...item });
        },
        youpinOnShelf: (_page, account, item = {}) => {
            const auth = authMap.uuzuhao;
            if (!auth) return false;
            return youpinOnShelf(null, account, { auth, ...item, with_detail: true });
        },
        uhaozuOffShelf: (_page, account, item = {}) => {
            const auth = authMap.uhaozu;
            if (!auth) return false;
            return uhaozuOffShelf(null, account, { auth, ...item });
        },
        uhaozuOnShelf: (_page, account, item = {}) => {
            const auth = authMap.uhaozu;
            if (!auth) return false;
            return uhaozuOnShelf(null, account, { auth, ...item });
        },
        uhaozuReshelfByModify: (_page, account, item = {}) => {
            const auth = authMap.uhaozu;
            if (!auth) return false;
            return uhaozuReshelfByModify(null, account, { auth, ...item });
        },
        changeZhwStatus: (account, gameId, type, dataId) => {
            const auth = authMap.zuhaowang;
            if (!auth) return false;
            return changeZhwStatus(account, gameId, type, auth, { data_id: dataId, user_id: user && user.id });
        },
        readOnly
    });

    return {
        planned: actions.length,
        actions: Array.isArray(runRecord.actions) ? runRecord.actions : [],
        errors: [
            ...(Array.isArray(preCleanupErrors) ? preCleanupErrors : []),
            ...(Array.isArray(runRecord.errors) ? runRecord.errors : [])
        ]
    };
}

module.exports = {
    detectConflictsAndBuildSnapshot,
    executeActions,
    buildPlatformRowsFromUserAccounts,
    executeUserActionsIfNeeded
};
