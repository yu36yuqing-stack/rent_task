async function ensureUhaozuPage(browser, uhaozuUrl) {
    const pages = await browser.pages();
    let uhaozuPage = pages.find(p => p.url().includes('uhaozu.com/goods/usercenter/list'));
    if (!uhaozuPage) {
        uhaozuPage = await browser.newPage();
        await uhaozuPage.goto(uhaozuUrl, { waitUntil: 'networkidle0' });
    } else {
        await uhaozuPage.bringToFront();
        await uhaozuPage.reload({ waitUntil: 'networkidle0' });
    }
    return uhaozuPage;
}

function bindPageConsole(page) {
    if (page.__uhaozuConsoleBound) return;
    page.on('console', msg => console.log('PAGE LOG:', msg.text()));
    page.__uhaozuConsoleBound = true;
}

async function collectUhaozuData(browser, uhaozuUrl) {
    const page = await ensureUhaozuPage(browser, uhaozuUrl);
    bindPageConsole(page);

    await new Promise(r => setTimeout(r, 1000));

    const data = await page.evaluate(() => {
        const items = [];
        const rows = Array.from(document.querySelectorAll('.rental-account-item-new, .list-item, tr.goods-item'));

        if (rows.length > 0) {
            rows.forEach(row => {
                const text = row.innerText;
                const idMatch = text.match(/商品编号[：:]\s*(\d+)/);
                const accMatch = text.match(/游戏账号[：:]\s*(\d+)/);

                if (!idMatch || !accMatch) return;

                const id = idMatch[1];
                const account = accMatch[1];

                let status = '未知';
                let reason = '';

                if (text.includes('审核未通过')) {
                    status = '审核失败';
                    const failBox = row.querySelector('.fail-txt-box .fail-txt');
                    if (failBox) {
                        reason = failBox.innerText.replace('失败原因：', '').trim();
                    } else {
                        const questionMark = row.querySelector('.wh-icon img');
                        if (questionMark && questionMark.parentElement.getAttribute('title')) {
                            reason = questionMark.parentElement.getAttribute('title');
                        }
                    }
                    if (!reason) reason = '未知原因';
                    console.log(`[Info] 账号 ${account} 审核失败原因: ${reason}`);
                }

                const btns = Array.from(row.querySelectorAll('a, button, span.btn, div.btn'));
                const hasListBtn = btns.some(b => b.innerText && b.innerText.trim() === '上架');
                const hasDelistBtn = btns.some(b => b.innerText && b.innerText.trim() === '下架');

                if (account.includes('2874231439')) {
                    console.log(`[DEBUG_UHAO] Found 呆瑶瑶5300 (2874231439). Full Text: ${text.substring(0, 300)}...`);
                    console.log(`[DEBUG_UHAO] Has ListBtn: ${hasListBtn}, Has DelistBtn: ${hasDelistBtn}`);
                }

                if (status === '审核失败') {
                    // Keep as is.
                } else if (text.includes('租出中') || text.includes('租赁中') || text.includes('出租中')) {
                    status = '租赁中';
                } else if (hasListBtn) {
                    status = '下架';
                } else if (hasDelistBtn) {
                    status = '上架';
                } else {
                    if (text.includes('待租')) status = '上架';
                    else if (text.includes('下架')) status = '下架';
                }

                if (account.includes('陌')) {
                    if (hasListBtn) status = '下架';
                    else if (hasDelistBtn) status = '上架';
                }

                items.push({ id, account, status, reason });
            });
        } else {
            const fullText = document.body.innerText;
            const blocks = fullText.split('商品编号：');
            for (let i = 1; i < blocks.length; i++) {
                const block = blocks[i];
                const id = block.split(/\s+/)[0];
                let status = '未知';
                if (block.includes('租出中') || block.includes('租赁中')) status = '租赁中';
                else if (block.includes('待租')) status = '上架';
                else if (block.includes('下架') && !block.includes('上架')) status = '下架';

                if (block.includes('陌')) {
                    if (block.includes(' 下架 ') || /[\s\n]下架[\s\n]/.test(block)) status = '上架';
                    else if (block.includes(' 上架 ') || /[\s\n]上架[\s\n]/.test(block)) status = '下架';
                    else if (block.includes('下架')) status = '下架';
                }

                const accMatch = block.match(/游戏账号：(\d+)/);
                const account = accMatch ? accMatch[1] : '';
                if (account) items.push({ id, account, status });
            }
        }
        return items;
    });

    return { page, data };
}

async function cleanPopups(page) {
    const count = await page.evaluate(() => {
        let clicked = 0;
        const confirmSelectors = ['.layui-layer-btn0', '.confirm-btn', '.el-button--primary', '.layui-layer-btn .layui-layer-btn0'];
        confirmSelectors.forEach(sel => {
            document.querySelectorAll(sel).forEach(btn => {
                if (btn.offsetParent) {
                    btn.click();
                    clicked++;
                }
            });
        });
        if (clicked === 0) {
            document.querySelectorAll('a, button, span').forEach(el => {
                const t = el.innerText.trim();
                const inDialog = el.closest('.layui-layer') || el.closest('.el-message-box');
                if (el.offsetParent && inDialog && ['确定', '确认', '知道了', '是'].includes(t)) {
                    el.click();
                    clicked++;
                }
            });
        }
        document.querySelectorAll('.layui-layer-close, .el-dialog__headerbtn').forEach(b => {
            if (b.offsetParent) {
                b.click();
                clicked++;
            }
        });
        return clicked;
    });
    if (count > 0) console.log(`[Clean] 清理了 ${count} 个弹窗/确认按钮`);
    return count > 0;
}

async function uhaozuConfirm(page) {
    console.log('[Confirm] 尝试点击 U号租 确认按钮...');
    const result = await page.evaluate(() => {
        const confirmSelectors = ['.layui-layer-btn0', '.confirm-btn', '.el-button--primary'];
        for (const sel of confirmSelectors) {
            const btns = Array.from(document.querySelectorAll(sel));
            const visibleBtn = btns.find(b => b.offsetParent !== null);
            if (visibleBtn) {
                visibleBtn.click();
                return { success: true, msg: `点击了 Selector: ${sel}` };
            }
        }
        const allBtns = Array.from(document.querySelectorAll('a, button, span, div.btn'));
        const target = allBtns.find(el => {
            const t = el.innerText ? el.innerText.trim() : '';
            const isVisible = el.offsetParent !== null;
            if (el.classList.contains('layui-layer-close') || el.classList.contains('close')) return false;
            const inDialog = el.closest('.layui-layer') || el.closest('.el-message-box') || el.closest('.dialog');
            return isVisible && inDialog && ['确定', '确认', '是', 'Yes'].includes(t);
        });

        if (target) {
            target.click();
            return { success: true, msg: `点击了文本按钮: ${target.innerText}` };
        }
        return { success: false, msg: '未找到确认按钮' };
    });

    if (result.success) {
        console.log(`[Confirm] ${result.msg}`);
        return true;
    }
    return false;
}

async function uhaozuOffShelf(page, account) {
    console.log(`>>> 正在下架 U号租: ${account}`);
    await cleanPopups(page);
    await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight));

    const res = await page.evaluate(acc => {
        const xpath = `//*[contains(text(), '${acc}')]`;
        const snapshot = document.evaluate(xpath, document.body, null, XPathResult.ORDERED_NODE_SNAPSHOT_TYPE, null);
        let targetRow = null;
        for (let i = 0; i < snapshot.snapshotLength; i++) {
            let p = snapshot.snapshotItem(i).parentElement;
            for (let k = 0; k < 12; k++) {
                if (!p) break;
                if (p.classList.contains('rental-account-item-new') || p.classList.contains('list-item')) {
                    targetRow = p;
                    break;
                }
                p = p.parentElement;
            }
            if (targetRow) break;
        }

        if (targetRow) {
            const btn = targetRow.querySelector('.off-shelves-btn') ||
                Array.from(targetRow.querySelectorAll('*')).find(e => e.innerText && e.innerText.trim() === '下架');
            if (btn) {
                btn.click();
                return { success: true, msg: '点击了下架按钮' };
            }
        }
        return { success: false, msg: '未找到对应账号行或下架按钮' };
    }, account);

    if (res.success) {
        console.log(`[Click] ${res.msg}`);
        await new Promise(r => setTimeout(r, 1500));
        let confirmed = await uhaozuConfirm(page);
        if (!confirmed) {
            await new Promise(r => setTimeout(r, 1000));
            confirmed = await uhaozuConfirm(page);
        }
        if (confirmed) await new Promise(r => setTimeout(r, 3000));
        return true;
    }
    console.log(`[Fail] ${res.msg}`);
    return false;
}

async function uhaozuOnShelf(page, account) {
    console.log(`>>> 正在上架 U号租: ${account}`);
    await cleanPopups(page);
    const clickResult = await page.evaluate(targetAcc => {
        const rows = Array.from(document.querySelectorAll('.rental-account-item-new, .list-item, tr, .goods-item'));
        const targetRow = rows.find(row => row.innerText.includes(targetAcc));
        if (!targetRow) return { success: false, msg: '未找到包含该账号的行' };
        let btn = targetRow.querySelector('.shelves-btn');
        if (!btn) {
            const candidates = Array.from(targetRow.querySelectorAll('a, button, span'));
            btn = candidates.find(el => el.innerText.trim() === '上架');
        }
        if (btn) {
            btn.click();
            return { success: true, msg: '已点击上架按钮' };
        }
        return { success: false, msg: '行内未找到上架按钮' };
    }, account);

    console.log(`[Action] ${clickResult.msg}`);
    if (!clickResult.success) return false;
    await new Promise(r => setTimeout(r, 2000));

    const confirmResult = await page.evaluate(() => {
        const confirmBtns = Array.from(document.querySelectorAll('.confirm-btn'));
        const visibleBtns = confirmBtns.filter(btn => btn.offsetParent !== null);
        if (visibleBtns.length > 0) {
            visibleBtns[visibleBtns.length - 1].click();
            return { success: true, msg: '点击了 .confirm-btn' };
        }
        const layuiBtns = Array.from(document.querySelectorAll('.layui-layer-btn0'));
        if (layuiBtns.length > 0) {
            layuiBtns[layuiBtns.length - 1].click();
            return { success: true, msg: '点击了 layui-layer-btn0' };
        }
        return { success: false, msg: '未找到可见的确认按钮' };
    });
    console.log(`[Result] ${confirmResult.msg}`);
    return confirmResult.success;
}

module.exports = {
    collectUhaozuData,
    uhaozuOffShelf,
    uhaozuOnShelf
};
