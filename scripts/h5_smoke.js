#!/usr/bin/env node
'use strict';

const fs = require('fs');
const path = require('path');
const puppeteer = require('puppeteer-core');

function parseArgs(argv) {
  const out = {
    url: 'http://127.0.0.1:8080/',
    page: 'products',
    account: '',
    password: '',
    headless: true,
    timeout: 12000
  };
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === '--url') out.url = String(argv[i + 1] || out.url), i += 1;
    else if (a === '--page') out.page = String(argv[i + 1] || out.page), i += 1;
    else if (a === '--account') out.account = String(argv[i + 1] || ''), i += 1;
    else if (a === '--password') out.password = String(argv[i + 1] || ''), i += 1;
    else if (a === '--headful') out.headless = false;
    else if (a === '--timeout') out.timeout = Number(argv[i + 1] || out.timeout), i += 1;
  }
  return out;
}

function findChromePath() {
  if (process.env.CHROME_PATH && fs.existsSync(process.env.CHROME_PATH)) return process.env.CHROME_PATH;
  const candidates = [
    '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
    '/Applications/Chromium.app/Contents/MacOS/Chromium',
    '/usr/bin/google-chrome',
    '/usr/bin/chromium-browser',
    '/usr/bin/chromium'
  ];
  return candidates.find((p) => fs.existsSync(p)) || '';
}

async function maybeLogin(page, opts) {
  const loginBtn = await page.$('#btnLogin');
  if (!loginBtn) return;
  if (!opts.account || !opts.password) {
    throw new Error('当前页面需要登录，请传 --account 和 --password');
  }

  await page.type('#account', opts.account, { delay: 10 });
  await page.type('#password', opts.password, { delay: 10 });
  await Promise.all([
    page.click('#btnLogin'),
    page.waitForTimeout(300)
  ]);

  // 登录失败会展示错误文案
  const loginErr = await page.$eval('#loginErr', (n) => (n && n.textContent ? n.textContent.trim() : '')).catch(() => '');
  if (loginErr) {
    throw new Error(`登录失败: ${loginErr}`);
  }

  await page.waitForSelector('#heroAppView:not(.hidden)', { timeout: opts.timeout });
}

async function switchMenu(page, menu, timeout) {
  if (menu === 'products') return;
  await page.click('#menuTrigger');
  await page.waitForSelector('#sideDrawer:not(.hidden)', { timeout });
  const selector = `.drawer-item[data-menu="${menu}"]`;
  await page.click(selector);
  if (menu === 'orders') {
    await page.waitForSelector('#orderView:not(.hidden)', { timeout });
  } else if (menu === 'stats') {
    await page.waitForSelector('#statsView:not(.hidden)', { timeout });
  }
}

async function clickRegressionByPage(page, menu) {
  if (menu === 'products') {
    await page.waitForSelector('#listView', { timeout: 12000 });
    await page.click('#filters .filter-tab:nth-child(1)').catch(() => {});
    await page.click('#filters .filter-tab:nth-child(2)').catch(() => {});
    const hasCard = await page.$('.list-item');
    if (hasCard) {
      await page.click('.list-item [data-op="more-ops"]').catch(() => {});
      await page.click('#moreOpsCloseBtn').catch(() => {});
    }
    return;
  }

  if (menu === 'orders') {
    await page.click('#orderStatusTabs .orders-tab:nth-child(1)').catch(() => {});
    await page.click('#orderQuickFilters .orders-quick-item:nth-child(4)').catch(() => {});
    await page.click('#orderQuickFilters .orders-quick-item:nth-child(1)').catch(() => {});
    return;
  }

  if (menu === 'stats') {
    await page.click('#statsPeriods .stats-period-btn:nth-child(4)').catch(() => {});
    await page.click('#statsPeriods .stats-period-btn:nth-child(1)').catch(() => {});
  }
}

async function main() {
  const opts = parseArgs(process.argv.slice(2));
  const menu = ['products', 'orders', 'stats'].includes(opts.page) ? opts.page : 'products';
  const chromePath = findChromePath();
  if (!chromePath) {
    console.error('未找到 Chrome/Chromium，可通过 CHROME_PATH 指定浏览器可执行文件。');
    process.exit(2);
  }

  const jsErrors = [];
  const reqFailed = [];

  const browser = await puppeteer.launch({
    executablePath: chromePath,
    headless: opts.headless,
    defaultViewport: { width: 1366, height: 900 },
    args: ['--no-sandbox', '--disable-setuid-sandbox']
  });

  try {
    const p = await browser.newPage();
    p.on('pageerror', (e) => jsErrors.push(String(e && e.message ? e.message : e)));
    p.on('requestfailed', (r) => reqFailed.push(`${r.method()} ${r.url()} :: ${r.failure() ? r.failure().errorText : 'failed'}`));

    await p.goto(opts.url, { waitUntil: 'domcontentloaded', timeout: opts.timeout });
    await maybeLogin(p, opts);
    await switchMenu(p, menu, opts.timeout);
    await clickRegressionByPage(p, menu);
    await p.waitForTimeout(500);

    if (jsErrors.length) {
      console.error('检测到前端运行时错误:');
      jsErrors.forEach((x, i) => console.error(`  ${i + 1}. ${x}`));
      process.exit(1);
    }

    console.log(`smoke 通过: page=${menu}`);
    if (reqFailed.length) {
      console.log(`请求失败 ${reqFailed.length} 条(仅提示):`);
      reqFailed.slice(0, 5).forEach((x, i) => console.log(`  ${i + 1}. ${x}`));
    }
  } finally {
    await browser.close();
  }
}

main().catch((e) => {
  console.error(e && e.message ? e.message : e);
  process.exit(1);
});
