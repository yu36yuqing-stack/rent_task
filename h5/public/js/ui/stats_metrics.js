(function (root) {
  'use strict';

  const groups = [
    { name: '投入回收', keys: ['cumulative_cost', 'total_rec_amount_all_time', 'sale_amount', 'payback'],
      labels: ['累计总成本', '累计租金', '售出金额', '回本进度'] },
    { name: '期间收益', keys: ['amount_rec_sum', 'avg_daily_rec', 'income_per_asset_day', 'annual_rent_return'],
      labels: ['区间实收', '日均实收', '单号日均实收', '年化租金回报'] },
    { name: '订单产出', keys: ['paid_orders', 'paid_orders_per_day', 'income_per_order', 'hours_per_paid_order'],
      labels: ['有效订单', '日均单数', '单均实收', '单均有效租期'] },
    { name: '经营效率', keys: ['rented_asset_rate', 'turnover_hours', 'hourly_income', 'cancellation_rate'],
      labels: ['出单账号率', '账号周转率', '折算时租', '撤单率'] }
  ];
  const money = new Set(['cumulative_cost', 'total_rec_amount_all_time', 'sale_amount',
    'amount_rec_sum', 'avg_daily_rec', 'income_per_asset_day', 'income_per_order', 'hourly_income']);
  const rates = new Set(['payback', 'annual_rent_return', 'rented_asset_rate', 'cancellation_rate']);
  const escape = value => String(value).replace(/[&<>"']/g, ch => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
  })[ch]);

  function items(source = {}) {
    const metrics = source.operating_metrics || {};
    return groups.flatMap(group => group.keys.map((key, index) => {
      const raw = ['total_rec_amount_all_time', 'amount_rec_sum', 'avg_daily_rec'].includes(key)
        ? source[key] : metrics[key];
      let value = '—';
      if (Number.isFinite(raw)) {
        if (money.has(key)) value = '¥' + raw.toFixed(2);
        else if (rates.has(key)) value = (raw * 100).toFixed(1) + '%';
        else if (key === 'turnover_hours') {
          value = (metrics.missing_held_hours ? '≥' : '') + raw.toFixed(1) + 'h/天';
        } else if (key === 'hours_per_paid_order') value = raw.toFixed(1) + ' 小时';
        else value = raw.toFixed(key === 'paid_orders' ? 0 : 2);
      }
      return { key, label: group.labels[index], group: group.name, value };
    }));
  }

  function render(source = {}, options = {}) {
    const account = options.account === true;
    const prefix = account ? 'stats-acc-chip' : 'stats-kpi';
    return items(source).map(item => {
      const clickable = account && options.costDetail && item.key === 'cumulative_cost';
      const attrs = clickable ? ` data-stats-cost-detail="${escape(source.game_account)}" data-stats-cost-game="${escape(source.game_name)}"` : '';
      return `<div class="${account ? prefix : prefix + '-card'}${clickable ? ' is-clickable' : ''}" data-metric="${item.key}" data-metric-group="${item.group}"${attrs}>
        <p class="${account ? prefix + '-k' : prefix + '-key'}">${item.label}${clickable ? '<span class="stats-acc-chip-mark">›</span>' : ''}</p>
        <p class="${account ? prefix + '-v' : prefix + '-value'} stats-metric-value${!account && item.value.startsWith('¥') ? ' money' : ''}">${item.value}</p>
      </div>`;
    }).join('');
  }

  function coverageText(metrics = {}) {
    return [
      metrics.missing_hours ? `${metrics.missing_hours} 笔有收入订单时长待核实` : '',
      metrics.unknown_receipts ? `${metrics.unknown_receipts} 笔实收待核实` : '',
      metrics.missing_holding ? `${metrics.missing_holding} 个资产未计持有期` : '',
      metrics.missing_cost ? `${metrics.missing_cost} 个资产成本待补` : ''
    ].filter(Boolean).join(' · ');
  }

  root.StatsMetrics = { groups, items, render, coverageText };
  if (typeof module !== 'undefined') module.exports = root.StatsMetrics;
})(typeof window !== 'undefined' ? window : globalThis);
