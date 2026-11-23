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
const { replaceOrderStatsRowsForDay } = require('../database/order_stats_daily_db');
const { replaceDeviceSnapshot, initRentalDeviceDb } = require('../database/rental_device_db');
const { createAccountCostRecord } = require('../database/account_cost_record_db');
const { openDatabase } = require('../database/sqlite_client');
const { promisify } = require('node:util');
const { getOrderStatsDashboardByUser, getAccountCostDetailByUser, refreshOrderStatsDailyByUser } = require('../stats/order_stats');

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
    assert.equal(m.turnover_hours,170/9);
    assert.equal(m.turnover_rate,170/9/24);
    assert.equal(m.cancellation_rate,1/3);
    assert.equal(m.unknown_receipts,1);
    assert.equal(m.missing_hours,0);
    assert.equal(m.missing_held_hours,1);
    assert.equal(m.hourly_income,44/170.5);
    assert.equal(m.hours_per_paid_order,85);
    assert.equal(m.annual_rent_return,44*365/(720+200));
    // Daily averages run to the window end; turnover stops on the sale date.
    assert.equal(m.income_per_asset_day,44/13);
    assert.equal(m.payback,180/220);
    const day = {startDate:'2026-11-16',endDate:'2026-11-16'};
    assert.equal(dashboardMetrics([a],[order],[],day,0).turnover_rate,7);
    assert.equal(dashboardMetrics([a],[],[],day,0).turnover_hours,0);
    assert.equal(dashboardMetrics([a],[],[],day,0).cancellation_rate,null);
    assert.equal(dashboardMetrics([a],[unsent],[],day,0).turnover_hours,null);
    for (const duration of ['0小时30分钟0秒', '']) {
        const holding = new Map();
        const zeroOnly = dashboardMetrics([a],[{...zero, rent_duration:duration}],[],day,0,holding);
        assert.equal(zeroOnly.turnover_rate,0);
        assert.equal(zeroOnly.missing_hours,0);
        assert.equal(zeroOnly.missing_held_hours,0);
        assert.deepEqual(holding.get('A'),{days:1,hours:0,timed:1,missing:0,
            daily:{days:1,income:0,paid:0,effectiveOrders:0,rentHours:0}});
    }
    const unknownTimed = dashboardMetrics([a],[{...unsent,rent_duration:'1小时'}],[],day,0);
    assert.equal(unknownTimed.turnover_hours,null);
    assert.equal(unknownTimed.unknown_receipts,1);
    assert.equal(unknownTimed.missing_hours,0);
    assert.equal(dashboardMetrics([a],[{...unsent,rent_duration:'0分钟'}],[],day,0).turnover_hours,0);
    const partial = dashboardMetrics([a],[order,{...zero,desc:receiptNote('test',2),rent_duration:''}],[],day,0);
    assert.equal(partial.turnover_hours,168);
    assert.equal(partial.missing_hours,1);
    assert.equal(partial.missing_held_hours,1);
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
    assert.equal(report.by_account.find(row=>row.game_account==='A').turnover_hours,170/7);
    assert.equal(report.by_account.find(row=>row.game_account==='A').turnover_partial,true);
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
async function testOperatingDays() {
    const uid = 18;
    const now = new Date('2026-12-01T12:00:00+08:00');
    const options = {period:'last30', now};
    const main = openDatabase();
    for (const [gameId, game, account, date] of [
        ['1','WZRY','A','2026-11-21'], ['2','和平精英','A','2026-11-26'],
        ['1','WZRY','future','2026-12-01']
    ]) {
        await promisify(main.run).call(main, `INSERT INTO user_game_account
            (user_id,game_id,game_name,game_account,purchase_date,purchase_price) VALUES (?,?,?,?,?,10)`,
            [uid,gameId,game,account,date]);
    }
    await promisify(main.close).call(main);
    await initRentalDeviceDb();
    await replaceDeviceSnapshot(uid,[{deviceId:'one',deviceName:'主机',deviceNo:'01'}]);
    await createAccountCostRecord({user_id:uid,game_id:'GTA6',game_account:'device:one',
        cost_type:'purchase',cost_amount:100,cost_date:'2026-11-18'});
    for (const [type,date,amount] of [['purchase','2026-11-21',10],['other','2026-11-29',2]]) {
        await createAccountCostRecord({user_id:uid,game_id:'1',game_account:'A',
            cost_type:type,cost_date:date,cost_amount:amount});
    }
    for (const [game, date, income, count] of [
        ['WZRY','2026-11-20',77,1], ['WZRY','2026-11-21',80,4],
        ['WZRY','2026-11-30',20,1], ['和平精英','2026-11-26',50,1]
    ]) {
        await replaceOrderStatsRowsForDay(uid,date,game,[{channel:'uuzuhao',game_account:'A',
            amount_rec_sum:income,order_cnt_effective:count,rent_hour_sum:count*2}]);
        for (let i=0; i<count; i++) await upsertOrder({user_id:uid,channel:'uuzuhao',order_no:date+'-'+i,
            game_name:game,game_id:game==='WZRY'?'1':'2',game_account:'A',order_status:'已完成',rec_amount:income/count,
            start_time:date+' 09:00:00',end_time:date+' 11:00:00',rent_hour:2});
    }
    const wz = await getOrderStatsDashboardByUser(uid,{...options,game_name:'WZRY'});
    assert.equal(wz.summary.amount_rec_sum,177);
    assert.equal(wz.summary.operating_days,10);
    assert.equal(wz.summary.avg_daily_rec,10);
    const card = wz.by_account.find(x=>x.game_account==='A');
    const costs = await getAccountCostDetailByUser(uid,{game_name:'WZRY',game_account:'A'});
    assert.equal(costs.purchase_cost_amount,10);
    assert.equal(costs.list.find(x=>x.cost_type==='purchase').cost_date,card.purchase_date);
    assert.equal(costs.list.find(x=>x.cost_type==='other').cost_date,'2026-11-29');
    assert.equal(card.avg_daily_rec,10);
    assert.equal(card.settled_daily_count,0.5);
    assert.equal(card.avg_daily_order_cnt,0.5);
    assert.equal(card.avg_daily_rent_hour,1);
    const future = wz.by_account.find(x=>x.game_account==='future');
    assert.equal(future.operating_days,0);
    assert.equal(future.avg_daily_rec,null);
    assert.equal(future.settled_daily_count,null);
    const all = await getOrderStatsDashboardByUser(uid,{...options,game_name:'全部'});
    assert.equal(all.summary.operating_days,13);
    assert.equal(all.summary.avg_daily_rec,Number((150/13).toFixed(4)));
    assert.equal(all.summary.operating_metrics.paid_orders_per_day,6/13);
    assert.equal(all.summary.operating_metrics.income_per_asset_day,150/(10+5+13));
    const shared = all.by_account.find(x=>x.game_account==='A');
    assert.equal(shared.operating_days,10);
    assert.equal(shared.avg_daily_rec,15);
    assert.equal(shared.settled_daily_count,0.6);
    assert.equal(all.by_account.find(x=>x.game_account==='device:one').avg_daily_rec,0);
    const firstDay = await getOrderStatsDashboardByUser(uid,{stat_date:'2026-11-18',game_name:'GTA6',now});
    assert.equal(firstDay.summary.operating_days,1);
    assert.equal(firstDay.summary.avg_daily_rec,0);
    const before = await getOrderStatsDashboardByUser(uid,{stat_date:'2026-11-17',game_name:'GTA6',now});
    assert.equal(before.summary.operating_days,0);
    assert.equal(before.summary.operating_metrics.paid_orders_per_day,null);
    assert.equal(before.by_account[0].avg_daily_rec,null);
    const last7 = await getOrderStatsDashboardByUser(uid,{period:'last7',game_name:'WZRY',now});
    assert.equal(last7.summary.operating_days,7);
    assert.equal(last7.summary.avg_daily_rec,Number((20/7).toFixed(4)));
}

test().then(testOperatingDays).then(()=>console.log('PASS dashboard turnover, operating days, settled orders, data gaps and scope'))
    .catch(err=>{console.error(err);process.exitCode=1;}).finally(()=>fs.rmSync(temp,{recursive:true,force:true}));
