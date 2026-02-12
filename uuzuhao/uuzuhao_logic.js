async function ensureYoupinPage(browser, youpinUrl) {
    const pages = await browser.pages();
    let youpinPage = pages.find(p => p.url().includes('merchant.youpin898.com'));
    if (!youpinPage) {
        youpinPage = await browser.newPage();
        await youpinPage.goto(youpinUrl, { waitUntil: 'networkidle0' });
    } else {
        await youpinPage.bringToFront();
    }
    return youpinPage;
}

async function collectYoupinData(browser, youpinUrl) {
    const youpinPage = await ensureYoupinPage(browser, youpinUrl);
    const tabs = ['待租', '出租中', '已下架'];
    const data = [];

    for (const tabName of tabs) {
        await youpinPage.evaluate(name => {
            const tabEls = Array.from(document.querySelectorAll('.ant-tabs-tab-btn, .ant-tabs-tab'));
            const target = tabEls.find(el => el.innerText.trim() === name);
            if (target) target.click();
        }, tabName);

        await new Promise(r => setTimeout(r, 2000));

        await youpinPage.evaluate(() => {
            const pageSizeChanger = document.querySelector('.ant-pagination-options-size-changer');
            if (pageSizeChanger) {
                pageSizeChanger.click();
                setTimeout(() => {
                    const options = Array.from(document.querySelectorAll('.ant-select-item-option-content'));
                    const targetOption = options.find(opt => opt.innerText.includes('50') || opt.innerText.includes('20'));
                    if (targetOption) targetOption.click();
                }, 500);
            }
        });
        await new Promise(r => setTimeout(r, 2000));

        const items = await youpinPage.evaluate(currentTab => {
            const rows = Array.from(document.querySelectorAll('.ant-table-tbody .ant-table-row'));
            return rows.map(row => {
                const text = row.innerText;
                const lines = text.split('\t');
                let remark = lines[6] || '';
                if (!remark || remark === '-' || remark.length < 2) remark = lines[3] || '未知备注';

                let status = '未知';
                let reason = '';
                if (currentTab === '待租') status = '上架';
                else if (currentTab === '出租中') status = '租赁中';
                else if (currentTab === '已下架') {
                    status = '下架';
                    if (text.includes('系统下架')) reason = '系统下架';
                    else if (text.includes('商家下架')) reason = '商家下架';
                    else if (text.includes('投诉下架')) reason = '投诉下架';

                    if (lines[5] && lines[5] === '428530661') {
                        // 2026-02-11: 游戏在线，全平台下架
                        // reason = '系统下架';
                    }
                }

                return {
                    id: lines[0],
                    account: lines[5],
                    remark,
                    status,
                    reason
                };
            }).filter(i => i.account && i.account.match(/^\d+$/));
        }, tabName);

        data.push(...items);
    }

    return { page: youpinPage, data };
}

async function youpinOffShelf(page, account) {
    console.log(`>>> 正在下架 悠悠租号: ${account}`);

    await page.evaluate(() => {
        const tabs = Array.from(document.querySelectorAll('.ant-tabs-tab-btn, .ant-tabs-tab'));
        const target = tabs.find(el => el.innerText.trim() === '待租');
        if (target) target.click();
    });
    await new Promise(r => setTimeout(r, 2000));

    const actionResult = await page.evaluate(targetAcc => {
        const rows = Array.from(document.querySelectorAll('.ant-table-row'));
        const targetRow = rows.find(row => row.innerText.includes(targetAcc));
        if (!targetRow) return { success: false, msg: '未找到包含该账号的行 (悠悠)' };

        const btns = Array.from(targetRow.querySelectorAll('a, button, span, div'));
        const btn = btns.find(el => {
            const text = el.innerText ? el.innerText.trim() : '';
            return text === '下架' && el.offsetParent !== null;
        });

        if (btn) {
            btn.scrollIntoView();
            btn.click();
            return { success: true, msg: '已点击悠悠下架按钮' };
        }
        return { success: false, msg: `未找到悠悠下架按钮 (RowText: ${targetRow.innerText.substring(0, 20)}...)` };
    }, account);

    if (!actionResult.success) {
        console.log(`[Fail] ${actionResult.msg}`);
        return false;
    }
    console.log('[Confirm] 等待确认弹窗...');

    let confirmSuccess = false;
    let msg = '';

    for (let i = 0; i < 5; i++) {
        await new Promise(r => setTimeout(r, 1000));

        const confirmResult = await page.evaluate(() => {
            const selectors = [
                '.ant-modal-confirm-btns .ant-btn-primary',
                '.ant-modal-footer .ant-btn-primary',
                '.layui-layer-btn0',
                '.ant-popover-buttons .ant-btn-primary',
                '.ant-popover-inner-content .ant-btn-primary'
            ];

            for (const sel of selectors) {
                const btn = document.querySelector(sel);
                if (btn && btn.offsetParent !== null) {
                    btn.click();
                    return { success: true, msg: `点击了确认按钮 (Selector): ${sel}` };
                }
            }

            const allBtns = Array.from(document.querySelectorAll('button, .ant-btn, span.ant-btn'));
            const targetBtn = allBtns.find(b => {
                const t = b.innerText.trim();
                return (t === '确认' || t === '确定' || t === '确认下架' || t === '是') && b.offsetParent !== null;
            });

            if (targetBtn) {
                targetBtn.click();
                return { success: true, msg: `点击了确认按钮 (Text): ${targetBtn.innerText}` };
            }

            return { success: false, msg: '未找到确认弹窗按钮' };
        });

        if (confirmResult.success) {
            confirmSuccess = true;
            msg = confirmResult.msg;
            break;
        }
        msg = confirmResult.msg;
    }

    if (confirmSuccess) {
        console.log(`[Confirm] ${msg}`);
        return true;
    }

    const pageText = await page.evaluate(() => document.body.innerText.replace(/\s+/g, ' ').substring(0, 2000));
    console.log(`[Fail] ${msg} (尝试 5 次)`);
    console.log(`[Debug] Current Page Content (excerpt): ${pageText}`);
    return false;
}

async function youpinOnShelf(page, account) {
    console.log(`>>> [悠悠] 编辑上架模式: ${account}`);
    await page.evaluate(() => {
        const tabs = Array.from(document.querySelectorAll('.ant-tabs-tab-btn, .ant-tabs-tab'));
        const target = tabs.find(el => el.innerText.trim() === '已下架');
        if (target) target.click();
    });
    await new Promise(r => setTimeout(r, 2000));

    const clickEdit = await page.evaluate(targetAcc => {
        const rows = Array.from(document.querySelectorAll('.ant-table-row, .list-item, tr'));
        const targetRow = rows.find(row => row.innerText.includes(targetAcc));
        if (!targetRow) return { success: false, msg: '未找到包含该账号的行' };
        const btn = Array.from(targetRow.querySelectorAll('a, button, span')).find(el => el.innerText.trim() === '编辑');
        if (btn) {
            btn.click();
            return { success: true, msg: '点击了编辑按钮' };
        }
        return { success: false, msg: '未找到编辑按钮' };
    }, account);

    if (!clickEdit.success) return false;
    console.log('[悠悠] 等待编辑页面加载 (5s)...');
    await new Promise(r => setTimeout(r, 5000));

    const pages = await page.browser().pages();
    let editPage = pages[pages.length - 1];
    if (editPage.url() === page.url()) editPage = page;
    else await editPage.bringToFront();

    const clickSave = await editPage.evaluate(() => {
        const btns = Array.from(document.querySelectorAll('button, .ant-btn'));
        const target = btns.find(b => {
            const t = b.innerText.trim();
            return (t === '保存上架' || t === '确认发布' || t === '提交' || t === '保存并上架') && b.offsetParent !== null;
        });
        if (target) {
            target.click();
            return { success: true };
        }
        return { success: false };
    });

    if (clickSave.success) {
        await new Promise(r => setTimeout(r, 2000));
        await editPage.evaluate(() => {
            const confirmBtn = document.querySelector('.ant-modal-confirm-btns .ant-btn-primary');
            if (confirmBtn) confirmBtn.click();
        });
        if (editPage !== page) await editPage.close();
        return true;
    }
    return false;
}

module.exports = {
    collectYoupinData,
    youpinOffShelf,
    youpinOnShelf
};
