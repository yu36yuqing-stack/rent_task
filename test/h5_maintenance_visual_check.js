#!/usr/bin/env node
'use strict';

const fs = require('fs');
const path = require('path');
const puppeteer = require('puppeteer-core');

const root = path.resolve(__dirname, '..');
const css = fs.readFileSync(path.join(root, 'h5/public/css/app.css'), 'utf8');
const outputDir = path.join(root, 'coverage/h5-maintenance');
const chromePath = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const viewports = [320, 375, 390, 430, 580, 768];

function fixtureHtml() {
    const detailRows = Array.from({ length: 8 }, (_, index) => `
        <tr>
          <th scope="row">${index === 1 ? 'rent_robot_main.log' : `清理项目 ${index + 1}`}</th>
          <td>${index % 2 === 0 ? '7天' : '30天'}</td>
          <td>删除 ${98406 - index} 条/行</td>
          <td>157.56 MB</td>
          <td>137.79 MB</td>
          <td class="maintenance-result-success">释放 20.59 MB</td>
        </tr>
    `).join('');
    return `<!doctype html>
      <html lang="zh-CN">
      <head><meta name="viewport" content="width=device-width, initial-scale=1"><style>${css}</style></head>
      <body>
        <div class="wrap">
          <section class="hero"><div class="hero-toolbar"><button class="hero-menu-trigger">☰</button><h1 class="hero-menu-title">系统维护 · 数据清理</h1></div></section>
          <section id="maintenanceCleanupView" class="orders-view maintenance-view">
            <div class="maintenance-top-row">
              <div><p class="auth-title">数据清理</p><p class="head-summary-text">当前策略：任务与日志保留7天，黑名单历史和订单原始HTML保留30天，上下架历史保留7天；数据库空闲页达到阈值后压缩。</p></div>
              <button class="btn btn-ghost btn-page-action">立即清理一次</button>
            </div>
            <div class="maintenance-summary-grid">
              <div class="maintenance-kpi-card"><span>最近状态</span><strong class="maintenance-status-success">成功</strong></div>
              <div class="maintenance-kpi-card"><span>清理记录/日志行</span><strong>98406</strong></div>
              <div class="maintenance-kpi-card"><span>估算清理数据</span><strong>41.96 MB</strong></div>
              <div class="maintenance-kpi-card"><span>实际释放空间</span><strong>16.99 MB</strong></div>
              <div class="maintenance-kpi-card maintenance-kpi-wide"><span>最近执行</span><strong>2026-09-20 03:30:14</strong></div>
            </div>
            <div class="maintenance-log-list">
              <div class="panel maintenance-log-card">
                <div class="maintenance-log-head"><div><p class="maintenance-log-title">定时清理 · 成功</p><p class="maintenance-log-time">2026-09-20 03:30:00 → 2026-09-20 03:30:14</p></div><span class="maintenance-status-pill maintenance-status-success">成功</span></div>
                <div class="maintenance-log-meta"><span>耗时：13632 ms</span><span>处理：98406 条/行</span><span>实际释放：16.99 MB</span><span>触发人：-</span></div>
                <div class="maintenance-detail-table-wrap">
                  <table class="maintenance-detail-table"><thead><tr><th>清理项目</th><th>保留策略</th><th>处理数量</th><th>清理前</th><th>清理后</th><th>释放/结果</th></tr></thead><tbody>${detailRows}</tbody></table>
                </div>
              </div>
            </div>
          </section>
        </div>
      </body></html>`;
}

async function main() {
    fs.mkdirSync(outputDir, { recursive: true });
    const browser = await puppeteer.launch({
        executablePath: chromePath,
        headless: true,
        args: ['--no-sandbox', '--disable-setuid-sandbox']
    });
    const results = [];
    try {
        const page = await browser.newPage();
        for (const width of viewports) {
            await page.setViewport({ width, height: 900, deviceScaleFactor: 1 });
            await page.setContent(fixtureHtml(), { waitUntil: 'load' });
            const layout = await page.evaluate(() => {
                const view = document.getElementById('maintenanceCleanupView');
                const topRow = document.querySelector('.maintenance-top-row');
                const summary = document.querySelector('.maintenance-summary-grid');
                const card = document.querySelector('.maintenance-log-card');
                const tableWrap = document.querySelector('.maintenance-detail-table-wrap');
                const firstHeader = document.querySelector('.maintenance-detail-table th');
                const viewRect = view.getBoundingClientRect();
                const cardRect = card.getBoundingClientRect();
                const tableRect = tableWrap.getBoundingClientRect();
                return {
                    viewportWidth: window.innerWidth,
                    documentWidth: document.documentElement.scrollWidth,
                    viewLeft: viewRect.left,
                    viewRight: viewRect.right,
                    cardLeft: cardRect.left,
                    cardRight: cardRect.right,
                    tableLeft: tableRect.left,
                    tableRight: tableRect.right,
                    tableClientWidth: tableWrap.clientWidth,
                    tableScrollWidth: tableWrap.scrollWidth,
                    tableOverflowX: getComputedStyle(tableWrap).overflowX,
                    stickyPosition: getComputedStyle(firstHeader).position,
                    topDirection: getComputedStyle(topRow).flexDirection,
                    summaryColumns: getComputedStyle(summary).gridTemplateColumns.split(' ').filter(Boolean).length
                };
            });
            const expectedColumns = width <= 360 ? 1 : (width <= 640 ? 2 : 4);
            const expectedDirection = width <= 640 ? 'column' : 'row';
            if (layout.documentWidth > layout.viewportWidth
                || layout.viewLeft < 0 || layout.viewRight > layout.viewportWidth
                || layout.cardLeft < layout.viewLeft || layout.cardRight > layout.viewRight + 1
                || layout.tableLeft < layout.cardLeft || layout.tableRight > layout.cardRight + 1
                || layout.tableScrollWidth <= layout.tableClientWidth
                || layout.tableOverflowX !== 'auto'
                || layout.stickyPosition !== 'sticky'
                || layout.topDirection !== expectedDirection
                || layout.summaryColumns !== expectedColumns) {
                throw new Error(`维护页宽度 ${width}px 布局异常: ${JSON.stringify(layout)}`);
            }
            if (width === 390 || width === 768) {
                await page.screenshot({
                    path: path.join(outputDir, `maintenance-${width}.png`),
                    fullPage: true
                });
            }
            results.push(layout);
        }
    } finally {
        await browser.close();
    }
    console.log(JSON.stringify({ ok: true, results, outputDir }));
}

main().catch((error) => {
    console.error('[FAIL] h5_maintenance_visual_check:', error);
    process.exit(1);
});
