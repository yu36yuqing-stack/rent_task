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

    function productIdentityKey(input, fallbackGameId = '1') {
      if (!input || typeof input !== 'object') {
        const acc = String(input || '').trim();
        const gid = String(fallbackGameId || '1').trim() || '1';
        return `${gid}::${acc}`;
      }
      const acc = String((input && input.game_account) || input.account || '').trim();
      const gid = String((input && input.game_id) || fallbackGameId || '1').trim() || '1';
      return `${gid}::${acc}`;
    }

    function findProductItemByIdentity(gameId, account) {
      const gid = String(gameId || '1').trim() || '1';
      const acc = String(account || '').trim();
      if (!acc) return null;
      return (state.list || []).find((x) => {
        return String((x && x.game_account) || '').trim() === acc
          && String((x && x.game_id) || '1').trim() === gid;
      }) || null;
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
            body: JSON.stringify({
              game_account: item.game_account,
              game_id: item.game_id,
              game_name: item.game_name
            })
          });
        } else {
          await request('/api/blacklist/add', {
            method: 'POST',
            body: JSON.stringify({
              game_account: item.game_account,
              game_id: item.game_id,
              game_name: item.game_name,
              reason: '人工下架'
            })
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
      const gameId = String(item && item.game_id || '1').trim() || '1';
      const gameName = String(item && item.game_name || 'WZRY').trim() || 'WZRY';
      if (!account) return;
      const reason = String(item && item.blacklist_reason || '').trim();
      const enabled = !Boolean(item && item.blacklisted && isMaintenanceReason(reason));
      try {
        state.moreOpsSheet.maintenance_loading = true;
        renderMoreOpsSheet();
        await request('/api/products/maintenance/toggle', {
          method: 'POST',
          body: JSON.stringify({ game_account: account, game_id: gameId, game_name: gameName, enabled })
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

    async function toggleProdGuard(item) {
      const account = String(item && item.game_account || '').trim();
      const gameId = String(item && item.game_id || '1').trim() || '1';
      const gameName = String(item && item.game_name || 'WZRY').trim() || 'WZRY';
      if (!account) return;
      const enabled = Boolean(item && item.prod_guard_enabled);
      const nextEnabled = !enabled;
      const actionText = nextEnabled ? '开启在线风控' : '关闭在线风控';
      if (!nextEnabled) {
        const ok = window.confirm('关闭后将不再检测该账号在线状态，也不再触发在线风控，是否继续？');
        if (!ok) return;
      }
      try {
        state.moreOpsSheet.prod_guard_loading = true;
        renderMoreOpsSheet();
        const out = await request('/api/products/account-switch/toggle', {
          method: 'POST',
          body: JSON.stringify({
            game_account: account,
            game_id: gameId,
            game_name: gameName,
            switch_key: 'prod_guard',
            enabled: nextEnabled
          })
        });
        const savedEnabled = Boolean(out && out.data && out.data.prod_guard_enabled);
        const savedSwitch = out && out.data && out.data.switch && typeof out.data.switch === 'object'
          ? out.data.switch
          : {};
        if (!savedEnabled) delete state.onlineStatusMap[account];
        state.list = (state.list || []).map((x) => {
          if (String(x && x.game_account || '').trim() !== account || String((x && x.game_id) || '1').trim() !== gameId) return x;
          return {
            ...x,
            switch: savedSwitch,
            prod_guard_enabled: savedEnabled
          };
        });
        closeMoreOpsSheet();
        await loadList();
        renderList();
        showToast(savedEnabled ? '已开启在线风控' : '已关闭在线风控');
      } catch (e) {
        alert(e.message || `${actionText}失败`);
      } finally {
        state.moreOpsSheet.prod_guard_loading = false;
        renderMoreOpsSheet();
      }
    }

    async function queryStatus(item) {
      const account = String(item && item.game_account || '').trim();
      const gameId = String(item && item.game_id || '1').trim() || '1';
      const gameName = String(item && item.game_name || 'WZRY').trim() || 'WZRY';
      const identityKey = productIdentityKey(item);
      const prodGuardEnabled = item && item.prod_guard_enabled === undefined ? true : Boolean(item && item.prod_guard_enabled);
      if (!account) return;
      state.forbiddenLoadingMap[identityKey] = true;
      if (prodGuardEnabled) state.onlineLoadingMap[identityKey] = true;
      renderOnlinePart(identityKey);
      renderForbiddenPart(identityKey);
      try {
        const [onlineRes, forbiddenRes] = await Promise.all([
          prodGuardEnabled
            ? request('/api/products/online', {
              method: 'POST',
              body: JSON.stringify({ game_account: account, game_name: gameName })
            })
            : Promise.resolve(null),
          request('/api/products/forbidden/query', {
            method: 'POST',
            body: JSON.stringify({ game_account: account, game_name: gameName })
          })
        ]);
        const forbiddenEnabled = Boolean(forbiddenRes && forbiddenRes.data && forbiddenRes.data.enabled);
        const hit = findProductItemByIdentity(gameId, account);
        if (hit) {
          if (prodGuardEnabled) {
            const online = Boolean(onlineRes && onlineRes.data && onlineRes.data.online);
            const tag = online ? '在线' : '离线';
            state.onlineStatusMap[identityKey] = tag;
            hit.online_tag = tag;
            hit.online_query_time = String((onlineRes && onlineRes.data && onlineRes.data.query_time) || '').trim();
          } else {
            delete state.onlineStatusMap[identityKey];
            hit.online_tag = '';
            hit.online_query_time = '';
          }
          hit.forbidden_status = forbiddenEnabled ? '禁玩中' : '未禁玩';
          hit.forbidden_query_time = String((forbiddenRes && forbiddenRes.data && forbiddenRes.data.query_time) || '').trim();
        }
      } catch (e) {
        alert(e.message || '状态查询失败');
      } finally {
        state.onlineLoadingMap[identityKey] = false;
        state.forbiddenLoadingMap[identityKey] = false;
        renderOnlinePart(identityKey);
        renderForbiddenPart(identityKey);
        renderMoreOpsSheet();
      }
    }

    function buildOnlineChipHtml(identityKey) {
      const key = String(identityKey || '').trim();
      const mapText = String(state.onlineStatusMap[key] || '').trim();
      const [gid, acc] = key.split('::');
      const hit = findProductItemByIdentity(gid, acc);
      const rowText = String((hit && hit.online_tag) || '').trim();
      const onlineText = mapText || rowText;
      if (!onlineText) return '';
      const onlineClass = onlineText === '在线' ? 'chip-online' : 'chip-offline';
      const queryTime = String((hit && hit.online_query_time) || '').trim();
      const title = queryTime ? ` title="查询时间：${escapeAttr(queryTime)}"` : '';
      return `<span class="chip ${onlineClass}"${title}>${onlineText}</span>`;
    }

    function buildForbiddenChipHtml(identityKey) {
      const key = String(identityKey || '').trim();
      const [gid, acc] = key.split('::');
      const hit = findProductItemByIdentity(gid, acc);
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
      const totalCost = Number(item && item.total_cost_amount || 0);
      if ((!Number.isFinite(p) || p <= 0 || !/^\d{4}-\d{2}-\d{2}$/.test(d)) && (!Number.isFinite(totalCost) || totalCost <= 0)) return '';
      const parts = [];
      if (Number.isFinite(p) && p > 0 && /^\d{4}-\d{2}-\d{2}$/.test(d)) {
        parts.push(`<span class="purchase-brief-line">采购价 ¥${p.toFixed(2)}</span>`);
        parts.push(`<span class="purchase-brief-line">采购日期 ${d}</span>`);
      }
      if (Number.isFinite(totalCost) && totalCost > 0 && (!Number.isFinite(p) || p <= 0 || Math.abs(totalCost - p) >= 0.01)) {
        parts.push(`<span class="purchase-brief-line">总成本 ¥${totalCost.toFixed(2)}</span>`);
      }
      return `
        <div class="purchase-brief">
          ${parts.join('')}
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

    function renderRentCountdownPart(identityKey) {
      const key = String(identityKey || '').trim();
      if (!key) return;
      const card = state.cardNodeMap[key];
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
          const key = productIdentityKey(item);
          if (!key) continue;
          const card = state.cardNodeMap[key];
          if (card && card.querySelector('[data-slot="rent-countdown"]')) active += 1;
          renderRentCountdownPart(key);
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

    function renderOnlinePart(identityKey) {
      const key = String(identityKey || '').trim();
      if (!key) return;
      const card = state.cardNodeMap[key];
      if (!card) {
        renderList();
        return;
      }

      const chipSlot = card.querySelector('[data-slot="online-chip"]');
      if (chipSlot) {
        chipSlot.innerHTML = buildOnlineChipHtml(key);
      }
      const forbiddenSlot = card.querySelector('[data-slot="forbidden-chip"]');
      if (forbiddenSlot) {
        forbiddenSlot.innerHTML = buildForbiddenChipHtml(key);
      }

      const btn = card.querySelector('[data-op="online-query"]');
      if (btn) {
        const querying = Boolean(state.onlineLoadingMap[key] || state.forbiddenLoadingMap[key]);
        btn.disabled = querying;
        btn.textContent = querying ? '查询中...' : '状态查询';
      }
    }

    function renderForbiddenPart(identityKey) {
      const key = String(identityKey || '').trim();
      if (!key) return;
      const card = state.cardNodeMap[key];
      if (!card) return;

      const btn = card.querySelector('[data-op="forbidden-play"]');
      if (btn) {
        const loading = Boolean(state.forbiddenLoadingMap[key]);
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
      const identityKey = productIdentityKey(state.moreOpsSheet);
      const querying = Boolean(state.onlineLoadingMap[identityKey]);
      const handling = Boolean(state.forbiddenLoadingMap[identityKey]);
      const maintenanceLoading = Boolean(state.moreOpsSheet.maintenance_loading);
      const maintenanceEnabled = Boolean(state.moreOpsSheet.maintenance_enabled);
      const prodGuardLoading = Boolean(state.moreOpsSheet.prod_guard_loading);
      const prodGuardEnabled = state.moreOpsSheet.prod_guard_enabled === undefined ? true : Boolean(state.moreOpsSheet.prod_guard_enabled);
      els.moreOpsSheetTitle.textContent = `更多操作 · ${name || '当前账号'}`;
      els.moreOpsForbiddenBtn.disabled = querying || handling || maintenanceLoading || prodGuardLoading;
      if (els.moreOpsProdGuardBtn) {
        els.moreOpsProdGuardBtn.disabled = querying || handling || maintenanceLoading || prodGuardLoading;
        els.moreOpsProdGuardBtn.textContent = prodGuardLoading
          ? '处理中...'
          : (prodGuardEnabled ? '关闭在线风控' : '开启在线风控');
      }
      if (els.moreOpsMaintenanceBtn) {
        els.moreOpsMaintenanceBtn.disabled = querying || handling || maintenanceLoading || prodGuardLoading;
        els.moreOpsMaintenanceBtn.textContent = maintenanceLoading
          ? '处理中...'
          : (maintenanceEnabled ? '结束维护' : '开启维护');
      }
      els.moreOpsPurchaseBtn.disabled = querying || handling || maintenanceLoading || prodGuardLoading;
      if (els.moreOpsCostBtn) {
        els.moreOpsCostBtn.disabled = querying || handling || maintenanceLoading || prodGuardLoading;
      }
      els.moreOpsCloseBtn.disabled = querying || handling || maintenanceLoading || prodGuardLoading;
      els.moreOpsForbiddenBtn.textContent = handling ? '处理中...' : '处理禁玩';
    }

    function closeActionSheets() {
      state.activeActionSheet = '';
      state.moreOpsSheet = { open: false, account: '', game_id: '1', game_name: 'WZRY', role_name: '', maintenance_enabled: false, maintenance_loading: false, prod_guard_enabled: true, prod_guard_loading: false };
      state.forbiddenSheet = {
        open: false,
        account: '',
        game_id: '1',
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
      state.moreOpsSheet = { open: false, account: '', game_id: '1', game_name: 'WZRY', role_name: '', maintenance_enabled: false, maintenance_loading: false, prod_guard_enabled: true, prod_guard_loading: false };
      state.activeActionSheet = 'forbidden';
      renderMoreOpsSheet();
      state.forbiddenSheet = {
        open: true,
        account,
        game_id: String(item && item.game_id || '1').trim() || '1',
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
        game_id: '1',
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
        game_id: '1',
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
        game_id: String(item && item.game_id || '1').trim() || '1',
        game_name: String(item && item.game_name || 'WZRY').trim() || 'WZRY',
        role_name: String(item && (item.role_name || item.game_account) || '').trim(),
        maintenance_enabled: Boolean(item && item.blacklisted && isMaintenanceReason(item.blacklist_reason)),
        maintenance_loading: false,
        prod_guard_enabled: item && item.prod_guard_enabled === undefined ? true : Boolean(item && item.prod_guard_enabled),
        prod_guard_loading: false
      };
      renderForbiddenSheet();
      renderMoreOpsSheet();
    }

    function closeMoreOpsSheet() {
      if (state.activeActionSheet === 'more') state.activeActionSheet = '';
      state.moreOpsSheet = { open: false, account: '', game_id: '1', game_name: 'WZRY', role_name: '', maintenance_enabled: false, maintenance_loading: false, prod_guard_enabled: true, prod_guard_loading: false };
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
      const purchaseDate = String(item && item.purchase_date || '').slice(0, 10);
      state.purchaseSheet = {
        open: true,
        account,
        game_id: String(item && item.game_id || '1').trim() || '1',
        game_name: String(item && item.game_name || 'WZRY').trim() || 'WZRY',
        role_name: String(item && (item.role_name || item.game_account) || '').trim(),
        purchase_price: price,
        purchase_date: /^\d{4}-\d{2}-\d{2}$/.test(purchaseDate) ? purchaseDate : todayDateText(),
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
        game_id: '1',
        game_name: 'WZRY',
        role_name: '',
        purchase_price: '',
        purchase_date: '',
        result_text: '',
        result_type: '',
        loading: false
      };
      renderPurchaseSheet();
    }

    function renderCostSheet() {
      const opened = Boolean(state.costSheet && state.costSheet.open);
      els.costSheet.classList.toggle('hidden', !opened);
      if (!opened) return;

      const titleName = String(state.costSheet.role_name || state.costSheet.account || '').trim() || '当前账号';
      const resultText = String(state.costSheet.result_text || '').trim();
      const resultType = String(state.costSheet.result_type || '').trim();
      const loading = Boolean(state.costSheet.loading);

      els.costSheetTitle.textContent = `新增成本 · ${titleName}`;
      els.costSheetResult.className = `sheet-result ${resultType}`;
      els.costSheetResult.textContent = resultText;
      els.costAmountInput.value = String(state.costSheet.cost_amount || '');
      els.costDateInput.value = String(state.costSheet.cost_date || '');
      els.costDescInput.value = String(state.costSheet.cost_desc || '');
      els.costAmountInput.disabled = loading;
      els.costDateInput.disabled = loading;
      els.costDescInput.disabled = loading;
      if (els.costDetailBtn) els.costDetailBtn.disabled = loading;
      els.costSaveBtn.disabled = loading;
      els.costCancelBtn.disabled = loading;
    }

    function openCostSheet(item) {
      const account = String(item && item.game_account || '').trim();
      if (!account) return;
      state.costSheet = {
        open: true,
        account,
        game_id: String(item && item.game_id || '1').trim() || '1',
        game_name: String(item && item.game_name || 'WZRY').trim() || 'WZRY',
        role_name: String(item && (item.role_name || item.game_account) || '').trim(),
        cost_amount: '',
        cost_date: todayDateText(),
        cost_desc: '',
        result_text: '',
        result_type: '',
        loading: false
      };
      renderCostSheet();
    }
    function closeCostSheet() {
      state.costSheet = {
        open: false,
        account: '',
        game_id: '1',
        game_name: 'WZRY',
        role_name: '',
        cost_amount: '',
        cost_date: '',
        cost_desc: '',
        result_text: '',
        result_type: '',
        loading: false
      };
      renderCostSheet();
    }

    async function submitPurchaseConfig() {
      const account = String((state.purchaseSheet || {}).account || '').trim();
      const gameId = String((state.purchaseSheet || {}).game_id || '1').trim() || '1';
      const gameName = String((state.purchaseSheet || {}).game_name || 'WZRY').trim() || 'WZRY';
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
            game_id: gameId,
            game_name: gameName,
            purchase_price: Number(priceNum.toFixed(2)),
            purchase_date: dateVal
          })
        });
        const savedPrice = Number(out && out.data && out.data.purchase_price || 0);
        const savedDate = String(out && out.data && out.data.purchase_date || '').slice(0, 10);
        const savedTotalCost = Number(out && out.data && out.data.total_cost_amount || 0);
        state.list = (state.list || []).map((x) => {
          if (String(x && x.game_account || '').trim() !== account || String((x && x.game_id) || '1').trim() !== gameId) return x;
          return {
            ...x,
            purchase_price: Number(savedPrice.toFixed(2)),
            purchase_date: savedDate,
            total_cost_amount: Number(savedTotalCost.toFixed(2))
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

    async function submitCostConfig() {
      const account = String((state.costSheet || {}).account || '').trim();
      const gameId = String((state.costSheet || {}).game_id || '1').trim() || '1';
      const gameName = String((state.costSheet || {}).game_name || 'WZRY').trim() || 'WZRY';
      if (!account) return;
      const amountRaw = String(els.costAmountInput.value || '').trim();
      const dateVal = String(els.costDateInput.value || '').trim();
      const descVal = String(els.costDescInput.value || '').trim();
      const amountNum = Number(amountRaw);
      if (!Number.isFinite(amountNum) || amountNum < 0) {
        state.costSheet.result_text = '成本价格不合法';
        state.costSheet.result_type = 'err';
        renderCostSheet();
        return;
      }
      if (!/^\d{4}-\d{2}-\d{2}$/.test(dateVal)) {
        state.costSheet.result_text = '请选择成本日期';
        state.costSheet.result_type = 'err';
        renderCostSheet();
        return;
      }

      state.costSheet.loading = true;
      state.costSheet.result_text = '保存中...';
      state.costSheet.result_type = '';
      renderCostSheet();
      try {
        const out = await request('/api/products/account-cost/create', {
          method: 'POST',
          body: JSON.stringify({
            game_account: account,
            game_id: gameId,
            game_name: gameName,
            cost_amount: Number(amountNum.toFixed(2)),
            cost_date: dateVal,
            cost_type: 'maintenance',
            cost_desc: descVal
          })
        });
        const savedTotalCost = Number(out && out.data && out.data.total_cost_amount || 0);
        state.list = (state.list || []).map((x) => {
          if (String(x && x.game_account || '').trim() !== account || String((x && x.game_id) || '1').trim() !== gameId) return x;
          return {
            ...x,
            total_cost_amount: Number(savedTotalCost.toFixed(2))
          };
        });
        state.costSheet.result_text = '保存成功';
        state.costSheet.result_type = 'ok';
        renderCostSheet();
        showToast('成本记录已保存');
        setTimeout(() => {
          closeCostSheet();
          renderList();
        }, 220);
      } catch (e) {
        state.costSheet.result_text = String(e && e.message ? e.message : '保存失败');
        state.costSheet.result_type = 'err';
        renderCostSheet();
      } finally {
        state.costSheet.loading = false;
        renderCostSheet();
      }
    }

    function openCostDetailFromSheet() {
      const sheet = state.costSheet || {};
      const account = String(sheet.account || '').trim();
      const gameId = String(sheet.game_id || '1').trim() || '1';
      const gameName = String(sheet.game_name || 'WZRY').trim() || 'WZRY';
      if (!account || typeof window.openStatsCostDetailExternal !== 'function') return;
      const item = findProductItemByIdentity(gameId, account) || {};
      closeCostSheet();
      void window.openStatsCostDetailExternal({
        game_account: account,
        game_id: gameId,
        game_name: gameName,
        role_name: String(sheet.role_name || '').trim(),
        display_name: String(sheet.role_name || account).trim(),
        total_cost_amount: Number(item.total_cost_amount || 0),
        purchase_cost_amount: Number(item.purchase_price || 0)
      });
    }

    async function submitForbidden(enabled) {
      const account = String((state.forbiddenSheet || {}).account || '').trim();
      const gameId = String((state.forbiddenSheet || {}).game_id || '1').trim() || '1';
      const gameName = String((state.forbiddenSheet || {}).game_name || 'WZRY').trim() || 'WZRY';
      const identityKey = productIdentityKey({ game_account: account, game_id: gameId });
      if (!account) return;
      state.forbiddenSheet.loading = true;
      state.forbiddenSheet.result_text = '处理中...';
      state.forbiddenSheet.result_type = '';
      renderForbiddenSheet();
      state.forbiddenLoadingMap[identityKey] = true;
      renderForbiddenPart(identityKey);
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
        const hit = findProductItemByIdentity(gameId, account);
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
        state.forbiddenLoadingMap[identityKey] = false;
        renderForbiddenPart(identityKey);
        renderMoreOpsSheet();
      }
    }

    async function queryForbidden() {
      const account = String((state.forbiddenSheet || {}).account || '').trim();
      const gameId = String((state.forbiddenSheet || {}).game_id || '1').trim() || '1';
      const gameName = String((state.forbiddenSheet || {}).game_name || 'WZRY').trim() || 'WZRY';
      const identityKey = productIdentityKey({ game_account: account, game_id: gameId });
      if (!account) return;
      state.forbiddenSheet.query_loading = true;
      state.forbiddenSheet.result_text = '';
      state.forbiddenSheet.result_type = '';
      renderForbiddenSheet();
      state.forbiddenLoadingMap[identityKey] = true;
      renderForbiddenPart(identityKey);
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
        const hit = findProductItemByIdentity(gameId, account);
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
        state.forbiddenLoadingMap[identityKey] = false;
        renderForbiddenPart(identityKey);
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
      if (els.productGameTabs) {
        const games = [
          { k: 'WZRY', t: '王者荣耀', icon: '/assets/game_icons/wzry.webp' },
          { k: '和平精英', t: '和平精英', icon: '/assets/game_icons/hpjy.png' },
          { k: 'CFM', t: 'CFM枪战王者', icon: '/assets/game_icons/cfm.png' }
        ];
        els.productGameTabs.innerHTML = games.map((x) => `
          <button class="stats-game-tab ${String(state.product_game_name || 'WZRY') === x.k ? 'active' : ''}" data-product-game="${x.k}" type="button">
            <span class="game-avatar"><img src="${x.icon}" alt="${x.t}" loading="lazy" decoding="async"></span>
            <span class="stats-game-tab-text">${x.t}</span>
          </button>
        `).join('');
        Array.from(els.productGameTabs.querySelectorAll('[data-product-game]')).forEach((n) => {
          n.addEventListener('click', async () => {
            const k = String(n.getAttribute('data-product-game') || 'WZRY').trim();
            if (k === String(state.product_game_name || 'WZRY')) return;
            state.product_game_name = k;
            state.page = 1;
            await loadList();
            renderList();
          });
        });
      }

      const allActive = state.filter === 'all';
      const restrictedActive = state.filter === 'restricted';
      const rentingActive = state.filter === 'renting';
      const orderCountLabel = orderCountLabelByMode();
      els.filters.innerHTML = `
        <button class="stats-period-btn product-filter-tab ${allActive ? 'active' : ''}" data-filter="all" type="button">全部</button>
        <button class="stats-period-btn product-filter-tab ${restrictedActive ? 'active' : ''}" data-filter="restricted" type="button">限制中</button>
        <button class="stats-period-btn product-filter-tab ${rentingActive ? 'active' : ''}" data-filter="renting" type="button">租赁中</button>
      `;
      els.orderTotal.innerHTML = `
        <span class="order-total-main">${orderCountLabel}：${Number(state.stats.total_paid || 0)}</span>
        <span class="order-total-divider" aria-hidden="true"></span>
        <span class="order-total-summary">商品主档总数：${Number(state.stats.master_total || state.stats.total_all || 0)}</span>
      `;
      Array.from(els.filters.querySelectorAll('.product-filter-tab')).forEach((n) => {
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
          const identityKey = productIdentityKey(item);
          const querying = Boolean(state.onlineLoadingMap[identityKey] || state.forbiddenLoadingMap[identityKey]);
          const forbiddenLoading = Boolean(state.forbiddenLoadingMap[identityKey]);
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
                <span data-slot="online-chip">${buildOnlineChipHtml(identityKey)}</span>
                <span data-slot="forbidden-chip">${buildForbiddenChipHtml(identityKey)}</span>
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
              <button class="btn btn-ghost btn-card-action product-op-btn" data-op="online-query" ${querying ? 'disabled' : ''}>
                状态查询
              </button>
              <button class="btn btn-ghost btn-card-action product-op-btn ${item.blacklisted ? 'product-op-btn-danger' : ''}" data-op="blacklist-toggle">
                ${item.blacklisted ? '移出黑名单' : '加入黑名单'}
              </button>
              <button class="btn btn-ghost btn-card-action product-op-btn" data-op="more-ops" ${(querying || forbiddenLoading) ? 'disabled' : ''}>
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
          state.cardNodeMap[identityKey] = node;
          root.appendChild(node);
        });
      }

      const totalPages = Math.max(1, Math.ceil(state.total / state.pageSize));
      els.pageInfo.textContent = `第 ${state.page} / ${totalPages} 页 · 每页 ${state.pageSize} 条`;
      els.prevPage.disabled = state.page <= 1;
      els.nextPage.disabled = state.page >= totalPages;
      startRentCountdownTicker();
    }
