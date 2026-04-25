function escapeBoardHtml(text) {
  return String(text || '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function normalizeBoardGameName(gameName) {
  const text = String(gameName || '').trim();
  const upper = text.toUpperCase();
  if (upper === 'CSGO' || text === 'CS:GO' || upper === 'CS2' || text.includes('反恐精英')) return 'CSGO';
  if (text.includes('CFM') || text.includes('枪战王者') || text.includes('穿越火线') || upper === 'CFM') return 'CFM';
  if (text === '和平精英' || upper === 'HPJY') return '和平精英';
  return 'WZRY';
}

function buildBoardGameAvatarHtml(gameName) {
  const normalized = normalizeBoardGameName(gameName);
  if (normalized === 'CSGO') {
    return `<span class="game-avatar game-avatar-csgo" title="CSGO" aria-label="CSGO">
      <img src="/assets/game_icons/csgo.png?v=20260425-soldier" alt="CSGO" loading="lazy" decoding="async">
    </span>`;
  }
  if (normalized === 'CFM') {
    return `<span class="game-avatar game-avatar-cfm" title="CFM枪战王者" aria-label="CFM枪战王者">
      <img src="/assets/game_icons/cfm.png" alt="CFM枪战王者" loading="lazy" decoding="async">
    </span>`;
  }
  if (normalized === '和平精英') {
    return `<span class="game-avatar game-avatar-hpjy" title="和平精英" aria-label="和平精英">
      <img src="/assets/game_icons/hpjy.png" alt="和平精英" loading="lazy" decoding="async">
    </span>`;
  }
  return `<span class="game-avatar game-avatar-wzry" title="王者荣耀" aria-label="王者荣耀">
    <img src="/assets/game_icons/wzry.webp" alt="王者荣耀" loading="lazy" decoding="async">
  </span>`;
}

function boardMatchesFilter(board, filter, query) {
  const normalizedFilter = String(filter || 'all').trim();
  const normalizedQuery = String(query || '').trim().toLowerCase();
  const mobiles = Array.isArray(board && board.mobiles) ? board.mobiles : [];
  if (normalizedFilter === 'has_mobile' && mobiles.filter((item) => item.mobile).length === 0) return false;
  if (!normalizedQuery) return true;
  const haystack = [
    board && board.board_name,
    board && board.board_ip,
    ...(mobiles.map((item) => item.mobile)),
    ...(mobiles.flatMap((item) => Array.isArray(item.accounts) ? item.accounts.map((acc) => acc && (acc.display_name || acc.account)) : []))
  ].map((item) => String(item || '').trim().toLowerCase());
  return haystack.some((item) => item.includes(normalizedQuery));
}

function boardFilteredList() {
  const source = state.board && Array.isArray(state.board.list) ? state.board.list : [];
  const filter = state.board ? state.board.filter : 'all';
  const query = state.board ? state.board.query : '';
  return source.filter((board) => boardMatchesFilter(board, filter, query));
}

function applyBoardPayload(out) {
  state.board.list = Array.isArray(out && out.boards) ? out.boards : [];
  state.board.summary = out && out.summary && typeof out.summary === 'object'
    ? out.summary
    : { board_count: state.board.list.length, mobile_count: 0, account_count: 0 };
}

async function loadBoardCards() {
  state.board.loading = true;
  renderBoardView();
  try {
    const out = await request('/api/board-cards');
    applyBoardPayload(out);
  } finally {
    state.board.loading = false;
    renderBoardView();
  }
}

function renderResult(node, text, type) {
  if (!node) return;
  const msg = String(text || '').trim();
  node.textContent = msg;
  node.classList.toggle('ok', type === 'ok' && Boolean(msg));
  node.classList.toggle('err', type === 'err' && Boolean(msg));
}

function renderBoardSmsSheet() {
  if (!els.boardSmsSheet) return;
  const sheet = state.board.smsSheet || {};
  const opened = Boolean(sheet.open);
  els.boardSmsSheet.classList.toggle('hidden', !opened);
  if (!opened) return;
  if (els.boardSmsSheetTitle) {
    els.boardSmsSheetTitle.textContent = `发送短信 · ${String(sheet.board_name || '').trim() || '板卡'}`;
  }
  if (els.boardSmsSender) {
    els.boardSmsSender.value = String(sheet.mobile || '').trim();
  }
  if (els.boardSmsRecipient) {
    els.boardSmsRecipient.value = String(sheet.recipient || '').trim();
  }
  if (els.boardSmsContent && document.activeElement !== els.boardSmsContent) {
    els.boardSmsContent.value = String(sheet.content || '');
  }
  renderResult(els.boardSmsSheetResult, sheet.result_text, sheet.result_type);
  if (els.boardSmsSendBtn) {
    els.boardSmsSendBtn.disabled = Boolean(sheet.sending);
    els.boardSmsSendBtn.textContent = sheet.sending ? '发送中...' : '发送';
  }
}

function renderBoardCreateSheet() {
  if (!els.boardCreateSheet) return;
  const sheet = state.board.createSheet || {};
  const opened = Boolean(sheet.open);
  els.boardCreateSheet.classList.toggle('hidden', !opened);
  if (!opened) return;
  if (els.boardCreateName && document.activeElement !== els.boardCreateName) {
    els.boardCreateName.value = String(sheet.board_name || '');
  }
  if (els.boardCreateIp && document.activeElement !== els.boardCreateIp) {
    els.boardCreateIp.value = String(sheet.board_ip || '');
  }
  renderResult(els.boardCreateSheetResult, sheet.result_text, sheet.result_type);
  if (els.boardCreateSaveBtn) {
    els.boardCreateSaveBtn.disabled = Boolean(sheet.saving);
    els.boardCreateSaveBtn.textContent = sheet.saving ? '保存中...' : '保存';
  }
}

function renderBoardMobileSlotSheet() {
  if (!els.boardMobileSlotSheet) return;
  const sheet = state.board.mobileSlotSheet || {};
  const opened = Boolean(sheet.open);
  els.boardMobileSlotSheet.classList.toggle('hidden', !opened);
  if (!opened) return;
  if (els.boardMobileSlotSheetTitle) {
    els.boardMobileSlotSheetTitle.textContent = `新增卡位手机号 · ${String(sheet.board_name || '').trim() || '板卡'}`;
  }
  if (els.boardMobileSlotMobile && document.activeElement !== els.boardMobileSlotMobile) {
    els.boardMobileSlotMobile.value = String(sheet.mobile || '');
  }
  if (els.boardMobileSlotIndex && document.activeElement !== els.boardMobileSlotIndex) {
    els.boardMobileSlotIndex.value = String(sheet.slot_index || '');
  }
  renderResult(els.boardMobileSlotSheetResult, sheet.result_text, sheet.result_type);
  if (els.boardMobileSlotSaveBtn) {
    els.boardMobileSlotSaveBtn.disabled = Boolean(sheet.saving);
    els.boardMobileSlotSaveBtn.textContent = sheet.saving ? '保存中...' : '保存';
  }
}

function renderBoardMobileAccountSheet() {
  if (!els.boardMobileAccountSheet) return;
  const sheet = state.board.mobileAccountSheet || {};
  const opened = Boolean(sheet.open);
  els.boardMobileAccountSheet.classList.toggle('hidden', !opened);
  if (!opened) return;
  if (els.boardMobileAccountSheetTitle) {
    els.boardMobileAccountSheetTitle.textContent = `新增手机号账号 · ${String(sheet.mobile || '').trim() || '手机号'}`;
  }
  if (els.boardMobileAccountValue && document.activeElement !== els.boardMobileAccountValue) {
    els.boardMobileAccountValue.value = String(sheet.account || '');
  }
  renderResult(els.boardMobileAccountSheetResult, sheet.result_text, sheet.result_type);
  if (els.boardMobileAccountSaveBtn) {
    els.boardMobileAccountSaveBtn.disabled = Boolean(sheet.saving);
    els.boardMobileAccountSaveBtn.textContent = sheet.saving ? '保存中...' : '保存';
  }
}

function renderBoardSmsRecordSheet() {
  if (!els.boardSmsRecordSheet) return;
  const sheet = state.board.smsRecordSheet || {};
  const opened = Boolean(sheet.open);
  els.boardSmsRecordSheet.classList.toggle('hidden', !opened);
  if (!opened) return;
  if (els.boardSmsRecordSheetTitle) {
    els.boardSmsRecordSheetTitle.textContent = String(sheet.title || '短信发送记录');
  }
  renderResult(els.boardSmsRecordSheetResult, sheet.result_text || (sheet.loading ? '加载中...' : ''), sheet.result_type);
  if (els.boardSmsRecordList) {
    const list = Array.isArray(sheet.list) ? sheet.list : [];
    if (sheet.loading && list.length === 0) {
      els.boardSmsRecordList.innerHTML = '<div class="board-sms-record-empty">短信记录加载中...</div>';
    } else if (list.length === 0) {
      els.boardSmsRecordList.innerHTML = '<div class="board-sms-record-empty">暂无短信发送记录</div>';
    } else {
      els.boardSmsRecordList.innerHTML = list.map((item) => `
        <div class="board-sms-record-item">
          <div class="board-sms-record-top">
            <span class="board-sms-record-time">${escapeBoardHtml(item.create_date || '-')}</span>
            <span class="board-sms-record-status ${String(item.send_status || '') === 'success' ? 'ok' : 'err'}">${String(item.send_status || '') === 'success' ? '成功' : '失败'}</span>
          </div>
          <div class="board-sms-record-line">发件人：${escapeBoardHtml(item.sender_mobile || '-')}</div>
          <div class="board-sms-record-line">收件人：${escapeBoardHtml(item.recipient_mobile || '-')}</div>
          <div class="board-sms-record-line">短信：${escapeBoardHtml(item.sms_content || '-')}</div>
          <div class="board-sms-record-line">结果：${escapeBoardHtml(item.send_result || '-')}</div>
        </div>
      `).join('');
    }
  }
}

function renderBoardView() {
  if (!els.boardView) return;
  const filtered = boardFilteredList();
  const summary = state.board.summary || { board_count: 0, mobile_count: 0, account_count: 0 };
  if (els.boardSearchInput && document.activeElement !== els.boardSearchInput) {
    els.boardSearchInput.value = String(state.board.query || '');
  }
  if (els.boardSummaryText) {
    const suffix = state.board.loading ? '，正在加载...' : filtered.length !== Number(summary.board_count || 0) ? `，当前筛出 ${filtered.length} 张` : '';
    els.boardSummaryText.textContent = `共 ${Number(summary.board_count || 0)} 张板卡，${Number(summary.mobile_count || 0)} 个手机号，${Number(summary.account_count || 0)} 个 account${suffix}`;
  }
  if (els.boardFilterTabs) {
    Array.from(els.boardFilterTabs.querySelectorAll('[data-board-filter]')).forEach((node) => {
      const current = String(node.getAttribute('data-board-filter') || '').trim();
      node.classList.toggle('active', current === String(state.board.filter || 'all'));
    });
  }
  if (state.board.loading && filtered.length === 0) {
    els.boardListContainer.innerHTML = '<div class="panel board-empty">板卡信息加载中...</div>';
  } else if (filtered.length === 0) {
    els.boardListContainer.innerHTML = '<div class="panel board-empty">当前没有匹配的板卡</div>';
  } else {
    els.boardListContainer.innerHTML = filtered.map((board) => {
      const mobiles = Array.isArray(board.mobiles) ? board.mobiles : [];
      const mobileHtml = mobiles.map((mobile) => {
        const accounts = Array.isArray(mobile.accounts) ? mobile.accounts : [];
        const accountHtml = accounts.length > 0
          ? accounts.map((account) => `
            <span class="board-account-tag">
              ${buildBoardGameAvatarHtml(account && account.game_name)}
              <span class="board-account-tag-text">${escapeBoardHtml(account && (account.display_name || account.account) || '')}</span>
            </span>
          `).join('')
          : '<span class="board-account-empty">暂无绑定 account</span>';
        return `
          <div class="board-mobile-card">
            <div class="board-mobile-head">
              <div>
                <p class="board-mobile-title">卡${Number(mobile.slot_index || 0)}：${escapeBoardHtml(mobile.mobile || mobile.mobile_masked || '-')}</p>
                <p class="board-mobile-meta">account ${Number(mobile.account_count || 0)}/5</p>
              </div>
              <div class="board-mobile-actions">
                <button class="btn btn-ghost btn-card-action" data-op="board-add-account" data-board-id="${Number(board.id || 0)}" data-mobile-slot-id="${Number(mobile.id || 0)}">新增账号</button>
                <button class="btn btn-ghost btn-card-action" data-op="board-view-sms-records" data-mobile-slot-id="${Number(mobile.id || 0)}" data-mobile="${escapeBoardHtml(mobile.mobile || '')}">查看记录</button>
                <button class="btn btn-ghost btn-card-action" data-op="board-sms" data-board-id="${Number(board.id || 0)}" data-mobile-id="${Number(mobile.id || 0)}">发短信</button>
              </div>
            </div>
            <div class="board-account-list">${accountHtml}</div>
          </div>
        `;
      }).join('');
      const addSlotBtn = board.can_add_mobile_slot
        ? `<button class="btn btn-ghost btn-card-action" data-op="board-add-slot" data-board-id="${Number(board.id || 0)}">新增卡位</button>`
        : '';
      return `
        <div class="panel board-card">
          <div class="board-card-head">
            <div>
              <p class="board-card-title">${escapeBoardHtml(board.board_name || '-')}</p>
              <p class="board-card-meta">IP：${escapeBoardHtml(board.board_ip || '-')}</p>
            </div>
            <div class="board-card-actions">${addSlotBtn}</div>
          </div>
          <div class="board-mobile-list">${mobileHtml || '<div class="board-account-empty">当前板卡还没有绑定卡位手机号</div>'}</div>
        </div>
      `;
    }).join('');
  }
  renderBoardSmsSheet();
  renderBoardCreateSheet();
  renderBoardMobileSlotSheet();
  renderBoardMobileAccountSheet();
  renderBoardSmsRecordSheet();
}

function openBoardSmsSheet(boardId, mobileId) {
  const boards = Array.isArray(state.board.list) ? state.board.list : [];
  const board = boards.find((item) => Number(item.id || 0) === Number(boardId || 0));
  const mobile = board && Array.isArray(board.mobiles) ? board.mobiles.find((item) => Number(item.id || 0) === Number(mobileId || 0)) : null;
  if (!board || !mobile) return showToast('手机号信息不存在');
  state.board.smsSheet = {
    open: true,
    sending: false,
    board_id: Number(board.id || 0),
    board_name: String(board.board_name || '').trim(),
    mobile_id: Number(mobile.id || 0),
    mobile: String(mobile.mobile || '').trim(),
    recipient: '',
    content: '',
    result_text: '',
    result_type: ''
  };
  renderBoardSmsSheet();
}

function closeBoardSmsSheet() {
  state.board.smsSheet = {
    open: false,
    sending: false,
    board_id: 0,
    board_name: '',
    mobile_id: 0,
    mobile: '',
    recipient: '',
    content: '',
    result_text: '',
    result_type: ''
  };
  renderBoardSmsSheet();
}

function openBoardCreateSheet() {
  state.board.createSheet = {
    open: true,
    saving: false,
    board_name: '',
    board_ip: '',
    result_text: '',
    result_type: ''
  };
  renderBoardCreateSheet();
}

function closeBoardCreateSheet() {
  state.board.createSheet = {
    open: false,
    saving: false,
    board_name: '',
    board_ip: '',
    result_text: '',
    result_type: ''
  };
  renderBoardCreateSheet();
}

function openBoardMobileSlotSheet(boardId) {
  const board = (state.board.list || []).find((item) => Number(item.id || 0) === Number(boardId || 0));
  if (!board) return showToast('板卡不存在');
  state.board.mobileSlotSheet = {
    open: true,
    saving: false,
    board_id: Number(board.id || 0),
    board_name: String(board.board_name || '').trim(),
    slot_index: '',
    mobile: '',
    result_text: '',
    result_type: ''
  };
  renderBoardMobileSlotSheet();
}

function closeBoardMobileSlotSheet() {
  state.board.mobileSlotSheet = {
    open: false,
    saving: false,
    board_id: 0,
    board_name: '',
    slot_index: '',
    mobile: '',
    result_text: '',
    result_type: ''
  };
  renderBoardMobileSlotSheet();
}

function openBoardMobileAccountSheet(boardId, mobileSlotId) {
  const board = (state.board.list || []).find((item) => Number(item.id || 0) === Number(boardId || 0));
  const mobile = board && Array.isArray(board.mobiles) ? board.mobiles.find((item) => Number(item.id || 0) === Number(mobileSlotId || 0)) : null;
  if (!board || !mobile) return showToast('手机号卡位不存在');
  state.board.mobileAccountSheet = {
    open: true,
    saving: false,
    board_id: Number(board.id || 0),
    mobile_slot_id: Number(mobile.id || 0),
    mobile: String(mobile.mobile || '').trim(),
    account: '',
    result_text: '',
    result_type: ''
  };
  renderBoardMobileAccountSheet();
}

function closeBoardMobileAccountSheet() {
  state.board.mobileAccountSheet = {
    open: false,
    saving: false,
    board_id: 0,
    mobile_slot_id: 0,
    mobile: '',
    account: '',
    result_text: '',
    result_type: ''
  };
  renderBoardMobileAccountSheet();
}

function closeBoardEditorSheets() {
  closeBoardCreateSheet();
  closeBoardMobileSlotSheet();
  closeBoardMobileAccountSheet();
}

function openBoardSmsRecordSheet(mobileSlotId, mobile) {
  state.board.smsRecordSheet = {
    open: true,
    loading: true,
    mobile_slot_id: Number(mobileSlotId || 0),
    title: `短信发送记录 · ${String(mobile || '').trim() || '手机号'}`,
    result_text: '',
    result_type: '',
    list: []
  };
  renderBoardSmsRecordSheet();
}

function closeBoardSmsRecordSheet() {
  state.board.smsRecordSheet = {
    open: false,
    loading: false,
    mobile_slot_id: 0,
    title: '',
    result_text: '',
    result_type: '',
    list: []
  };
  renderBoardSmsRecordSheet();
}

async function submitBoardSms() {
  const sheet = state.board.smsSheet || {};
  const recipient = String((els.boardSmsRecipient && els.boardSmsRecipient.value) || '').trim();
  const content = String((els.boardSmsContent && els.boardSmsContent.value) || '').trim();
  if (!recipient) throw new Error('请输入收件人');
  if (!content) throw new Error('请输入短信内容');
  const out = await request('/api/board-cards/send-sms', {
    method: 'POST',
    body: JSON.stringify({
      board_id: Number(sheet.board_id || 0),
      mobile_id: Number(sheet.mobile_id || 0),
      recipient,
      content
    })
  });
  state.board.smsSheet = { ...sheet, recipient, content, result_text: String((out && out.message) || '发送短信功能开发中').trim(), result_type: 'ok' };
}

async function submitBoardCreate() {
  const boardName = String((els.boardCreateName && els.boardCreateName.value) || '').trim();
  const boardIp = String((els.boardCreateIp && els.boardCreateIp.value) || '').trim();
  if (!boardName) throw new Error('请输入板卡名称');
  if (!boardIp) throw new Error('请输入板卡 IP');
  const out = await request('/api/board-cards', {
    method: 'POST',
    body: JSON.stringify({ board_name: boardName, board_ip: boardIp })
  });
  applyBoardPayload(out);
  state.board.createSheet = { ...state.board.createSheet, board_name: '', board_ip: '', result_text: String(out.message || '板卡已新增'), result_type: 'ok' };
}

async function submitBoardMobileSlot() {
  const sheet = state.board.mobileSlotSheet || {};
  const slotRaw = String((els.boardMobileSlotIndex && els.boardMobileSlotIndex.value) || '').trim();
  const mobile = String((els.boardMobileSlotMobile && els.boardMobileSlotMobile.value) || '').trim();
  const slotMatch = slotRaw.match(/^卡?\s*([12])$/);
  if (!slotMatch) throw new Error('请输入卡槽：卡1 或 卡2');
  if (!mobile) throw new Error('请输入手机号');
  const out = await request('/api/board-cards/mobile-slots', {
    method: 'POST',
    body: JSON.stringify({ board_id: Number(sheet.board_id || 0), slot_index: Number(slotMatch[1]), mobile })
  });
  applyBoardPayload(out);
  state.board.mobileSlotSheet = { ...sheet, slot_index: '', mobile: '', result_text: String(out.message || '卡位手机号已新增'), result_type: 'ok' };
}

async function submitBoardMobileAccount() {
  const sheet = state.board.mobileAccountSheet || {};
  const account = String((els.boardMobileAccountValue && els.boardMobileAccountValue.value) || '').trim();
  if (!account) throw new Error('请输入账号');
  const out = await request('/api/board-cards/mobile-accounts', {
    method: 'POST',
    body: JSON.stringify({ mobile_slot_id: Number(sheet.mobile_slot_id || 0), account })
  });
  applyBoardPayload(out);
  state.board.mobileAccountSheet = { ...sheet, account: '', result_text: String(out.message || '手机号账号已新增'), result_type: 'ok' };
}

async function loadBoardSmsRecords(mobileSlotId) {
  const out = await request(`/api/board-cards/sms-records?mobile_slot_id=${encodeURIComponent(String(mobileSlotId || 0))}`);
  state.board.smsRecordSheet.list = Array.isArray(out.list) ? out.list : [];
  state.board.smsRecordSheet.loading = false;
  state.board.smsRecordSheet.result_text = '';
  state.board.smsRecordSheet.result_type = '';
}

if (els.boardAddBtn) {
  els.boardAddBtn.addEventListener('click', openBoardCreateSheet);
}

if (els.boardSearchInput) {
  els.boardSearchInput.addEventListener('input', () => {
    state.board.query = String(els.boardSearchInput.value || '').trim();
    renderBoardView();
  });
}

if (els.boardFilterTabs) {
  els.boardFilterTabs.addEventListener('click', (e) => {
    const btn = e.target && e.target.closest ? e.target.closest('[data-board-filter]') : null;
    if (!btn) return;
    state.board.filter = String(btn.getAttribute('data-board-filter') || 'all').trim() || 'all';
    renderBoardView();
  });
}

if (els.boardListContainer) {
  els.boardListContainer.addEventListener('click', (e) => {
    const addSlotBtn = e.target && e.target.closest ? e.target.closest('[data-op="board-add-slot"]') : null;
    if (addSlotBtn) return openBoardMobileSlotSheet(Number(addSlotBtn.getAttribute('data-board-id') || 0));
    const addAccountBtn = e.target && e.target.closest ? e.target.closest('[data-op="board-add-account"]') : null;
    if (addAccountBtn) {
      return openBoardMobileAccountSheet(
        Number(addAccountBtn.getAttribute('data-board-id') || 0),
        Number(addAccountBtn.getAttribute('data-mobile-slot-id') || 0)
      );
    }
    const viewBtn = e.target && e.target.closest ? e.target.closest('[data-op="board-view-sms-records"]') : null;
    if (viewBtn) {
      const mobileSlotId = Number(viewBtn.getAttribute('data-mobile-slot-id') || 0);
      const mobile = String(viewBtn.getAttribute('data-mobile') || '').trim();
      openBoardSmsRecordSheet(mobileSlotId, mobile);
      (async () => {
        try {
          await loadBoardSmsRecords(mobileSlotId);
        } catch (e2) {
          state.board.smsRecordSheet.loading = false;
          state.board.smsRecordSheet.result_text = e2.message || '短信记录加载失败';
          state.board.smsRecordSheet.result_type = 'err';
        } finally {
          renderBoardSmsRecordSheet();
        }
      })();
      return;
    }
    const smsBtn = e.target && e.target.closest ? e.target.closest('[data-op="board-sms"]') : null;
    if (!smsBtn) return;
    openBoardSmsSheet(Number(smsBtn.getAttribute('data-board-id') || 0), Number(smsBtn.getAttribute('data-mobile-id') || 0));
  });
}

if (els.boardSmsContent) {
  els.boardSmsContent.addEventListener('input', () => {
    state.board.smsSheet.content = String(els.boardSmsContent.value || '');
  });
}

if (els.boardSmsRecipient) {
  els.boardSmsRecipient.addEventListener('input', () => {
    state.board.smsSheet.recipient = String(els.boardSmsRecipient.value || '');
  });
}

if (els.boardCreateName) {
  els.boardCreateName.addEventListener('input', () => {
    state.board.createSheet.board_name = String(els.boardCreateName.value || '');
  });
}

if (els.boardCreateIp) {
  els.boardCreateIp.addEventListener('input', () => {
    state.board.createSheet.board_ip = String(els.boardCreateIp.value || '');
  });
}

if (els.boardMobileSlotMobile) {
  els.boardMobileSlotMobile.addEventListener('input', () => {
    state.board.mobileSlotSheet.mobile = String(els.boardMobileSlotMobile.value || '');
  });
}

if (els.boardMobileSlotIndex) {
  els.boardMobileSlotIndex.addEventListener('input', () => {
    state.board.mobileSlotSheet.slot_index = String(els.boardMobileSlotIndex.value || '');
  });
}

if (els.boardMobileAccountValue) {
  els.boardMobileAccountValue.addEventListener('input', () => {
    state.board.mobileAccountSheet.account = String(els.boardMobileAccountValue.value || '');
  });
}

if (els.boardSmsSendBtn) {
  els.boardSmsSendBtn.addEventListener('click', async () => {
    if (state.board.smsSheet.sending) return;
    state.board.smsSheet.sending = true;
    state.board.smsSheet.result_text = '';
    state.board.smsSheet.result_type = '';
    renderBoardSmsSheet();
    try {
      await submitBoardSms();
      showToast(state.board.smsSheet.result_text || '发送短信功能开发中');
    } catch (e) {
      state.board.smsSheet.result_text = e.message || '短信发送失败';
      state.board.smsSheet.result_type = 'err';
      showToast(state.board.smsSheet.result_text);
    } finally {
      state.board.smsSheet.sending = false;
      renderBoardSmsSheet();
    }
  });
}

if (els.boardCreateSaveBtn) {
  els.boardCreateSaveBtn.addEventListener('click', async () => {
    if (state.board.createSheet.saving) return;
    state.board.createSheet.saving = true;
    state.board.createSheet.result_text = '';
    state.board.createSheet.result_type = '';
    renderBoardCreateSheet();
    try {
      await submitBoardCreate();
      showToast(state.board.createSheet.result_text || '板卡已新增');
      closeBoardCreateSheet();
      renderBoardView();
    } catch (e) {
      state.board.createSheet.result_text = e.message || '板卡新增失败';
      state.board.createSheet.result_type = 'err';
      renderBoardCreateSheet();
      showToast(state.board.createSheet.result_text);
    } finally {
      state.board.createSheet.saving = false;
      renderBoardCreateSheet();
    }
  });
}

if (els.boardMobileSlotSaveBtn) {
  els.boardMobileSlotSaveBtn.addEventListener('click', async () => {
    if (state.board.mobileSlotSheet.saving) return;
    state.board.mobileSlotSheet.saving = true;
    state.board.mobileSlotSheet.result_text = '';
    state.board.mobileSlotSheet.result_type = '';
    renderBoardMobileSlotSheet();
    try {
      await submitBoardMobileSlot();
      showToast(state.board.mobileSlotSheet.result_text || '卡位手机号已新增');
      closeBoardMobileSlotSheet();
      renderBoardView();
    } catch (e) {
      state.board.mobileSlotSheet.result_text = e.message || '卡位手机号新增失败';
      state.board.mobileSlotSheet.result_type = 'err';
      renderBoardMobileSlotSheet();
      showToast(state.board.mobileSlotSheet.result_text);
    } finally {
      state.board.mobileSlotSheet.saving = false;
      renderBoardMobileSlotSheet();
    }
  });
}

if (els.boardMobileAccountSaveBtn) {
  els.boardMobileAccountSaveBtn.addEventListener('click', async () => {
    if (state.board.mobileAccountSheet.saving) return;
    state.board.mobileAccountSheet.saving = true;
    state.board.mobileAccountSheet.result_text = '';
    state.board.mobileAccountSheet.result_type = '';
    renderBoardMobileAccountSheet();
    try {
      await submitBoardMobileAccount();
      showToast(state.board.mobileAccountSheet.result_text || '手机号账号已新增');
      closeBoardMobileAccountSheet();
      renderBoardView();
    } catch (e) {
      state.board.mobileAccountSheet.result_text = e.message || '手机号账号新增失败';
      state.board.mobileAccountSheet.result_type = 'err';
      renderBoardMobileAccountSheet();
      showToast(state.board.mobileAccountSheet.result_text);
    } finally {
      state.board.mobileAccountSheet.saving = false;
      renderBoardMobileAccountSheet();
    }
  });
}

if (els.boardSmsCloseBtn) els.boardSmsCloseBtn.addEventListener('click', closeBoardSmsSheet);
if (els.boardCreateCloseBtn) els.boardCreateCloseBtn.addEventListener('click', closeBoardCreateSheet);
if (els.boardMobileSlotCloseBtn) els.boardMobileSlotCloseBtn.addEventListener('click', closeBoardMobileSlotSheet);
if (els.boardMobileAccountCloseBtn) els.boardMobileAccountCloseBtn.addEventListener('click', closeBoardMobileAccountSheet);
if (els.boardSmsRecordCloseBtn) els.boardSmsRecordCloseBtn.addEventListener('click', closeBoardSmsRecordSheet);
if (els.boardSmsSheet) els.boardSmsSheet.addEventListener('click', (e) => { if (e.target === els.boardSmsSheet) closeBoardSmsSheet(); });
if (els.boardCreateSheet) els.boardCreateSheet.addEventListener('click', (e) => { if (e.target === els.boardCreateSheet) closeBoardCreateSheet(); });
if (els.boardMobileSlotSheet) els.boardMobileSlotSheet.addEventListener('click', (e) => { if (e.target === els.boardMobileSlotSheet) closeBoardMobileSlotSheet(); });
if (els.boardMobileAccountSheet) els.boardMobileAccountSheet.addEventListener('click', (e) => { if (e.target === els.boardMobileAccountSheet) closeBoardMobileAccountSheet(); });
if (els.boardSmsRecordSheet) els.boardSmsRecordSheet.addEventListener('click', (e) => { if (e.target === els.boardSmsRecordSheet) closeBoardSmsRecordSheet(); });

window.loadBoardCards = loadBoardCards;
window.renderBoardView = renderBoardView;
window.closeBoardSmsSheet = closeBoardSmsSheet;
window.closeBoardEditorSheets = closeBoardEditorSheets;
