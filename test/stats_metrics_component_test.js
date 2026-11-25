'use strict';
const assert = require('node:assert/strict');
const vm = require('node:vm');
const fs = require('node:fs');
const { items, render, coverageText, groups } = require('../h5/public/js/ui/stats_metrics');
const { accountOperatingMetrics, dashboardMetrics } = require('../stats/dashboard_metrics');

const range = { startDate: '2026-11-16', endDate: '2026-11-22' };
const a = { game_name:'WZRY', game_account:'A', purchase_date:'2026-11-01', purchase_price:100, total_cost_amount:120 };
const b = { ...a, game_name:'和平精英', purchase_date:'2026-11-20', purchase_price:20, total_cost_amount:20 };
const device = { ...a, game_name:'GTA6', game_account:'device:1' };
const order = { ...a, order_status:'已完成', channel:'uuzuhao', rec_amount:4.47, rent_hour:2,
    start_time:'2026-11-22 10:00:00', end_time:'2026-11-22 12:00:00' };
const rows = [{ ...a, stat_date:'2026-11-22', amount_rec_sum:4.47 }];
const costs = [{ ...a, cost_type:'purchase', cost_date:'2026-11-01', cost_amount:100 },
    { ...a, cost_type:'maintenance', cost_date:'2026-11-22', cost_amount:20 }];
const historical = new Map([['A', 50], ['device:1', 12]]);
const scoped = accountOperatingMetrics([a,b,device],[order],costs,range,historical,rows);
const { daily_averages, ...expected } = dashboardMetrics([a,b],[order],costs,range,50,new Map(),rows);
assert.deepEqual(scoped.get('A'), expected);
assert.equal(scoped.get('A').cumulative_cost,140);
assert.equal(scoped.get('A').rented_asset_rate,0.5);
assert.equal(scoped.get('A').income_per_order,4.47);
assert.equal(scoped.get('device:1').paid_orders,0);
assert.deepEqual([...accountOperatingMetrics([],[],[],range,new Map(),[])],[]);
const source = { game_account:'A', game_name:'WZRY', amount_rec_sum:4.47,
    total_rec_amount_all_time:50, avg_daily_rec:4.47/7, operating_metrics:expected };
const summary = items(source), account = items({ ...source });
assert.deepEqual(summary,account);
assert.equal(summary.length,16);
assert.deepEqual(summary.map(x=>x.label),groups.flatMap(g=>g.labels));
assert.equal(summary[10].value,'¥4.47');
assert.equal(summary[12].value,'50.0%');
assert.equal(items()[0].value,'—');
assert.equal(items({operating_metrics:{}})[15].value,'—');
const zero = items({amount_rec_sum:0,avg_daily_rec:0,total_rec_amount_all_time:0,
    operating_metrics:{paid_orders:0,paid_orders_per_day:0,turnover_hours:0,turnover_rate:0,hours_per_paid_order:0}});
assert.equal(zero[4].value,'¥0.00');
assert.equal(zero[8].value,'0'); assert.equal(zero[9].value,'0.00');
assert.equal(zero[11].value,'0.0 小时'); assert.equal(zero[13].value,'0.0h/天');
const partial = items({operating_metrics:{turnover_hours:168,turnover_rate:7,missing_held_hours:1}})[13];
assert.equal(partial.value,'≥168.0h/天');assert.equal('secondary' in partial,false);
assert.equal(items({operating_metrics:{turnover_hours:1}})[13].value,'1.0h/天');
const html=render({...source,game_account:'A"<&\'>',game_name:'<game>'},{account:true,costDetail:true});
assert.equal((html.match(/data-metric="/g)||[]).length,16);
assert.match(html,/data-stats-cost-detail="A&quot;&lt;&amp;&#39;&gt;"/);
assert.match(html,/stats-acc-chip-k/);assert.match(html,/stats-acc-chip-v/);
assert.equal(render(source).includes('data-turnover-label'),false);
assert.equal(render(source,{account:true}).includes('data-stats-cost-detail'),false);
assert.equal((render().match(/data-metric="/g)||[]).length,16);
assert.equal(coverageText(),'');
assert.equal(coverageText({missing_hours:1,unknown_receipts:2,missing_holding:3,missing_cost:4}),
    '1 笔有收入订单时长待核实 · 2 笔实收待核实 · 3 个资产未计持有期 · 4 个资产成本待补');
const browser = { window:{} };
vm.runInNewContext(fs.readFileSync(require.resolve('../h5/public/js/ui/stats_metrics'),'utf8'),browser);
assert.equal(browser.window.StatsMetrics.items(source).length,16);
console.log('PASS shared 16 metrics, asset grouping, zero/unknown, duration gaps and escaped cost identity');
