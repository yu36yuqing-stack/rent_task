'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const puppeteer = require('puppeteer-core');
const convert = require('v8-to-istanbul');
const { createCoverageMap } = require('istanbul-lib-coverage');

(async () => {
    const dir = path.resolve(__dirname,'../coverage/stats-account-metrics/ui');
    fs.mkdirSync(dir,{recursive:true});
    const coverage = createCoverageMap({});
    const browser = await puppeteer.launch({ executablePath:process.env.CHROME_PATH || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
        headless:true, args:['--disable-crash-reporter','--disable-breakpad'] });
    try {
        for (const width of [375,1280]) {
            const page = await browser.newPage();
            const errors = [];
            page.on('pageerror', error => errors.push(error.message));
            await page.setViewport({width,height:900});
            await page.coverage.startJSCoverage({includeRawScriptCoverage:true});
            await page.goto('http://127.0.0.1:8080/',{waitUntil:'networkidle0'});
            const result = await page.evaluate(async () => {
                window.testCalls = []; window.testAlerts = [];
                alert = value => testAlerts.push(value);
                window.confirm = () => true;
                showToast = () => {};
                renderList = () => {};
                const metric = { cumulative_cost:120,sale_amount:0,payback:0.5,income_per_asset_day:1,
                    annual_rent_return:1.23,paid_orders:2,paid_orders_per_day:0.5,income_per_order:4.47,
                    hours_per_paid_order:2,rented_asset_rate:1,turnover_hours:168,turnover_rate:7,
                    hourly_income:2.235,cancellation_rate:0.2,missing_hours:1,unknown_receipts:2,
                    missing_held_hours:1,missing_holding:1,missing_cost:1 };
                const source = { total_rec_amount_all_time:60,amount_rec_sum:8.94,avg_daily_rec:1,
                    operating_metrics:metric };
                const base = { ...source,game_name:'WZRY',game_account:'A',display_name:'合并账号',purchase_date:'2026-01-01',
                    purchase_base:100,total_cost_amount:120,settled_orders:{paid:2,cancelled:1} };
                const fixture = () => ({game_name:'全部',period:'week',range:{start_date:'2026-11-16',end_date:'2026-11-22'},
                    summary:{...source},calendar:{month:'2026-11',by_day:[{stat_date:'2026-11-22',amount_rec_sum:8.94}]},
                    by_account:[{...base},{...base,game_name:'GTA6',game_account:'device:one',product_kind:'device',
                        device_no:'XSX_01',cost_detail_available:true,cost_configured:true},
                        {...base,game_account:'sold',asset_status:'sold',sold_at:'2026-11-20',sold_price:90,lifecycle_profit_amount:30},
                        {game_name:'CFM',game_account:'unknown',operating_metrics:{},avg_daily_rec:null},
                        {...base,game_name:'GTA6',game_account:'device:old',product_kind:'device',cost_detail_available:false,cost_configured:false}]});
                window.testFixture = fixture;
                let failRequest = false, failLoad = false;
                request = async (url, options) => {
                    testCalls.push({url,method:options?.method||'GET'});
                    if (failRequest) throw Error('模拟接口失败');
                    if (url.includes('calendar')) return {month:'2026-11',by_day:[]};
                    if (options?.method === 'POST') return {data:{total_cost_amount:10}};
                    return {game_account:'A',game_name:'WZRY',display_name:'成本账号',total_cost_amount:120,
                        purchase_cost_amount:100,list:[{id:1,cost_type:'purchase',cost_amount:100,cost_date:'2026-01-01'},
                            {id:2,cost_type:'maintenance',cost_amount:10,cost_date:'2026-11-01'},
                            {id:3,cost_type:'other',cost_amount:10,cost_date:'2026-11-02',cost_desc:'资料'}]};
                };
                loadStatsBoard = async () => { if(failLoad)throw Error('模拟报表失败'); const old=state.statsBoard;
                    state.statsBoard={...fixture(),period:old.period,game_name:old.game_name,selected_date:old.selected_date}; };
                state.statsBoard=fixture(); renderStatsView(); renderStatsView();
                for(let n=document.getElementById('statsView');n;n=n.parentElement){n.classList.remove('hidden');n.hidden=false;}
                const header=[...document.querySelectorAll('#statsKpiGrid [data-metric]')].map(n=>({key:n.dataset.metric,
                    label:n.querySelector('.stats-kpi-key').textContent.replace('?',''),value:n.querySelector('.stats-kpi-value').textContent}));
                const cards=[...document.querySelectorAll('.stats-acc-item')].map(n=>({
                    items:[...n.querySelectorAll('.stats-acc-metrics [data-metric]')].map(c=>({key:c.dataset.metric,
                        label:c.querySelector('.stats-acc-chip-k').textContent.replace('›',''),value:c.querySelector('.stats-acc-chip-v').textContent})),
                    totalChips:n.querySelectorAll('.stats-acc-chip').length,
                    grids:n.querySelectorAll('.stats-acc-grid').length,
                    rows:new Set([...n.querySelectorAll('.stats-acc-chip')].map(c=>Math.round(c.getBoundingClientRect().top))).size,
                    columns:new Set([...n.querySelectorAll('.stats-acc-chip')].map(c=>Math.round(c.getBoundingClientRect().left))).size,
                    hasExtra:Boolean(n.querySelector('.stats-acc-extra')),
                    sold:Boolean(n.querySelector('.chip')),
                    coverage:n.querySelector('.stats-acc-coverage')?.textContent||''}));
                const first = document.querySelector('[data-stats-cost-detail]');first.click();
                await new Promise(resolve=>setTimeout(resolve,0));
                const costOpened=!els.statsCostDetailSheet.classList.contains('hidden');
                bindStatsCostDetailSheetEvents();els.statsCostDetailClose.click();
                await window.openStatsCostDetailExternal(base);
                els.statsCostDetailSheet.dispatchEvent(new MouseEvent('click',{bubbles:true}));
                await window.openStatsCostDetailExternal({});
                state.statsCostDetail={open:true,list:[],game_account:'A'};renderStatsCostDetailSheet();
                state.statsCostDetail={open:true,loading:true};renderStatsCostDetailSheet();
                state.statsCostDetail={open:true,error:'错误'};renderStatsCostDetailSheet();
                state.statsCostDetail={open:true,list:[{id:9,cost_type:'other',cost_amount:1}],read_only:true};renderStatsCostDetailSheet();
                failRequest=true;await openStatsCostDetail(base);failRequest=false;
                await openStatsCostDetail(base);
                state.list=[{game_account:'other',game_name:'WZRY'},base,{...base,game_name:'CFM'}];
                state.statsBoard.by_account=[...state.list];
                await deleteStatsCostDetail(0);
                await deleteStatsCostDetail(3);
                await openStatsCostDetail(base);failLoad=true;await deleteStatsCostDetail(1);failLoad=false;
                await openStatsCostDetail(base);failRequest=true;await deleteStatsCostDetail(2);failRequest=false;
                window.confirm=()=>false;await openStatsCostDetail(base);
                document.querySelector('[data-cost-delete-id]').click();
                window.confirm=()=>true;document.querySelector('[data-cost-delete-id]').click();
                await new Promise(resolve=>setTimeout(resolve,0));closeStatsCostDetailSheet();
                state.statsBoard.missing_purchase_accounts=[];renderStatsMissingOverlay();
                state.statsBoard.missing_purchase_accounts=[{game_account:'missing',display_name:'待补'}];renderStatsMissingOverlay();
                state.statsBoard.missing_purchase_accounts=[];renderStatsMissingOverlay();
                await loadStatsCalendar('invalid');renderStatsCalendar();
                state.statsBoard.calendar={month:'bad',by_day:[]};renderStatsCalendar();
                state.statsBoard.calendar={month:'2026-11',by_day:[]};state.statsBoard.selected_date='2026-11-01';renderStatsCalendar();
                document.querySelector('[data-stat-date="2026-11-01"]').click();await new Promise(r=>setTimeout(r,0));
                document.querySelector('[data-stat-date="2026-11-02"]').click();await new Promise(r=>setTimeout(r,0));
                failLoad=true;document.querySelector('[data-stat-date="2026-11-03"]').click();await new Promise(r=>setTimeout(r,0));failLoad=false;
                els.statsCalMonth.value='2026-10';await els.statsCalMonth.onchange();
                failRequest=true;await els.statsCalMonth.onchange();failRequest=false;
                for(const game of ['WZRY','GTA6','和平精英','CFM','CSGO','全部']) {
                    document.querySelector(`[data-stats-game="${game}"]`).click();await new Promise(r=>setTimeout(r,0));
                }
                document.querySelector('[data-stats-game="全部"]').click();
                for(const period of ['week','last7','month','last30']){
                    document.querySelector(`[data-stats-period="${period}"]`).click();await new Promise(r=>setTimeout(r,0));
                }
                document.querySelector('[data-stats-period="last30"]').click();
                state.statsBoard.by_account=[];renderStatsView();
                gameIconByName('unknown');
                state.statsBoard=fixture();renderStatsView();
                return {header,cards,costOpened,calls:testCalls,alerts:testAlerts};
            });
            assert.equal(result.header.length,16);
            assert.equal(result.cards.length,5);
            for(const card of result.cards)assert.deepEqual(card.items.map(x=>[x.key,x.label]),result.header.map(x=>[x.key,x.label]));
            assert.deepEqual(result.cards[0].items.map(x=>x.value),result.header.map(x=>x.value));
            assert.equal(result.cards[3].items.every(x=>x.value==='—'),true);
            for(const card of result.cards){
                assert.equal(card.totalChips,16);assert.equal(card.grids,1);
                assert.equal(card.rows,4);assert.equal(card.columns,4);assert.equal(card.hasExtra,false);
            }
            assert.equal(result.cards[2].sold,true);
            assert.match(result.cards[0].coverage,/实收待核实/);
            assert.equal(result.costOpened,true);
            assert(result.calls.some(x=>x.url.includes('account-cost-detail')));
            assert(result.calls.some(x=>x.method==='POST'));
            assert.deepEqual(errors,[]);
            assert(await page.$eval('#statsView',n=>n.scrollWidth<=n.clientWidth+1));
            assert(await page.$$eval('.stats-acc-metrics [data-metric]',ns=>ns.every(n=>n.scrollWidth<=n.clientWidth+1)));
            await (await page.$('.stats-acc-item')).screenshot({path:path.join(dir,'account-'+width+'.png')});
            const entries=await page.coverage.stopJSCoverage();
            for(const entry of entries.filter(e=>/\/js\/menu_stats\.js/.test(e.url))){
                const file=path.resolve(__dirname,'../h5/public/js/menu_stats.js');
                const converter=convert(file,0,{source:entry.text});await converter.load();
                converter.applyCoverage(entry.rawScriptCoverage.functions);coverage.merge(converter.toIstanbul());
            }
            await page.close();
            console.log('PASS strict 4x4 / 16 total cells, no extra row, cost detail, calendar and layout '+width+'px');
        }
        fs.writeFileSync(path.join(dir,'coverage.json'),JSON.stringify(coverage.toJSON()));
    }finally{await browser.close();}
})().catch(error=>{console.error(error);process.exitCode=1;});
