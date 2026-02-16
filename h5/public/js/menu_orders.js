    function formatOrderTimeRange(item) {
      const s = String(item.start_time || '').slice(5, 16);
      const e = String(item.end_time || '').slice(5, 16);
      return `${s} ~ ${e}`;
    }

    function renderOrdersView() {
      const o = state.orders || {};
      const tabs = [
        { k: 'all', t: '全部' },
        { k: 'progress', t: '进行中' },
        { k: 'done', t: '已完成' }
      ];
      const quick = [
        { k: 'today', t: '当日' },
        { k: 'yesterday', t: '昨日' },
        { k: 'week', t: '本周' },
        { k: 'last7', t: '近7天' },
        { k: 'month', t: '本月' },
        { k: 'last30', t: '近30天' }
      ];
      els.orderStatusTabs.innerHTML = tabs.map((x) => `
        <button class="orders-tab ${o.status_filter === x.k ? 'active' : ''}" data-order-status="${x.k}">${x.t}</button>
      `).join('');
      els.orderQuickFilters.innerHTML = quick.map((x) => `
        <button class="orders-quick-item ${o.quick_filter === x.k ? 'active' : ''}" data-order-quick="${x.k}">${x.t}</button>
      `).join('');
      if (els.orderSyncNowBtn) {
        els.orderSyncNowBtn.disabled = Boolean(o.syncing);
        els.orderSyncNowBtn.textContent = o.syncing ? '同步中...' : '同步订单';
      }
      els.orderGameHint.textContent = `游戏：${o.game_name || 'WZRY'}（默认） · 汇总：${Number(o.total || 0)}（0收-${Number((o.stats && o.stats.done_zero) || 0)}）`;

      if (!Array.isArray(o.list) || o.list.length === 0) {
        els.orderListContainer.innerHTML = '<div class="panel"><div style="color:#6d7a8a;font-size:13px;">暂无订单数据</div></div>';
      } else {
        els.orderListContainer.innerHTML = o.list.map((item) => `
          <div class="order-card">
            <div class="order-card-top">
              <p class="order-card-role">${item.role_name || item.game_account || '-'}</p>
              <span class="order-chip ${(String(item.order_status || '') === '租赁中' || String(item.order_status || '') === '出租中') ? 'progress' : 'done'}">${item.order_status || '-'}</span>
            </div>
            <div class="order-id-row">
              <span class="order-id-label">No.${item.order_no || '-'}</span>
              <button class="order-copy-btn" data-order-copy="${item.order_no || ''}">复制</button>
            </div>
            <div class="order-card-line">${formatOrderTimeRange(item)}</div>
            <div class="order-card-line">渠道：${item.channel || '-'} · 账号：${item.game_account || '-'}</div>
            <div class="order-bottom">
              <div class="order-bottom-left">
                时长：${Number(item.rent_hour || 0)}小时 · 订单金额：¥${Number(item.order_amount || 0).toFixed(2)}
              </div>
              <div class="order-income">
                <span class="order-income-label">实际收入</span>¥${Number(item.rec_amount || 0).toFixed(2)}
              </div>
            </div>
          </div>
        `).join('');
        Array.from(els.orderListContainer.querySelectorAll('[data-order-copy]')).forEach((n) => {
          n.addEventListener('click', () => copyAccount(n.getAttribute('data-order-copy') || ''));
        });
      }

      Array.from(els.orderStatusTabs.querySelectorAll('[data-order-status]')).forEach((n) => {
        n.addEventListener('click', async () => {
          const k = String(n.getAttribute('data-order-status') || 'all').trim();
          if (k === o.status_filter) return;
          state.orders.status_filter = k;
          state.orders.page = 1;
          await loadOrders();
          renderOrdersView();
        });
      });
      Array.from(els.orderQuickFilters.querySelectorAll('[data-order-quick]')).forEach((n) => {
        n.addEventListener('click', async () => {
          const k = String(n.getAttribute('data-order-quick') || 'today').trim();
          if (k === o.quick_filter) return;
          state.orders.quick_filter = k;
          state.orders.page = 1;
          await loadOrders();
          renderOrdersView();
        });
      });

      const totalPages = Math.max(1, Math.ceil(Number(o.total || 0) / Number(o.pageSize || 20)));
      els.orderPageInfo.textContent = `第 ${o.page} / ${totalPages} 页 · 每页 ${o.pageSize} 条`;
      els.orderPrevPage.disabled = o.page <= 1;
      els.orderNextPage.disabled = o.page >= totalPages;
    }
