'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'gta6-test-'));
for (const key of ['MAIN','STATS','ORDER','PRICE','RUNTIME']) process.env[key + '_DB_FILE_PATH'] = path.join(tmp, key + '.db');
process.env.H5_PORT = '0';
process.env.H5_HOST = '127.0.0.1';
process.env.SHEEP_FIX_ENABLE = 'false';
process.env.BL_V2_INSPECTOR_ENABLE = 'false';
const { bootstrap } = require('../h5/local_h5_server');
const { stopProdRiskTaskWorker } = require('../product/prod_status_guard');
const { createUserByAdmin } = require('../database/user_db');
const { upsertUserGameAccount } = require('../database/user_game_account_db');
const { createAccessToken } = require('../user/auth_token');
const { setSystemConfig } = require('../database/system_config_db');
const { refreshDevices, syncEnabledDevices } = require('../product/rental_device_service');
const { listDeviceCards, replaceDeviceSnapshot } = require('../database/rental_device_db');
const { listRentalDevices, _internals } = require('../uuzuhao/uuzuhao_api');

async function checkUi(base, user) {
    const browser = await require('puppeteer-core').launch({ executablePath: process.env.CHROME_PATH ||
        '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', headless: true, args: ['--no-sandbox'] });
    try {
        for (const width of [375, 1280]) {
            const page = await browser.newPage();
            await page.setViewport({ width, height: 850 });
            const errors = [];
            page.on('pageerror', e => errors.push(e.message));
            await page.evaluateOnNewDocument(auth => sessionStorage.setItem('h5_auth_bundle', JSON.stringify(auth)),
                { token: createAccessToken(user), user: { id: user.id, account: user.account, user_type: user.user_type } });
            await page.goto(base);
            const tab = '[data-product-game="GTA6"]';
            await page.waitForSelector(tab, { visible: true });
            assert.deepEqual(await page.$$eval('[data-product-game]', tabs => tabs.slice(0,4).map(t => t.textContent.trim())), ['全部','王者荣耀','GTA6','和平精英']);
            await page.click(tab);
            await page.waitForFunction(() => document.querySelector('#orderTotal')?.textContent.includes('主机数') ||
                document.querySelector('#listView')?.innerText.includes('主机数'));
            const card = '#listView .product-card';
            assert.deepEqual(await page.$$eval(card + ' button', buttons => buttons.map(b => b.textContent.trim())), ['采购与成本']);
            assert(!(await page.$eval(card, n => n.textContent)).includes('累计租金'));
            assert(await page.$eval(tab+' img', i => i.complete && i.naturalWidth > 0));
            assert(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth+1));
            const dir = path.join(__dirname, '../coverage/rental-device');
            fs.mkdirSync(dir, { recursive: true });
            await page.screenshot({ path: path.join(dir, 'preview-'+width+'.png') });
            await page.click('[data-op="device-cost"]');
            assert.deepEqual(await page.$$eval('#moreOpsSheet button', bs => bs.filter(b=>b.offsetWidth>0).map(b=>b.id).sort()),
                ['moreOpsCloseBtn','moreOpsCostBtn','moreOpsCostDetailBtn','moreOpsPurchaseBtn'].sort());
            await page.click('#moreOpsCostDetailBtn');
            await page.waitForFunction(() => document.querySelector('#statsCostDetailSummary')?.textContent.includes('总成本'));
            assert.deepEqual(errors, []);
            await page.close();
        }
    } finally { await browser.close(); }
}

async function main() {
    const web = await bootstrap();
    const device = { deviceId: '9223372036854775806', deviceNo:'DEV-01', deviceName:'预览主机', deviceModelName:'Xbox Series X',
        supplyHourPrice:'1.50', maxRentHours:48, status:5, statusDesc:'租赁中' };
    let pages = [], requests = [];
    const merchant = http.createServer(async (req,res) => {
        const chunks = [];
        for await (const c of req) chunks.push(c);
        const body = JSON.parse(Buffer.concat(chunks));
        requests.push({ url:req.url, method:req.method, body });
        const data = pages[body.pageNum-1];
        res.end(JSON.stringify(data ? { code:0, data } : { code:9, msg:'fixture error' }).replaceAll('"9223372036854775806"', '9223372036854775806'));
    });
    try {
        await new Promise(r => merchant.listen(0,'127.0.0.1',r));
        const user = await createUserByAdmin({account:'device-fixture',password:'fixture-password',status:'enabled',user_type:'内部'});
        const other = await createUserByAdmin({account:'other-fixture',password:'fixture-password',status:'enabled',user_type:'内部'});
        const uid = user.id;
        const base = 'http://127.0.0.1:'+web.address().port;
        const api = async (route, body, as = user) => {
            const response = await fetch(base+route, { method:body?'POST':'GET', headers:{
                Authorization:'Bearer '+createAccessToken(as),'Content-Type':'application/json'}, body:body && JSON.stringify(body) });
            return { status:response.status, ...await response.json() };
        };
        const auth = {app_key:'test',app_secret:'test-secret',api_base:'http://127.0.0.1:'+merchant.address().port};
        assert.deepEqual(await syncEnabledDevices(uid, auth), {skipped:true});
        assert.equal(requests.length,0);
        await setSystemConfig('uuzuhao.rental_device_sync',{user_ids:[uid]},{expectedId:0,expectedVersion:0});
        pages = [{hasMore:true,deviceList:[device]}, {hasMore:false,deviceList:[device,{deviceId:2}]}];
        assert.deepEqual(await syncEnabledDevices(uid,auth), {ok:true,count:2});
        for (const [i,r] of requests.entries()) {
            assert.equal(r.method,'POST'); assert.equal(r.url,'/api/youpin/rent-connector/device/v1/list');
            assert.deepEqual([r.body.pageNum,r.body.pageSize,r.body.tab],[i+1,100,0]);
            assert.equal(r.body.sign,_internals.createSign(r.body,auth.app_secret)); assert(!('userId' in r.body));
        }
        pages = [{hasMore:true,deviceList:[{deviceId:3}]}];
        assert.equal((await syncEnabledDevices(uid,auth)).ok,false);
        assert.equal((await listDeviceCards(uid)).length,2);
        for(const [bad, msg] of [[{deviceList:[]},/返回结构/],[{hasMore:true,deviceList:[]},/未前进/],
            [{hasMore:false,deviceList:[{}]},/deviceId/]]) {
            pages=[bad]; await assert.rejects(()=>listRentalDevices(auth),msg);
        }
        await assert.rejects(()=>replaceDeviceSnapshot(uid,[{deviceId:null}]),/constraint/i);
        assert.equal((await listDeviceCards(uid)).length,2);
        await upsertUserGameAccount({user_id:uid,game_account:'ordinary',game_id:'1',game_name:'WZRY'});
        const devices = await api('/api/products?game_name=GTA6');
        assert.deepEqual([devices.total,devices.stats.total_renting],[2,1]);
        const key = {game_id:'GTA6',game_name:'GTA6',game_account:'device:'+device.deviceId};
        assert.equal(devices.list[0].game_account,key.game_account);
        assert.equal((await api('/api/products?game_name=GTA6&filter=renting')).total,1);
        assert.equal((await api('/api/products?game_name=GTA6&asset_status=sold')).total,0);
        assert.equal((await api('/api/products?game_name=GTA6',null,other)).total,0);
        const mixed = await api('/api/products?page_size=1&page=2');
        assert.equal(mixed.total,3); assert.equal(mixed.list[0].product_kind,'device');
        const purchase = {...key,purchase_price:100,purchase_date:'2026-11-23'};
        assert.equal((await api('/api/products/purchase-config',purchase,other)).status,404);
        assert.equal((await api('/api/products/purchase-config',{...purchase,game_account:'11'})).status,400);
        assert.equal((await api('/api/products/purchase-config',purchase)).data.total_cost_amount,100);
        assert.equal((await api('/api/products/purchase-config',{...purchase,purchase_price:110})).data.total_cost_amount,110);
        const extra = await api('/api/products/account-cost/create',{...key,cost_amount:12,cost_type:'maintenance',cost_date:'2026-11-23',cost_desc:'配件'});
        assert.equal((await api('/api/products/account-cost/create',{...key,cost_amount:1,cost_type:'purchase',cost_date:'2026-11-23'})).status,400);
        assert.equal(extra.data.total_cost_amount,122);
        const detail = '/api/stats/account-cost-detail?game_name=GTA6&game_account='+key.game_account;
        assert.equal((await api(detail)).list.length,2);
        assert.equal((await api(detail,null,other)).ok,false);
        assert.equal((await api('/api/products/account-cost/delete',{...key,record_id:extra.data.record.id})).data.total_cost_amount,110);
        const count = requests.length;
        assert.equal((await api('/api/products/online',key)).status,400);
        assert.equal((await api('/api/products/auth-revoke',key)).status,400);
        assert.equal(requests.length,count);
        pages = [{hasMore:false,deviceList:[]}];
        await refreshDevices(uid,auth);
        assert.equal((await listDeviceCards(uid)).length,0);
        pages = [{hasMore:false,deviceList:[{...device,deviceName:'主机改名',deviceNo:'NEW-02'}]}];
        await refreshDevices(uid,auth);
        assert.equal((await api(detail)).total_cost_amount,110);
        if (process.argv.includes('--ui')) await checkUi(base,user);
        console.log('[PASS] device paging, atomic snapshot, costs, ownership, isolation, product list'+(process.argv.includes('--ui')?', mobile and desktop UI':''));
    } finally {
        stopProdRiskTaskWorker();
        await new Promise(r=>merchant.close(r));
        await new Promise(r=>web.close(r));
    }
}
main().catch(e => { console.error(e); process.exitCode=1; });
