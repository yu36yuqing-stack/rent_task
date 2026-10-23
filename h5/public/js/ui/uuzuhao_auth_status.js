(function (root) {
  'use strict';
  const message = 'QQ鉴权失败，请号主前往悠悠租号重新授权。后台在线检测已暂停，授权后点击“状态查询”恢复。';
  const productNotFoundMessage = '悠悠商品不存在，请号主前往悠悠租号检查并恢复商品，必要时重新授权。后台在线检测已暂停，处理后点击“状态查询”恢复。';

  function messageFor(item) {
    return String(item?.uuzuhao_auth_state?.error_code || '').trim() === '12101001'
      ? productNotFoundMessage
      : message;
  }

  function isRequired(item) {
    return Boolean(item && item.uuzuhao_auth_state && item.uuzuhao_auth_state.required === true);
  }

  function mainLabel(item, label, soldView) {
    if (soldView || !isRequired(item)) return label;
    return !label || label === '状态正常'
      ? '需重新授权'
      : label;
  }

  function applyState(item, payload) {
    const next = payload && payload.data && payload.data.uuzuhao_auth_state;
    if (!item || !next || typeof next.required !== 'boolean') return false;
    const currentVersion = Number(item.uuzuhao_auth_state && item.uuzuhao_auth_state.version || 0);
    if (Number(next.version || 0) < currentVersion) return false;
    item.uuzuhao_auth_state = next;
    return true;
  }

  root.UuzuhaoAuthStatus = Object.freeze({ isRequired, mainLabel, applyState, message, messageFor });
})(window);
