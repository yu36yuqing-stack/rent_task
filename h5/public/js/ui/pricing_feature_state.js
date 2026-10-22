(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  if (root) root.PricingFeatureState = api;
})(typeof window === 'object' ? window : null, function () {
  'use strict';

  function read(value) {
    if (!value || typeof value.enabled !== 'boolean'
      || !['rolling_24h', 'business_day'].includes(value.count_mode)
      || typeof value.reconcile_required !== 'boolean'
      || !Number.isSafeInteger(value.version) || value.version < 0) return null;
    return {
      enabled: value.enabled,
      count_mode: value.count_mode,
      reconcile_required: value.reconcile_required,
      version: value.version
    };
  }

  function merge(current, incoming) {
    const next = read(incoming);
    const previous = read(current);
    if (!next) return { accepted: false, reason: 'unsupported' };
    if (!previous) return { accepted: true, feature: next, changed: false };
    if (next.version < previous.version) return { accepted: false, reason: 'stale' };
    const changed = next.count_mode !== previous.count_mode || next.enabled !== previous.enabled;
    if (next.version === previous.version) {
      if (changed) return { accepted: false, reason: 'conflict' };
      // Only completion can change without a new configuration version.
      if (!previous.reconcile_required && next.reconcile_required) return { accepted: false, reason: 'stale' };
    }
    return { accepted: true, feature: next, changed };
  }

  function confirms(value, intent) {
    const feature = read(value);
    return Boolean(feature && intent && feature.version > intent.expected_version
      && feature.enabled === intent.enabled && feature.count_mode === intent.count_mode);
  }

  function status(feature, options = {}) {
    if (options.failed) return { key: 'failed', text: '保存失败' };
    if (!options.confirmed || options.saving || options.uncertain
      || !feature.enabled || feature.reconcile_required) return { key: 'pending', text: '待生效' };
    return { key: 'effective', text: '已生效' };
  }

  function isRejected(error) {
    const status = Number(error && error.status);
    return status >= 400 && status < 500;
  }

  async function withTimeout(request, path, options = {}, timeoutMs = 15000) {
    const controller = new AbortController();
    let timer;
    const deadline = new Promise((resolve, reject) => {
      timer = setTimeout(() => {
        const error = new Error('设置请求超时');
        error.name = 'TimeoutError';
        reject(error);
        controller.abort();
      }, timeoutMs);
    });
    try {
      return await Promise.race([request(path, { ...options, signal: controller.signal }), deadline]);
    } finally {
      clearTimeout(timer);
    }
  }

  return { read, merge, confirms, status, isRejected, withTimeout };
});
