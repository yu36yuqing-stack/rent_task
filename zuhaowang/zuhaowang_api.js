// 租号王 API 模块 (zuhaowan_api.js)
const { exec } = require('child_process');
const { buildEncryptedBody } = require('./toEncryptBody');

const DEFAULT_SOURCE = 'android';

function nowMs() {
    return Date.now();
}

function shortTraceId(prefix = 'zhw') {
    return `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

function resolveLogMeta(auth = {}, options = {}) {
    const userId = Number(
        options.user_id
        || options.userId
        || auth.user_id
        || 0
    ) || 0;
    const traceId = String(options.trace_id || options.traceId || '').trim() || shortTraceId('zhw');
    return { userId, traceId };
}

function buildStatusCount(list = []) {
    const out = {};
    for (const row of list || []) {
        const k = String((row && row.status) || '未知');
        out[k] = Number(out[k] || 0) + 1;
    }
    return out;
}

function resolveAuth(auth = {}) {
    const tokenYuanbao = String(auth.token_yuanbao || auth.token || '').trim();
    const tokenGet = String(auth.token_get || '').trim() || tokenYuanbao;
    const tokenPost = String(auth.token_post || '').trim() || tokenYuanbao;
    const cfg = {
        token_get: tokenGet,
        token_post: tokenPost,
        token_yuanbao: tokenYuanbao,
        device_id: String(auth.device_id || '').trim(),
        package_name: String(auth.package_name || '').trim(),
        source: String(auth.source || DEFAULT_SOURCE).trim() || DEFAULT_SOURCE,
        app_version: String(auth.app_version || auth.x_versioncode || '').trim(),
        main_version: String(auth.main_version || auth.x_versioncode || '').trim(),
        x_versioncode: String(auth.x_versioncode || '').trim(),
        x_versionnumber: String(auth.x_versionnumber || '').trim(),
        x_channel: String(auth.x_channel || '').trim(),
        user_agent: String(auth.user_agent || '').trim(),
        content_type: String(auth.content_type || '').trim(),
        rsa_public_key: String(auth.rsa_public_key || '').trim()
    };
    if (!cfg.token_get && !cfg.token_post && !cfg.token_yuanbao) throw new Error('zuhaowang token 未配置');
    if (!cfg.device_id) throw new Error('zuhaowang device_id 未配置');
    if (!cfg.package_name) throw new Error('zuhaowang package_name 未配置');
    return cfg;
}

// Curl 封装
function curlRequest(url, method, data = null, token, auth = {}) {
    const cfg = resolveAuth(auth);
    return new Promise((resolve, reject) => {
        let cmd = `curl -s -X ${method} '${url}'`;
        // Headers
        cmd += ` -H 'token: ${token}'`;
        cmd += ` -H 'deviceid: ${cfg.device_id}'`;
        cmd += ` -H 'packagename: ${cfg.package_name}'`;
        cmd += ` -H 'source: ${cfg.source}'`;
        if (cfg.app_version) cmd += ` -H 'appversion: ${cfg.app_version}'`;
        if (cfg.main_version) cmd += ` -H 'mainversion: ${cfg.main_version}'`;
        if (cfg.x_versioncode) cmd += ` -H 'x-versioncode: ${cfg.x_versioncode}'`;
        if (cfg.x_versionnumber) cmd += ` -H 'x-versionnumber: ${cfg.x_versionnumber}'`;
        if (cfg.x_channel) cmd += ` -H 'x-channel: ${cfg.x_channel}'`;
        if (cfg.user_agent) cmd += ` -H 'User-Agent: ${cfg.user_agent}'`;
        
        if (data) {
            cmd += ` -H 'content-type: ${cfg.content_type || 'application/json; charset=UTF-8'}'`;
            cmd += ` -d '${JSON.stringify(data)}'`;
        }
        cmd += ' --compressed --http2';

        exec(cmd, { maxBuffer: 1024 * 1024 }, (err, stdout, stderr) => {
            if (err) return reject(err);
            try {
                // 有时候 API 返回非 JSON 或空
                if(!stdout || stdout.trim().length === 0) return reject(new Error('Empty response'));
                const json = JSON.parse(stdout);
                resolve(json);
            } catch (e) {
                console.error("Raw Output:", stdout);
                reject(new Error(`Parse error: ${e.message}`));
            }
        });
    });
}

// 获取商品列表
async function getGoodsList(auth = {}) {
    const out = await getGoodsListByEncryptedPayload({ biz_params: {} }, auth);
    const list = Array.isArray(out.goods_list) ? out.goods_list : [];
    return list.map((x) => ({
        account: String(x.account || '').trim(),
        gameName: String(x.gameName || '').trim(),
        roleName: String(x.roleName || '').trim(),
        exceptionMsg: String(x.exceptionMsg || '').trim(),
        status: String(x.status || '未知'),
        rawStatus: Number(x.rawStatus),
        gameId: Number(x.gameId),
        id: String(x.id || '').trim()
    }));
}

async function resolveDataIdByAccountAndGame(accountNo, gameId, auth = {}) {
    const acc = String(accountNo || '').trim();
    const gid = Number(gameId || 0);
    if (!acc || !gid) return '';
    const out = await getGoodsListByEncryptedPayload({ biz_params: {} }, auth);
    const list = Array.isArray(out.goods_list) ? out.goods_list : [];
    const hit = list.find((x) => String(x.account || '').trim() === acc && Number(x.gameId || 0) === gid);
    return hit ? String(hit.id || '').trim() : '';
}

// 变更状态（默认切元宝 changeStatusSingle）
// type: 1=上架, 2=下架
async function changeStatus(accountNo, gameId, type, auth = {}, options = {}) {
    const meta = resolveLogMeta(auth, options);
    const dataId = String(
        (options && (options.data_id || options.dataId)) || ''
    ).trim() || await resolveDataIdByAccountAndGame(accountNo, gameId, auth);
    if (!dataId) {
        console.error(`[ZHW_YB_STATUS] user_id=${meta.userId} trace_id=${meta.traceId} ok=0 reason=missing_data_id account=${String(accountNo || '')} game_id=${Number(gameId || 0)} type=${Number(type || 0)}`);
        return false;
    }
    return changeStatusSingleByEncryptedPayload(accountNo, gameId, type, auth, {
        ...options,
        trace_id: meta.traceId,
        data_id: Number(dataId)
    });
}

function buildOrderEncryptedPayload(payload = {}, auth = {}) {
    const ak = String(payload.ak || '').trim();
    const data = String(payload.data || '').trim();
    if (ak && data) return { ak, data };

    const bizParams = payload.biz_params && typeof payload.biz_params === 'object'
        ? payload.biz_params
        : {
            // 元宝助手抓包确认的订单查询参数模型
            pageNum: Number(payload.pageNum ?? 0),
            pageSize: Number(payload.pageSize ?? 15),
            queryType: Number(payload.queryType ?? 0),
            sortType: Number(payload.sortType ?? 1),
            fromDate: String(payload.fromDate || ''),
            toDate: String(payload.toDate || '')
        };
    return buildEncryptedBody(bizParams, {
        public_key: auth.rsa_public_key
    });
}

function mapGoodsStatus(rawStatus) {
    const n = Number(rawStatus);
    if (n === 2) return '租赁中';
    if (n === -1) return '下架';
    if (n === 1) return '上架';
    return '未知';
}

function inferGameNameByGameId(gameId) {
    const gid = String(gameId || '').trim();
    if (gid === '1104466820') return 'WZRY';
    if (gid === '1106467070') return '和平精英';
    return '';
}

function buildGoodsEncryptedPayload(payload = {}, auth = {}) {
    const bizParams = payload.biz_params && typeof payload.biz_params === 'object'
        ? payload.biz_params
        : {};
    return buildEncryptedBody(bizParams, {
        public_key: auth.rsa_public_key
    });
}

function buildChangeStatusEncryptedPayload(payload = {}, auth = {}) {
    const bizParams = payload.biz_params && typeof payload.biz_params === 'object'
        ? payload.biz_params
        : {};
    return buildEncryptedBody(bizParams, {
        public_key: auth.rsa_public_key
    });
}

// 元宝商品列表：
// - 仅支持业务参数，由本地 toEncryptBody.js 实时加密生成 ak/data
async function getGoodsListByEncryptedPayload(payload = {}, auth = {}, options = {}) {
    const startedAt = nowMs();
    const meta = resolveLogMeta(auth, options);
    const cfg = resolveAuth(auth);
    const url = String(options.url || 'https://api-game.duodian.cn/api/ybzs/accountManage/getAccountList').trim();
    const body = buildGoodsEncryptedPayload(payload, cfg);
    if (!body.ak || !body.data) throw new Error('zuhaowang 商品请求缺少 ak/data');

    const token = String(
        options.token
        || payload.token
        || cfg.token_yuanbao
        || cfg.token_get
    ).trim();
    if (!token) throw new Error('zuhaowang 商品请求缺少 token（可用 token_yuanbao 或 token_get）');

    let res;
    try {
        res = await curlRequest(url, 'POST', body, token, cfg);
    } catch (e) {
        const costMs = nowMs() - startedAt;
        console.error(`[ZHW_YB_GOODS] user_id=${meta.userId} trace_id=${meta.traceId} ok=0 cost_ms=${costMs} url=${url} err=${String(e && e.message ? e.message : e)}`);
        throw e;
    }
    if (!res || String(res.code) !== '0') {
        const costMs = nowMs() - startedAt;
        console.warn(`[ZHW_YB_GOODS] user_id=${meta.userId} trace_id=${meta.traceId} ok=0 cost_ms=${costMs} url=${url} code=${String(res && res.code || '')} desc=${String(res && res.desc || '')}`);
        throw new Error(res ? String(res.desc || 'API Error') : 'API Error');
    }

    const list = Array.isArray(res.data) ? res.data : [];
    const mapped = list.map((item) => {
        const rawStatus = Number(item && item.status);
        return {
            account: String((item && item.accountNo) || '').trim(),
            gameName: String((item && item.gameName) || '').trim() || inferGameNameByGameId(item && item.gameId),
            roleName: String((item && item.roleName) || '').trim(),
            exceptionMsg: String((item && item.exceptionMsg) || '').trim(),
            status: mapGoodsStatus(rawStatus),
            rawStatus,
            gameId: Number(item && item.gameId),
            id: String((item && item.dataId) || '').trim(),
            raw: item
        };
    }).filter((x) => x.account);

    const costMs = nowMs() - startedAt;
    const statusCount = buildStatusCount(mapped);
    console.log(`[ZHW_YB_GOODS] user_id=${meta.userId} trace_id=${meta.traceId} ok=1 cost_ms=${costMs} url=${url} code=${String(res.code)} total=${mapped.length} status_count=${JSON.stringify(statusCount)}`);

    return {
        goods_list: mapped,
        total_count: mapped.length,
        raw: res
    };
}

// 元宝商品状态变更（单个）：
// - 默认按抓包参数模型 { paramList:[{ dataId, type, skipFreqLimit }] } 生成加密业务参数
// - 仅支持由本地 toEncryptBody.js 实时生成 ak/data
async function changeStatusSingleByEncryptedPayload(accountNo, gameId, type, auth = {}, options = {}) {
    const startedAt = nowMs();
    const meta = resolveLogMeta(auth, options);
    const cfg = resolveAuth(auth);
    const url = String(options.url || 'https://api-game.duodian.cn/api/ybzs/accountManage/changeStatusSingle').trim();
    const dataId = Number(
        (options && options.data_id)
        || (options && options.dataId)
        || 0
    );
    const opType = Number(type || 0);
    if (![1, 2].includes(opType)) throw new Error('changeStatusSingle type 仅支持 1(上架)/2(下架)');

    const defaultBizParams = {
        paramList: [
            {
                dataId,
                type: opType,
                skipFreqLimit: Number(
                    options && options.skip_freq_limit !== undefined
                        ? options.skip_freq_limit
                        : (options && options.skipFreqLimit !== undefined ? options.skipFreqLimit : 0)
                )
            }
        ]
    };

    const bizParams = options.biz_params && typeof options.biz_params === 'object'
        ? options.biz_params
        : defaultBizParams;

    const list = Array.isArray(bizParams.paramList) ? bizParams.paramList : [];
    const first = list[0] && typeof list[0] === 'object' ? list[0] : null;
    if (!first || !Number(first.dataId)) throw new Error('changeStatusSingle 缺少 dataId（paramList[0].dataId）');
    if (![1, 2].includes(Number(first.type))) throw new Error('changeStatusSingle 缺少合法 type（paramList[0].type）');

    const body = buildChangeStatusEncryptedPayload({ biz_params: bizParams }, cfg);
    if (!body.ak || !body.data) throw new Error('zuhaowang changeStatusSingle 请求缺少 ak/data');

    const token = String(
        options.token
        || cfg.token_yuanbao
        || cfg.token_post
        || cfg.token_get
    ).trim();
    if (!token) throw new Error('zuhaowang changeStatusSingle 请求缺少 token');

    let res;
    try {
        res = await curlRequest(url, 'POST', body, token, cfg);
    } catch (e) {
        const costMs = nowMs() - startedAt;
        console.error(`[ZHW_YB_STATUS] user_id=${meta.userId} trace_id=${meta.traceId} ok=0 cost_ms=${costMs} url=${url} account=${String(accountNo || '')} game_id=${Number(gameId || 0)} data_id=${Number(first.dataId || 0)} type=${Number(first.type || 0)} err=${String(e && e.message ? e.message : e)}`);
        return false;
    }
    if (res && String(res.code) === '0') {
        const costMs = nowMs() - startedAt;
        console.log(`[ZHW_YB_STATUS] user_id=${meta.userId} trace_id=${meta.traceId} ok=1 cost_ms=${costMs} url=${url} account=${String(accountNo || '')} game_id=${Number(gameId || 0)} data_id=${Number(first.dataId || 0)} type=${Number(first.type || 0)} code=${String(res.code)} desc=${String(res.desc || '')}`);
        return true;
    }
    const costMs = nowMs() - startedAt;
    console.warn(`[ZHW_YB_STATUS] user_id=${meta.userId} trace_id=${meta.traceId} ok=0 cost_ms=${costMs} url=${url} account=${String(accountNo || '')} game_id=${Number(gameId || 0)} data_id=${Number(first.dataId || 0)} type=${Number(first.type || 0)} code=${String(res && res.code || '')} desc=${String(res && res.desc || '')}`);
    return false;
}

// 订单列表：
// - payload 支持直接传 { ak, data }
// - 也支持传业务参数，由本地自动加密生成 ak/data
async function getOrderListByEncryptedPayload(payload = {}, auth = {}, options = {}) {
    const cfg = resolveAuth(auth);
    const url = 'https://api-game.duodian.cn/api/ybzs/tradeOrder/getOrderList';
    const body = buildOrderEncryptedPayload(payload, cfg);
    if (!body.ak || !body.data) throw new Error('zuhaowang 订单请求缺少 ak/data');
    if (!cfg.token_yuanbao) throw new Error('zuhaowang token_yuanbao 未配置');

    // 订单链路固定使用元宝侧 token，避免和商品 token 混用。
    const res = await curlRequest(url, 'POST', body, cfg.token_yuanbao, cfg);
    if (!res || String(res.code) !== '0') {
        throw new Error(res ? String(res.desc || 'API Error') : 'API Error');
    }

    const list = Array.isArray(res.data) ? res.data : [];
    return {
        order_list: list,
        total_count: list.length,
        raw: res
    };
}

module.exports = {
    getGoodsList,
    changeStatus,
    getGoodsListByEncryptedPayload,
    changeStatusSingleByEncryptedPayload,
    getOrderListByEncryptedPayload,
    _internals: {
        buildOrderEncryptedPayload,
        buildGoodsEncryptedPayload,
        buildChangeStatusEncryptedPayload,
        mapGoodsStatus,
        inferGameNameByGameId
    }
};
