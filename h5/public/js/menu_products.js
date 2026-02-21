    function platformBadges(v) {
      const s = v || {};
      return [
        `悠悠: ${s.uuzuhao || '未'}`,
        `U号: ${s.uhaozu || '未'}`,
        `ZHW: ${s.zuhaowang || '未'}`
      ];
    }

    function formatBlacklistTimeForCard(v) {
      const t = String(v || '').trim();
      if (!t) return '';
      const m = /^(\d{4})-(\d{2})-(\d{2})\s+(\d{2}:\d{2}:\d{2})$/.exec(t);
      if (m) return `${m[2]}-${m[3]} ${m[4]}`;
      return t.length >= 14 ? t.slice(-14) : t;
    }

    async function copyAccount(text) {
      const val = String(text || '').trim();
      if (!val) return;
      try {
        if (navigator.clipboard && navigator.clipboard.writeText) {
          await navigator.clipboard.writeText(val);
        } else {
          const t = document.createElement('textarea');
          t.value = val;
          t.style.position = 'fixed';
          t.style.left = '-9999px';
          document.body.appendChild(t);
          t.select();
          document.execCommand('copy');
          document.body.removeChild(t);
        }
        showToast('已复制');
      } catch (_) {
        showToast('复制失败');
      }
    }

    async function toggleBlacklist(item) {
      try {
        if (item.blacklisted) {
          await request('/api/blacklist/remove', {
            method: 'POST',
            body: JSON.stringify({ game_account: item.game_account })
          });
        } else {
          await request('/api/blacklist/add', {
            method: 'POST',
            body: JSON.stringify({ game_account: item.game_account, reason: '人工下架' })
          });
        }
        await loadList();
        renderList();
      } catch (e) {
        alert(e.message);
      }
    }

    async function queryOnline(item) {
      const account = String(item && item.game_account || '').trim();
      if (!account) return;
      // 每次主动查询先清空历史结果，避免旧结果误导为最新状态。
      if (state.onlineStatusMap && Object.prototype.hasOwnProperty.call(state.onlineStatusMap, account)) {
        delete state.onlineStatusMap[account];
      }
      const hitBeforeQuery = (state.list || []).find((x) => String((x && x.game_account) || '').trim() === account);
      if (hitBeforeQuery && Object.prototype.hasOwnProperty.call(hitBeforeQuery, 'online_tag')) {
        hitBeforeQuery.online_tag = '';
      }
      state.onlineLoadingMap[account] = true;
      renderOnlinePart(account);
      try {
        const res = await request('/api/products/online', {
          method: 'POST',
          body: JSON.stringify({ game_account: account, game_name: 'WZRY' })
        });
        const online = Boolean(res && res.data && res.data.online);
        const tag = online ? '在线' : '离线';
        state.onlineStatusMap[account] = tag;
        const hit = (state.list || []).find((x) => String((x && x.game_account) || '').trim() === account);
        if (hit) hit.online_tag = tag;
      } catch (e) {
        alert(e.message || '在线查询失败');
      } finally {
        state.onlineLoadingMap[account] = false;
        renderOnlinePart(account);
        renderMoreOpsSheet();
      }
    }

    function buildOnlineChipHtml(account) {
      const acc = String(account || '').trim();
      const mapText = String(state.onlineStatusMap[acc] || '').trim();
      const hit = (state.list || []).find((x) => String((x && x.game_account) || '').trim() === acc);
      const rowText = String((hit && hit.online_tag) || '').trim();
      const onlineText = mapText || rowText;
      if (!onlineText) return '';
      const onlineClass = onlineText === '在线' ? 'chip-online' : 'chip-offline';
      return `<span class="chip ${onlineClass}">${onlineText}</span>`;
    }

    function buildPurchaseBriefHtml(item) {
      const p = Number(item && item.purchase_price);
      const d = String(item && item.purchase_date || '').slice(0, 10);
      if (!Number.isFinite(p) || p <= 0 || !/^\d{4}-\d{2}-\d{2}$/.test(d)) return '';
      return `
        <div class="purchase-brief">
          <span class="purchase-brief-line">采购价 ¥${p.toFixed(2)}</span>
          <span class="purchase-brief-line">采购日期 ${d}</span>
        </div>
      `;
    }

    function orderCountLabelByMode() {
      const mode = String((state.userRules && state.userRules.order_off_mode) || 'natural_day').trim();
      return mode === 'rolling_24h' ? '近24h订单' : '今日订单';
    }

    function renderOnlinePart(account) {
      const acc = String(account || '').trim();
      if (!acc) return;
      const card = state.cardNodeMap[acc];
      if (!card) {
        renderList();
        return;
      }

      const chipSlot = card.querySelector('[data-slot="online-chip"]');
      if (chipSlot) {
        chipSlot.innerHTML = buildOnlineChipHtml(acc);
      }

      const btn = card.querySelector('[data-op="online-query"]');
      if (btn) {
        const querying = Boolean(state.onlineLoadingMap[acc]);
        btn.disabled = querying;
        btn.textContent = '在线查询';
      }
    }

    function renderForbiddenPart(account) {
      const acc = String(account || '').trim();
      if (!acc) return;
      const card = state.cardNodeMap[acc];
      if (!card) return;

      const btn = card.querySelector('[data-op="forbidden-play"]');
      if (btn) {
        const loading = Boolean(state.forbiddenLoadingMap[acc]);
        btn.disabled = loading;
        btn.textContent = loading ? '处理中...' : '处理禁玩';
      }
    }

    function renderForbiddenSheet() {
      const opened = Boolean(state.forbiddenSheet && state.forbiddenSheet.open);
      els.forbiddenSheet.classList.toggle('hidden', !opened);
      if (!opened) return;
      const name = String(state.forbiddenSheet.role_name || state.forbiddenSheet.account || '').trim();
      els.forbiddenSheetTitle.textContent = `处理禁玩 · ${name || '当前账号'}`;
      const resultText = String(state.forbiddenSheet.result_text || '').trim();
      const resultType = String(state.forbiddenSheet.result_type || '').trim();
      els.forbiddenSheetResult.className = `sheet-result ${resultType}`;
      els.forbiddenSheetResult.textContent = resultText;
      const loading = Boolean(state.forbiddenSheet.loading);
      els.sheetEnableForbidden.disabled = loading;
      els.sheetDisableForbidden.disabled = loading;
      els.sheetCancelForbidden.disabled = loading;
    }

    function renderMoreOpsSheet() {
      const opened = Boolean(state.moreOpsSheet && state.moreOpsSheet.open);
      els.moreOpsSheet.classList.toggle('hidden', !opened);
      if (!opened) return;
      const name = String(state.moreOpsSheet.role_name || state.moreOpsSheet.account || '').trim();
      const account = String(state.moreOpsSheet.account || '').trim();
      const querying = Boolean(state.onlineLoadingMap[account]);
      const handling = Boolean(state.forbiddenLoadingMap[account]);
      els.moreOpsSheetTitle.textContent = `更多操作 · ${name || '当前账号'}`;
      els.moreOpsForbiddenBtn.disabled = querying || handling;
      els.moreOpsPurchaseBtn.disabled = querying || handling;
      els.moreOpsCloseBtn.disabled = querying || handling;
      els.moreOpsForbiddenBtn.textContent = handling ? '处理中...' : '处理禁玩';
    }

    function closeActionSheets() {
      state.activeActionSheet = '';
      state.moreOpsSheet = { open: false, account: '', role_name: '' };
      state.forbiddenSheet = { open: false, account: '', role_name: '', result_text: '', result_type: '', loading: false };
      renderMoreOpsSheet();
      renderForbiddenSheet();
    }

    function openForbiddenSheet(item) {
      const account = String(item && item.game_account || '').trim();
      if (!account) return;
      state.moreOpsSheet = { open: false, account: '', role_name: '' };
      state.activeActionSheet = 'forbidden';
      renderMoreOpsSheet();
      state.forbiddenSheet = {
        open: true,
        account,
        role_name: String(item && (item.role_name || item.game_account) || '').trim(),
        result_text: '',
        result_type: '',
        loading: false
      };
      renderForbiddenSheet();
    }

    function closeForbiddenSheet() {
      if (state.activeActionSheet === 'forbidden') state.activeActionSheet = '';
      state.forbiddenSheet = { open: false, account: '', role_name: '', result_text: '', result_type: '', loading: false };
      renderForbiddenSheet();
    }

    function openMoreOpsSheet(item) {
      const account = String(item && item.game_account || '').trim();
      if (!account) return;
      state.forbiddenSheet = { open: false, account: '', role_name: '', result_text: '', result_type: '', loading: false };
      state.activeActionSheet = 'more';
      state.moreOpsSheet = {
        open: true,
        account,
        role_name: String(item && (item.role_name || item.game_account) || '').trim()
      };
      renderForbiddenSheet();
      renderMoreOpsSheet();
    }

    function closeMoreOpsSheet() {
      if (state.activeActionSheet === 'more') state.activeActionSheet = '';
      state.moreOpsSheet = { open: false, account: '', role_name: '' };
      renderMoreOpsSheet();
    }

    function renderPurchaseSheet() {
      const opened = Boolean(state.purchaseSheet && state.purchaseSheet.open);
      els.purchaseSheet.classList.toggle('hidden', !opened);
      if (!opened) return;

      const titleName = String(state.purchaseSheet.role_name || state.purchaseSheet.account || '').trim() || '当前账号';
      const resultText = String(state.purchaseSheet.result_text || '').trim();
      const resultType = String(state.purchaseSheet.result_type || '').trim();
      const loading = Boolean(state.purchaseSheet.loading);

      els.purchaseSheetTitle.textContent = `维护采购信息 · ${titleName}`;
      els.purchaseSheetResult.className = `sheet-result ${resultType}`;
      els.purchaseSheetResult.textContent = resultText;
      els.purchasePriceInput.value = String(state.purchaseSheet.purchase_price || '');
      els.purchaseDateInput.value = String(state.purchaseSheet.purchase_date || '');
      els.purchasePriceInput.disabled = loading;
      els.purchaseDateInput.disabled = loading;
      els.purchaseSaveBtn.disabled = loading;
      els.purchaseCancelBtn.disabled = loading;
    }

    function openPurchaseSheet(item) {
      const account = String(item && item.game_account || '').trim();
      if (!account) return;
      const priceRaw = Number(item && item.purchase_price);
      const price = Number.isFinite(priceRaw) && priceRaw > 0 ? priceRaw.toFixed(2) : '';
      state.purchaseSheet = {
        open: true,
        account,
        role_name: String(item && (item.role_name || item.game_account) || '').trim(),
        purchase_price: price,
        purchase_date: String(item && item.purchase_date || '').slice(0, 10),
        result_text: '',
        result_type: '',
        loading: false
      };
      renderPurchaseSheet();
    }

    function closePurchaseSheet() {
      state.purchaseSheet = {
        open: false,
        account: '',
        role_name: '',
        purchase_price: '',
        purchase_date: '',
        result_text: '',
        result_type: '',
        loading: false
      };
      renderPurchaseSheet();
    }

    async function submitPurchaseConfig() {
      const account = String((state.purchaseSheet || {}).account || '').trim();
      if (!account) return;
      const priceRaw = String(els.purchasePriceInput.value || '').trim();
      const dateVal = String(els.purchaseDateInput.value || '').trim();
      const priceNum = Number(priceRaw);
      if (!Number.isFinite(priceNum) || priceNum < 0) {
        state.purchaseSheet.result_text = '采购价格不合法';
        state.purchaseSheet.result_type = 'err';
        renderPurchaseSheet();
        return;
      }
      if (!/^\d{4}-\d{2}-\d{2}$/.test(dateVal)) {
        state.purchaseSheet.result_text = '请选择采购日期';
        state.purchaseSheet.result_type = 'err';
        renderPurchaseSheet();
        return;
      }

      state.purchaseSheet.loading = true;
      state.purchaseSheet.result_text = '保存中...';
      state.purchaseSheet.result_type = '';
      renderPurchaseSheet();
      try {
        const out = await request('/api/products/purchase-config', {
          method: 'POST',
          body: JSON.stringify({
            game_account: account,
            purchase_price: Number(priceNum.toFixed(2)),
            purchase_date: dateVal
          })
        });
        const savedPrice = Number(out && out.data && out.data.purchase_price || 0);
        const savedDate = String(out && out.data && out.data.purchase_date || '').slice(0, 10);
        state.list = (state.list || []).map((x) => {
          if (String(x && x.game_account || '').trim() !== account) return x;
          return {
            ...x,
            purchase_price: Number(savedPrice.toFixed(2)),
            purchase_date: savedDate
          };
        });
        state.purchaseSheet.result_text = '保存成功';
        state.purchaseSheet.result_type = 'ok';
        renderPurchaseSheet();
        showToast('采购信息已保存');
        setTimeout(() => {
          closePurchaseSheet();
          renderList();
        }, 220);
      } catch (e) {
        state.purchaseSheet.result_text = String(e && e.message ? e.message : '保存失败');
        state.purchaseSheet.result_type = 'err';
        renderPurchaseSheet();
      } finally {
        state.purchaseSheet.loading = false;
        renderPurchaseSheet();
      }
    }

    async function submitForbidden(enabled) {
      const account = String((state.forbiddenSheet || {}).account || '').trim();
      if (!account) return;
      state.forbiddenSheet.loading = true;
      state.forbiddenSheet.result_text = '处理中...';
      state.forbiddenSheet.result_type = '';
      renderForbiddenSheet();
      state.forbiddenLoadingMap[account] = true;
      renderForbiddenPart(account);
      try {
        const out = await request('/api/products/forbidden/play', {
          method: 'POST',
          body: JSON.stringify({ game_account: account, game_name: 'WZRY', enabled: Boolean(enabled) })
        });
        const on = Boolean(out && out.data && out.data.enabled);
        state.forbiddenSheet.result_text = on ? '禁玩已开启' : '禁玩已解除';
        state.forbiddenSheet.result_type = 'ok';
      } catch (e) {
        state.forbiddenSheet.result_text = String(e && e.message ? e.message : '禁玩操作失败');
        state.forbiddenSheet.result_type = 'err';
      } finally {
        state.forbiddenSheet.loading = false;
        renderForbiddenSheet();
        state.forbiddenLoadingMap[account] = false;
        renderForbiddenPart(account);
        renderMoreOpsSheet();
      }
    }

    function updatePullRefreshUi() {
      // 下拉刷新仅保留全局 request loading，不再展示页面私有 loading 条。
      if (els.pullRefresh) els.pullRefresh.classList.add('hidden');
    }

    function resetPullRefreshUi() {
      state.pullRefresh.dragging = false;
      state.pullRefresh.ready = false;
      state.pullRefresh.distance = 0;
      updatePullRefreshUi();
    }

    async function triggerPullRefresh() {
      if (state.pullRefresh.loading) return;
      state.pullRefresh.loading = true;
      updatePullRefreshUi();
      const start = Date.now();
      try {
        state.page = 1;
        await loadList();
        renderList();
      } catch (e) {
        alert(e.message || '刷新失败');
      } finally {
        const elapsed = Date.now() - start;
        if (elapsed < 300) {
          await new Promise((resolve) => setTimeout(resolve, 300 - elapsed));
        }
        state.pullRefresh.loading = false;
        resetPullRefreshUi();
      }
    }

    function renderFilters() {
      const allActive = state.filter === 'all';
      const restrictedActive = state.filter === 'restricted';
      const rentingActive = state.filter === 'renting';
      const summaryMap = {
        all: Number(state.stats.total_all || 0),
        restricted: Number(state.stats.total_restricted || 0),
        renting: Number(state.stats.total_renting || 0)
      };
      const summaryTotal = Number(summaryMap[state.filter] || 0);
      els.filters.innerHTML = `
        <div class="filter-tab ${allActive ? 'active' : ''}" data-filter="all">
          <div class="txt">全部</div>
        </div>
        <div class="filter-tab ${restrictedActive ? 'active' : ''}" data-filter="restricted">
          <div class="txt">限制中</div>
        </div>
        <div class="filter-tab ${rentingActive ? 'active' : ''}" data-filter="renting">
          <div class="txt">租赁中</div>
        </div>
      `;
      els.orderTotal.innerHTML = `
        <span class="order-total-main">今日有效订单数：${Number(state.stats.total_paid || 0)}</span>
        <span class="order-total-divider" aria-hidden="true"></span>
        <span class="order-total-summary">汇总${summaryTotal}</span>
      `;
      Array.from(els.filters.querySelectorAll('.filter-tab')).forEach((n) => {
        n.addEventListener('click', async () => {
          const nextFilter = n.getAttribute('data-filter') || 'all';
          if (nextFilter === state.filter) return;
          state.filter = nextFilter;
          state.page = 1;
          await loadList();
          renderList();
        });
      });
      if (els.productSyncNowBtn) {
        const syncing = Boolean(state.productsSyncing);
        els.productSyncNowBtn.disabled = syncing;
        els.productSyncNowBtn.textContent = syncing ? '同步中...' : '同步商品';
      }
    }

    function renderList() {
      const root = els.listContainer;
      root.innerHTML = '';
      state.cardNodeMap = {};
      renderFilters();

      if (state.list.length === 0) {
        root.innerHTML = '<div class="panel"><div style="color:#6d7a8a;font-size:13px;">暂无数据</div></div>';
      } else {
        state.list.forEach((item, idx) => {
          const node = document.createElement('div');
          node.className = 'list-item';
          const plat = platformBadges(item.channel_status).map((x) => {
            const isRenting = /租赁中/.test(String(x || ''));
            return `<span class="plat ${isRenting ? 'plat-renting' : ''}">${x}</span>`;
          }).join('');
          const account = String(item.game_account || '').trim();
          const querying = Boolean(state.onlineLoadingMap[account]);
          const forbiddenLoading = Boolean(state.forbiddenLoadingMap[account]);
          const blacklistTime = formatBlacklistTimeForCard(item.blacklist_create_date);
          const statusText = item.blacklisted
            ? `黑名单 · ${item.blacklist_reason || '无原因'}${blacklistTime ? ` · ${blacklistTime}` : ''}`
            : (item.mode_restricted ? '渠道受限' : '状态正常');
          const statusClass = statusText === '状态正常' ? '' : 'chip-black';
          node.style.animationDelay = `${Math.min(idx * 35, 220)}ms`;
          node.innerHTML = `
            <div class="row">
              <p class="title">${item.role_name || item.game_account}</p>
              <div style="display:flex;align-items:center;gap:6px;">
                <span data-slot="online-chip">${buildOnlineChipHtml(account)}</span>
                <span class="chip ${statusClass}">
                  ${statusText}
                </span>
              </div>
            </div>
            <div class="info-squares">
              <div class="info-square base-square">
                <div class="account-main">
                  <div class="account">账号：${item.game_account}</div>
                  <button class="copy-btn" data-copy="${item.game_account}">复制</button>
                </div>
                ${buildPurchaseBriefHtml(item)}
                <p class="square-line">${orderCountLabelByMode()}：${item.today_paid_count}</p>
              </div>
              <div class="info-square channel-square">
                <p class="square-title">渠道状态</p>
                <div class="platforms">${plat}</div>
              </div>
            </div>
            <div class="ops">
              <button class="btn btn-chip btn-chip-ok" data-op="online-query" ${querying ? 'disabled' : ''}>
                在线查询
              </button>
              <button class="btn btn-chip ${item.blacklisted ? 'btn-chip-danger' : 'btn-chip-ok'}" data-op="blacklist-toggle">
                ${item.blacklisted ? '移出黑名单' : '加入黑名单'}
              </button>
              <button class="btn btn-chip btn-chip-ok" data-op="more-ops" ${(querying || forbiddenLoading) ? 'disabled' : ''}>
                更多操作
              </button>
            </div>
          `;
          node.querySelector('.copy-btn').addEventListener('click', (e) => {
            const v = e.currentTarget.getAttribute('data-copy') || '';
            copyAccount(v);
          });
          node.querySelector('[data-op=\"online-query\"]').addEventListener('click', () => queryOnline(item));
          node.querySelector('[data-op=\"blacklist-toggle\"]').addEventListener('click', () => toggleBlacklist(item));
          node.querySelector('[data-op=\"more-ops\"]').addEventListener('click', () => openMoreOpsSheet(item));
          state.cardNodeMap[account] = node;
          root.appendChild(node);
        });
      }

      const totalPages = Math.max(1, Math.ceil(state.total / state.pageSize));
      els.pageInfo.textContent = `第 ${state.page} / ${totalPages} 页 · 每页 ${state.pageSize} 条`;
      els.prevPage.disabled = state.page <= 1;
      els.nextPage.disabled = state.page >= totalPages;
    }
