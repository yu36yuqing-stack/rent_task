(function (root) {
  'use strict';
  const modes = { follow: '跟随时租', flat: '日租持平', decrease: '日租递减' };
  function draft(policy = {}) {
    return { mode: policy.mode || 'follow', percentages: (policy.factors || [1, 1, 0.95, 0.9]).map(value => String(Number((value * 100).toFixed(2)))) };
  }
  function parse(value) {
    if (!Object.hasOwn(modes, value.mode)) throw new Error('请选择有效的日租模式');
    const percentages = value.mode === 'follow' ? [100, 100, 95, 90]
      : value.mode === 'flat' ? [100, 100, 100, 100] : value.percentages;
    if (!Array.isArray(percentages) || percentages.length !== 4) throw new Error('请填写四档日租系数');
    const factors = percentages.map(value => Number(Number(value).toFixed(2)) / 100);
    if (factors.some((value, i) => !Number.isFinite(value) || value <= 0 || value > 1 || (i > 0 && value > factors[i - 1]))) {
      throw new Error('日租系数须大于0且不超过100%，后续不得递增');
    }
    return { mode: value.mode, factors };
  }
  function render(value, saving, escape) {
    return `<div class="pricing-ratio-copy"><strong>日租阶梯</strong><span>调整包天/24小时套餐；U号租递减模式下包夜也按首档基准同比递减。保存后作用于该渠道全部已配置账号。</span></div>
      <div class="orders-tabs">${Object.entries(modes).map(([mode, label]) => `<button type="button" class="orders-tab header-tab ${value.mode === mode ? 'active' : ''}" data-daily-mode="${mode}" ${saving ? 'disabled' : ''}>${label}</button>`).join('')}</div>
      <div class="pricing-ratio-grid ${value.mode === 'decrease' ? '' : 'hidden'}">${value.percentages.map((percentage, i) => `<label class="pricing-ratio-field"><span>第${i + 1}档日租</span><div class="pricing-price-input"><input type="number" min="0.01" max="100" step="0.01" inputmode="decimal" data-daily-factor="${i}" aria-label="第${i + 1}档日租百分比" value="${escape(percentage)}" ${saving ? 'disabled' : ''}><span>%</span></div></label>`).join('')}</div>
      <p class="head-summary-text" data-daily-preview></p>`;
  }
  function preview(value, channel, hourly, normalize) {
    if (value.mode === 'follow') return '日租按各档时租价 × 本渠道日租倍率计算。';
    try {
      const policy = parse(value);
      const key = channel.channel === 'uhaozu' ? 'day' : 'p24';
      const base = normalize(Number(hourly) * Number(channel.ratios[key]), (channel.price_rules || {})[key]);
      if (!(base > 0)) return '请输入有效的首档示例时租价和日租倍率。';
      let night = '';
      if (channel.channel === 'uhaozu' && policy.mode === 'decrease') {
        const nightBase = normalize(Number(hourly) * Number(channel.ratios.night), (channel.price_rules || {}).night);
        if (!Number.isFinite(nightBase) || nightBase <= 0) return '请输入有效的包夜倍率。';
        night = `；四档包夜示例：${policy.factors.map(factor => `¥${normalize(nightBase * factor, (channel.price_rules || {}).night).toFixed(2)}`).join(' / ')}`;
      }
      return `四档日租示例：${policy.factors.map(factor => `¥${normalize(base * factor, (channel.price_rules || {})[key]).toFixed(2)}`).join(' / ')}${night}；各账号以自己的首档价格计算。`;
    } catch (error) {
      return error.message;
    }
  }
  function bind(host, value, onChange) {
    Array.from(host.querySelectorAll('[data-daily-mode]')).forEach(button => {
      button.onclick = () => { value.mode = button.getAttribute('data-daily-mode'); onChange(true); };
    });
    Array.from(host.querySelectorAll('[data-daily-factor]')).forEach(input => {
      input.oninput = () => { value.percentages[Number(input.getAttribute('data-daily-factor'))] = input.value; onChange(false); };
    });
  }
  root.DailyPricePolicy = { draft, parse, render, preview, bind };
  if (typeof module !== 'undefined') module.exports = root.DailyPricePolicy;
})(typeof window === 'undefined' ? globalThis : window);
