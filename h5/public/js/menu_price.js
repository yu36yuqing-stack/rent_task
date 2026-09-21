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

function ensurePricingLadderState() {
  const pricing = state.pricing || (state.pricing = {});
  if (!pricing.game_name) pricing.game_name = 'WZRY';
  if (!Array.isArray(pricing.list)) pricing.list = [];
  if (typeof pricing.query !== 'string') pricing.query = '';
  if (!pricing.editing || typeof pricing.editing !== 'object') pricing.editing = {};
  if (!pricing.saving || typeof pricing.saving !== 'object') pricing.saving = {};
  if (!pricing.drafts || typeof pricing.drafts !== 'object') pricing.drafts = {};
  if (!pricing.feature || typeof pricing.feature !== 'object') {
    pricing.feature = { enabled: false, reconcile_required: false, version: 0 };
  }
  if (typeof pricing.feature_saving !== 'boolean') pricing.feature_saving = false;
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

function renderPricingPackageValues(prices = {}, packageKeys = ['hour', 'night', 'day', 'week']) {
  return packageKeys.map((key) => `
    <span class="pricing-package-value">${escapePricingHtml(formatPricingResultMoney(prices[key]))}</span>
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
  if (value === 1) return '第 1 单价（完成 0 单）';
  return `第 ${value} 单价（完成 ${value - 1} 单后）`;
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
    order_finished_changed: '订单换挡',
    daily_reset: '06:00重置',
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
    <div class="pricing-package-row ${packageCountClass} ${Number(tier.tier) === Number(result.current_tier || payload.current_tier) ? 'is-active' : ''}">
      <strong>${escapePricingHtml(pricingTierLabel(tier.tier))}${Number(tier.tier) === Number(result.current_tier || payload.current_tier) ? ' · 当前使用' : ''}</strong>
      ${renderPricingPackageValues(tier.prices, packageKeys)}
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
    <div class="pricing-channel-meta">商品 ${escapePricingHtml(result.goods_id || '未关联')}${result.min_rent_hour ? ` · 起租 ${Number(result.min_rent_hour)} 小时` : ''}</div>
    ${result.verification_note ? `<div class="pricing-channel-meta">${escapePricingHtml(result.verification_note)}</div>` : ''}
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
        { channel: 'zuhaowang', label: '租号玩', enabled: false },
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

function applyPricingPayload(out) {
  const pricing = ensurePricingLadderState();
  pricing.game_name = normalizePricingGameName(out && out.game_name || pricing.game_name || 'WZRY');
  pricing.list = Array.isArray(out && out.list) ? out.list : [];
  pricing.count_window = String(out && out.count_window || '06:00～次日06:00');
  pricing.feature = out && out.feature && typeof out.feature === 'object'
    ? {
        enabled: out.feature.enabled === true,
        reconcile_required: out.feature.reconcile_required === true,
        version: Number(out.feature.version || 0)
      }
    : { enabled: false, reconcile_required: false, version: 0 };
  pricing.error = '';
  pricing.loaded_once = true;
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
            aria-label="第 ${tier} 单价格" value="${escapePricingHtml(draft.prices[index] || '')}" ${editing && !saving ? '' : 'disabled'}>
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
            <span>完成 ${Number(item.today_order_count || 0)} 单</span>
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
          <span class="pricing-current-price">${item.configured
            ? `已完成 ${Number(item.today_order_count || 0)} 单，当前使用第 ${Math.min(4, Math.max(1, Number(item.current_tier || Number(item.today_order_count || 0) + 1)))} 单价格`
            : '阶梯调价：未启用'}</span>
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
  if (pricing.feature_saving || pricing.feature.enabled === enabled) return;
  if (enabled && !window.confirm('开启后，下一个订单同步周期会校准所有已配置账号。确认开启？')) {
    renderPricingFeatureState();
    return;
  }
  pricing.feature_saving = true;
  renderPricingFeatureState();
  try {
    const out = await request('/api/pricing/ladder/feature', {
      method: 'POST',
      body: JSON.stringify({
        enabled,
        expected_version: Number(pricing.feature.version || 0)
      })
    });
    const saved = out && out.feature ? out.feature : {};
    pricing.feature = {
      enabled: saved.enabled === true,
      reconcile_required: saved.reconcile_required === true,
      version: Number(saved.version || 0)
    };
    showToast(pricing.feature.enabled ? '自动阶梯调价已开启' : '自动阶梯调价已关闭');
  } catch (e) {
    showToast(e.message || '自动阶梯调价开关保存失败');
  } finally {
    pricing.feature_saving = false;
    renderPricingFeatureState();
  }
}

function renderPricingFeatureState() {
  const pricing = ensurePricingLadderState();
  if (els.pricingFeatureToggle) {
    els.pricingFeatureToggle.checked = pricing.feature.enabled === true;
    els.pricingFeatureToggle.disabled = pricing.feature_saving === true;
    els.pricingFeatureToggle.onchange = () => void updatePricingFeature(Boolean(els.pricingFeatureToggle.checked));
  }
  if (els.pricingFeatureStatus) {
    els.pricingFeatureStatus.textContent = pricing.feature_saving
      ? '保存中...'
      : (pricing.feature.enabled ? (pricing.feature.reconcile_required ? '已开启 · 待校准' : '已开启') : '已关闭 · 仅保存配置');
  }
}

function renderPricingView() {
  if (!els.pricingView) return;
  const pricing = ensurePricingLadderState();
  renderPricingGameTabs();
  renderPricingFeatureState();
  const windowText = document.getElementById('pricingWindowText');
  if (windowText) windowText.textContent = `订单周期：${pricing.count_window || '06:00～次日06:00'}`;
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
}

async function loadPricingView() {
  const pricing = ensurePricingLadderState();
  pricing.loading = true;
  pricing.error = '';
  renderPricingView();
  try {
    const out = await request(`/api/pricing/ladder?${buildPricingRequestQuery()}`);
    applyPricingPayload(out);
  } catch (e) {
    pricing.error = String(e && e.message || '阶梯定价加载失败');
  } finally {
    pricing.loading = false;
    renderPricingView();
  }
}

window.loadPricingView = loadPricingView;
window.renderPricingView = renderPricingView;
window.__pricingLadderTest = {
  normalizePricingGameName,
  formatPricingMoney,
  formatPricingResultMoney,
  normalizePricingDraft,
  validatePricingDraft,
  pricingApplyStatusText,
  pricingTierLabel,
  filterPricingItems,
  pricingLogStatusText,
  pricingLogTriggerText,
  formatPricingErrorDetail,
  renderPricingChannelLogs,
  renderPricingChannelResult,
  renderPricingPackageValues
};
