(function (root) {
  'use strict';
  const message = 'QQ鉴权失败，请号主前往悠悠租号重新授权。后台在线检测已暂停，授权后点击“状态查询”恢复。';

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

  root.UuzuhaoAuthStatus = Object.freeze({ isRequired, mainLabel, applyState, message });
})(window);
