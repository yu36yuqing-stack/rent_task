function normalizePricingGameName(gameName) {
  const text = String(gameName || '').trim();
  const upper = text.toUpperCase();
  if (upper === 'CSGO' || text === 'CS:GO' || upper === 'CS2' || text.includes('反恐精英')) return 'CSGO';
  if (text === '和平精英' || upper === 'HPJY') return '和平精英';
  if (text.includes('CFM') || text.includes('枪战王者') || text.includes('穿越火线') || upper === 'CFM') return 'CFM';
  return 'WZRY';
}

function buildPricingGameAvatarHtml(gameName) {
  const normalized = normalizePricingGameName(gameName);
  const catalog = {
    CSGO: { title: 'CSGO', className: 'game-avatar-csgo', src: '/assets/game_icons/csgo.png?v=20260425-soldier' },
    '和平精英': { title: '和平精英', className: 'game-avatar-hpjy', src: '/assets/game_icons/hpjy.png' },
    CFM: { title: 'CFM', className: 'game-avatar-cfm', src: '/assets/game_icons/cfm.png' },
    WZRY: { title: '王者荣耀', className: 'game-avatar-wzry', src: '/assets/game_icons/wzry.webp' }
  };
  const item = catalog[normalized] || catalog.WZRY;
  return `<span class="game-avatar ${item.className}" title="${item.title}" aria-label="${item.title}">
    <img src="${item.src}" alt="${item.title}" loading="lazy" decoding="async">
  </span>`;
}

function escapePricingHtml(text) {
  return String(text == null ? '' : text)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function formatPricingMoney(value) {
  const n = Number(value);
  if (!Number.isFinite(n) || n <= 0) return '';
  return n.toFixed(2).replace(/\.?0+$/, '');
}

function formatPricingResultMoney(value) {
  const text = formatPricingMoney(value);
  return text ? `¥${text}` : '-';
}

function pricingGameOptions() {
  return [
    { game_name: 'WZRY', label: '王者荣耀' },
    { game_name: '和平精英', label: '和平精英' },
    { game_name: 'CFM', label: 'CFM' },
    { game_name: 'CSGO', label: 'CSGO' }
  ];
}

function normalizePricingCountMode(value) {
  return value === 'business_day' ? 'business_day' : 'rolling_24h';
}

function pricingCountWindowLabel(mode) {
  return normalizePricingCountMode(mode) === 'business_day' ? '每日06:00切日' : '近24小时';
}

function pricingCountSummary(mode, count) {
  return `${normalizePricingCountMode(mode) === 'business_day' ? '本周期' : '近24h'} ${Number(count || 0)}单`;
}

function pricingCountWindowRange(start, end) {
  const format = (value) => {
    if (!value) return '';
    const timestamp = new Date(value).getTime();
    if (!Number.isFinite(timestamp)) return '';
    return new Date(timestamp + 8 * 3600 * 1000).toISOString().slice(5, 16).replace('-', '/').replace('T', ' ');
  };
  const from = format(start);
  const to = format(end);
  return from && to ? `${from}—${to}（北京时间）` : '';
}

function ensurePricingLadderState() {
  let pricing = state.pricing || (state.pricing = {});
  const ownerId = String(state.user && state.user.id || '');
  if (pricing.feature_owner_id !== undefined && pricing.feature_owner_id !== ownerId) {
    if (pricing.feature_poll_timer) clearTimeout(pricing.feature_poll_timer);
    pricing = state.pricing = {};
  }
  pricing.feature_owner_id = ownerId;
  if (!pricing.game_name) pricing.game_name = 'WZRY';
  if (!Array.isArray(pricing.list)) pricing.list = [];
  if (typeof pricing.query !== 'string') pricing.query = '';
  if (!pricing.editing || typeof pricing.editing !== 'object') pricing.editing = {};
  if (!pricing.saving || typeof pricing.saving !== 'object') pricing.saving = {};
  if (!pricing.drafts || typeof pricing.drafts !== 'object') pricing.drafts = {};
  if (!pricing.feature || typeof pricing.feature !== 'object') {
    pricing.feature = { enabled: false, count_mode: 'rolling_24h', reconcile_required: false, version: 0 };
  }
  pricing.count_mode = normalizePricingCountMode(pricing.count_mode || pricing.feature.count_mode);
  pricing.feature.count_mode = normalizePricingCountMode(pricing.feature.count_mode || pricing.count_mode);
  if (typeof pricing.feature_saving !== 'boolean') pricing.feature_saving = false;
  if (typeof pricing.feature_confirmed !== 'boolean') pricing.feature_confirmed = false;
  if (typeof pricing.feature_save_error !== 'boolean') pricing.feature_save_error = false;
  if (typeof pricing.data_stale !== 'boolean') pricing.data_stale = false;
  if (!pricing.channel_sheet || typeof pricing.channel_sheet !== 'object') {
    pricing.channel_sheet = {
      account: '',
      channel: 'uhaozu',
      view: 'result',
      loading: false,
      payload: null,
      error: ''
    };
  }
  if (typeof pricing.loaded_once !== 'boolean') pricing.loaded_once = false;
  if (!pricing.ratio_settings || typeof pricing.ratio_settings !== 'object') {
    pricing.ratio_settings = {
      loading: false,
      saving: false,
      loaded_once: false,
      selected_channel: 'uhaozu',
      preview_hour: '2',
      channels: [],
      drafts: {},
      error: ''
    };
  }
  if (typeof pricing.ratio_settings.preview_hour !== 'string') {
    pricing.ratio_settings.preview_hour = String(pricing.ratio_settings.preview_hour || '2');
  }
  return pricing;
}

function pricingChannelSheetEls() {
  return {
    sheet: document.getElementById('pricingChannelSheet'),
    title: document.getElementById('pricingChannelSheetTitle'),
    tabs: document.getElementById('pricingChannelTabs'),
    body: document.getElementById('pricingChannelBody'),
    close: document.getElementById('pricingChannelCloseBtn')
  };
}

function closePricingChannelSheet() {
  const nodes = pricingChannelSheetEls();
  if (!nodes.sheet) return;
  nodes.sheet.classList.add('hidden');
  nodes.sheet.setAttribute('aria-hidden', 'true');
}

function renderPricingPackageValues(prices = {}, packageKeys = ['hour', 'night', 'day', 'week'], packageLabels = {}) {
  return packageKeys.map((key) => `
    <span class="pricing-package-value" data-label="${escapePricingHtml(packageLabels[key] || key)}">${escapePricingHtml(formatPricingResultMoney(prices[key]))}</span>
  `).join('');
}

function pricingApplyStatusText(status) {
  if (status === 'effective') return '渠道价格与当前档一致';
  if (status === 'effective_partial') return '时租价格与当前档一致';
  if (status === 'manual') return '渠道手工价（不会自动纠正）';
  if (status === 'pending') return '待执行换档';
  if (status === 'blocked') return '受上下架安全规则阻塞';
  if (status === 'failed') return '上次换档失败';
  return '套餐数据暂不完整';
}

function pricingTierLabel(tier) {
  const value = Math.min(4, Math.max(1, Number(tier || 1)));
  return `${value}档时租价`;
}

function pricingTierSummary(item = {}) {
  if (!item.configured) return '阶梯调价：未启用';
  const current = Number(item.current_tier || 0);
  const desired = Number(item.desired_tier || 1);
  const status = item.ladder_status === 'failed' ? ' · 换档失败' : (current !== desired || ['pending', 'blocked'].includes(item.ladder_status) ? ' · 待换档' : '');
  return `当前${current ? `第${current}档` : '未应用'} · 目标第${desired}档${status}`;
}

function formatPricingRatio(value) {
  const n = Number(value);
  if (!Number.isFinite(n) || n <= 0) return '';
  return n.toFixed(4).replace(/\.?0+$/, '');
}

function normalizePricingRatioDraft(channel = {}) {
  const ratios = channel.ratios && typeof channel.ratios === 'object' ? channel.ratios : {};
  const keys = Array.isArray(channel.package_keys) ? channel.package_keys : [];
  return Object.fromEntries(keys.map((key) => [key, formatPricingRatio(
    key === 'hour' && ratios[key] === undefined ? 1 : ratios[key]
  )]));
}

function validatePricingRatioDraft(channel = {}, draft = {}) {
  const keys = Array.isArray(channel.package_keys) ? channel.package_keys : [];
  const out = {};
  for (const key of keys) {
    const value = Number(String(draft[key] == null ? '' : draft[key]).trim());
    const rounded = Number(value.toFixed(4));
    if (!Number.isFinite(rounded) || rounded <= 0) {
      throw new Error(`${channel.package_labels && channel.package_labels[key] || key}倍率必须大于 0`);
    }
    out[key] = rounded;
  }
  return out;
}

function normalizePricingPreviewPrice(value, rule = {}) {
  const n = Number(value);
  if (!Number.isFinite(n) || n <= 0) return 0;
  const decimals = Math.max(0, Math.min(4, Number.isInteger(Number(rule.decimals)) ? Number(rule.decimals) : 2));
  const factor = 10 ** decimals;
  if (String(rule.rounding || '') === 'truncate') {
    const scaled = Number((n * factor).toFixed(8));
    return Number((Math.trunc(scaled) / factor).toFixed(decimals));
  }
  return Number(n.toFixed(decimals));
}

function calculatePricingRatioPreview(channel = {}, draft = {}, hourPrice = '') {
  const keys = Array.isArray(channel.package_keys) ? channel.package_keys : [];
  const labels = channel.package_labels && typeof channel.package_labels === 'object' ? channel.package_labels : {};
  const priceRules = channel.price_rules && typeof channel.price_rules === 'object' ? channel.price_rules : {};
  const hour = normalizePricingPreviewPrice(Number(String(hourPrice == null ? '' : hourPrice).trim()), priceRules.hour);
  const validHour = Number.isFinite(hour) && hour > 0;
  return keys.map((key) => {
    const ratio = Number(Number(String(draft[key] == null ? '' : draft[key]).trim()).toFixed(4));
    const validRatio = Number.isFinite(ratio) && ratio > 0;
    return {
      key,
      label: labels[key] || key,
      hour_price: validHour ? hour : 0,
      ratio: validRatio ? Number(ratio.toFixed(4)) : 0,
      price: validHour && validRatio ? normalizePricingPreviewPrice(hour * ratio, priceRules[key]) : 0
    };
  });
}

function renderPricingRatioInlineResults(channel = {}, draft = {}, hourPrice = '') {
  const results = new Map(calculatePricingRatioPreview(channel, draft, hourPrice).map((item) => [item.key, item]));
  Array.from(document.querySelectorAll('[data-pricing-ratio-result-key]')).forEach((node) => {
    const item = results.get(String(node.getAttribute('data-pricing-ratio-result-key') || ''));
    node.textContent = `= ${formatPricingResultMoney(item && item.price)}`;
  });
}

function renderPricingRatioSettings() {
  const ratioState = ensurePricingLadderState().ratio_settings;
  const tabs = document.getElementById('pricingRatioChannelTabs');
  const panel = document.getElementById('pricingRatioPanel');
  if (!tabs || !panel) return;
  const channels = Array.isArray(ratioState.channels) ? ratioState.channels : [];
  if (ratioState.loading && !ratioState.loaded_once) {
    tabs.innerHTML = '';
    panel.innerHTML = '<div class="pricing-channel-empty">加载中...</div>';
    return;
  }
  if (ratioState.error) {
    tabs.innerHTML = '';
    panel.innerHTML = `<div class="pricing-channel-empty pricing-error">${escapePricingHtml(ratioState.error)}</div>`;
    return;
  }
  if (channels.length === 0) {
    tabs.innerHTML = '';
    panel.innerHTML = '<div class="pricing-channel-empty">暂无可配置的调价渠道。</div>';
    return;
  }
  if (!channels.some((item) => item.channel === ratioState.selected_channel)) {
    ratioState.selected_channel = channels[0].channel;
  }
  tabs.innerHTML = channels.map((channel) => `
    <button class="orders-tab header-tab ${channel.channel === ratioState.selected_channel ? 'active' : ''}"
      data-pricing-ratio-channel="${escapePricingHtml(channel.channel)}" type="button">${escapePricingHtml(channel.label)}</button>
  `).join('');
  Array.from(tabs.querySelectorAll('[data-pricing-ratio-channel]')).forEach((button) => {
    button.onclick = () => {
      ratioState.selected_channel = String(button.getAttribute('data-pricing-ratio-channel') || 'uhaozu');
      renderPricingRatioSettings();
    };
  });
  const selected = channels.find((item) => item.channel === ratioState.selected_channel) || channels[0];
  const draft = ratioState.drafts[selected.channel] || normalizePricingRatioDraft(selected);
  ratioState.drafts[selected.channel] = draft;
  ratioState.daily_drafts = ratioState.daily_drafts || {};
  const dailyDraft = ratioState.daily_drafts[selected.channel] || window.DailyPricePolicy.draft(selected.daily_policy);
  ratioState.daily_drafts[selected.channel] = dailyDraft;
  const refreshDailyPreview = () => {
    const output = panel.querySelector('[data-daily-preview]');
    if (output) output.textContent = window.DailyPricePolicy.preview(dailyDraft,
      { ...selected, ratios: draft }, ratioState.preview_hour, normalizePricingPreviewPrice);
  };
  const labels = selected.package_labels || {};
  const fields = selected.package_keys.map((key) => `
    <label class="pricing-ratio-field">
      <span>${escapePricingHtml(labels[key] || key)}</span>
      <div class="pricing-ratio-field-line">
        <div class="pricing-price-input">
          <input data-pricing-ratio-key="${escapePricingHtml(key)}" type="number" min="0.0001" step="0.0001" inputmode="decimal"
            value="${escapePricingHtml(draft[key] || '')}" ${ratioState.saving ? 'disabled' : ''}>
          <span>倍</span>
        </div>
        <span class="pricing-ratio-result" data-pricing-ratio-result-key="${escapePricingHtml(key)}">= -</span>
      </div>
    </label>
  `).join('');
  panel.innerHTML = `
    <div class="pricing-ratio-copy">
      <strong>${escapePricingHtml(selected.label)}套餐倍率</strong>
      <span>${selected.source === 'saved' ? `已保存${selected.modify_date ? ` · ${escapePricingHtml(selected.modify_date)}` : ''}` : '当前使用系统建议值，保存后转为号主配置'}</span>
    </div>
    <div class="pricing-ratio-grid">${fields}</div>
    <div id="pricingDailyPolicyPanel" class="pricing-ratio-panel">${window.DailyPricePolicy.render(dailyDraft, ratioState.saving, escapePricingHtml)}</div>
    <div class="pricing-ratio-actions">
      <span class="head-summary-text">各套餐独立乘原始基础时租价，时租倍率不影响其他套餐；保存后下次同步生效。</span>
      <button class="btn btn-ghost btn-page-action" id="pricingRatioSaveBtn" type="button" ${ratioState.saving ? 'disabled' : ''}>${ratioState.saving ? '保存中...' : '保存设置'}</button>
    </div>
  `;
  Array.from(panel.querySelectorAll('[data-pricing-ratio-key]')).forEach((input) => {
    input.oninput = () => {
      draft[String(input.getAttribute('data-pricing-ratio-key') || '')] = input.value;
      renderPricingRatioInlineResults(selected, draft, ratioState.preview_hour);
      refreshDailyPreview();
    };
  });
  const previewHour = document.getElementById('pricingRatioPreviewHour');
  if (previewHour) {
    if (document.activeElement !== previewHour) previewHour.value = ratioState.preview_hour;
    previewHour.oninput = () => {
      ratioState.preview_hour = previewHour.value;
      renderPricingRatioInlineResults(selected, draft, ratioState.preview_hour);
      refreshDailyPreview();
    };
  }
  renderPricingRatioInlineResults(selected, draft, ratioState.preview_hour);
  window.DailyPricePolicy.bind(panel, dailyDraft, (rerender) => {
    if (rerender) renderPricingRatioSettings();
    else refreshDailyPreview();
  });
  refreshDailyPreview();
  const save = document.getElementById('pricingRatioSaveBtn');
  if (save) save.onclick = () => void savePricingRatioSettings(selected);
}

async function savePricingRatioSettings(channel) {
  const ratioState = ensurePricingLadderState().ratio_settings;
  if (ratioState.saving) return;
  let ratios;
  let dailyPolicy;
  try {
    ratios = validatePricingRatioDraft(channel, ratioState.drafts[channel.channel] || {});
    dailyPolicy = window.DailyPricePolicy.parse(ratioState.daily_drafts[channel.channel]);
  } catch (e) {
    showToast(e.message || '套餐倍率不合法');
    return;
  }
  ratioState.saving = true;
  renderPricingRatioSettings();
  try {
    const out = await request('/api/pricing/ladder/package-ratios', {
      method: 'POST',
      body: JSON.stringify({
        channel: channel.channel,
        ratios,
        hour_ratio_editable: true,
        daily_policy: dailyPolicy,
        expected_version: Number(channel.version || 0)
      })
    });
    const saved = out && out.setting ? out.setting : {};
    Object.assign(channel, saved);
    ratioState.drafts[channel.channel] = normalizePricingRatioDraft(channel);
    ratioState.daily_drafts[channel.channel] = window.DailyPricePolicy.draft(channel.daily_policy);
    const queued = Number(saved.queued_count || 0);
    showToast(queued > 0 ? `设置已保存，${queued} 个账号将在下次同步生效` : '设置已保存');
  } catch (e) {
    showToast(e.message || '套餐倍率保存失败');
  } finally {
    ratioState.saving = false;
    renderPricingRatioSettings();
  }
}

async function loadPricingRatioSettings() {
  const ratioState = ensurePricingLadderState().ratio_settings;
  ratioState.loading = true;
  ratioState.error = '';
  renderPricingRatioSettings();
  try {
    const out = await request('/api/pricing/ladder/package-ratios');
    ratioState.channels = Array.isArray(out && out.channels) ? out.channels : [];
    ratioState.drafts = Object.fromEntries(ratioState.channels.map((channel) => [channel.channel, normalizePricingRatioDraft(channel)]));
    ratioState.daily_drafts = Object.fromEntries(ratioState.channels.map((channel) => [channel.channel, window.DailyPricePolicy.draft(channel.daily_policy)]));
    ratioState.loaded_once = true;
  } catch (e) {
    ratioState.error = String(e && e.message || '套餐倍率加载失败');
  } finally {
    ratioState.loading = false;
    renderPricingRatioSettings();
  }
}

function filterPricingItems(items = [], query = '') {
  const keyword = String(query || '').trim().toLowerCase();
  const list = Array.isArray(items) ? items : [];
  if (!keyword) return list;
  return list.filter((item) => (
    String(item && item.display_name || '').toLowerCase().includes(keyword)
    || String(item && item.game_account || '').toLowerCase().includes(keyword)
  ));
}

function pricingLogStatusText(status) {
  return status === 'success' ? '成功' : '失败';
}

function pricingLogTriggerText(source) {
  const labels = {
    rule_saved: '保存策略',
    package_ratio_saved: '套餐倍率变更',
    order_finished_changed: '订单换挡',
    daily_reset: '06:00重置',
    rolling_24h_reconcile: '近24h换档',
    business_day_reconcile: '06:00周期换档',
    count_mode_changed_reconcile: '计数周期变更',
    feature_enabled_reconcile: '功能启用校准',
    pricing_h5: '手工发布'
  };
  return labels[String(source || '').trim()] || '阶梯调价';
}

function formatPricingErrorDetail(log = {}) {
  const detail = log.error_detail && typeof log.error_detail === 'object' ? log.error_detail : null;
  const lines = [String(log.fail_message || '渠道未返回明确错误信息')];
  if (detail) {
    if (detail.stage) lines.push(`失败阶段：${detail.stage}`);
    if (detail.code) lines.push(`错误代码：${detail.code}`);
    if (detail.uhaozu_response) {
      const raw = JSON.stringify(detail.uhaozu_response, null, 2);
      lines.push(`U号租返回：\n${raw.length > 4000 ? `${raw.slice(0, 4000)}\n...` : raw}`);
    }
    if (detail.channel_response) {
      const raw = JSON.stringify(detail.channel_response, null, 2);
      lines.push(`渠道返回：\n${raw.length > 4000 ? `${raw.slice(0, 4000)}\n...` : raw}`);
    }
  }
  return lines.join('\n');
}

function renderPricingChannelLogs(result = {}) {
  const logs = Array.isArray(result.adjustment_logs) ? result.adjustment_logs : [];
  const label = String(result.label || 'U号租');
  const packageKeys = Array.isArray(result.package_keys) && result.package_keys.length
    ? result.package_keys
    : ['hour', 'night', 'day', 'week'];
  const packageLabels = result.package_labels || { hour: '时租', night: '包夜', day: '包天', week: '包周' };
  if (logs.length === 0) {
    return `<div class="pricing-channel-empty">当前账号暂无 ${escapePricingHtml(label)}调价记录。</div>`;
  }
  return `<div class="pricing-error-log-list">${logs.map((log) => `
    <article class="pricing-error-log-item ${log.publish_status === 'success' ? 'is-success' : 'is-failed'}">
      <div class="pricing-error-log-head">
        <span><strong>${escapePricingHtml(pricingLogStatusText(log.publish_status))}</strong> · ${escapePricingHtml(pricingLogTriggerText(log.trigger_source))}</span>
        <span class="pricing-error-log-tools">
          <span>${escapePricingHtml(log.create_date || '-')}</span>
          ${log.publish_status === 'fail' ? `<button class="pricing-log-detail-btn" data-pricing-error-detail="${Number(log.id || 0)}" type="button" title="查看渠道错误详情" aria-label="查看渠道错误详情">?</button>` : ''}
        </span>
      </div>
      ${log.publish_status === 'fail' ? `<p>${escapePricingHtml(log.fail_message || '渠道未返回明确错误信息')}</p>` : ''}
      <div class="pricing-error-log-prices">
        调整前：时租 ${escapePricingHtml(formatPricingResultMoney(log.before_prices && log.before_prices.hour))} ·
        目标：时租 ${escapePricingHtml(formatPricingResultMoney(log.target_prices && log.target_prices.hour))} ·
        调整后：时租 ${escapePricingHtml(formatPricingResultMoney(log.remote_prices && log.remote_prices.hour))}
      </div>
      <div class="pricing-error-log-prices">目标套餐：${packageKeys.filter((key) => key !== 'hour').map((key) => `${escapePricingHtml(packageLabels[key] || key)} ${escapePricingHtml(formatPricingResultMoney(log.target_prices && log.target_prices[key]))}`).join(' · ')}</div>
    </article>
  `).join('')}</div>`;
}

function renderPricingChannelResult(payload = {}, result = {}) {
  const sheetState = ensurePricingLadderState().channel_sheet;
  const currentTier = Number(result.current_tier ?? payload.current_tier ?? 0);
  const remote = result.remote_current || {};
  const tiers = Array.isArray(result.tiers) ? result.tiers : [];
  const logs = Array.isArray(result.adjustment_logs) ? result.adjustment_logs : [];
  const packageKeys = Array.isArray(result.package_keys) && result.package_keys.length ? result.package_keys : ['hour'];
  const packageLabels = result.package_labels || {};
  const packageCountClass = `package-count-${Math.min(9, Math.max(1, packageKeys.length))}`;
  const viewTabs = `
    <div class="orders-tabs pricing-result-tabs">
      <button class="orders-tab header-tab ${sheetState.view === 'result' ? 'active' : ''}" data-pricing-result-view="result" type="button">套餐结果</button>
      <button class="orders-tab header-tab ${sheetState.view === 'logs' ? 'active' : ''}" data-pricing-result-view="logs" type="button">调价记录${logs.length ? ` (${logs.length})` : ''}</button>
    </div>
  `;
  if (sheetState.view === 'logs') return `${viewTabs}${renderPricingChannelLogs(result)}`;
  if (result.available === false) {
    return `${viewTabs}<div class="pricing-channel-empty"><strong>${escapePricingHtml(result.label || '该渠道')}</strong><span>当前账号未关联该渠道商品。</span></div>`;
  }
  const tierRows = tiers.map((tier) => `
    <div class="pricing-package-row ${packageCountClass} ${Number(tier.tier) === currentTier ? 'is-active' : ''}">
      <strong>${escapePricingHtml(pricingTierLabel(tier.tier))}${Number(tier.tier) === currentTier ? ' · 当前使用' : ''}</strong>
      ${renderPricingPackageValues(tier.prices, packageKeys, packageLabels)}
    </div>
  `).join('');
  return `
    ${viewTabs}
    <div class="pricing-channel-current">
      <div>
        <span>${escapePricingHtml(result.label || '渠道')}当前价格（最近同步）</span>
        <strong>${escapePricingHtml(pricingApplyStatusText(result.apply_status))}</strong>
      </div>
      <div class="pricing-package-line">
        ${packageKeys.filter((key) => Number(remote[key] || 0) > 0).map((key) => `<span>${escapePricingHtml(packageLabels[key] || key)} ${escapePricingHtml(formatPricingResultMoney(remote[key]))}</span>`).join('') || '<span>暂无可回读价格</span>'}
      </div>
    </div>
    ${tiers.length ? `
      <div class="pricing-package-scroll">
        <div class="pricing-package-table ${packageCountClass}">
          <div class="pricing-package-row pricing-package-header ${packageCountClass}">
            <strong>阶梯价格</strong>${packageKeys.map((key) => `<span>${escapePricingHtml(packageLabels[key] || key)}</span>`).join('')}
          </div>
          ${tierRows}
        </div>
      </div>
    ` : `<div class="pricing-channel-empty">${escapePricingHtml(result.label || '渠道')}当前套餐价格不完整，暂时无法计算四档套餐结果。</div>`}
    <div class="pricing-channel-meta">${escapePricingHtml(pricingTierSummary({ configured: true, current_tier: result.current_tier, desired_tier: result.desired_tier || payload.desired_tier, ladder_status: result.apply_status }))}</div>
    ${result.runtime && result.runtime.last_error ? `<div class="pricing-channel-meta">${escapePricingHtml(result.runtime.last_error)}</div>` : ''}
    <div class="pricing-channel-meta">商品 ${escapePricingHtml(result.goods_id || '未关联')}${result.min_rent_hour ? ` · 起租 ${Number(result.min_rent_hour)} 小时` : ''}</div>
    ${result.verification_note ? `<div class="pricing-channel-meta">${escapePricingHtml(result.verification_note)}</div>` : ''}
    <div class="pricing-channel-meta">订单周期：${escapePricingHtml(payload.count_window || pricingCountWindowLabel(payload.count_mode))} · ${escapePricingHtml(pricingCountSummary(payload.count_mode, payload.current_order_count))}${pricingCountWindowRange(payload.window_start, payload.window_end) ? `<br>${escapePricingHtml(pricingCountWindowRange(payload.window_start, payload.window_end))}` : ''}</div>
  `;
}

function renderPricingChannelSheet() {
  const pricing = ensurePricingLadderState();
  const sheetState = pricing.channel_sheet;
  const nodes = pricingChannelSheetEls();
  if (!nodes.sheet || !nodes.body || !nodes.tabs) return;
  if (nodes.close) nodes.close.onclick = closePricingChannelSheet;
  const item = pricingItemByAccount(sheetState.account);
  if (nodes.title) nodes.title.textContent = item ? `${item.display_name || item.game_account} · 渠道价格` : '渠道价格';
  const channels = sheetState.payload && Array.isArray(sheetState.payload.channels)
    ? sheetState.payload.channels
    : [
        { channel: 'uhaozu', label: 'U号租', enabled: true },
        { channel: 'zuhaowang', label: '租号王', enabled: false },
        { channel: 'uuzuhao', label: '悠悠租号', enabled: true }
      ];
  nodes.tabs.innerHTML = channels.map((channel) => `
    <button class="orders-tab header-tab ${sheetState.channel === channel.channel ? 'active' : ''}"
      data-pricing-channel-tab="${escapePricingHtml(channel.channel)}" type="button">${escapePricingHtml(channel.label)}</button>
  `).join('');
  Array.from(nodes.tabs.querySelectorAll('[data-pricing-channel-tab]')).forEach((button) => {
    button.onclick = () => {
      sheetState.channel = String(button.getAttribute('data-pricing-channel-tab') || 'uhaozu');
      sheetState.view = 'result';
      renderPricingChannelSheet();
    };
  });
  if (sheetState.loading) nodes.body.innerHTML = '<div class="pricing-channel-empty">加载中...</div>';
  else if (sheetState.error) nodes.body.innerHTML = `<div class="pricing-channel-empty pricing-error">${escapePricingHtml(sheetState.error)}</div>`;
  else {
    const selected = channels.find((item) => item.channel === sheetState.channel) || channels[0];
    if (!selected || selected.enabled !== true) {
      const packageText = Array.isArray(selected && selected.package_keys) && selected.package_keys.length
        ? `已知套餐：${selected.package_keys.map((key) => selected.package_labels && selected.package_labels[key] || key).join('、')}`
        : '套餐能力待接口确认';
      nodes.body.innerHTML = `<div class="pricing-channel-empty"><strong>${escapePricingHtml(selected && selected.label || '该渠道')}</strong><span>一期暂未启用自动改价。${escapePricingHtml(packageText)}</span></div>`;
    } else {
      const results = sheetState.payload && sheetState.payload.channel_results || {};
      const result = results[sheetState.channel] || sheetState.payload && sheetState.payload.channel_result || selected;
      nodes.body.innerHTML = renderPricingChannelResult(sheetState.payload || {}, result);
    }
  }
  Array.from(nodes.body.querySelectorAll('[data-pricing-result-view]')).forEach((button) => {
    button.onclick = () => {
      sheetState.view = String(button.getAttribute('data-pricing-result-view') || 'result');
      renderPricingChannelSheet();
    };
  });
  Array.from(nodes.body.querySelectorAll('[data-pricing-error-detail]')).forEach((button) => {
    button.onclick = () => {
      const id = Number(button.getAttribute('data-pricing-error-detail') || 0);
      const logs = sheetState.payload && sheetState.payload.channel_result
        ? (((sheetState.payload.channel_results || {})[sheetState.channel] || sheetState.payload.channel_result).adjustment_logs || [])
        : [];
      const log = logs.find((item) => Number(item.id || 0) === id);
      if (log) showToast(formatPricingErrorDetail(log), 0, 'detail');
    };
  });
}

async function loadPricingChannelResult(account) {
  const pricing = ensurePricingLadderState();
  const item = pricingItemByAccount(account);
  if (!item) return;
  const sheetState = pricing.channel_sheet;
  sheetState.account = account;
  sheetState.channel = 'uhaozu';
  sheetState.view = 'result';
  sheetState.loading = true;
  sheetState.error = '';
  sheetState.payload = null;
  const nodes = pricingChannelSheetEls();
  if (nodes.sheet) {
    nodes.sheet.classList.remove('hidden');
    nodes.sheet.setAttribute('aria-hidden', 'false');
  }
  renderPricingChannelSheet();
  try {
    const params = new URLSearchParams({
      game_id: String(item.game_id || ''),
      game_name: String(item.game_name || ''),
      game_account: String(item.game_account || '')
    });
    sheetState.payload = await request(`/api/pricing/ladder/channel-result?${params.toString()}`);
  } catch (e) {
    sheetState.error = String(e && e.message || '渠道价格加载失败');
  } finally {
    sheetState.loading = false;
    renderPricingChannelSheet();
  }
}

function normalizePricingDraft(item = {}) {
  const prices = Array.isArray(item.prices) ? item.prices.slice(0, 4) : [];
  while (prices.length < 4) prices.push(0);
  return {
    prices: prices.map((value) => formatPricingMoney(value)),
    copied_from_game_account: String(item.copied_from_game_account || '').trim()
  };
}

function validatePricingDraft(draft = {}) {
  const rawPrices = Array.isArray(draft.prices) ? draft.prices : [];
  if (rawPrices.length !== 4) throw new Error('请填写第 1 至第 4 单的价格');
  const texts = rawPrices.map((value) => String(value == null ? '' : value).trim());
  if (texts.every((value) => value === '')) return [];
  if (texts.some((value) => value === '')) {
    throw new Error('四档价格需要全部填写，或全部清空');
  }
  const prices = texts.map(Number);
  if (prices.some((value) => !Number.isFinite(value) || value <= 0)) {
    throw new Error('四档价格必须是大于 0 的数字');
  }
  return prices.map((value) => Number(value.toFixed(2)));
}

function buildPricingRequestQuery() {
  const params = new URLSearchParams();
  params.set('game_name', String(ensurePricingLadderState().game_name || 'WZRY'));
  return params.toString();
}

function applyPricingPayload(out, options = {}) {
  const pricing = ensurePricingLadderState();
  const game = normalizePricingGameName(out && out.game_name || pricing.game_name);
  if (options.game_name && game !== options.game_name) return false;
  const incoming = window.PricingFeatureState.read(out && out.feature);
  const previous = pricing.feature_confirmed ? pricing.feature : null;
  if (incoming) {
    const merged = window.PricingFeatureState.merge(previous, incoming);
    if (!merged.accepted || (out.count_mode && out.count_mode !== incoming.count_mode)) return false;
    const intent = pricing.feature_uncertain;
    if (pricing.feature_intent && incoming.version <= pricing.feature_intent.expected_version) return false;
    if (intent && incoming.version <= intent.expected_version) return false;
    pricing.feature = merged.feature;
    pricing.feature_confirmed = true;
    if (intent) {
      pricing.feature_save_error = intent.mode_changed && !window.PricingFeatureState.confirms(incoming, intent);
      pricing.feature_uncertain = null;
      delete pricing.pending_count_mode;
    }
    if (previous && incoming.version > previous.version && !intent) pricing.feature_save_error = false;
    if (previous && merged.changed && !options.from_save && !intent) {
      showToast('设置已在其他页面更新，已同步最新配置');
    }
  } else if (pricing.feature_confirmed || pricing.feature_uncertain) {
    return false;
  } else if (out && out.feature && typeof out.feature.enabled === 'boolean') {
    // An older service can still tell us the switch state, but cannot confirm the period setting.
    pricing.feature.enabled = out.feature.enabled;
  }
  pricing.game_name = game;
  pricing.list = Array.isArray(out && out.list) ? out.list : [];
  pricing.count_mode = incoming ? incoming.count_mode : normalizePricingCountMode(out && out.count_mode);
  pricing.count_window = String(out && out.count_window || pricingCountWindowLabel(pricing.count_mode));
  pricing.window_start = String(out && out.window_start || '');
  pricing.window_end = String(out && out.window_end || '');
  pricing.data_stale = false;
  pricing.error = '';
  pricing.loaded_once = true;
  return true;
}

function renderPricingGameTabs() {
  if (!els.pricingGameTabs) return;
  const current = normalizePricingGameName(ensurePricingLadderState().game_name);
  els.pricingGameTabs.innerHTML = pricingGameOptions().map((item) => `
    <button class="stats-game-tab ${current === item.game_name ? 'active' : ''}" data-pricing-game="${item.game_name}" type="button">
      ${buildPricingGameAvatarHtml(item.game_name)}
      <span class="stats-game-tab-text">${escapePricingHtml(item.label)}</span>
    </button>
  `).join('');
  Array.from(els.pricingGameTabs.querySelectorAll('[data-pricing-game]')).forEach((node) => {
    node.onclick = () => {
      const nextGame = String(node.getAttribute('data-pricing-game') || '').trim();
      const pricing = ensurePricingLadderState();
      if (!nextGame || nextGame === pricing.game_name) return;
      pricing.game_name = nextGame;
      pricing.editing = {};
      pricing.saving = {};
      pricing.drafts = {};
      pricing.query = '';
      pricing.loaded_once = false;
      pricing.list = [];
      void loadPricingView();
    };
  });
}

function pricingItemByAccount(account) {
  return ensurePricingLadderState().list.find((item) => String(item.game_account || '') === String(account || '')) || null;
}

function configuredPricingSources(targetAccount) {
  return ensurePricingLadderState().list.filter((item) => (
    Boolean(item.configured)
    && String(item.game_account || '') !== String(targetAccount || '')
  ));
}

function enterPricingEdit(account) {
  const pricing = ensurePricingLadderState();
  const item = pricingItemByAccount(account);
  if (!item) return;
  pricing.edit_revision = Number(pricing.edit_revision || 0) + 1;
  pricing.editing[account] = true;
  pricing.drafts[account] = normalizePricingDraft(item);
  renderPricingView();
}

function copyPricingDraft(targetAccount, sourceAccount) {
  const pricing = ensurePricingLadderState();
  const source = pricingItemByAccount(sourceAccount);
  if (!source || !source.configured) return false;
  pricing.drafts[targetAccount] = {
    prices: normalizePricingDraft(source).prices,
    copied_from_game_account: String(source.game_account || '')
  };
  return true;
}

function readPricingDraftFromCard(account, card) {
  const pricing = ensurePricingLadderState();
  const current = pricing.drafts[account] || { prices: ['', '', '', ''], copied_from_game_account: '' };
  current.prices = Array.from(card.querySelectorAll('[data-pricing-tier]')).map((input) => input.value);
  pricing.drafts[account] = current;
  return current;
}

async function savePricingAccount(account, card) {
  const pricing = ensurePricingLadderState();
  const item = pricingItemByAccount(account);
  if (!item || pricing.saving[account]) return;
  let draft;
  let prices;
  try {
    draft = readPricingDraftFromCard(account, card);
    prices = validatePricingDraft(draft);
  } catch (e) {
    showToast(e.message || '价格填写不完整');
    return;
  }
  const clearing = prices.length === 0;
  if (clearing && !item.configured) {
    pricing.editing[account] = false;
    delete pricing.drafts[account];
    renderPricingView();
    return;
  }
  if (clearing && !window.confirm('确认清空该账号的阶梯价格配置？渠道当前价格不会改变。')) return;
  pricing.edit_revision = Number(pricing.edit_revision || 0) + 1;
  pricing.saving[account] = true;
  renderPricingView();
  try {
    const out = await request('/api/pricing/ladder/account', {
      method: 'POST',
      body: JSON.stringify({
        game_id: item.game_id,
        game_name: item.game_name,
        game_account: item.game_account,
        action: clearing ? 'clear' : 'save',
        prices,
        expected_version: Number(item.version || 0),
        copied_from_game_account: draft.copied_from_game_account || ''
      })
    });
    const saved = out && out.rule ? out.rule : {};
    item.configured = saved.configured === false ? false : true;
    item.prices = item.configured
      ? (Array.isArray(saved.prices) ? saved.prices : prices)
      : ['', '', '', ''];
    item.version = item.configured ? Number(saved.version || item.version || 0) : 0;
    item.copied_from_game_account = item.configured ? String(saved.copied_from_game_account || '') : '';
    if (saved.runtime) {
      item.current_tier = Number(saved.runtime.applied_tier || 0);
      item.desired_tier = Number(saved.runtime.desired_tier || 1);
      item.today_order_count = Number(saved.runtime.completed_order_count || 0);
      item.ladder_status = String(saved.runtime.status || '');
      item.last_error = String(saved.runtime.last_error || '');
    }
    pricing.editing[account] = false;
    delete pricing.drafts[account];
    const publishResult = saved.publish_result || {};
    const published = Number(publishResult.applied || 0) > 0;
    const publishFailed = Number(publishResult.failed || 0) > 0;
    showToast(item.configured
      ? (published ? '阶梯价格已保存，渠道价格更新成功' : (publishFailed ? '阶梯价格已保存，渠道价格更新失败并进入重试' : '阶梯价格已保存'))
      : '已清空，账号回到待配置状态');
  } catch (e) {
    showToast(e.message || '阶梯价格保存失败');
  } finally {
    pricing.saving[account] = false;
    renderPricingView();
  }
}

function bindPricingCardEvents() {
  if (!els.pricingListContainer) return;
  Array.from(els.pricingListContainer.querySelectorAll('[data-pricing-account-card]')).forEach((card) => {
    const account = String(card.getAttribute('data-pricing-account-card') || '').trim();
    const action = card.querySelector('[data-pricing-action]');
    if (action) {
      action.onclick = () => {
        const pricing = ensurePricingLadderState();
        if (pricing.editing[account]) void savePricingAccount(account, card);
        else enterPricingEdit(account);
      };
    }
    const channelAction = card.querySelector('[data-pricing-channel-result]');
    if (channelAction) channelAction.onclick = () => void loadPricingChannelResult(account);
    const select = card.querySelector('[data-pricing-copy]');
    if (select) {
      select.onchange = () => {
        const sourceAccount = String(select.value || '').trim();
        if (!sourceAccount) return;
        readPricingDraftFromCard(account, card);
        if (copyPricingDraft(account, sourceAccount)) renderPricingView();
      };
    }
    Array.from(card.querySelectorAll('[data-pricing-tier]')).forEach((input) => {
      input.oninput = () => readPricingDraftFromCard(account, card);
    });
  });
}

function renderPricingList() {
  if (!els.pricingListContainer) return;
  const pricing = ensurePricingLadderState();
  if (pricing.loading && !pricing.loaded_once) {
    els.pricingListContainer.innerHTML = '<div class="panel pricing-empty-card">加载中...</div>';
    return;
  }
  if (pricing.error) {
    els.pricingListContainer.innerHTML = `<div class="panel pricing-empty-card pricing-error">${escapePricingHtml(pricing.error)}</div>`;
    return;
  }
  if (pricing.data_stale) {
    els.pricingListContainer.innerHTML = '<div class="panel pricing-empty-card">订单数据待更新，请稍后刷新。</div>';
    return;
  }
  if (pricing.list.length === 0) {
    els.pricingListContainer.innerHTML = '<div class="panel pricing-empty-card">当前游戏暂无可配置账号。</div>';
    return;
  }
  const filtered = filterPricingItems(pricing.list, pricing.query);
  if (filtered.length === 0) {
    els.pricingListContainer.innerHTML = '<div class="panel pricing-empty-card">没有找到匹配的账号。</div>';
    return;
  }
  els.pricingListContainer.innerHTML = filtered.map((item) => {
    const account = String(item.game_account || '').trim();
    const editing = Boolean(pricing.editing[account]);
    const saving = Boolean(pricing.saving[account]);
    const draft = editing ? (pricing.drafts[account] || normalizePricingDraft(item)) : normalizePricingDraft(item);
    const sources = configuredPricingSources(account);
    const copyOptions = sources.map((source) => `
      <option value="${escapePricingHtml(source.game_account)}" ${draft.copied_from_game_account === source.game_account ? 'selected' : ''}>
        ${escapePricingHtml(source.display_name || source.game_account)} · ${escapePricingHtml(source.game_account)}
      </option>
    `).join('');
    const inputs = [1, 2, 3, 4].map((tier, index) => `
      <label class="pricing-tier-field">
        <span>${escapePricingHtml(pricingTierLabel(tier))}</span>
        <div class="pricing-price-input">
          <input data-pricing-tier="${tier}" type="number" min="0.01" step="0.01" inputmode="decimal"
            aria-label="${tier}档时租价" title="原始基础时租价，实际渠道时租另乘时租倍率" value="${escapePricingHtml(draft.prices[index] || '')}" ${editing && !saving ? '' : 'disabled'}>
          <span>元</span>
        </div>
      </label>
    `).join('');
    return `
      <article class="panel pricing-account-card ${editing ? 'is-editing' : ''}" data-pricing-account-card="${escapePricingHtml(account)}">
        <div class="pricing-account-head">
          <div class="pricing-account-identity">
            <p class="pricing-account-name">${escapePricingHtml(item.display_name || account || '-')}</p>
            <p class="pricing-account-meta">${escapePricingHtml(account || '-')}</p>
          </div>
          <div class="pricing-account-status">
            <span>${escapePricingHtml(pricingCountSummary(pricing.count_mode, item.today_order_count))}</span>
            <span>${item.configured ? '已配置' : '待配置'}</span>
          </div>
        </div>
        ${editing ? `
          <label class="pricing-copy-field">
            <span>复制其他账号配置</span>
            <select data-pricing-copy ${sources.length > 0 && !saving ? '' : 'disabled'}>
              <option value="">${sources.length > 0 ? '选择账号' : '暂无已配置账号'}</option>
              ${copyOptions}
            </select>
          </label>
        ` : ''}
        <div class="pricing-ladder-grid">${inputs}</div>
        <div class="pricing-account-footer">
          <span class="pricing-current-price">${escapePricingHtml(pricingTierSummary(item))}</span>
          <div class="pricing-account-actions">
            <button class="btn btn-ghost btn-card-action" data-pricing-channel-result type="button">查看渠道价格</button>
            <button class="btn btn-ghost btn-card-action" data-pricing-action type="button" ${saving ? 'disabled' : ''}>
              ${saving ? '保存中...' : (editing ? '保存' : '编辑')}
            </button>
          </div>
        </div>
      </article>
    `;
  }).join('');
  bindPricingCardEvents();
}

async function updatePricingFeature(enabled) {
  const pricing = ensurePricingLadderState();
  if (pricing.feature_saving || (pricing.feature.enabled === enabled && !pricing.feature_uncertain)) return;
  if (enabled && !window.confirm('开启后，下一个订单同步周期会校准所有已配置账号。确认开启？')) {
    renderPricingFeatureState();
    return;
  }
  await savePricingFeatureSettings(enabled, pricing.pending_count_mode || pricing.feature.count_mode, false);
}

async function updatePricingCountMode(value) {
  const pricing = ensurePricingLadderState();
  const mode = normalizePricingCountMode(value);
  if (pricing.feature_saving || (pricing.feature.count_mode === mode && !pricing.feature_uncertain)) return;
  await savePricingFeatureSettings(pricing.feature.enabled, mode, true);
}

function isCurrentPricingOwner(pricing, userId) {
  return state.pricing === pricing && String(state.user && state.user.id || '') === userId;
}

function pricingHasActiveEdits(pricing) {
  return Object.values(pricing.editing).some(Boolean) || Object.values(pricing.saving).some(Boolean);
}

function schedulePricingFeatureRefresh() {
  const pricing = ensurePricingLadderState();
  if (pricing.feature_poll_timer) clearTimeout(pricing.feature_poll_timer);
  pricing.feature_poll_timer = null;
  const userId = String(state.user && state.user.id || '');
  const needsCheck = () => isCurrentPricingOwner(pricing, userId) && userId
    && ['pricing_uhaozu', 'pricing_uuzuhao', 'pricing_zuhaowang'].includes(state.currentMenu)
    && document.visibilityState !== 'hidden'
    && !pricing.feature_saving && !pricing.feature_save_error
    && !pricingHasActiveEdits(pricing)
    && (pricing.feature_uncertain || (pricing.feature.enabled && pricing.feature.reconcile_required));
  // Only revisit pending settings on the active page, for at most twenty checks.
  if (!needsCheck() || Number(pricing.feature_poll_attempts || 0) >= 20) return;
  pricing.feature_poll_timer = setTimeout(() => {
    pricing.feature_poll_timer = null;
    if (!needsCheck()) return;
    if (pricing.loading) return schedulePricingFeatureRefresh();
    pricing.feature_poll_attempts = Number(pricing.feature_poll_attempts || 0) + 1;
    void loadPricingView({ poll: true });
  }, 15000);
  if (pricing.feature_poll_timer && typeof pricing.feature_poll_timer.unref === 'function') pricing.feature_poll_timer.unref();
}

function pricingFeatureSaveMessage(intent) {
  return intent.mode_changed
    ? (intent.enabled ? '计数周期已保存，下一轮订单同步成功后重新计算档位' : '计数周期已保存，开启自动调价后生效')
    : (intent.enabled ? '自动阶梯调价已开启' : '自动阶梯调价已关闭');
}

async function savePricingFeatureSettings(enabled, countMode, modeChanged) {
  const pricing = ensurePricingLadderState();
  const userId = String(state.user && state.user.id || '');
  const intent = {
    enabled, count_mode: countMode, expected_version: Number(pricing.feature.version || 0), mode_changed: modeChanged
  };
  pricing.feature_request_revision = Number(pricing.feature_request_revision || 0) + 1;
  pricing.feature_poll_attempts = 0;
  pricing.feature_saving = true;
  pricing.feature_save_error = false;
  pricing.feature_intent = intent;
  pricing.feature_uncertain = null;
  pricing.pending_count_mode = countMode;
  pricing.pending_enabled = enabled;
  pricing.data_stale = countMode !== pricing.count_mode;
  renderPricingFeatureState();
  try {
    const out = await window.PricingFeatureState.withTimeout(request, '/api/pricing/ladder/feature', {
      method: 'POST',
      body: JSON.stringify({ enabled, count_mode: countMode, expected_version: intent.expected_version })
    });
    if (!isCurrentPricingOwner(pricing, userId)) return;
    if (!window.PricingFeatureState.confirms(out && out.feature, intent)) {
      throw new Error('服务端未确认本次设置，请刷新后重试');
    }
    const merged = window.PricingFeatureState.merge(pricing.feature_confirmed ? pricing.feature : null, out.feature);
    if (merged.accepted) pricing.feature = merged.feature;
    pricing.feature_confirmed = true;
    pricing.feature_intent = null;
    delete pricing.pending_count_mode;
    pricing.data_stale = pricing.count_mode !== pricing.feature.count_mode;
    const refreshed = await loadPricingView({ from_save: true });
    if (!isCurrentPricingOwner(pricing, userId)) return;
    if (!window.PricingFeatureState.confirms(pricing.feature, intent)) {
      showToast('设置已在其他页面更新，已同步最新配置');
    } else if (refreshed.ok) showToast(pricingFeatureSaveMessage(intent));
    else if (refreshed.reason !== 'superseded') showToast('设置已保存，数据刷新失败');
  } catch (e) {
    if (!isCurrentPricingOwner(pricing, userId)) return;
    if (window.PricingFeatureState.isRejected(e) && Number(e.status) !== 409) {
      pricing.feature_save_error = modeChanged;
      pricing.feature_intent = null;
      pricing.data_stale = pricing.count_mode !== pricing.feature.count_mode;
      showToast(e.message || '设置保存失败，请重试');
    } else {
      // A lost response does not tell us whether the write committed. Confirm by reading it back.
      pricing.feature_uncertain = intent;
      pricing.feature_intent = null;
      const checked = await loadPricingView({ from_save: true });
      if (!isCurrentPricingOwner(pricing, userId)) return;
      if (checked.ok && window.PricingFeatureState.confirms(pricing.feature, intent)) {
        showToast(pricingFeatureSaveMessage(intent));
      } else if (checked.ok || window.PricingFeatureState.isRejected(e)) {
        pricing.feature_save_error = modeChanged;
        pricing.feature_uncertain = null;
        pricing.data_stale = pricing.count_mode !== pricing.feature.count_mode;
        showToast(e.message || '设置保存失败，请重试');
      } else {
        showToast('暂未确认保存结果，请稍后刷新或重试');
      }
    }
  } finally {
    pricing.feature_saving = false;
    pricing.feature_intent = null;
    delete pricing.pending_enabled;
    if (!pricing.feature_uncertain) delete pricing.pending_count_mode;
    if (isCurrentPricingOwner(pricing, userId)) {
      renderPricingView();
      schedulePricingFeatureRefresh();
    }
  }
}

function renderPricingFeatureState() {
  const pricing = ensurePricingLadderState();
  if (els.pricingFeatureToggle) {
    els.pricingFeatureToggle.checked = pricing.feature_saving ? pricing.pending_enabled : pricing.feature.enabled === true;
    els.pricingFeatureToggle.disabled = pricing.feature_saving === true || !pricing.feature_confirmed;
    els.pricingFeatureToggle.onchange = () => void updatePricingFeature(Boolean(els.pricingFeatureToggle.checked));
  }
  if (els.pricingFeatureStatus) {
    els.pricingFeatureStatus.textContent = pricing.feature.enabled ? '已开启' : '已关闭';
  }
  const countStatus = document.getElementById('pricingCountStatus');
  if (countStatus) {
    const status = window.PricingFeatureState.status(pricing.feature, {
      saving: pricing.feature_saving, uncertain: Boolean(pricing.feature_uncertain),
      failed: pricing.feature_save_error, confirmed: pricing.feature_confirmed
    });
    countStatus.textContent = status.text;
    countStatus.dataset.state = status.key;
    countStatus.hidden = !pricing.feature_confirmed && !pricing.feature_saving && !pricing.feature_uncertain && !pricing.feature_save_error;
  }
  const countSelect = document.getElementById('pricingCountMode');
  if (countSelect) {
    countSelect.value = pricing.pending_count_mode || pricing.feature.count_mode;
    countSelect.disabled = pricing.feature_saving === true || !pricing.feature_confirmed;
    countSelect.onchange = () => void updatePricingCountMode(countSelect.value);
  }
}

function renderPricingView() {
  if (!els.pricingView) return;
  const pricing = ensurePricingLadderState();
  const ratioMode = state.currentMenu === 'pricing_ratios';
  const ladderPane = document.getElementById('pricingLadderPane');
  const ratioPane = document.getElementById('pricingRatioPane');
  if (ladderPane) ladderPane.classList.toggle('hidden', ratioMode);
  if (ratioPane) ratioPane.classList.toggle('hidden', !ratioMode);
  if (ratioMode) {
    renderPricingRatioSettings();
    return;
  }
  renderPricingGameTabs();
  renderPricingFeatureState();
  const windowText = document.getElementById('pricingWindowText');
  if (windowText) {
    windowText.textContent = pricing.data_stale ? '' : pricingCountWindowRange(pricing.window_start, pricing.window_end);
    windowText.hidden = !windowText.textContent;
  }
  const helpSummary = document.getElementById('pricingWindowHelpSummary');
  if (helpSummary) helpSummary.textContent = `档位按${pricing.count_window || pricingCountWindowLabel(pricing.count_mode)}有效订单数计算：`;
  const helpDescription = document.getElementById('pricingWindowHelpDescription');
  if (helpDescription) helpDescription.textContent = pricing.count_mode === 'business_day'
    ? '统计最近一次北京时间06:00到当前时间的订单；凌晨6点前从前一天06:00算起，06:00进入新周期。'
    : '按当前时间向前滚动24小时统计，订单移出窗口后，档位可能下降。';
  if (window.HelpSheet) window.HelpSheet.bind(
    document.getElementById('pricingWindowHelpBtn'),
    document.getElementById('pricingWindowHelpSheet'),
    document.getElementById('pricingWindowHelpCloseBtn')
  );
  if (els.pricingSearchInput) {
    if (document.activeElement !== els.pricingSearchInput) els.pricingSearchInput.value = pricing.query;
    els.pricingSearchInput.oninput = () => {
      pricing.query = String(els.pricingSearchInput.value || '').trim();
      renderPricingView();
    };
  }
  if (els.pricingSearchSummary) {
    const visible = filterPricingItems(pricing.list, pricing.query).length;
    els.pricingSearchSummary.textContent = pricing.query
      ? `当前显示 ${visible} / 共 ${pricing.list.length} 个账号`
      : `共 ${pricing.list.length} 个账号`;
  }
  renderPricingList();
  schedulePricingFeatureRefresh();
}

async function loadPricingView(options = {}) {
  const pricing = ensurePricingLadderState();
  if (state.currentMenu === 'pricing_ratios') {
    await loadPricingRatioSettings();
    return { ok: false, reason: 'superseded' };
  }
  const userId = String(state.user && state.user.id || '');
  const game = pricing.game_name;
  const revision = Number(pricing.feature_request_revision || 0);
  const editRevision = Number(pricing.edit_revision || 0);
  const requestId = pricing.list_request_id = Number(pricing.list_request_id || 0) + 1;
  const active = () => isCurrentPricingOwner(pricing, userId)
    && requestId === pricing.list_request_id && game === pricing.game_name;
  if (!options.poll) {
    pricing.feature_poll_attempts = 0;
    pricing.loading = true;
    pricing.error = '';
    renderPricingView();
  }
  try {
    const out = await window.PricingFeatureState.withTimeout(request, `/api/pricing/ladder?${buildPricingRequestQuery()}`, { background: options.poll === true });
    if (!active() || revision !== Number(pricing.feature_request_revision || 0)) return { ok: false, reason: 'superseded' };
    if (options.poll && (pricingHasActiveEdits(pricing) || editRevision !== Number(pricing.edit_revision || 0))) {
      return { ok: false, reason: 'superseded' };
    }
    if (!applyPricingPayload(out, { game_name: game, from_save: options.from_save })) {
      if (!options.poll) pricing.error = '暂未获取到对应配置的订单数据，请稍后刷新';
      return { ok: false, reason: 'stale' };
    }
    return { ok: true };
  } catch (e) {
    if (!active()) return { ok: false, reason: 'superseded' };
    if (!options.poll) pricing.error = String(e && e.message || '阶梯定价加载失败');
    return { ok: false, reason: 'error' };
  } finally {
    if (active()) {
      pricing.loading = false;
      if (!options.poll || (!pricingHasActiveEdits(pricing) && editRevision === Number(pricing.edit_revision || 0))) renderPricingView();
      schedulePricingFeatureRefresh();
    }
  }
}

window.loadPricingView = loadPricingView;
window.renderPricingView = renderPricingView;
window.__pricingLadderTest = {
  normalizePricingGameName,
  normalizePricingCountMode,
  pricingCountWindowLabel,
  pricingCountSummary,
  pricingCountWindowRange,
  formatPricingMoney,
  formatPricingResultMoney,
  normalizePricingDraft,
  validatePricingDraft,
  pricingApplyStatusText,
  pricingTierLabel,
  pricingTierSummary,
  filterPricingItems,
  pricingLogStatusText,
  pricingLogTriggerText,
  formatPricingErrorDetail,
  renderPricingChannelLogs,
  renderPricingChannelResult,
  renderPricingPackageValues,
  formatPricingRatio,
  normalizePricingRatioDraft,
  validatePricingRatioDraft,
  normalizePricingPreviewPrice,
  calculatePricingRatioPreview
};
