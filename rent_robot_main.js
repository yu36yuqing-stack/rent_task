const puppeteer = require('puppeteer-core');
const fs = require('fs');
const path = require('path');
const util = require('util');
const { getGoodsList: getZhwList, changeStatus: changeZhwStatus } = require('./zuhaowang/zuhaowang_api.js');
const { collectUhaozuData, uhaozuOffShelf, uhaozuOnShelf } = require('./uhaozu/uhaozu_api.js');
const { collectYoupinData, youpinOffShelf, youpinOnShelf } = require('./uuzuhao/uuzuhao_api.js');
const { detectConflictsAndBuildSnapshot, executeActions } = require('./action_engine/action_engine.js');
const { reportAndNotify, sendTelegram } = require('./report/report_rent_status.js');
const { ensureBlacklistSyncedFromFile, getActiveBlacklist } = require('./database/blacklist_db.js');

const TASK_DIR = __dirname;
if (!fs.existsSync(TASK_DIR)) fs.mkdirSync(TASK_DIR, { recursive: true });
const LOG_DIR = path.join(TASK_DIR, 'log');
if (!fs.existsSync(LOG_DIR)) fs.mkdirSync(LOG_DIR, { recursive: true });
const MAIN_LOG_FILE = path.join(LOG_DIR, 'rent_robot_main.log');

function setupMainLogger() {
    const original = {
        log: console.log.bind(console),
        info: console.info.bind(console),
        warn: console.warn.bind(console),
        error: console.error.bind(console)
    };

    const writeLine = (level, args) => {
        const msg = util.format(...args);
        try {
            fs.appendFileSync(MAIN_LOG_FILE, `[${new Date().toISOString()}] [${level}] ${msg}\n`);
        } catch (e) {
            original.error('[Logger] 写日志失败:', e.message);
        }
    };

    console.log = (...args) => { writeLine('LOG', args); original.log(...args); };
    console.info = (...args) => { writeLine('INFO', args); original.info(...args); };
    console.warn = (...args) => { writeLine('WARN', args); original.warn(...args); };
    console.error = (...args) => { writeLine('ERROR', args); original.error(...args); };
}

setupMainLogger();
console.log(`[Boot] rent_robot_main.js 启动 pid=${process.pid} args=${process.argv.slice(2).join(' ') || '(none)'}`);

process.on('unhandledRejection', reason => {
    console.error('[UnhandledRejection]', reason);
});

process.on('uncaughtException', err => {
    console.error('[UncaughtException]', err);
});

const args = process.argv.slice(2);

const LOCK_FILE = path.join(TASK_DIR, 'rent_robot.lock');
const MAX_LOCK_AGE_MS = 10 * 60 * 1000;

const BROWSER_PORT = 9222;
const BROWSER_URL = `http://127.0.0.1:${BROWSER_PORT}`;
const YOUPIN_URL = 'https://merchant.youpin898.com/commodity';
const UHAOZU_URL = 'https://www.uhaozu.com/goods/usercenter/list';

function checkLock() {
    console.log(`[Lock] 检查锁文件: ${LOCK_FILE}`);
    if (fs.existsSync(LOCK_FILE)) {
        const stats = fs.statSync(LOCK_FILE);
        const age = Date.now() - stats.mtimeMs;
        if (age < MAX_LOCK_AGE_MS) {
            console.log(`[Skip] 任务锁定中 (持续 ${Math.round(age/1000)}s)，跳过本次执行。`);
            console.log('ALERT_OVERLAP');
            return false;
        } else {
            console.log('[Info] 锁文件超时，强制覆盖。');
        }
    }
    fs.writeFileSync(LOCK_FILE, process.pid.toString());
    console.log('[Lock] 已创建执行锁');
    return true;
}

function releaseLock() {
    if (fs.existsSync(LOCK_FILE)) {
        fs.unlinkSync(LOCK_FILE);
        console.log('[Lock] 已释放执行锁');
    }
}

async function ensureBrowser() {
    try {
        const browser = await puppeteer.connect({ browserURL: BROWSER_URL, defaultViewport: null });
        const pages = await browser.pages();
        const urls = pages.map(p => p.url());
        let needRefresh = false;
        if (!urls.some(u => u.includes('uhaozu.com'))) {
            const p = await browser.newPage();
            await p.goto(UHAOZU_URL, { waitUntil: 'domcontentloaded' });
            needRefresh = true;
        }
        if (!urls.some(u => u.includes('youpin898.com'))) {
            const p = await browser.newPage();
            await p.goto(YOUPIN_URL, { waitUntil: 'domcontentloaded' });
            needRefresh = true;
        }
        if(needRefresh) await new Promise(r => setTimeout(r, 3000));
        return browser;
    } catch (err) {
        console.log('[Alert] 浏览器异常，尝试重启...');
        const CHROME_CMD = `/Applications/Google\\ Chrome.app/Contents/MacOS/Google\\ Chrome --remote-debugging-port=${BROWSER_PORT} --user-data-dir="$HOME/Library/Application Support/Google/Chrome/OpenClawRobot" --no-first-run --no-default-browser-check "${UHAOZU_URL}" "${YOUPIN_URL}"`;
        require('child_process').exec(CHROME_CMD);
        await new Promise(r => setTimeout(r, 5000));
        return await puppeteer.connect({ browserURL: BROWSER_URL, defaultViewport: null });
    }
}

const STATUS_FILE = path.join(TASK_DIR, 'rent_robot_status.json');
const HISTORY_FILE = path.join(TASK_DIR, 'rent_robot_history.jsonl');
const BLACKLIST_FILE = path.join(TASK_DIR, 'config', 'blacklist.json');

async function loadBlacklistAccountsFromDb() {
    try {
        await ensureBlacklistSyncedFromFile(BLACKLIST_FILE, {
            source: 'rent_robot_main_boot',
            operator: 'system',
            desc: 'auto sync from file before run'
        });
        const blacklist = await getActiveBlacklist();
        const accounts = blacklist
            .filter(entry => entry && entry.account)
            .filter(entry => String(entry.action || 'off').toLowerCase() !== 'on')
            .map(entry => String(entry.account).trim());

        console.log(`[Blacklist] DB加载完成，条目=${accounts.length}`);
        return new Set(accounts);
    } catch (e) {
        console.warn(`[Blacklist] DB读取失败，回退文件读取。err=${e.message}`);
    }

    try {
        const blacklistData = fs.readFileSync(BLACKLIST_FILE, 'utf8');
        const blacklist = JSON.parse(blacklistData);
        if (!Array.isArray(blacklist)) return new Set();
        const accounts = blacklist
            .filter(entry => entry && entry.account)
            .filter(entry => String(entry.action || 'off').toLowerCase() !== 'on')
            .map(entry => String(entry.account).trim());
        console.log(`[Blacklist] 文件回退加载完成，条目=${accounts.length} 文件=${BLACKLIST_FILE}`);
        return new Set(accounts);
    } catch (e) {
        console.warn(`[Blacklist] 文件回退读取失败，忽略黑名单。file=${BLACKLIST_FILE}, err=${e.message}`);
        return new Set();
    }
}

(async () => {
    if (!checkLock()) {
        console.log('[Exit] 锁存在，结束本次执行');
        return;
    }
    let browser;
    
    // 记录本次执行情况
    const runRecord = {
        timestamp: Date.now(),
        actions: [],
        errors: [],
        status: 'success'
    };

    try {
        console.log('[Step] 开始连接浏览器');
        browser = await ensureBrowser();
        console.log('[Step] 浏览器连接成功');

        // ----------------------
        // 1. 抓取悠悠租号 (已封装)
        // ----------------------
        console.log('[Step] 开始抓取 悠悠租号');
        const youpinResult = await collectYoupinData(browser, YOUPIN_URL);
        const youpinPage = youpinResult.page;
        const youpinData = youpinResult.data;
        console.log(`[Step] 悠悠租号抓取完成，记录数=${youpinData.length}`);

        // ----------------------
        // 2. 抓取 U号租 (已封装)
        // ----------------------
        console.log('[Step] 开始抓取 U号租');
        const uhaozuResult = await collectUhaozuData(browser, UHAOZU_URL);
        const uhaozuPage = uhaozuResult.page;
        const uhaozuData = uhaozuResult.data;
        console.log(`[Step] U号租抓取完成，记录数=${uhaozuData.length}`);

        // ----------------------
        // 3. 抓取 租号王 (API)
        // ----------------------
        let zhwData = [];
        console.log('[Step] 开始抓取 租号王 API');
        try {
            zhwData = await getZhwList();
            console.log(`[Step] 租号王抓取完成，记录数=${zhwData.length}`);
        } catch (e) {
            console.error(`[Zuhaowang] API Fetch Error: ${e.message}`);
            runRecord.errors.push(`租号王API失败: ${e.message}`);
        }

        // ----------------------
        // 4. 三方冲突检测 & 构建快照
        // ----------------------
        let snapshot;
        let actions = [];
        const blacklistAccounts = await loadBlacklistAccountsFromDb();
        ({ snapshot, actions } = detectConflictsAndBuildSnapshot({
            youpinData,
            uhaozuData,
            zhwData,
            blacklistAccounts
        }));

        // ----------------------
        // 5. 执行操作
        // ----------------------
        await executeActions({
            actions,
            runRecord,
            youpinPage,
            uhaozuPage,
            youpinOffShelf,
            youpinOnShelf,
            uhaozuOffShelf,
            uhaozuOnShelf,
            changeZhwStatus
        });

        // ----------------------
        // 6. 写入状态 & 报告
        // ----------------------
        fs.writeFileSync(STATUS_FILE, JSON.stringify(snapshot, null, 2));
        console.log(`[Step] 状态快照已写入: ${STATUS_FILE} accounts=${snapshot.accounts.length}`);

        if (actions.length === 0) {
            console.log('✅ 所有状态正常 (三方一致或无冲突)');
        }

        console.log('[Step] 开始生成并发送状态通知');
        const reportResult = await reportAndNotify();
        console.log(`[Step] 通知已发送 ok=${reportResult.ok} normal=${reportResult.allNormal}`);

    } catch (e) {
        console.error('[Error]', e);
        runRecord.status = 'error';
        runRecord.errors.push(e.message);
        try {
            const errText = `⚠️ 租号任务执行异常\n时间: ${new Date().toLocaleString('zh-CN')}\n错误: ${e.message}`;
            await sendTelegram(errText, '');
            console.log('[Step] 异常通知已发送');
        } catch (notifyErr) {
            console.error('[Error] 异常通知发送失败:', notifyErr.message);
        }
    } finally {
        try {
            const line = JSON.stringify(runRecord);
            fs.appendFileSync(HISTORY_FILE, line + '\n');
            console.log(`[Step] 运行历史已追加: ${HISTORY_FILE} status=${runRecord.status} actions=${runRecord.actions.length} errors=${runRecord.errors.length}`);
        } catch (err) {
            console.error('History write fail', err);
        }

        if(browser) {
            await browser.disconnect();
            console.log('[Step] 浏览器连接已断开');
        }
        releaseLock();
        console.log('[Exit] 本次执行结束');
    }
})();

// ==========================================
// 辅助函数
// ==========================================
