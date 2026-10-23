(function (root) {
  'use strict';
  const message = 'QQ鉴权失败，请号主前往悠悠租号重新授权。后台在线检测已暂停，授权后点击“状态查询”恢复。';
  const productNotFoundMessage = '悠悠商品不存在，请号主前往悠悠租号检查并恢复商品，必要时重新授权。后台在线检测已暂停，处理后点击“状态查询”恢复。';
  const shelfMessages = {
    '12115014': '悠悠上架授权信息与账号密码不符，请号主前往悠悠租号核对账号密码并重新授权。后台在线检测及自动补上架已暂停，渠道商品恢复正常上架或出租后自动解除标记。',
    '12115012': '悠悠上架授权失效，请号主前往悠悠租号重新发布授权。后台在线检测及自动补上架已暂停，渠道商品恢复正常上架或出租后自动解除标记。'
  };

  function messageFor(item) {
    return String(item?.uuzuhao_auth_state?.error_code || '').trim() === '12101001'
      ? productNotFoundMessage
      : shelfMessages[String(item?.uuzuhao_auth_state?.error_code || '').trim()] || message;
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
