    function platformBadges(item) {
      const legacy = item && item.channel_status && typeof item.channel_status === 'object' ? item.channel_status : {};
      const norm = item && item.platform_status_norm && typeof item.platform_status_norm === 'object' ? item.platform_status_norm : {};
      const defs = [
        { key: 'uuzuhao', name: '悠悠' },
        { key: 'uhaozu', name: 'U号' },
        { key: 'zuhaowang', name: 'ZHW' }
      ];
      return defs.map((d) => {
        const one = norm[d.key] && typeof norm[d.key] === 'object' ? norm[d.key] : null;
        const label = one && String(one.label || '').trim()
          ? String(one.label || '').trim()
          : (String(legacy[d.key] || '').trim() || '未');
        const reason = one && String(one.reason || '').trim() ? String(one.reason || '').trim() : '';
        const code = one && String(one.code || '').trim() ? String(one.code || '').trim() : '';
        const shortReason = isDangerStatusCode(code) ? shortenDangerReason(reason) : '';
        const suffix = shortReason && shortReason !== label ? `·${shortReason}` : '';
        const display = (code === 'auth_abnormal' && shortReason)
          ? shortReason
          : `${label}${suffix}`;
        return {
          text: `${d.name}: ${display}`,
          code,
          reason
        };
      });
    }

    function isDangerStatusCode(code) {
      const c = String(code || '').trim();
      return c === 'auth_abnormal' || c === 'review_fail' || c === 'restricted';
    }

    function shortenDangerReason(reason) {
      const r = String(reason || '').trim();
      if (!r) return '';
      if (r.includes('仅卖家下架状态支持直接上架')) return '平台限制上架';
      if (r.includes('检测游戏在线') || (r.includes('检测') && r.includes('在线'))) return '检测在线';
      if (r.includes('游戏在线')) return '游戏在线';
      if (r.includes('授权')) return '授权异常';
      if (r.includes('审核')) return '审核失败';
      if (r.includes('限制') || r.includes('禁玩')) return '平台限制';
      return r.length > 6 ? `${r.slice(0, 6)}...` : r;
    }

    function hasAnyNormalChannel(item) {
      const norm = item && item.platform_status_norm && typeof item.platform_status_norm === 'object'
        ? item.platform_status_norm
        : {};
      return Object.values(norm).some((one) => {
        if (!one || typeof one !== 'object') return false;
        const code = String(one.code || '').trim();
        return code === 'listed' || code === 'renting';
      });
    }

    function escapeAttr(v) {
      return String(v || '')
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;');
    }

    function formatBlacklistTimeForCard(v) {
      const t = String(v || '').trim();
      if (!t) return '';
      const m = /^(\d{4})-(\d{2})-(\d{2})\s+(\d{2}:\d{2}:\d{2})$/.exec(t);
      if (m) return `${m[2]}-${m[3]} ${m[4].slice(0, 5)}`;
      return t.length >= 16 ? t.slice(5, 16) : t;
    }

    function compactMainStatusReason(reasonText) {
      const text = String(reasonText || '').trim();
      if (!text) return '';
      if (text === '冷却期下架') return '冷却中';
      return text;
    }

    function isMaintenanceReason(reasonText) {
      return String(reasonText || '').trim() === '维护中';
    }

    function normalizeGameName(gameName, gameId) {
      const n = String(gameName || '').trim();
      const lower = n.toLowerCase();
      if (n.includes('CFM') || n.includes('枪战王者') || n.includes('穿越火线') || lower === 'cfm') return 'CFM';
      if (n === '和平精英' || n.toUpperCase() === 'HPJY') return '和平精英';
      const gid = String(gameId || '').trim();
      if (gid === '3') return 'CFM';
      if (gid === '2') return '和平精英';
      return 'WZRY';
    }

    function buildGameAvatarHtml(item) {
      const normalized = normalizeGameName(item && item.game_name, item && item.game_id);
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

    async function toggleMaintenance(item) {
      const account = String(item && item.game_account || '').trim();
      if (!account) return;
      const reason = String(item && item.blacklist_reason || '').trim();
      const enabled = !Boolean(item && item.blacklisted && isMaintenanceReason(reason));
      try {
        state.moreOpsSheet.maintenance_loading = true;
        renderMoreOpsSheet();
        await request('/api/products/maintenance/toggle', {
          method: 'POST',
          body: JSON.stringify({ game_account: account, enabled })
        });
        closeMoreOpsSheet();
        await loadList();
        renderList();
        showToast(enabled ? '已开启维护' : '已结束维护');
      } catch (e) {
        alert(e.message || (enabled ? '开启维护失败' : '结束维护失败'));
      } finally {
        state.moreOpsSheet.maintenance_loading = false;
        renderMoreOpsSheet();
      }
    }

    async function queryStatus(item) {
      const account = String(item && item.game_account || '').trim();
      const gameName = String(item && item.game_name || 'WZRY').trim() || 'WZRY';
      if (!account) return;
      state.onlineLoadingMap[account] = true;
      state.forbiddenLoadingMap[account] = true;
      renderOnlinePart(account);
      renderForbiddenPart(account);
      try {
        const [onlineRes, forbiddenRes] = await Promise.all([
          request('/api/products/online', {
            method: 'POST',
            body: JSON.stringify({ game_account: account, game_name: gameName })
          }),
          request('/api/products/forbidden/query', {
            method: 'POST',
            body: JSON.stringify({ game_account: account, game_name: gameName })
          })
        ]);
        const online = Boolean(onlineRes && onlineRes.data && onlineRes.data.online);
        const tag = online ? '在线' : '离线';
        const forbiddenEnabled = Boolean(forbiddenRes && forbiddenRes.data && forbiddenRes.data.enabled);
        const hit = (state.list || []).find((x) => String((x && x.game_account) || '').trim() === account);
        state.onlineStatusMap[account] = tag;
        if (hit) {
          hit.online_tag = tag;
          hit.online_query_time = String((onlineRes && onlineRes.data && onlineRes.data.query_time) || '').trim();
          hit.forbidden_status = forbiddenEnabled ? '禁玩中' : '未禁玩';
          hit.forbidden_query_time = String((forbiddenRes && forbiddenRes.data && forbiddenRes.data.query_time) || '').trim();
        }
      } catch (e) {
        alert(e.message || '状态查询失败');
      } finally {
        state.onlineLoadingMap[account] = false;
        state.forbiddenLoadingMap[account] = false;
        renderOnlinePart(account);
        renderForbiddenPart(account);
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
      const queryTime = String((hit && hit.online_query_time) || '').trim();
      const title = queryTime ? ` title="查询时间：${escapeAttr(queryTime)}"` : '';
      return `<span class="chip ${onlineClass}"${title}>${onlineText}</span>`;
    }

    function buildForbiddenChipHtml(account) {
      const acc = String(account || '').trim();
      const hit = (state.list || []).find((x) => String((x && x.game_account) || '').trim() === acc);
      const txt = String((hit && hit.forbidden_status) || '').trim();
      if (!txt) return '';
      const queryTime = String((hit && hit.forbidden_query_time) || '').trim();
      const title = queryTime ? ` title="查询时间：${escapeAttr(queryTime)}"` : '';
      const cls = txt === '禁玩中' ? 'chip-black' : 'chip-offline';
      return `<span class="chip ${cls}"${title}>${txt}</span>`;
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

    function parseDateTimeText(v) {
      const s = String(v || '').trim();
      if (!s) return null;
      const ms = Date.parse(s.replace(' ', 'T'));
      if (!Number.isFinite(ms)) return null;
      return new Date(ms);
    }

    function formatRemainByEndMs(endMs) {
      const diffSec = Math.floor((Number(endMs || 0) - Date.now()) / 1000);
      if (diffSec <= 0) return '';
      const day = Math.floor(diffSec / 86400);
      const hour = Math.floor((diffSec % 86400) / 3600);
      const min = Math.floor((diffSec % 3600) / 60);
      const sec = diffSec % 60;
      if (day > 0) return `${day}天${hour}时${min}分`;
      if (hour > 0) return `${hour}时${min}分${sec}秒`;
      return `${min}分${sec}秒`;
    }

    function buildRentCountdownHtml(item) {
      const endTime = String(item && item.renting_order_end_time || '').trim();
      if (!endTime) return '';
      const end = parseDateTimeText(endTime);
      if (!end) return '';
      const endMs = end.getTime();
      const remain = formatRemainByEndMs(endMs);
      if (!remain) return '';
      return `<span class="plat plat-renting rent-countdown-chip" data-slot="rent-countdown" data-end-ms="${endMs}">租赁倒计时：${remain}</span>`;
    }

    function renderRentCountdownPart(account) {
      const acc = String(account || '').trim();
      if (!acc) return;
      const card = state.cardNodeMap[acc];
      if (!card) return;
      const slot = card.querySelector('[data-slot="rent-countdown"]');
      if (!slot) return;
      const endMs = Number(slot.getAttribute('data-end-ms') || 0);
      const remain = formatRemainByEndMs(endMs);
      if (!remain) {
        slot.remove();
        return;
      }
      slot.textContent = `租赁倒计时：${remain}`;
    }

    function startRentCountdownTicker() {
      if (state.rentCountdownTimer) {
        clearInterval(state.rentCountdownTimer);
        state.rentCountdownTimer = 0;
      }
      const hasCountdown = (state.list || []).some((x) => String((x && x.renting_order_end_time) || '').trim());
      if (!hasCountdown) return;
      state.rentCountdownTimer = setInterval(() => {
        let active = 0;
        for (const item of (state.list || [])) {
          const acc = String((item && item.game_account) || '').trim();
          if (!acc) continue;
          const card = state.cardNodeMap[acc];
          if (card && card.querySelector('[data-slot="rent-countdown"]')) active += 1;
          renderRentCountdownPart(acc);
        }
        if (active <= 0 && state.rentCountdownTimer) {
          clearInterval(state.rentCountdownTimer);
          state.rentCountdownTimer = 0;
        }
      }, 1000);
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
      const forbiddenSlot = card.querySelector('[data-slot="forbidden-chip"]');
      if (forbiddenSlot) {
        forbiddenSlot.innerHTML = buildForbiddenChipHtml(acc);
      }

      const btn = card.querySelector('[data-op="online-query"]');
      if (btn) {
        const querying = Boolean(state.onlineLoadingMap[acc] || state.forbiddenLoadingMap[acc]);
        btn.disabled = querying;
        btn.textContent = querying ? '查询中...' : '状态查询';
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
      const queryLoading = Boolean(state.forbiddenSheet.query_loading);
      els.sheetEnableForbidden.disabled = loading || queryLoading;
      els.sheetDisableForbidden.disabled = loading || queryLoading;
      els.sheetCancelForbidden.disabled = loading || queryLoading;
    }

    function renderMoreOpsSheet() {
      const opened = Boolean(state.moreOpsSheet && state.moreOpsSheet.open);
      els.moreOpsSheet.classList.toggle('hidden', !opened);
      if (!opened) return;
      const name = String(state.moreOpsSheet.role_name || state.moreOpsSheet.account || '').trim();
      const account = String(state.moreOpsSheet.account || '').trim();
      const querying = Boolean(state.onlineLoadingMap[account]);
      const handling = Boolean(state.forbiddenLoadingMap[account]);
      const maintenanceLoading = Boolean(state.moreOpsSheet.maintenance_loading);
      const maintenanceEnabled = Boolean(state.moreOpsSheet.maintenance_enabled);
      els.moreOpsSheetTitle.textContent = `更多操作 · ${name || '当前账号'}`;
      els.moreOpsForbiddenBtn.disabled = querying || handling || maintenanceLoading;
      if (els.moreOpsMaintenanceBtn) {
        els.moreOpsMaintenanceBtn.disabled = querying || handling || maintenanceLoading;
        els.moreOpsMaintenanceBtn.textContent = maintenanceLoading
          ? '处理中...'
          : (maintenanceEnabled ? '结束维护' : '开启维护');
      }
      els.moreOpsPurchaseBtn.disabled = querying || handling || maintenanceLoading;
      els.moreOpsCloseBtn.disabled = querying || handling || maintenanceLoading;
      els.moreOpsForbiddenBtn.textContent = handling ? '处理中...' : '处理禁玩';
    }

    function closeActionSheets() {
      state.activeActionSheet = '';
      state.moreOpsSheet = { open: false, account: '', role_name: '', maintenance_enabled: false, maintenance_loading: false };
      state.forbiddenSheet = {
        open: false,
        account: '',
        game_name: 'WZRY',
        role_name: '',
        result_text: '',
        result_type: '',
        loading: false,
        query_loading: false,
        query_status: '',
        query_text: ''
      };
      renderMoreOpsSheet();
      renderForbiddenSheet();
    }

    function openForbiddenSheet(item) {
      const account = String(item && item.game_account || '').trim();
      if (!account) return;
      state.moreOpsSheet = { open: false, account: '', role_name: '', maintenance_enabled: false, maintenance_loading: false };
      state.activeActionSheet = 'forbidden';
      renderMoreOpsSheet();
      state.forbiddenSheet = {
        open: true,
        account,
        game_name: String(item && item.game_name || 'WZRY').trim() || 'WZRY',
        role_name: String(item && (item.role_name || item.game_account) || '').trim(),
        result_text: '',
        result_type: '',
        loading: false,
        query_loading: false,
        query_status: String(item && item.forbidden_status || '').trim() === '禁玩中' ? 'on'
          : (String(item && item.forbidden_status || '').trim() === '未禁玩' ? 'off' : ''),
        query_text: String(item && item.forbidden_status || '').trim()
          || (String(item && item.forbidden_query_time || '').trim() ? `最近查询：${String(item.forbidden_query_time || '').trim()}` : '')
      };
      renderForbiddenSheet();
    }

    function closeForbiddenSheet() {
      if (state.activeActionSheet === 'forbidden') state.activeActionSheet = '';
      state.forbiddenSheet = {
        open: false,
        account: '',
        game_name: 'WZRY',
        role_name: '',
        result_text: '',
        result_type: '',
        loading: false,
        query_loading: false,
        query_status: '',
        query_text: ''
      };
      renderForbiddenSheet();
    }

    function openMoreOpsSheet(item) {
      const account = String(item && item.game_account || '').trim();
      if (!account) return;
      state.forbiddenSheet = {
        open: false,
        account: '',
        game_name: 'WZRY',
        role_name: '',
        result_text: '',
        result_type: '',
        loading: false,
        query_loading: false,
        query_status: '',
        query_text: ''
      };
      state.activeActionSheet = 'more';
      state.moreOpsSheet = {
        open: true,
        account,
        role_name: String(item && (item.role_name || item.game_account) || '').trim(),
        maintenance_enabled: Boolean(item && item.blacklisted && isMaintenanceReason(item.blacklist_reason)),
        maintenance_loading: false
      };
      renderForbiddenSheet();
      renderMoreOpsSheet();
    }

    function closeMoreOpsSheet() {
      if (state.activeActionSheet === 'more') state.activeActionSheet = '';
      state.moreOpsSheet = { open: false, account: '', role_name: '', maintenance_enabled: false, maintenance_loading: false };
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
      const gameName = String((state.forbiddenSheet || {}).game_name || 'WZRY').trim() || 'WZRY';
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
          body: JSON.stringify({ game_account: account, game_name: gameName, enabled: Boolean(enabled) })
        });
        const on = Boolean(out && out.data && out.data.enabled);
        const queryTime = String((out && out.data && out.data.query_time) || '').trim();
        state.forbiddenSheet.result_text = on ? '禁玩已开启' : '禁玩已解除';
        state.forbiddenSheet.result_type = 'ok';
        state.forbiddenSheet.query_status = on ? 'on' : 'off';
        state.forbiddenSheet.query_text = queryTime
          ? `${on ? '禁玩中' : '未禁玩'} · ${queryTime.slice(5, 16)}`
          : (on ? '禁玩中' : '未禁玩');
        const hit = (state.list || []).find((x) => String((x && x.game_account) || '').trim() === account);
        if (hit) {
          hit.forbidden_status = on ? '禁玩中' : '未禁玩';
          hit.forbidden_query_time = queryTime;
        }
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

    async function queryForbidden() {
      const account = String((state.forbiddenSheet || {}).account || '').trim();
      const gameName = String((state.forbiddenSheet || {}).game_name || 'WZRY').trim() || 'WZRY';
      if (!account) return;
      state.forbiddenSheet.query_loading = true;
      state.forbiddenSheet.result_text = '';
      state.forbiddenSheet.result_type = '';
      renderForbiddenSheet();
      state.forbiddenLoadingMap[account] = true;
      renderForbiddenPart(account);
      try {
        const out = await request('/api/products/forbidden/query', {
          method: 'POST',
          body: JSON.stringify({ game_account: account, game_name: gameName })
        });
        const on = Boolean(out && out.data && out.data.enabled);
        const queryTime = String((out && out.data && out.data.query_time) || '').trim();
        state.forbiddenSheet.query_status = on ? 'on' : 'off';
        state.forbiddenSheet.query_text = queryTime
          ? `${on ? '禁玩中' : '未禁玩'} · ${queryTime.slice(5, 16)}`
          : (on ? '禁玩中' : '未禁玩');
        state.forbiddenSheet.result_text = '';
        state.forbiddenSheet.result_type = '';
        const hit = (state.list || []).find((x) => String((x && x.game_account) || '').trim() === account);
        if (hit) {
          hit.forbidden_status = on ? '禁玩中' : '未禁玩';
          hit.forbidden_query_time = queryTime;
        }
      } catch (e) {
        state.forbiddenSheet.query_status = 'err';
        state.forbiddenSheet.query_text = '查询失败';
        state.forbiddenSheet.result_text = String(e && e.message ? e.message : '禁玩查询失败');
        state.forbiddenSheet.result_type = 'err';
      } finally {
        state.forbiddenSheet.query_loading = false;
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
      const orderCountLabel = orderCountLabelByMode();
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
        <span class="order-total-main">${orderCountLabel}：${Number(state.stats.total_paid || 0)}</span>
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
      if (state.rentCountdownTimer) {
        clearInterval(state.rentCountdownTimer);
        state.rentCountdownTimer = 0;
      }
      renderFilters();

      if (state.list.length === 0) {
        root.innerHTML = '<div class="panel"><div style="color:#6d7a8a;font-size:13px;">暂无数据</div></div>';
      } else {
        state.list.forEach((item, idx) => {
          const node = document.createElement('div');
          node.className = 'order-card product-card';
          const plat = platformBadges(item).map((x) => {
            const text = String((x && x.text) || '').trim();
            const code = String((x && x.code) || '').trim();
            const reason = String((x && x.reason) || '').trim();
            const isRenting = code === 'renting' || /租赁中/.test(text);
            const isDanger = isDangerStatusCode(code);
            const cls = isDanger ? 'plat-abnormal' : (isRenting ? 'plat-renting' : '');
            const title = reason ? ` title="${escapeAttr(reason)}"` : '';
            return `<span class="plat ${cls}"${title}>${text}</span>`;
          }).join('');
          const account = String(item.game_account || '').trim();
          const querying = Boolean(state.onlineLoadingMap[account] || state.forbiddenLoadingMap[account]);
          const forbiddenLoading = Boolean(state.forbiddenLoadingMap[account]);
          const blacklistDisplayDate = String(item.blacklist_display_date || item.blacklist_create_date || '').trim();
          const blacklistTime = formatBlacklistTimeForCard(blacklistDisplayDate);
          const overall = item && item.overall_status_norm && typeof item.overall_status_norm === 'object'
            ? item.overall_status_norm
            : {};
          const overallLabel = String(overall.label || '').trim();
          const anyNormalChannel = hasAnyNormalChannel(item);
          const statusText = item.blacklisted
            ? `${compactMainStatusReason(item.blacklist_reason || '无原因')}${blacklistTime ? ` · ${blacklistTime}` : ''}`
            : (anyNormalChannel
              ? '状态正常'
              : (overallLabel && overallLabel !== '上架' && overallLabel !== '下架' && overallLabel !== '租赁中' && overallLabel !== '未知'
              ? `${overallLabel}`
              : (item.mode_restricted ? '渠道受限' : '状态正常')));
          const statusClass = statusText === '状态正常' ? '' : 'chip-black';
          node.style.animationDelay = `${Math.min(idx * 35, 220)}ms`;
          node.innerHTML = `
            <div class="order-card-top product-card-top">
              <p class="order-card-role product-card-role">${buildGameAvatarHtml(item)}<span class="product-role-text">${item.display_name || item.role_name || item.game_account}</span></p>
              <div class="card-top-chips">
                <span data-slot="online-chip">${buildOnlineChipHtml(account)}</span>
                <span data-slot="forbidden-chip">${buildForbiddenChipHtml(account)}</span>
                <span class="chip ${statusClass} status-main-chip" title="${escapeAttr(statusText)}">
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
                ${buildRentCountdownHtml(item)}
              </div>
              <div class="info-square channel-square">
                <p class="square-title">渠道状态</p>
                <div class="platforms">${plat}</div>
              </div>
            </div>
            <div class="ops">
              <button class="btn btn-chip btn-chip-ok" data-op="online-query" ${querying ? 'disabled' : ''}>
                状态查询
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
          node.querySelector('[data-op=\"online-query\"]').addEventListener('click', () => queryStatus(item));
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
      startRentCountdownTicker();
    }
