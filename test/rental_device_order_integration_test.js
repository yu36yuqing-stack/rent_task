'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'rent-device-orders-'));
process.env.TZ = 'Asia/Shanghai';
for (const key of ['MAIN','ORDER','STATS','RUNTIME','PRICE']) process.env[key + '_DB_FILE_PATH'] = path.join(root,key+'.db');
Object.assign(process.env,{H5_PORT:'0',H5_HOST:'127.0.0.1',SHEEP_FIX_ENABLE:'false',BL_V2_INSPECTOR_ENABLE:'false'});

const { bootstrap } = require('../h5/local_h5_server');
const { stopProdRiskTaskWorker } = require('../product/prod_status_guard');
const { createUserByAdmin } = require('../database/user_db');
const { upsertUserPlatformAuth } = require('../database/user_platform_auth_db');
const { setSystemConfig } = require('../database/system_config_db');
const { upsertOrder } = require('../order/service/order_command_service');
const { listActiveRentingOrdersByUser } = require('../order/service/order_query_service');
const { replaceDeviceSnapshot } = require('../database/rental_device_db');
const { upsertRentalDeviceOrders, listDirtyDeviceDates } = require('../database/rental_device_order_db');
const { importRentalDeviceOrders, syncConfiguredRentalDeviceOrders } = require('../order/rental_device_order_service');
const { listGta6DeviceOrders, _internals } = require('../uuzuhao/uuzuhao_api');
const { refreshRentalDeviceStats, getOrderStatsDashboardByUser, getIncomeCalendarByUser } = require('../stats/order_stats');
const { createAccessToken } = require('../user/auth_token');
const ms = text => String(Date.parse(text.replace(' ','T')+'+08:00'));
const today = new Date().toLocaleDateString('sv-SE');
const yesterday = new Date(Date.now()-86400000).toLocaleDateString('sv-SE');
const stableNow = new Date(`${today}T23:00:00+08:00`);
const oldDate = '2025-01-05';
const fixture = { purchaseOrderNo:'host-a', gameId:11000, deviceId:'9223372036854775806', deviceNo:'X_01',
    deviceName:'轻舟<测试>', orderType:2, orderStatus:4000, receivableAmount:10, settlementAmount:7.25, returnAmount:2.75,
    rentHour:2, createTime:ms(yesterday+' 20:00:00'), rentStartTime:ms(yesterday+' 22:00:00'), rentEndTime:ms(today+' 00:00:00') };

async function browserCheck(base,user) {
    const puppeteer = require('puppeteer-core');
    let browser;
    for (let attempt = 0; attempt < 3; attempt++) {
        try {
            browser = await puppeteer.launch({ executablePath:process.env.CHROME_PATH ||
                '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', headless:true,
                args:['--disable-crash-reporter','--disable-breakpad'] });
            break;
        } catch (error) {
            if (attempt === 2) throw error;
            await new Promise(resolve=>setTimeout(resolve,500));
        }
    }
    try {
        for (const width of [375,1280]) {
            const page = await browser.newPage();
            const errors = [];
            page.on('pageerror',e=>errors.push(e.message));
            await page.setViewport({width,height:850});
            await page.evaluateOnNewDocument(auth=>sessionStorage.setItem('h5_auth_bundle',JSON.stringify(auth)),
                {token:createAccessToken(user),user:{id:user.id,account:user.account,user_type:user.user_type}});
            await page.goto(base);
            const dir = path.resolve(__dirname,'../coverage/rental-device-orders');
            fs.mkdirSync(dir,{recursive:true});
            for (const [menu,attribute,selector,needle] of [
                ['orders','data-order-game','#orderListContainer','悠悠主机'],
                ['stats','data-stats-game','#statsAccountList','历史总收入']
            ]) {
                await page.waitForSelector('#menuTrigger',{visible:true});
                await page.click('#menuTrigger');
                await page.click(`[data-menu="${menu}"]`);
                const tab = `[${attribute}="GTA6"]`;
                await page.waitForSelector(tab,{visible:true});
                await page.waitForNetworkIdle({idleTime:250});
                assert.deepEqual(await page.$$eval(`[${attribute}]`,ns=>ns.slice(0,4).map(n=>n.textContent.trim())),
                    ['全部','王者荣耀','GTA6','和平精英']);
                await page.locator(tab).click();
                await page.waitForSelector(tab+'.active',{visible:true,timeout:6000}).catch(error => {
                    throw new Error(`${menu}: ${error.message}; browser errors: ${errors.join(' | ')}`);
                });
                if (menu === 'orders') await page.locator('[data-order-quick="last7"]').click();
                await page.waitForFunction((s,t)=>document.querySelector(s)?.innerText.includes(t),{timeout:8000},selector,needle);
                assert(await page.$eval(tab+' img',img=>img.complete && img.naturalWidth>0));
                assert(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+1));
                await page.screenshot({path:path.join(dir,menu+'-'+width+'.png')});
            }
            assert.deepEqual(errors,[]);
            await page.close();
        }
    } finally { await browser.close(); }
}

async function main() {
    const web = await bootstrap();
    let rows = [], override, calls = [], broken = false;
    const merchant = http.createServer(async(req,res)=>{
        const chunks = [];
        for await(const c of req) chunks.push(c);
        const body = JSON.parse(Buffer.concat(chunks));
        calls.push({url:req.url,method:req.method,body});
        const data = override?.(body) ?? {totalCount:rows.length,orderList:rows.slice((body.page-1)*body.pageSize,body.page*body.pageSize)};
        res.end(JSON.stringify(broken ? {code:900,msg:'fixture'} : {code:0,data})
            .replaceAll('"9223372036854775806"','9223372036854775806'));
    });
    try {
        await new Promise(r=>merchant.listen(0,'127.0.0.1',r));
        const user = await createUserByAdmin({account:'host-fixture',password:'fixture-password',status:'enabled',user_type:'内部'});
        const other = await createUserByAdmin({account:'other-host',password:'fixture-password',status:'enabled',user_type:'内部'});
        const uid = user.id;
        const auth = {app_key:'fixture',app_secret:'fixture-secret',api_base:'http://127.0.0.1:'+merchant.address().port};
        const base = 'http://127.0.0.1:'+web.address().port;
        const api = async (route, as=user, body) => (await fetch(base+route,{method:body?'POST':'GET',headers:{
            Authorization:'Bearer '+createAccessToken(as),'Content-Type':'application/json'},body:body&&JSON.stringify(body)})).json();
        assert.equal((await api('/api/orders/sync',user,{game_name:'GTA6'})).rental_device_orders.reason,'disabled');
        assert.equal(calls.length,0);
        await setSystemConfig('uuzuhao.rental_device_order_sync',{user_ids:[uid]},{expectedId:0,expectedVersion:0});
        assert.equal((await syncConfiguredRentalDeviceOrders(uid)).reason,'missing_auth');
        await upsertUserPlatformAuth({user_id:uid,platform:'uuzuhao',auth_type:'token',auth_payload:auth});
        await replaceDeviceSnapshot(uid,[{deviceId:fixture.deviceId,deviceName:fixture.deviceName,deviceNo:fixture.deviceNo}]);
        rows = [fixture,{...fixture,purchaseOrderNo:'host-progress',orderStatus:3000,settlementAmount:10,returnAmount:null},
            {...fixture,purchaseOrderNo:'unlinked',deviceId:null,deviceName:'',deviceNo:'',orderStatus:4200,settlementAmount:0,returnAmount:10},
            {...fixture,purchaseOrderNo:'old',createTime:ms(oldDate+' 16:00:00'),rentStartTime:ms(oldDate+' 16:00:00'),rentEndTime:ms(oldDate+' 18:00:00')},
            {...fixture,purchaseOrderNo:'cancelled-review',orderStatus:9900,settlementAmount:1,returnAmount:9},
            {...fixture,purchaseOrderNo:'outside-status',orderStatus:1234},
            ...Array.from({length:45},(_,i)=>({...fixture,purchaseOrderNo:'extra-'+i,orderStatus:9900,orderType:8,receivableAmount:0,
                settlementAmount:0,returnAmount:0,rentStartTime:null,rentEndTime:null}))];
        const imported = await api('/api/orders/sync',user,{game_name:'GTA6'});
        assert.equal(imported.rental_device_orders.count,51);
        assert.equal(imported.rental_device_orders.changed,51);
        assert.equal(imported.rental_device_orders.review,2);
        assert.equal(calls.length,2);
        for (const [i,c] of calls.entries()) {
            assert.equal(c.url,'/api/youpin/rent-connector/device/v1/order/list');
            assert.deepEqual([c.method,c.body.gameId,c.body.orderStatus,c.body.page],['POST',11000,0,i+1]);
            assert.equal(c.body.sign,_internals.createSign(c.body,auth.app_secret)); assert(!('userId' in c.body));
        }
        const scoped = '/api/orders?game_name=GTA6&quick_filter=last30&page_size=20';
        assert.equal((await api(scoped+'&keyword=host-a')).list[0].game_account,'device:'+fixture.deviceId);
        assert.equal((await api(scoped+'&keyword=X_01')).total,49);
        assert.equal((await api(scoped+'&keyword=轻舟')).total,49);
        assert.equal((await api(scoped+'&keyword=_')).total,0);
        assert.equal((await api(scoped+'&status_filter=progress')).total,1);
        const refunds = await api(scoped+'&status_filter=refund');
        assert(refunds.list.some(x=>x.order_status==='已退款'),JSON.stringify(refunds.list.map(x=>[x.order_no,x.order_status,x.refund_amount])));
        assert.equal((await api(scoped+'&status_filter=cancel')).total,46);
        assert.equal((await api(scoped,other)).total,0);
        assert.equal((await listActiveRentingOrdersByUser(uid)).length,0);
        await upsertOrder({user_id:uid,channel:'uuzuhao',order_no:'host-a',game_id:'1',game_name:'WZRY',game_account:'ordinary',
            order_status:'租赁中',start_time:yesterday+' 22:00:00',end_time:today+' 00:00:00',order_amount:1});
        assert.equal((await listActiveRentingOrdersByUser(uid)).length,1);
        const paged = await api('/api/orders?game_name=全部&quick_filter=last30&page_size=3');
        assert.equal(paged.total,(await api(scoped)).total+1); assert.equal(paged.list.length,3);

        const view = async options => getOrderStatsDashboardByUser(uid,{...options,game_name:'GTA6',now:stableNow});
        assert.equal((await view({period:'today'})).summary.amount_rec_sum,7.25);
        assert.equal((await view({period:'today'})).summary.amount_refund_sum,24.5);
        for (const options of [{period:'month'},{period:'last30'},{stat_date:oldDate}]) {
            assert.equal((await view(options)).summary.total_rec_amount_all_time,14.5);
        }
        assert.equal((await view({period:'today'})).by_account.find(x=>x.game_account.startsWith('device:9')).annualized_return_rate,null);
        const income = await getIncomeCalendarByUser(uid,{game_name:'GTA6',month:'2025-01'});
        assert.equal(income.total_rec_amount,7.25);
        assert.equal((await importRentalDeviceOrders(uid,auth)).changed,0);
        assert.equal((await refreshRentalDeviceStats(uid)).skipped,true);

        await assert.rejects(()=>listGta6DeviceOrders(auth,{maxPages:1}),/分页上限/);
        const original = rows;
        for(const [data,msg] of [
            [{totalCount:-1,orderList:[]},/结构/],
            [{totalCount:51,orderList:[fixture]},/不完整/],
            [{totalCount:1,orderList:[{...fixture,gameId:11001}]},/游戏/],
            [{totalCount:2,orderList:[fixture,fixture]},/重复/]
        ]) {
            override=()=>data;
            await assert.rejects(()=>importRentalDeviceOrders(uid,auth),msg);
        }
        override = body => body.page===2 ? {totalCount:52,orderList:[fixture]} : undefined;
        await assert.rejects(()=>importRentalDeviceOrders(uid,auth),/总数变化/);
        override=undefined;
        rows=[{...fixture,settlementAmount:'7.123'}];
        await assert.rejects(()=>importRentalDeviceOrders(uid,auth),/金额/);
        rows=original;
        broken=true;
        assert.equal((await syncConfiguredRentalDeviceOrders(uid)).ok,false);
        broken=false;
        assert.equal((await view({period:'today'})).summary.total_rec_amount_all_time,14.5);

        rows = rows.map(o=>o.purchaseOrderNo==='old'?{...o,orderStatus:4200,settlementAmount:0,returnAmount:10}:o);
        assert.equal((await importRentalDeviceOrders(uid,auth)).changed,1);
        assert.deepEqual((await listDirtyDeviceDates(uid,today)).map(r=>r.stat_date),[oldDate]);
        assert.equal((await refreshRentalDeviceStats(uid)).refreshed_days,1);
        assert.equal((await view({period:'today'})).summary.total_rec_amount_all_time,7.25);
        assert.equal((await getIncomeCalendarByUser(uid,{game_name:'GTA6',month:'2025-01'})).total_rec_amount,0);
        assert.equal((await getOrderStatsDashboardByUser(uid,{game_name:'全部',period:'today'})).summary.amount_rec_sum,7.25);
        await assert.rejects(()=>upsertRentalDeviceOrders(uid,[{order_no:'bad'}]),/constraint/i);
        await replaceDeviceSnapshot(uid,[]);
        assert.equal((await view({period:'today'})).summary.total_rec_amount_all_time,7.25);
        await replaceDeviceSnapshot(uid,[{deviceId:fixture.deviceId,deviceName:fixture.deviceName,deviceNo:fixture.deviceNo}]);
        if(process.argv.includes('--ui')) await browserCheck(base,user);
        console.log('[PASS] GTA6 order pagination, mapping, isolation, reports and old refund replay');
    } finally {
        stopProdRiskTaskWorker();
        await new Promise(r=>merchant.close(r));
        await new Promise(r=>web.close(r));
        fs.rmSync(root,{recursive:true,force:true});
    }
}
main().catch(e=>{console.error(e);process.exitCode=1});
