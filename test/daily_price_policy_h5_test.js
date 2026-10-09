'use strict';
const fs=require('fs'),os=require('os'),path=require('path'),assert=require('assert');
const temp=fs.mkdtempSync(path.join(os.tmpdir(),'rent-daily-h5-'));
for(const name of ['MAIN','PRICE','ORDER','RUNTIME','STATS'])process.env[`${name}_DB_FILE_PATH`]=path.join(temp,`${name}.db`);
Object.assign(process.env,{SHEEP_FIX_ENABLE:'0',BL_V2_INSPECTOR_ENABLE:'0',ORDER_COUNT_TRACE:'false',H5_PORT:String(27000+Math.floor(Math.random()*1000))});
const {createUserByAdmin}=require('../database/user_db');
const {upsertUserGameAccount}=require('../database/user_game_account_db');
const {savePriceLadderRuleByUser}=require('../price/price_ladder_service');
const {createAccessToken}=require('../user/auth_token');
const {bootstrap}=require('../h5/local_h5_server');
const {stopProdRiskTaskWorker}=require('../product/prod_status_guard');
const puppeteer=require('puppeteer-core');
async function main(){
    const user=await createUserByAdmin({account:'daily_h5',password:'test-local-123',name:'日租测试',user_type:'内部',status:'enabled'});
    await upsertUserGameAccount({user_id:user.id,game_id:'1',game_name:'WZRY',game_account:'daily-h5',channel_prd_info:{uhaozu:{prd_id:'u'},uuzuhao:{prd_id:'y'},zuhaowang:{prd_id:'z'}}});
    await savePriceLadderRuleByUser(user.id,{game_id:'1',game_account:'daily-h5',prices:[2,2.2,2.4,2.6],expected_version:0});
    await upsertUserGameAccount({user_id:user.id,game_id:'1',game_name:'WZRY',game_account:'2630403808',channel_prd_info:{uuzuhao:{prd_id:'yy-regression'}}});
    await savePriceLadderRuleByUser(user.id,{game_id:'1',game_account:'2630403808',prices:[1.6,1.9,2.1,2.5],expected_version:0});
    const server=await bootstrap();let browser;
    const base=`http://127.0.0.1:${process.env.H5_PORT}`,token=createAccessToken(user);
    const endpoint='/api/pricing/ladder/package-ratios';
    const headers={Authorization:`Bearer ${token}`,'Content-Type':'application/json'};
    const read=async()=> (await fetch(base+endpoint,{headers})).json();
    const send=async body=>{const r=await fetch(base+endpoint,{method:'POST',headers,body:JSON.stringify(body)});return {status:r.status,body:await r.json()};};
    try{
        assert.strictEqual((await fetch(base+endpoint)).status,401);
        const initial=await read();assert(initial.channels.every(c=>c.daily_policy.mode==='follow'));
        const saved=await send({channel:'uhaozu',ratios:{hour:1,night:4,day:6,week:35},daily_policy:{mode:'flat'},expected_version:0});
        assert.strictEqual(saved.status,200);assert.strictEqual(saved.body.setting.daily_policy.mode,'flat');
        assert.strictEqual((await send({channel:'uhaozu',ratios:{night:4,day:6,week:35},daily_policy:{mode:'flat'},expected_version:0})).status,409);
        const bad=await send({channel:'uhaozu',ratios:{night:10,day:6,week:35},daily_policy:{mode:'decrease'},expected_version:1});
        assert.strictEqual(bad.status,400);assert(bad.body.message.includes('冲突'));
        assert.strictEqual((await send({channel:'uhaozu',ratios:{night:4,day:6,week:35},daily_policy:{mode:'unknown'},expected_version:1})).status,400);
        for(const factors of [[0.95,0.96,0.85,0.85],[0,0,0,0],[1.01,0.9,0.85,0.85]]){
            assert.strictEqual((await send({channel:'uhaozu',ratios:{night:4,day:6,week:35},daily_policy:{mode:'decrease',factors},expected_version:1})).status,400);
            assert.strictEqual((await read()).channels[0].version,1);
        }
        const badRule=await fetch(base+'/api/pricing/ladder/account',{method:'POST',headers,body:JSON.stringify({game_id:'1',game_account:'daily-h5',prices:[2,3,4,5],expected_version:1})});
        assert.strictEqual(badRule.status,400);assert((await badRule.json()).message.includes('冲突'));
        assert.strictEqual((await read()).channels[0].version,1);
        const shortRatios={hour:1,p2:1.8,p3:2.4,p5:3.5,p7:4.9,p9:6,p10:6,p24:6.5,p168:40};
        const shortSaved=await send({channel:'uuzuhao',ratios:shortRatios,daily_policy:{mode:'decrease',factors:[0.95,0.9,0.85,0.85]},expected_version:0});
        assert.strictEqual(shortSaved.status,200);
        assert.strictEqual(shortSaved.body.setting.version,1);
        assert.strictEqual((await send({channel:'uuzuhao',ratios:{...shortRatios,p10:7},daily_policy:{mode:'decrease',factors:[0.95,0.9,0.85,0.85]},expected_version:1})).status,400);
        assert.deepStrictEqual((await read()).channels.find(c=>c.channel==='uuzuhao').daily_policy,{mode:'decrease',factors:[0.95,0.9,0.85,0.85]});
        browser=await puppeteer.launch({executablePath:'/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',headless:true});
        const page=await browser.newPage(),errors=[];page.on('pageerror',e=>errors.push(e.message));
        await page.coverage.startJSCoverage({resetOnNavigation:false,includeRawScriptCoverage:true});
        await page.setRequestInterception(true);page.on('request',r=>r.url().startsWith(base)?r.continue():r.abort());
        await page.goto(base);
        await page.evaluate(bundle=>localStorage.setItem('h5_auth_bundle',bundle),JSON.stringify({token,access_token:token,user,refresh_token:''}));
        await page.goto(base+'/?menu=pricing_ratios');
        await page.waitForSelector('[data-daily-mode="flat"].active');
        await page.click('[data-daily-mode="decrease"]');
        await page.$eval('[data-daily-factor="3"]',input=>{input.value='90';input.dispatchEvent(new Event('input',{bubbles:true}));});
        // Flat's saved coefficients are all 100%; set third tier explicitly to the requested suggestion.
        await page.$eval('[data-daily-factor="2"]',input=>{input.value='95';input.dispatchEvent(new Event('input',{bubbles:true}));});
        assert((await page.$eval('[data-daily-preview]',n=>n.textContent)).includes('¥12.00 / ¥12.00 / ¥11.40 / ¥10.80'));
        assert((await page.$eval('[data-daily-preview]',n=>n.textContent)).includes('四档包夜示例：¥8.00 / ¥8.00 / ¥7.60 / ¥7.20'));
        await page.$eval('#pricingRatioPreviewHour',i=>{i.value='3';i.dispatchEvent(new Event('input',{bubbles:true}));});
        assert((await page.$eval('[data-daily-preview]',n=>n.textContent)).includes('¥18.00 / ¥18.00 / ¥17.10 / ¥16.20'));
        await page.$eval('#pricingRatioPreviewHour',i=>{i.value='2';i.dispatchEvent(new Event('input',{bubbles:true}));});
        await page.$eval('[data-pricing-ratio-key="day"]',i=>{i.value='7';i.dispatchEvent(new Event('input',{bubbles:true}));});
        assert((await page.$eval('[data-daily-preview]',n=>n.textContent)).includes('¥14.00 / ¥14.00 / ¥13.30 / ¥12.60'));
        await page.$eval('[data-pricing-ratio-key="day"]',i=>{i.value='6';i.dispatchEvent(new Event('input',{bubbles:true}));});
        assert.strictEqual(await page.$eval('[data-daily-factor="0"]',i=>i.disabled),false);
        // Uhaozu night and daily packages now share the first-tier base and factors.
        await page.$eval('[data-pricing-ratio-key="day"]',i=>{i.value='7';i.dispatchEvent(new Event('input',{bubbles:true}));});
        for(const [index,value] of ['95','90','85','85'].entries()){
            await page.$eval(`[data-daily-factor="${index}"]`,(i,v)=>{i.value=v;i.dispatchEvent(new Event('input',{bubbles:true}));},value);
        }
        assert((await page.$eval('[data-daily-preview]',n=>n.textContent)).includes('¥13.30 / ¥12.60 / ¥11.90 / ¥11.90'));
        await page.click('#pricingRatioSaveBtn');
        await page.waitForFunction(()=>document.getElementById('toast').textContent.includes('已保存'));
        const persisted=(await read()).channels.find(c=>c.channel==='uhaozu');
        assert.deepStrictEqual(persisted.daily_policy,{mode:'decrease',factors:[0.95,0.9,0.85,0.85]});
        await page.reload();await page.waitForSelector('[data-daily-mode="decrease"].active');
        assert.strictEqual(await page.$eval('[data-daily-factor="0"]',i=>i.value),'95');
        assert.strictEqual(await page.$eval('[data-daily-factor="3"]',i=>i.value),'85');
        const directory=path.resolve('coverage/daily-price-policy');fs.mkdirSync(directory,{recursive:true});
        for(const width of [375,1365]){
            await page.setViewport({width,height:900});
            for(const channel of ['uhaozu','zuhaowang','uuzuhao']){
                await page.click(`[data-pricing-ratio-channel="${channel}"]`);
                await page.click('[data-daily-mode="decrease"]');
                assert.strictEqual(await page.$eval('[data-daily-factor="0"]',i=>i.disabled),false);
                if(channel==='uuzuhao'){
                    const preview=await page.$eval('[data-daily-preview]',n=>n.textContent);
                    assert(preview.includes('四档短租示例'));
                    for(const hours of [2,3,5,7,9,10])assert(preview.includes(`${hours}h `));
                }
                const size=await page.evaluate(()=>({scroll:document.documentElement.scrollWidth,width:innerWidth,buttons:[...document.querySelectorAll('[data-daily-mode]')].map(b=>b.getBoundingClientRect().height)}));
                assert(size.scroll<=size.width,JSON.stringify(size));assert(size.buttons.every(h=>h>0&&h<=42));
                await page.screenshot({path:path.join(directory,`${channel}-${width}.png`),fullPage:true});
            }
        }
        // Switch away and back: per-channel unsaved drafts remain isolated.
        await page.click('[data-pricing-ratio-channel="uhaozu"]');
        assert.strictEqual(await page.$eval('[data-daily-factor="3"]',i=>i.value),'85');
        await page.$eval('[data-daily-factor="0"]',i=>{i.value='101';i.dispatchEvent(new Event('input',{bubbles:true}));});
        const beforeFirstInvalid=(await read()).channels[0].version;
        await page.click('#pricingRatioSaveBtn');
        assert.strictEqual((await read()).channels[0].version,beforeFirstInvalid,'invalid first coefficient not posted');
        await page.$eval('[data-daily-factor="0"]',i=>{i.value='95';i.dispatchEvent(new Event('input',{bubbles:true}));});
        await page.$eval('[data-daily-factor="3"]',i=>{i.value='101';i.dispatchEvent(new Event('input',{bubbles:true}));});
        const version=(await read()).channels[0].version;
        await page.click('#pricingRatioSaveBtn');
        assert.strictEqual((await read()).channels[0].version,version,'invalid UI policy not posted');
        await page.click('[data-daily-mode="follow"]');
        await page.click('#pricingRatioSaveBtn');
        await page.waitForFunction(()=>document.querySelector('[data-daily-mode="follow"].active')
            && !document.getElementById('pricingRatioSaveBtn').disabled);
        const restored=(await read()).channels[0];
        assert.strictEqual(restored.version,version+1);assert.strictEqual(restored.daily_policy.mode,'follow');
        assert.deepStrictEqual(errors,[]);
        const scripts=await page.coverage.stopJSCoverage();
        if(process.env.NODE_V8_COVERAGE){
            const result=scripts.filter(s=>new URL(s.url).pathname.startsWith('/js/')).map(s=>({
                ...s.rawScriptCoverage,url:path.resolve(__dirname,'../h5/public','.'+new URL(s.url).pathname)
            }));
            fs.writeFileSync(path.join(process.env.NODE_V8_COVERAGE,`coverage-browser-${process.pid}.json`),JSON.stringify({result}));
        }
        console.log('[PASS] authenticated H5 API, browser save/reload, invalid input, 3 channels x 2 viewports');
    }finally{
        if(browser)await browser.close();stopProdRiskTaskWorker();await new Promise(r=>server.close(r));
    }
}
main().catch(e=>{console.error(e);process.exitCode=1;});
