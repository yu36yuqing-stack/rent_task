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
      refreshing: false,
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

function renderPricingPackageValues(prices = {}) {
  return ['hour', 'night', 'day', 'week'].map((key) => `
    <span class="pricing-package-value">${escapePricingHtml(formatPricingResultMoney(prices[key]))}</span>
  `).join('');
}

function pricingApplyStatusText(status) {
  if (status === 'effective') return '渠道价格与当前档一致';
  if (status === 'manual') return '渠道手工价（不会自动纠正）';
  if (status === 'pending') return '待执行换档';
  if (status === 'blocked') return '受上下架安全规则阻塞';
  if (status === 'failed') return '上次换档失败';
  return '套餐数据暂不完整';
}

function renderPricingChannelLogs(result = {}) {
  const logs = Array.isArray(result.error_logs) ? result.error_logs : [];
  if (logs.length === 0) {
    return '<div class="pricing-channel-empty">当前账号暂无 U号租价格设置错误。</div>';
  }
  return `<div class="pricing-error-log-list">${logs.map((log) => `
    <article class="pricing-error-log-item">
      <div class="pricing-error-log-head">
        <span>${escapePricingHtml(log.create_date || '-')}</span>
        <span class="pricing-error-log-tools">
          <span>批次 ${escapePricingHtml(log.batch_id || '-')}</span>
          <button class="copy-btn" data-pricing-copy-error="${Number(log.id || 0)}" type="button">复制错误</button>
        </span>
      </div>
      <p>${escapePricingHtml(log.fail_message || 'U号租未返回明确错误信息')}</p>
      <div class="pricing-error-log-prices">
        目标：时租 ${escapePricingHtml(formatPricingResultMoney(log.target_prices && log.target_prices.hour))} ·
        包夜 ${escapePricingHtml(formatPricingResultMoney(log.target_prices && log.target_prices.night))} ·
        包天 ${escapePricingHtml(formatPricingResultMoney(log.target_prices && log.target_prices.day))} ·
        包周 ${escapePricingHtml(formatPricingResultMoney(log.target_prices && log.target_prices.week))}
      </div>
    </article>
  `).join('')}</div>`;
}

function renderUhaozuChannelResult(payload = {}) {
  const result = payload.channel_result || {};
  const sheetState = ensurePricingLadderState().channel_sheet;
  const baseline = result.baseline || null;
  const remote = result.remote_current || {};
  const tiers = Array.isArray(result.tiers) ? result.tiers : [];
  const errors = Array.isArray(result.error_logs) ? result.error_logs : [];
  const baselineText = result.baseline_status === 'saved'
    ? '已冻结基准'
    : (result.baseline_status === 'preview' ? '使用当前同步价格预览，保存配置后冻结' : '套餐价格不完整');
  const viewTabs = `
    <div class="orders-tabs pricing-result-tabs">
      <button class="orders-tab header-tab ${sheetState.view === 'result' ? 'active' : ''}" data-pricing-result-view="result" type="button">套餐结果</button>
      <button class="orders-tab header-tab ${sheetState.view === 'logs' ? 'active' : ''}" data-pricing-result-view="logs" type="button">错误日志${errors.length ? ` (${errors.length})` : ''}</button>
    </div>
  `;
  if (sheetState.view === 'logs') return `${viewTabs}${renderPricingChannelLogs(result)}`;
  const baselineBlock = baseline ? `
    <div class="pricing-channel-summary">
      <div>
        <span>价格基准</span>
        <strong>${escapePricingHtml(baselineText)}</strong>
      </div>
      <div class="pricing-package-line">
        <span>时租 ${escapePricingHtml(formatPricingResultMoney(baseline.prices && baseline.prices.hour))}</span>
        <span>包夜 ${escapePricingHtml(formatPricingResultMoney(baseline.prices && baseline.prices.night))}</span>
        <span>包天 ${escapePricingHtml(formatPricingResultMoney(baseline.prices && baseline.prices.day))}</span>
        <span>包周 ${escapePricingHtml(formatPricingResultMoney(baseline.prices && baseline.prices.week))}</span>
      </div>
      <div class="pricing-package-line pricing-ratio-line">
        <span>比例 1</span>
        <span>${escapePricingHtml(String(baseline.ratios && baseline.ratios.night || '-'))}</span>
        <span>${escapePricingHtml(String(baseline.ratios && baseline.ratios.day || '-'))}</span>
        <span>${escapePricingHtml(String(baseline.ratios && baseline.ratios.week || '-'))}</span>
      </div>
    </div>
  ` : '<div class="pricing-channel-empty">U号租当前套餐价格不完整，暂时无法计算四档套餐结果。</div>';
  const tierRows = tiers.map((tier) => `
    <div class="pricing-package-row ${Number(tier.tier) === Number(payload.current_tier) ? 'is-active' : ''}">
      <strong>第 ${Number(tier.tier || 0)} 单${Number(tier.tier) === Number(payload.current_tier) ? ' · 当前档' : ''}</strong>
      ${renderPricingPackageValues(tier.prices)}
    </div>
  `).join('');
  return `
    ${viewTabs}
    <div class="pricing-channel-current">
      <div>
        <span>U号租当前渠道价格（最近同步）</span>
        <strong>${escapePricingHtml(pricingApplyStatusText(result.apply_status))}</strong>
      </div>
      <div class="pricing-package-line">
        <span>时租 ${escapePricingHtml(formatPricingResultMoney(remote.hour))}</span>
        <span>包夜 ${escapePricingHtml(formatPricingResultMoney(remote.night))}</span>
        <span>包天 ${escapePricingHtml(formatPricingResultMoney(remote.day))}</span>
        <span>包周 ${escapePricingHtml(formatPricingResultMoney(remote.week))}</span>
      </div>
    </div>
    ${baselineBlock}
    ${tiers.length ? `
      <div class="pricing-package-table">
        <div class="pricing-package-row pricing-package-header">
          <strong>订单档位</strong><span>时租</span><span>包夜</span><span>包天</span><span>包周</span>
        </div>
        ${tierRows}
      </div>
    ` : ''}
    <div class="pricing-channel-inline-actions">
      <span>商品 ${escapePricingHtml(result.goods_id || '未关联')}</span>
      <button class="btn btn-ghost btn-card-action" data-pricing-refresh-baseline type="button"
        ${result.remote_complete && !sheetState.refreshing ? '' : 'disabled'}>${sheetState.refreshing ? '更新中...' : '以当前渠道价格更新基准'}</button>
    </div>
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
        { channel: 'uuzuhao', label: '悠悠租号', enabled: false }
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
      nodes.body.innerHTML = renderUhaozuChannelResult(sheetState.payload || {});
    }
  }
  Array.from(nodes.body.querySelectorAll('[data-pricing-result-view]')).forEach((button) => {
    button.onclick = () => {
      sheetState.view = String(button.getAttribute('data-pricing-result-view') || 'result');
      renderPricingChannelSheet();
    };
  });
  const refresh = nodes.body.querySelector('[data-pricing-refresh-baseline]');
  if (refresh) refresh.onclick = () => void refreshPricingChannelBaseline();
  Array.from(nodes.body.querySelectorAll('[data-pricing-copy-error]')).forEach((button) => {
    button.onclick = async () => {
      const id = Number(button.getAttribute('data-pricing-copy-error') || 0);
      const logs = sheetState.payload && sheetState.payload.channel_result
        ? sheetState.payload.channel_result.error_logs || []
        : [];
      const log = logs.find((item) => Number(item.id || 0) === id);
      const ok = log ? await copyTextToClipboard(log.fail_message || '') : false;
      showToast(ok ? '错误信息已复制' : '复制失败');
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

async function refreshPricingChannelBaseline() {
  const pricing = ensurePricingLadderState();
  const sheetState = pricing.channel_sheet;
  const item = pricingItemByAccount(sheetState.account);
  if (!item || sheetState.refreshing) return;
  if (!window.confirm('确认使用最近同步的 U号租套餐价格覆盖该账号的价格基准？')) return;
  sheetState.refreshing = true;
  renderPricingChannelSheet();
  try {
    sheetState.payload = await request('/api/pricing/ladder/channel-baseline', {
      method: 'POST',
      body: JSON.stringify({
        game_id: item.game_id,
        game_name: item.game_name,
        game_account: item.game_account,
        channel: 'uhaozu'
      })
    });
    showToast('U号租价格基准已更新');
  } catch (e) {
    showToast(e.message || '价格基准更新失败');
  } finally {
    sheetState.refreshing = false;
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
    showToast(item.configured ? '阶梯价格已保存' : '已清空，账号回到待配置状态');
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
  els.pricingListContainer.innerHTML = pricing.list.map((item) => {
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
        <span>第 ${tier} 单</span>
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
            ? `当前档位：第 ${Math.min(4, Math.max(1, Number(item.current_tier || Number(item.today_order_count || 0) + 1)))} 单`
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
  pricingApplyStatusText
};
