#!/usr/bin/env node
'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const root = path.resolve(__dirname, '..');
const sourcePath = path.join(root, 'h5/public/js/menu_maintenance.js');
const source = fs.readFileSync(sourcePath, 'utf8');
const css = fs.readFileSync(path.join(root, 'h5/public/css/app.css'), 'utf8');
const context = vm.createContext({
    els: { maintenanceCleanupRunBtn: null },
    window: {}
});
vm.runInContext(source, context, { filename: sourcePath });

const detailResult = {
    runtime_task: {
        retention_days: 7,
        deleted_rows: 12,
        before_bytes: 4096,
        after_bytes: 2048,
        estimated_deleted_bytes: 2048,
        freed_bytes: 0
    },
    user_blacklist_history: {
        retention_days: 30,
        deleted_rows: 0,
        before_bytes: 1024,
        after_bytes: 1024,
        estimated_deleted_bytes: 0,
        freed_bytes: 0
    },
    product_onoff_history: {
        retention_days: 7,
        deleted_rows: 3,
        before_bytes: 2048,
        after_bytes: 1024,
        estimated_deleted_bytes: 1024,
        freed_bytes: 0
    },
    order_detail_html: {
        retention_days: 30,
        cleared_rows: 8,
        before_bytes: 8192,
        after_bytes: 1024,
        estimated_deleted_bytes: 7168,
        freed_bytes: 0
    },
    application_logs: {
        retention_days: 7,
        files: [{
            file_name: 'worker<script>.log',
            retention_days: 7,
            removed_lines: 20,
            before_bytes: 4096,
            after_bytes: 1024,
            freed_bytes: 3072
        }]
    },
    database_compaction: [
        {
            database_name: 'main',
            status: 'compacted',
            before: { file_bytes: 10000 },
            after: { file_bytes: 7000 },
            freed_bytes: 3000
        },
        {
            database_name: 'order',
            status: 'skipped',
            reason: 'below_threshold',
            before: { file_bytes: 8000 },
            after: { file_bytes: 8000 },
            freed_bytes: 0
        },
        {
            database_name: 'runtime',
            status: 'skipped',
            reason: 'database_busy',
            before: { file_bytes: 6000 },
            after: { file_bytes: 6000 },
            freed_bytes: 0
        }
    ]
};
const row = {
    trigger_type: 'scheduled',
    status: 'success',
    started_at: '2026-09-20 03:30:00',
    finished_at: '2026-09-20 03:30:14',
    duration_ms: 14000,
    deleted_rows: 43,
    freed_bytes: 6072,
    result: detailResult
};

const rows = context.buildMaintenanceDetailRows(row);
assert.strictEqual(rows.length, 8, '四类数据、一个日志文件和三个数据库应各占一行');
assert.strictEqual(rows[0].label, '运行任务');
assert.strictEqual(rows[0].processed, '删除 12 条');
assert.strictEqual(rows[1].result, '无可清理数据');
assert.strictEqual(rows[3].processed, '清空 8 条');
assert.strictEqual(rows[4].result, '释放 3.00 KB');
assert.strictEqual(rows[5].result_class, 'success');
assert.strictEqual(rows[6].result, '未达到压缩阈值');
assert.strictEqual(rows[7].result, '数据库忙，已跳过');

const html = context.renderMaintenanceTargets(row);
assert.ok(html.includes('<table class="maintenance-detail-table">'));
assert.ok(html.includes('<th scope="col">清理项目</th>'));
assert.ok(html.includes('worker&lt;script&gt;.log'), '日志文件名必须转义');
assert.ok(!html.includes('maintenance-log-grid'), '不应继续使用散列文本布局');

const legacyRows = context.buildMaintenanceDetailRows({
    retention_days: 7,
    deleted_rows: 5,
    before_bytes: 2000,
    after_bytes: 1500,
    freed_bytes: 500,
    result_json: '{}'
});
assert.strictEqual(legacyRows.length, 1, '旧记录缺少明细时应生成汇总行');
assert.strictEqual(legacyRows[0].label, '清理汇总');
assert.strictEqual(legacyRows[0].result, '释放 500 B');

context.state = {
    maintenanceCleanup: {
        loading: false,
        running: false,
        error: '',
        dashboard: { latest: row, logs: [row] }
    }
};
context.els = {
    maintenanceCleanupView: {},
    maintenanceCleanupRunBtn: { disabled: false, textContent: '' },
    maintenanceCleanupSummary: { innerHTML: '' },
    maintenanceCleanupList: { innerHTML: '' }
};
context.renderMaintenanceCleanup();
assert.ok(context.els.maintenanceCleanupList.innerHTML.includes('maintenance-log-meta'));
assert.ok(context.els.maintenanceCleanupList.innerHTML.includes('maintenance-detail-table'));
assert.ok(context.els.maintenanceCleanupSummary.innerHTML.includes('实际释放空间'));

assert.ok(css.includes('overflow-x: auto'), '移动端表格容器应支持横向滚动');
assert.ok(css.includes('position: sticky'), '表格首列应固定');
assert.ok(css.includes('min-width: 660px'), '窄屏表格应保持稳定列宽');

async function runAsyncStateChecks() {
    const requests = [];
    const toasts = [];
    context.request = async (url, options = {}) => {
        requests.push({ url, options });
        if (String(options.method || '') === 'POST') return { ok: true };
        return { dashboard: { latest: row, logs: [row] } };
    };
    context.showToast = (message) => toasts.push(message);

    context.state.maintenanceCleanup = { loading: false, running: false, error: '', dashboard: null };
    await context.loadMaintenanceCleanup();
    assert.strictEqual(context.state.maintenanceCleanup.loading, false);
    assert.strictEqual(context.state.maintenanceCleanup.dashboard.latest.status, 'success');

    await context.runMaintenanceCleanupNow();
    assert.strictEqual(context.state.maintenanceCleanup.running, false);
    assert.strictEqual(requests.filter((item) => item.options.method === 'POST').length, 1);
    assert.ok(requests.some((item) => item.url.includes('limit=20')));
    assert.deepStrictEqual(toasts, ['数据清理完成']);

    context.state.maintenanceCleanup = { loading: true, running: false, error: '', dashboard: null };
    context.renderMaintenanceCleanup();
    assert.ok(context.els.maintenanceCleanupSummary.innerHTML.includes('数据清理记录加载中'));
    assert.ok(context.els.maintenanceCleanupList.innerHTML.includes('清理历史加载中'));

    context.state.maintenanceCleanup = { loading: false, running: false, error: '', dashboard: { logs: [] } };
    context.renderMaintenanceCleanup();
    assert.ok(context.els.maintenanceCleanupList.innerHTML.includes('暂无清理记录'));
}

runAsyncStateChecks()
    .then(() => console.log('[PASS] h5_maintenance_table_smoke_test'))
    .catch((error) => {
        console.error(error);
        process.exitCode = 1;
    });
