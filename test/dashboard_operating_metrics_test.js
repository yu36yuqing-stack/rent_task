'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'rent-dashboard-'));
for (const name of ['MAIN', 'ORDER', 'STATS', 'RUNTIME', 'PRICE']) {
    process.env[name + '_DB_FILE_PATH'] = path.join(temp, name + '.db');
}
const { receiptNote } = require('../order/report_receipt');
const { parseUhaozuOrderDetailHtml } = require('../uhaozu/uhaozu_api');
const { readDashboardOrders } = require('../order/service/dashboard_order_facts');
const { dashboardMetrics, orderTotals } = require('../stats/dashboard_metrics');
const { upsertOrder } = require('../database/order_db');
const { upsertOrderDetail } = require('../database/order_detail_db');
const { initUserGameAccountDb } = require('../database/user_game_account_db');
const { openDatabase } = require('../database/sqlite_client');
const { promisify } = require('node:util');
const { getOrderStatsDashboardByUser, refreshOrderStatsDailyByUser } = require('../stats/order_stats');

async function test() {
    const range = { startDate: '2026-11-16', endDate: '2026-11-22' };
    const a = { game_name:'WZRY', game_account:'A', purchase_date:'2026-01-01', purchase_price:100, total_cost_amount:120 };
    const b = { ...a, game_account:'B', asset_status:'sold', sold_at:'2026-11-18', sold_price:80,
        purchase_date:'2026-11-17', total_cost_amount:100 };
    const order = { ...a, user_id:8, channel:'uuzuhao', order_no:'long', order_status:'已完成',
        start_time:'2026-11-09 10:00:00', end_time:'2026-11-16 10:00:00', rent_hour:168, rec_amount:42 };
    const short = { ...order, channel:'uhaozu', order_no:'partial', order_status:'部分完成', rent_hour:24,
        rec_amount:2, start_time:'2026-11-16 13:00:00', end_time:'2026-11-17 13:00:00', complete_time:'2026-11-16 15:00:00' };
    const zero = { ...order, order_no:'refund', order_status:'已退款', rec_amount:0, desc:receiptNote('test','0'),
        rent_duration:'0小时30分钟0秒' };
    const unsent = { ...zero, order_no:'unknown', desc:receiptNote('test',null), rent_duration:'' };
    assert.equal(receiptNote('sync',1,false),'sync [receipt:pending]');
    assert.equal(parseUhaozuOrderDetailHtml('').net_rent_confirmed,false);
    const costs = [{...a,cost_type:'purchase',cost_amount:100,cost_date:a.purchase_date},
        {...a,cost_type:'other',cost_amount:20,cost_date:'2026-11-22'}];
    const m = dashboardMetrics([a,b], [order,short,zero,unsent], costs, range,100, new Map(), [{...a,stat_date:'2026-11-16',amount_rec_sum:44}]);
    assert.equal(m.held_days,9);
    assert.equal(m.rented_asset_rate,0.5);
    assert.equal(m.turnover_hours,170.5/9);
    assert.equal(m.turnover_rate,170.5/9/24);
    assert.equal(m.cancellation_rate,1/3);
    assert.equal(m.unknown_receipts,1);
    assert.equal(m.missing_hours,1);
    assert.equal(m.hourly_income,44/170.5);
    assert.equal(m.hours_per_paid_order,85);
    assert.equal(m.annual_rent_return,44*365/(720+200));
    assert.equal(m.income_per_asset_day,44/9);
    assert.equal(m.payback,180/220);
    const day = {startDate:'2026-11-16',endDate:'2026-11-16'};
    assert.equal(dashboardMetrics([a],[order],[],day,0).turnover_rate,7);
    assert.equal(dashboardMetrics([a],[],[],day,0).turnover_hours,0);
    assert.equal(dashboardMetrics([a],[],[],day,0).cancellation_rate,null);
    assert.equal(dashboardMetrics([a],[unsent],[],day,0).turnover_hours,null);
    const noDate = dashboardMetrics([{...a, purchase_date:'', total_cost_amount:0, purchase_price:0}],[],[],day,0);
    assert.equal(noDate.missing_holding,1); assert.equal(noDate.turnover_hours,null); assert.equal(noDate.payback,null);
    assert.equal(orderTotals([{...order,channel:'zuhaowang',ren_way:'包天',rent_hour:7}]).hours,168);
    assert.equal(orderTotals([{...short, complete_time:'bad'}]).missingHours,1);
    assert.equal(orderTotals([{...order, source_amount:'0',rec_amount:0}]).cancelled,1);
    assert.equal(orderTotals([{...zero,detail_net:0}]).cancelled,1);
    assert.equal(orderTotals([{...zero, desc:'old'}]).unknown,1);
    assert.equal(orderTotals([{...order,order_status:'已退款',desc:receiptNote('test',2)}]).paid,1);
    await readDashboardOrders(8,'全部',day.startDate,day.endDate);
    for (const row of [order,short,zero,unsent,{...zero,order_no:'ongoing',order_status:'租赁中'},
        {...order,order_no:'settling',order_status:'结算中'},{...order,user_id:9},{...order,game_account:'C',game_id:2,game_name:'和平精英',order_no:'other-game'}]) {
        await upsertOrder({...row,game_id:row.game_id||1});
    }
    await upsertOrderDetail({...short,order_detail_no:short.order_no,detail_snapshot:{net_rent_confirmed:true},net_rent_amount:2});
    const facts = await readDashboardOrders(8,'WZRY',range.startDate,range.endDate+' 23:59:59');
    assert.equal(facts.length,4);
    assert.equal(orderTotals(facts).paid,2); assert.equal(orderTotals(facts).cancelled,1);
    assert.equal(orderTotals(facts).hours,170);
    assert.equal((await readDashboardOrders(8,'WZRY','2026-11-09','2026-11-15 23:59:59')).length,0);
    assert.equal((await readDashboardOrders(8,'GTA6',range.startDate,range.endDate)).length,0);
    await initUserGameAccountDb();
    const db = openDatabase();
    for (const account of ['A','idle']) {
        await promisify(db.run).call(db,`INSERT INTO user_game_account (user_id,game_account,game_id,game_name,purchase_date,purchase_price)
            VALUES (8,?,'1','WZRY','2026-01-01',100)`,account);
    }
    await promisify(db.close).call(db);
    const report = await getOrderStatsDashboardByUser(8,{period:'last7',game_name:'WZRY',now:new Date('2026-11-23T12:00:00+08:00')});
    assert.equal(report.summary.operating_metrics.held_days,14);
    assert.equal(report.summary.operating_metrics.paid_orders,2);
    assert.equal(report.summary.operating_metrics.turnover_hours,170/14);
    assert.equal(report.by_account.find(row=>row.game_account==='A').settled_orders.cancelled,1);
    const main = openDatabase();
    await promisify(main.run).call(main, `INSERT INTO user_game_account (user_id,game_account,game_id,game_name)
        VALUES (8,'no-cost','1','WZRY')`);
    await promisify(main.close).call(main);
    await upsertOrder({...order,order_no:'no-cost',game_account:'no-cost',game_id:1,rec_amount:7});
    const dayOptions = {game_name:'WZRY',now:new Date('2026-11-16T23:00:00+08:00')};
    await refreshOrderStatsDailyByUser(8,{...dayOptions,days:1});
    const daily = await getOrderStatsDashboardByUser(8,{...dayOptions,period:'today'});
    // Daily income includes the previously booked 42 on the settling order; terminal counts exclude it.
    assert.equal(daily.summary.amount_rec_sum,91);
    assert.equal(daily.summary.operating_metrics.paid_orders,2);
    assert.equal(daily.summary.operating_metrics.missing_holding,1);
}
test().then(()=>console.log('PASS dashboard turnover, settled orders, data gaps and scope'))
    .catch(err=>{console.error(err);process.exitCode=1;}).finally(()=>fs.rmSync(temp,{recursive:true,force:true}));
