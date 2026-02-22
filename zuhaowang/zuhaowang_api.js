// 租号王 API 模块 (zuhaowan_api.js)
const { exec } = require('child_process');
const { buildEncryptedBody } = require('./toEncryptBody');

const DEFAULT_SOURCE = 'android';

function resolveAuth(auth = {}) {
    const cfg = {
        token_get: String(auth.token_get || '').trim(),
        token_post: String(auth.token_post || '').trim(),
        token_yuanbao: String(auth.token_yuanbao || '').trim(),
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
    if (!cfg.token_get) throw new Error('zuhaowang token_get 未配置');
    if (!cfg.token_post) throw new Error('zuhaowang token_post 未配置');
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
    const cfg = resolveAuth(auth);
    const url = 'https://api-game.duodian.cn/api/accountManage/getManageList?gameId&sort=0&status=0';
    const res = await curlRequest(url, 'GET', null, cfg.token_get, cfg);
    
    if (!res || res.code !== '0') {
        throw new Error(res ? res.desc : 'API Error');
    }
    
    if (!res.data) return [];

    return res.data.map(item => {
        // status: 2:出租中; -1:已下架; 1:待出租(上架)
        const info = item.rentInfo || {};
        const rawStatus = info.status;
        let statusText = '未知';
        
        // 映射逻辑
        if (rawStatus === 2) statusText = '租赁中';
        else if (rawStatus === -1) statusText = '下架';
        else if (rawStatus === 1) statusText = '上架';

        return {
            account: String(item.accountNo), // 统一转字符串
            gameName: item.gameName,
            roleName: item.roleName,
            exceptionMsg: String(item.exceptionMsg || ''),
            status: statusText,
            rawStatus: rawStatus,
            gameId: item.gameId,
            id: info.dataId
        };
    });
}

// 变更状态
// type: 1=上架, 2=下架
async function changeStatus(accountNo, gameId, type, auth = {}) {
    const cfg = resolveAuth(auth);
    const url = 'https://api-game.duodian.cn/api/accountManage/changeStatus';
    const payload = { 
        "accountNo": String(accountNo), 
        "gameId": Number(gameId), 
        "type": Number(type) 
    };
    
    // Retry logic if needed, but for now simple call
    const res = await curlRequest(url, 'POST', payload, cfg.token_post, cfg);
    
    if (res && res.code === '0') {
        return true;
    } else {
        console.error(`[Zuhaowan] Change status failed: ${res ? res.desc : 'Unknown error'}`);
        return false;
    }
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
    getOrderListByEncryptedPayload,
    _internals: {
        buildOrderEncryptedPayload
    }
};
