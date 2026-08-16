#!/usr/bin/env node
'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const root = path.resolve(__dirname, '..');
const productsSource = fs.readFileSync(path.join(root, 'h5/public/js/menu_products.js'), 'utf8');
const appCoreSource = fs.readFileSync(path.join(root, 'h5/public/js/app_core.js'), 'utf8');
const cssSource = fs.readFileSync(path.join(root, 'h5/public/css/app.css'), 'utf8');
const context = vm.createContext({});
vm.runInContext(productsSource, context, { filename: 'menu_products.js' });

const successItem = {
    auth_revoke: {
        status: 'success',
        status_text: '成功',
        finished_at: '2026-08-16 02:00:09'
    }
};
const successHtml = context.buildAuthRevokeStatusHtml(successItem);
const successDetail = context.buildAuthRevokeDetailText(successItem);
assert.ok(successHtml.includes('解除授权'), '卡片标题应展示解除授权');
assert.ok(!successHtml.includes('最近解除'), '卡片不应继续展示最近解除');
assert.ok(successHtml.includes('data-op="auth-revoke-detail"'), '状态标签应支持点击查看详情');
assert.ok(successHtml.includes('成功 · 08-16 02:00'), '卡片应保持紧凑时间展示');
assert.ok(successDetail.includes('完成时间：2026-08-16 02:00:09'), '点击详情应展示完整秒级时间');

const failedDetail = context.buildAuthRevokeDetailText({
    auth_revoke: {
        status: 'failed',
        status_text: '失败待重试',
        last_error: 'code=500, msg=解除授权接口超时',
        modify_date: '2026-08-16 02:05:11'
    }
});
assert.ok(failedDetail.includes('错误：code=500, msg=解除授权接口超时'), '失败详情应展示完整错误');
assert.ok(failedDetail.includes('更新时间：2026-08-16 02:05:11'), '失败详情应展示完整更新时间');

assert.ok(appCoreSource.includes("function showToast(msg, durationMs = 1200, variant = '')"), 'Toast 应支持自定义展示时长和类型');
assert.ok(appCoreSource.includes("node.classList.remove('show');"), 'Toast 关闭时应先原地淡出');
assert.ok(!appCoreSource.includes("node.classList.remove('show', 'toast-detail');"), '居中 Toast 淡出时不应立即跳回底部');
assert.ok(appCoreSource.includes('toastCleanupTimer = setTimeout'), 'Toast 淡出完成后应延迟清理居中定位');
assert.ok(productsSource.includes("showToast(buildAuthRevokeDetailText(item), 3000, 'detail')"), '解除授权详情应使用居中 Toast');
assert.ok(cssSource.includes('white-space: pre-line'), 'Toast 应支持多行展示');
assert.ok(cssSource.includes('max-width: calc(100vw - 32px)'), 'Toast 宽度不应超出手机视口');
assert.ok(cssSource.includes('.toast.toast-detail'), '详情 Toast 应有独立居中样式');

console.log('[PASS] h5_auth_revoke_card_smoke_test');
