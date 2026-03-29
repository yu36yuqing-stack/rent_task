    function renderStatsMissingOverlay() {
      const missing = Array.isArray(state.statsBoard && state.statsBoard.missing_purchase_accounts)
        ? state.statsBoard.missing_purchase_accounts
        : [];
      if (missing.length === 0) {
        els.statsMissingOverlay.classList.add('hidden');
        els.statsMissingList.innerHTML = '';
        return;
      }
      els.statsMissingList.innerHTML = missing.map((x) => {
        const role = String(x.display_name || x.role_name || '').trim();
        const acc = String(x.game_account || '').trim();
        return `<li>${role || acc}（${acc}）</li>`;
      }).join('');
      els.statsMissingOverlay.classList.remove('hidden');
    }

    function costTypeText(costType) {
      const text = String(costType || '').trim().toLowerCase();
      if (text === 'purchase') return '采购';
      if (text === 'maintenance') return '维护';
      return '其他';
    }

    function renderStatsCostDetailSheet() {
      const d = state.statsCostDetail || {};
      const opened = Boolean(d.open);
      const deleting = Boolean(d.deleting);
      if (!els.statsCostDetailSheet) return;
      els.statsCostDetailSheet.classList.toggle('hidden', !opened);
      if (!opened) return;
      els.statsCostDetailTitle.textContent = `成本明细 · ${String(d.display_name || d.game_account || '当前账号').trim() || '当前账号'}`;
      if (d.loading) {
        els.statsCostDetailSummary.className = 'sheet-result';
        els.statsCostDetailSummary.textContent = '加载中...';
        els.statsCostDetailList.innerHTML = '';
        return;
      }
      const err = String(d.error || '').trim();
      if (err) {
        els.statsCostDetailSummary.className = 'sheet-result err';
        els.statsCostDetailSummary.textContent = err;
        els.statsCostDetailList.innerHTML = '';
        return;
      }
      els.statsCostDetailSummary.className = 'sheet-result';
      els.statsCostDetailSummary.textContent = `总成本 ¥${Number(d.total_cost_amount || 0).toFixed(2)} · 采购成本 ¥${Number(d.purchase_cost_amount || 0).toFixed(2)}`;
      const list = Array.isArray(d.list) ? d.list : [];
      if (list.length === 0) {
        els.statsCostDetailList.innerHTML = '<div class="panel"><div style="color:#6d7a8a;font-size:13px;">暂无成本记录</div></div>';
        return;
      }
      els.statsCostDetailList.innerHTML = list.map((x) => `
        <div class="stats-cost-detail-item">
          <div class="stats-cost-detail-top">
            <p class="stats-cost-detail-date">${x.cost_date || '-'}</p>
            <div class="stats-cost-detail-top-actions">
              <p class="stats-cost-detail-money">¥${Number(x.cost_amount || 0).toFixed(2)}</p>
              <button class="btn btn-ghost btn-card-action stats-cost-detail-delete" data-cost-delete-id="${Number(x.id || 0)}" ${deleting ? 'disabled' : ''}>删除</button>
            </div>
          </div>
          <p class="stats-cost-detail-meta">类型：${costTypeText(x.cost_type)}${x.cost_desc ? ` · ${x.cost_desc}` : ''}</p>
        </div>
      `).join('');
      Array.from(els.statsCostDetailList.querySelectorAll('[data-cost-delete-id]')).forEach((n) => {
        n.addEventListener('click', async () => {
          const recordId = Number(n.getAttribute('data-cost-delete-id') || 0);
          if (!recordId) return;
          if (!window.confirm('删除后会重算总成本，确认删除？')) return;
          await deleteStatsCostDetail(recordId);
        });
      });
    }

    function closeStatsCostDetailSheet() {
      state.statsCostDetail = {
        open: false,
        loading: false,
        deleting: false,
        game_account: '',
        game_name: 'WZRY',
        display_name: '',
        total_cost_amount: 0,
        purchase_cost_amount: 0,
        list: [],
        error: ''
      };
      renderStatsCostDetailSheet();
    }

    function bindStatsCostDetailSheetEvents() {
      if (els.statsCostDetailClose) {
        els.statsCostDetailClose.onclick = () => closeStatsCostDetailSheet();
      }
      if (els.statsCostDetailSheet) {
        els.statsCostDetailSheet.onclick = (e) => {
          if (e.target === els.statsCostDetailSheet) closeStatsCostDetailSheet();
        };
      }
    }

    async function openStatsCostDetail(item) {
      const gameAccount = String(item && item.game_account || '').trim();
      const gameName = String(item && item.game_name || state.statsBoard.game_name || 'WZRY').trim() || 'WZRY';
      if (!gameAccount) return;
      state.statsCostDetail = {
        open: true,
        loading: true,
        deleting: false,
        game_account: gameAccount,
        game_name: gameName,
        display_name: String(item && (item.display_name || item.role_name || item.game_account) || '').trim(),
        total_cost_amount: Number(item && item.total_cost_amount || 0),
        purchase_cost_amount: Number(item && item.purchase_cost_amount || item.purchase_base || 0),
        list: [],
        error: ''
      };
      renderStatsCostDetailSheet();
      try {
        const out = await request(`/api/stats/account-cost-detail?game_account=${encodeURIComponent(gameAccount)}&game_name=${encodeURIComponent(gameName)}`);
        state.statsCostDetail = {
          open: true,
          loading: false,
          deleting: false,
          game_account: String(out.game_account || gameAccount).trim(),
          game_name: String(out.game_name || gameName).trim() || gameName,
          display_name: String(out.display_name || state.statsCostDetail.display_name || gameAccount).trim(),
          total_cost_amount: Number(out.total_cost_amount || 0),
          purchase_cost_amount: Number(out.purchase_cost_amount || 0),
          list: Array.isArray(out.list) ? out.list : [],
          error: ''
        };
      } catch (e) {
        state.statsCostDetail.loading = false;
        state.statsCostDetail.error = String(e && e.message ? e.message : '成本明细加载失败');
      }
      renderStatsCostDetailSheet();
    }

    async function deleteStatsCostDetail(recordId) {
      const d = state.statsCostDetail || {};
      if (!recordId || !d.game_account) return;
      const deletingRecord = (state.statsCostDetail.list || []).find((x) => Number(x && x.id || 0) === Number(recordId)) || null;
      state.statsCostDetail.deleting = true;
      renderStatsCostDetailSheet();
      try {
        const out = await request('/api/products/account-cost/delete', {
          method: 'POST',
          body: JSON.stringify({
            record_id: Number(recordId),
            game_account: String(d.game_account || '').trim(),
            game_name: String(d.game_name || 'WZRY').trim() || 'WZRY'
          })
        });
        const nextTotal = Number(out && out.data && out.data.total_cost_amount || 0);
        state.statsCostDetail.list = (state.statsCostDetail.list || []).filter((x) => Number(x && x.id || 0) !== Number(recordId));
        state.statsCostDetail.total_cost_amount = Number(nextTotal.toFixed(2));
        state.statsCostDetail.purchase_cost_amount = (state.statsCostDetail.list || []).reduce((sum, x) => {
          if (String(x && x.cost_type || '').trim() !== 'purchase') return sum;
          return sum + Number(x && x.cost_amount || 0);
        }, 0);
        const nextPurchase = (state.statsCostDetail.list || []).find((one) => String(one && one.cost_type || '').trim() === 'purchase') || null;
        state.list = (state.list || []).map((x) => {
          if (String(x && x.game_account || '').trim() !== String(d.game_account || '').trim()) return x;
          if (String(x && x.game_name || 'WZRY').trim() !== String(d.game_name || 'WZRY').trim()) return x;
          return {
            ...x,
            total_cost_amount: Number(nextTotal.toFixed(2)),
            purchase_price: nextPurchase
              ? Number(nextPurchase.cost_amount || 0)
              : (deletingRecord && String(deletingRecord.cost_type || '').trim() === 'purchase' ? 0 : Number(x.purchase_price || 0)),
            purchase_date: nextPurchase
              ? String(nextPurchase.cost_date || '').slice(0, 10)
              : (deletingRecord && String(deletingRecord.cost_type || '').trim() === 'purchase' ? '' : String(x.purchase_date || '').slice(0, 10))
          };
        });
        state.statsBoard.by_account = (state.statsBoard.by_account || []).map((x) => {
          if (String(x && x.game_account || '').trim() !== String(d.game_account || '').trim()) return x;
          if (String(x && x.game_name || 'WZRY').trim() !== String(d.game_name || 'WZRY').trim()) return x;
          return {
            ...x,
            total_cost_amount: Number(nextTotal.toFixed(2)),
            purchase_cost_amount: Number(state.statsCostDetail.purchase_cost_amount || 0),
            purchase_base: Number(state.statsCostDetail.purchase_cost_amount || 0)
          };
        });
        showToast('删除成功');
      } catch (e) {
        alert(e.message || '删除失败');
      } finally {
        state.statsCostDetail.deleting = false;
        renderStatsCostDetailSheet();
        if (typeof renderList === 'function') renderList();
      }
    }

    window.openStatsCostDetailExternal = async (item) => {
      await openStatsCostDetail(item || {});
    };

    function currentMonthText() {
      const d = new Date();
      return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
    }

    function daysInMonth(monthText) {
      const [y, m] = String(monthText || '').split('-').map((x) => Number(x || 0));
      return new Date(y, m, 0).getDate();
    }

    function dayOfWeek(monthText, day) {
      const [y, m] = String(monthText || '').split('-').map((x) => Number(x || 0));
      return new Date(y, (m || 1) - 1, day).getDay();
    }

    function isDateText(v) {
      return /^\d{4}-\d{2}-\d{2}$/.test(String(v || '').trim());
    }

    function gameIconByName(gameName) {
      const key = String(gameName || '').trim();
      if (key === 'WZRY') return '/assets/game_icons/wzry.webp';
      if (key === '和平精英') return '/assets/game_icons/hpjy.png';
      if (key === 'CFM') return '/assets/game_icons/cfm.png';
      return '';
    }

    async function loadStatsCalendar(monthText = '') {
      const month = /^\d{4}-\d{2}$/.test(String(monthText || '').trim())
        ? String(monthText).trim()
        : (state.statsBoard.calendar && state.statsBoard.calendar.month) || currentMonthText();
      const gameName = String((state.statsBoard && state.statsBoard.game_name) || '全部').trim() || '全部';
      const data = await request(`/api/stats/calendar?month=${encodeURIComponent(month)}&game_name=${encodeURIComponent(gameName)}`);
      state.statsBoard.calendar = {
        month: String(data.month || month),
        start_date: String(data.start_date || ''),
        end_date: String(data.end_date || ''),
        total_rec_amount: Number(data.total_rec_amount || 0),
        by_day: Array.isArray(data.by_day) ? data.by_day : []
      };
    }

    function renderStatsCalendar() {
      const cal = (state.statsBoard && state.statsBoard.calendar) || {};
      const month = /^\d{4}-\d{2}$/.test(String(cal.month || '')) ? cal.month : currentMonthText();
      const byDay = Array.isArray(cal.by_day) ? cal.by_day : [];
      const amountByDay = new Map(
        byDay.map((x) => [String(x.stat_date || '').slice(-2), Number(x.amount_rec_sum || 0)])
      );
      const selectedDate = isDateText(state.statsBoard && state.statsBoard.selected_date)
        ? String(state.statsBoard.selected_date).trim()
        : '';

      els.statsCalMonth.value = month;
      els.statsCalTitle.textContent = '收入日历';

      const totalDays = daysInMonth(month);
      const firstWeekday = dayOfWeek(month, 1);
      const cells = [];
      for (let i = 0; i < firstWeekday; i += 1) {
        cells.push('<div class="stats-cal-cell empty"></div>');
      }
      for (let d = 1; d <= totalDays; d += 1) {
        const dd = String(d).padStart(2, '0');
        const amt = Number(amountByDay.get(dd) || 0);
        const has = amt > 0;
        const statDate = `${month}-${dd}`;
        const active = selectedDate === statDate;
        cells.push(`
          <div class="stats-cal-cell ${has ? 'has-income' : ''} ${active ? 'active' : ''}" data-stat-date="${statDate}">
            <p class="stats-cal-day">${d}</p>
            <p class="stats-cal-income">${has ? `+${amt.toFixed(2)}` : ''}</p>
          </div>
        `);
      }
      els.statsCalGrid.innerHTML = cells.join('');
      els.statsCalGrid.classList.toggle('has-active', Boolean(selectedDate));
      Array.from(els.statsCalGrid.querySelectorAll('.stats-cal-cell[data-stat-date]')).forEach((n) => {
        n.addEventListener('click', async () => {
          try {
            const dateText = String(n.getAttribute('data-stat-date') || '').trim();
            if (!isDateText(dateText)) return;
            if (String((state.statsBoard && state.statsBoard.selected_date) || '').trim() === dateText) {
              state.statsBoard.period = 'last7';
              state.statsBoard.selected_date = '';
              await loadStatsBoard();
              renderStatsView();
              return;
            }
            state.statsBoard.selected_date = dateText;
            await loadStatsBoard({ stat_date: dateText });
            renderStatsView();
          } catch (e) {
            alert(e.message || '加载单日统计失败');
          }
        });
      });
      els.statsCalMonth.onchange = async () => {
        try {
          const nextMonth = String(els.statsCalMonth.value || '').trim();
          await loadStatsCalendar(nextMonth);
          renderStatsCalendar();
        } catch (e) {
          alert(e.message || '加载收入日历失败');
        }
      };
    }

    function renderStatsView() {
      const s = state.statsBoard || {};
      const games = [
        { k: '全部', t: '全部', icon: '' },
        { k: 'WZRY', t: '王者荣耀', icon: '/assets/game_icons/wzry.webp' },
        { k: '和平精英', t: '和平精英', icon: '/assets/game_icons/hpjy.png' },
        { k: 'CFM', t: 'CFM枪战王者', icon: '/assets/game_icons/cfm.png' }
      ];
      const periods = [
        { k: 'week', t: '本周' },
        { k: 'last7', t: '近7天' },
        { k: 'month', t: '本月' },
        { k: 'last30', t: '近30天' }
      ];
      const summary = s.summary || {};
      const profitability = s.profitability || {};
      const orderBase = Number(summary.order_cnt_total || 0);
      const avgRec = orderBase > 0 ? Number(summary.amount_rec_sum || 0) / orderBase : 0;

      if (els.statsGameTabs) {
        els.statsGameTabs.innerHTML = games.map((x) => `
          <button class="stats-game-tab ${String(s.game_name || '全部') === x.k ? 'active' : ''}" data-stats-game="${x.k}">
            ${x.icon ? `<span class="game-avatar"><img src="${x.icon}" alt="${x.t}" loading="lazy" decoding="async"></span>` : ''}
            <span class="stats-game-tab-text">${x.t}</span>
          </button>
        `).join('');
      }
      els.statsPeriods.innerHTML = periods.map((x) => `
        <button class="stats-period-btn ${s.period === x.k ? 'active' : ''}" data-stats-period="${x.k}">${x.t}</button>
      `).join('');
      els.statsRangeText.textContent = `统计区间：${(s.range && s.range.start_date) || '-'} ~ ${(s.range && s.range.end_date) || '-'}`;
      els.statsKpiGrid.innerHTML = `
        <div class="stats-kpi-card">
          <p class="stats-kpi-key">有效订单数</p>
          <p class="stats-kpi-value stats-kpi-value-order-cnt">${Number(summary.order_cnt_effective || 0)}</p>
        </div>
        <div class="stats-kpi-card">
          <p class="stats-kpi-key">历史总收入</p>
          <p class="stats-kpi-value money">¥${Number(summary.total_rec_amount_all_time || 0).toFixed(2)}</p>
        </div>
        <div class="stats-kpi-card">
          <p class="stats-kpi-key">实收总额</p>
          <p class="stats-kpi-value money">¥${Number(summary.amount_rec_sum || 0).toFixed(2)}</p>
        </div>
        <div class="stats-kpi-card">
          <p class="stats-kpi-key">单均实收</p>
          <p class="stats-kpi-value">¥${avgRec.toFixed(2)}</p>
        </div>
        <div class="stats-kpi-card">
          <p class="stats-kpi-key">退款率</p>
          <p class="stats-kpi-value">${(Number(summary.refund_rate || 0) * 100).toFixed(1)}%</p>
        </div>
        <div class="stats-kpi-card">
          <p class="stats-kpi-key">撤单率</p>
          <p class="stats-kpi-value">${(Number(summary.cancel_rate || 0) * 100).toFixed(1)}%</p>
        </div>
        <div class="stats-kpi-card">
          <p class="stats-kpi-key">期间成本分母</p>
          <p class="stats-kpi-value">¥${Number(profitability.cost_base_value || 0).toFixed(2)}</p>
        </div>
        <div class="stats-kpi-card">
          <p class="stats-kpi-key">年化收益率</p>
          <p class="stats-kpi-value">${(Number(profitability.annualized_return_rate || 0) * 100).toFixed(2)}%</p>
        </div>
        <div class="stats-kpi-card">
          <p class="stats-kpi-key">日均单数</p>
          <p class="stats-kpi-value">${Number(summary.avg_daily_order_cnt || 0).toFixed(2)}</p>
        </div>
        <div class="stats-kpi-card">
          <p class="stats-kpi-key">日均时长</p>
          <p class="stats-kpi-value">${Number(summary.avg_daily_rent_hour || 0).toFixed(2)}h</p>
        </div>
        <div class="stats-kpi-card">
          <p class="stats-kpi-key">日均单价</p>
          <p class="stats-kpi-value">¥${Number(summary.avg_order_price || 0).toFixed(2)}</p>
        </div>
        <div class="stats-kpi-card">
          <p class="stats-kpi-key">日均实收</p>
          <p class="stats-kpi-value">¥${Number(summary.avg_daily_rec || 0).toFixed(2)}</p>
        </div>
        <div class="stats-kpi-card">
          <p class="stats-kpi-key">3单达成率</p>
          <p class="stats-kpi-value">${(Number(summary.target3_rate || 0) * 100).toFixed(1)}%</p>
        </div>
      `;
      renderStatsCalendar();

      els.statsAccountTitle.textContent = `账号收益（已配置 ${Number(s.configured_account_count || 0)} 个）`;
      const list = Array.isArray(s.by_account) ? s.by_account : [];
      if (list.length === 0) {
        els.statsAccountList.innerHTML = '<div class="panel"><div style="color:#6d7a8a;font-size:13px;">暂无可展示的账号统计</div></div>';
      } else {
        els.statsAccountList.innerHTML = list.map((x) => `
          <div class="stats-acc-item">
            <div class="stats-acc-top">
              <p class="stats-acc-name">${gameIconByName(x.game_name) ? `<span class="game-avatar"><img src="${gameIconByName(x.game_name)}" alt="${x.game_name || ''}" loading="lazy" decoding="async"></span>` : ''}${x.display_name || x.role_name || x.game_account || '-'}</p>
              <span class="stats-acc-money">¥${Number(x.amount_rec_sum || 0).toFixed(2)}</span>
            </div>
            <p class="stats-acc-meta">账号：${x.game_account || '-'} · 有效订单：${Number(x.order_cnt_effective || 0)} · 采购：${x.purchase_date || '-'}</p>
            <div class="stats-acc-grid">
              <div class="stats-acc-chip is-clickable" data-stats-cost-detail="${x.game_account || ''}" data-stats-cost-game="${x.game_name || ''}"><p class="stats-acc-chip-k">维护成本<span class="stats-acc-chip-mark">›</span></p><p class="stats-acc-chip-v">¥${Number(x.total_cost_amount || 0).toFixed(2)}</p></div>
              <div class="stats-acc-chip"><p class="stats-acc-chip-k">采购成本</p><p class="stats-acc-chip-v">¥${Number(x.purchase_cost_amount || x.purchase_base || 0).toFixed(2)}</p></div>
              <div class="stats-acc-chip"><p class="stats-acc-chip-k">历史总收入</p><p class="stats-acc-chip-v">¥${Number(x.total_rec_amount_all_time || 0).toFixed(2)}</p></div>
              <div class="stats-acc-chip"><p class="stats-acc-chip-k">年化(单利)</p><p class="stats-acc-chip-v">${(Number(x.annualized_return_rate || 0) * 100).toFixed(2)}%</p></div>
              <div class="stats-acc-chip"><p class="stats-acc-chip-k">日均单数</p><p class="stats-acc-chip-v">${Number(x.avg_daily_order_cnt || 0).toFixed(2)}</p></div>
              <div class="stats-acc-chip"><p class="stats-acc-chip-k">日均时长</p><p class="stats-acc-chip-v">${Number(x.avg_daily_rent_hour || 0).toFixed(2)}h</p></div>
              <div class="stats-acc-chip"><p class="stats-acc-chip-k">日均单价</p><p class="stats-acc-chip-v">¥${Number(x.avg_order_price || 0).toFixed(2)}</p></div>
              <div class="stats-acc-chip"><p class="stats-acc-chip-k">日均实收</p><p class="stats-acc-chip-v">¥${Number(x.avg_daily_rec || 0).toFixed(2)}</p></div>
              <div class="stats-acc-chip"><p class="stats-acc-chip-k">3单达成率</p><p class="stats-acc-chip-v">${(Number(x.target3_rate || 0) * 100).toFixed(1)}%</p></div>
              <div class="stats-acc-chip"><p class="stats-acc-chip-k">退款/撤单</p><p class="stats-acc-chip-v">${Number(x.order_cnt_refund || 0)}/${Number(x.order_cnt_cancel || 0)}</p></div>
            </div>
          </div>
        `).join('');
        Array.from(els.statsAccountList.querySelectorAll('[data-stats-cost-detail]')).forEach((n) => {
          n.addEventListener('click', async () => {
            const account = String(n.getAttribute('data-stats-cost-detail') || '').trim();
            if (!account) return;
            const item = list.find((x) => String(x.game_account || '').trim() === account) || null;
            if (!item) return;
            await openStatsCostDetail(item);
          });
        });
      }

      Array.from(els.statsPeriods.querySelectorAll('[data-stats-period]')).forEach((n) => {
        n.addEventListener('click', async () => {
          const k = String(n.getAttribute('data-stats-period') || 'today').trim();
          if (k === state.statsBoard.period) return;
          state.statsBoard.period = k;
          state.statsBoard.selected_date = '';
          await loadStatsBoard();
          renderStatsView();
        });
      });
      if (els.statsGameTabs) {
        Array.from(els.statsGameTabs.querySelectorAll('[data-stats-game]')).forEach((n) => {
          n.addEventListener('click', async () => {
            const k = String(n.getAttribute('data-stats-game') || '全部').trim();
            if (k === String(state.statsBoard.game_name || '全部')) return;
            state.statsBoard.game_name = k;
            await loadStatsBoard();
            await loadStatsCalendar((state.statsBoard.calendar && state.statsBoard.calendar.month) || '');
            renderStatsView();
          });
        });
      }
      renderStatsMissingOverlay();
      renderStatsCostDetailSheet();
      bindStatsCostDetailSheetEvents();
    }

    bindStatsCostDetailSheetEvents();
