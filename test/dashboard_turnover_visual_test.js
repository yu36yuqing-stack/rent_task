'use strict';

const assert = require('node:assert/strict');
const path = require('node:path');
const fs = require('node:fs');
const puppeteer = require('puppeteer-core');

(async () => {
    const browser = await puppeteer.launch({
        executablePath: process.env.CHROME_PATH || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
        headless:true, args:['--disable-crash-reporter','--disable-breakpad']
    });
    try {
        const dir = path.resolve(__dirname,'../coverage/dashboard-turnover-ui');
        fs.mkdirSync(dir,{recursive:true});
        for (const width of [375,1280]) {
            const page = await browser.newPage();
            await page.setViewport({width,height:820});
            await page.goto('http://127.0.0.1:8080/',{waitUntil:'networkidle0'});
            await page.evaluate(() => {
                state.statsBoard = {game_name:'WZRY',period:'week',range:{start_date:'2026-11-16',end_date:'2026-11-22'},
                    summary:{total_rec_amount_all_time:100,amount_rec_sum:5,avg_daily_rec:5/7,
                        operating_metrics:{turnover_hours:168,turnover_rate:7,cancellation_rate:0.2,paid_orders:8,
                            unknown_receipts:2,missing_held_hours:0,missing_hours:1}},
                    calendar:{month:'2026-11',by_day:[]},by_account:[
                        {game_name:'WZRY',game_account:'A',avg_daily_rec:10,settled_daily_count:0.5,operating_metrics:{paid_orders_per_day:0.5}},
                        {game_name:'GTA6',game_account:'device:one',product_kind:'device',avg_daily_rec:0,settled_daily_count:0,operating_metrics:{paid_orders_per_day:0}},
                        {game_name:'WZRY',game_account:'future',avg_daily_rec:null,settled_daily_count:null}
                    ]};
                // Exercise the real renderer twice, as when switching periods.
                renderStatsView(); renderStatsView();
                for (let node = document.getElementById('statsView'); node; node=node.parentElement) {
                    node.classList.remove('hidden'); node.hidden=false;
                }
            });
            const cards = await page.$$eval('#statsKpiGrid .stats-kpi-card', nodes => nodes.map(n=>n.textContent.trim()));
            assert.equal(cards.length,16);
            assert.match(cards[13],/168\.0h\/天/); assert.equal(cards[13].includes('%'),false);
            assert.match(cards[15],/撤单率\s*20.0%/);
            const daily = await page.$$eval('.stats-acc-item', items => items.map(item =>
                [...item.querySelectorAll('.stats-acc-chip')].filter(chip =>
                    ['日均实收','日均单数'].includes(chip.querySelector('.stats-acc-chip-k').textContent))
                    .map(chip => chip.querySelector('.stats-acc-chip-v').textContent)));
            assert.deepEqual(daily,[['¥10.00','0.50'],['¥0.00','0.00'],['—','—']]);
            assert.equal(cards.filter(line=>line.includes('退款率')).length,0);
            assert.match(await page.$eval('#statsCoverageText',n=>n.textContent),/2 笔实收待核实/);
            assert.match(await page.$eval('#statsCoverageText',n=>n.textContent),/1 笔有收入订单时长待核实/);
            assert(await page.$eval('#statsKpiGrid',grid=>[...grid.children].every(c=>c.scrollWidth<=c.clientWidth+1)));
            assert.equal(await page.$('#statsMetricHelpBtn'),null);
            assert.equal(await page.$('#statsMetricHelpSheet'),null);
            await (await page.$('#statsKpiGrid')).screenshot({path:path.join(dir,String(width)+'.png')});
            await page.close();
        }
        console.log('PASS 16 cards, h/day only, no help icon and responsive layout at 375px / 1280px');
    } finally { await browser.close(); }
})().catch(err=>{console.error(err);process.exitCode=1;});
