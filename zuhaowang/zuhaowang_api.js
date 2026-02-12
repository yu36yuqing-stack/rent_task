// 租号王 API 模块 (zuhaowan_api.js)
const { exec } = require('child_process');

const TOKEN_GET = '7C1myCgHfwGQr8M3kOzp12kJ+ywIEaAaLcSEqWhpTlxpAEjoQpIRnEMa8DtSU8kYh/HwH2uHezdhjI1uxKkKeA==';
const TOKEN_POST = '7C1myCgHfwGQr8M3kOzp1/w2TS+3Q0LmMDaxxsQ5BJSps5p83XRFFgjRecXb9oEG2Vx2rjV3Pw0aq5dlCSfldw==';
const DEVICE_ID = 'b1e4d7ab291044b7b6167ce9bde98b5f';
const PACKAGE_NAME = 'com.duodian.freehire';

// Curl 封装
function curlRequest(url, method, data = null, token) {
    return new Promise((resolve, reject) => {
        let cmd = `curl -s -X ${method} '${url}'`;
        // Headers
        cmd += ` -H 'token: ${token}'`;
        cmd += ` -H 'deviceid: ${DEVICE_ID}'`;
        cmd += ` -H 'packagename: ${PACKAGE_NAME}'`;
        cmd += ` -H 'source: android'`;
        
        if (data) {
            cmd += ` -H 'content-type: application/json; charset=UTF-8'`;
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
async function getGoodsList() {
    const url = 'https://api-game.duodian.cn/api/accountManage/getManageList?gameId&sort=0&status=0';
    const res = await curlRequest(url, 'GET', null, TOKEN_GET);
    
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
            status: statusText,
            rawStatus: rawStatus,
            gameId: item.gameId,
            id: info.dataId
        };
    });
}

// 变更状态
// type: 1=上架, 2=下架
async function changeStatus(accountNo, gameId, type) {
    const url = 'https://api-game.duodian.cn/api/accountManage/changeStatus';
    const payload = { 
        "accountNo": String(accountNo), 
        "gameId": Number(gameId), 
        "type": Number(type) 
    };
    
    // Retry logic if needed, but for now simple call
    const res = await curlRequest(url, 'POST', payload, TOKEN_POST);
    
    if (res && res.code === '0') {
        return true;
    } else {
        console.error(`[Zuhaowan] Change status failed: ${res ? res.desc : 'Unknown error'}`);
        return false;
    }
}

module.exports = {
    getGoodsList,
    changeStatus
};
