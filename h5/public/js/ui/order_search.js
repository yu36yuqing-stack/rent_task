(function (root) {
  'use strict';

  const MAX_KEYWORD_LENGTH = 64;
  const DEFAULT_QUICK_FILTER = 'last24h';
  const emptyStats = () => ({ progress: 0, done: 0, done_zero: 0, today_total: 0, progress_order_amount_sum: 0 });

  function normalizeKeyword(value) {
    const keyword = String(value == null ? '' : value).trim();
    if (Array.from(keyword).length > MAX_KEYWORD_LENGTH) throw new Error('搜索关键词最多64个字符');
    return keyword;
  }

  function create(options) {
    const { getOrders, getIdentity, request, render, onError } = options;
    const nodes = options.nodes || {};
    let owner = String(getIdentity() || '');
    let sequence = 0;
    let composing = false;
    let bound = false;
    const initial = getOrders();
    initial.keyword = String(initial.keyword || '');
    initial.search_draft = String(initial.search_draft || initial.keyword);
    initial.search_error = '';

    function reset() {
      sequence += 1;
      owner = String(getIdentity() || '');
      const o = getOrders();
      if (o.countdown_timer_id) clearInterval(o.countdown_timer_id);
      Object.assign(o, { keyword: '', search_draft: '', search_error: '', loading: false,
        page: 1, total: 0, list: [], stats: emptyStats(), range: null, countdown_timer_id: 0,
        status_filter: 'all', quick_filter: DEFAULT_QUICK_FILTER, game_name: '全部',
        complaint_detail: { open: false }, detail_view: { open: false } });
      composing = false;
      renderForm();
    }

    function synchronizeOwner() {
      const identity = String(getIdentity() || '');
      if (identity !== owner) reset();
      return identity;
    }

    function fingerprint() {
      const o = getOrders();
      return JSON.stringify([o.keyword || '', o.game_name || '全部', o.status_filter || 'all',
        o.quick_filter || DEFAULT_QUICK_FILTER, o.page || 1, o.pageSize || 20]);
    }

    function renderForm() {
      const o = getOrders();
      if (nodes.input && nodes.input.value !== String(o.search_draft || '')) nodes.input.value = String(o.search_draft || '');
      if (nodes.clear) nodes.clear.classList.toggle('hidden', !String(o.search_draft || o.keyword || ''));
      if (nodes.form) nodes.form.setAttribute('aria-busy', o.loading ? 'true' : 'false');
      if (nodes.feedback) {
        nodes.feedback.textContent = o.search_error || '';
        nodes.feedback.classList.toggle('hidden', !o.search_error);
      }
    }

    async function load() {
      const identity = synchronizeOwner();
      if (!identity) return false;
      const o = getOrders();
      const ticket = ++sequence;
      const snapshot = fingerprint();
      const current = () => ticket === sequence && String(getIdentity() || '') === identity && fingerprint() === snapshot;
      o.loading = true;
      o.search_error = '';
      renderForm();
      try {
        const query = new URLSearchParams({ page: String(o.page || 1), page_size: String(o.pageSize || 20),
          status_filter: o.status_filter || 'all', quick_filter: o.quick_filter || DEFAULT_QUICK_FILTER,
          game_name: o.game_name || '全部', keyword: normalizeKeyword(o.keyword) });
        const data = await request(`/api/orders?${query}`, { background: true, is_current: current });
        if (!current()) return false;
        if (data.keyword !== undefined && String(data.keyword) !== (o.keyword || '')) throw new Error('搜索结果与当前条件不一致，请重新搜索');
        Object.assign(o, { total: Number(data.total || 0), list: Array.isArray(data.list) ? data.list : [],
          stats: data.stats || emptyStats(), page: Number(data.page || o.page || 1),
          pageSize: Number(data.page_size || o.pageSize || 20),
          game_name: String(data.game_name || o.game_name || '全部').trim() || '全部', range: data.range || null });
        return true;
      } catch (error) {
        if (!current()) return false;
        const message = error && error.message || '订单查询失败';
        o.search_error = `订单查询失败，已保留上次结果：${message}`;
        onError(message);
        return false;
      } finally {
        // A stale request must not clear the current request's busy state or feedback.
        if (ticket === sequence && String(getIdentity() || '') === identity) {
          o.loading = false;
          renderForm();
        }
      }
    }

    async function submit() {
      synchronizeOwner();
      if (composing) return false;
      const o = getOrders();
      o.search_error = '';
      try {
        o.keyword = normalizeKeyword(o.search_draft);
      } catch (error) {
        o.search_error = error.message;
        renderForm();
        onError(error.message);
        return false;
      }
      o.search_draft = o.keyword;
      o.page = 1;
      const result = await load();
      render();
      return result;
    }

    async function clear() {
      synchronizeOwner();
      const o = getOrders();
      o.keyword = '';
      o.search_draft = '';
      o.page = 1;
      const result = await load();
      render();
      return result;
    }

    function bind() {
      if (bound || !nodes.form || !nodes.input) return;
      bound = true;
      nodes.input.addEventListener('input', () => {
        synchronizeOwner();
        getOrders().search_draft = nodes.input.value;
        renderForm();
      });
      nodes.input.addEventListener('compositionstart', () => { composing = true; });
      nodes.input.addEventListener('compositionend', () => { composing = false; });
      nodes.input.addEventListener('keydown', event => {
        if (event.key === 'Enter' && (event.isComposing || composing || event.keyCode === 229)) event.preventDefault();
      });
      nodes.form.addEventListener('submit', event => { event.preventDefault(); void submit(); });
      if (nodes.clear) nodes.clear.addEventListener('click', () => { void clear(); });
    }

    bind();
    return { load, submit, clear, reset, render: () => { synchronizeOwner(); renderForm(); } };
  }

  const api = { MAX_KEYWORD_LENGTH, DEFAULT_QUICK_FILTER, normalizeKeyword, create };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.OrderSearch = api;
})(typeof window === 'undefined' ? globalThis : window);
