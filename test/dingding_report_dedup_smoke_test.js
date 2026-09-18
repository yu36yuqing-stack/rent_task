#!/usr/bin/env node
'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'rent-dingding-dedup-'));
process.env.MAIN_DB_FILE_PATH = path.join(tempDir, 'rent_robot.db');
process.env.RUNTIME_DB_FILE_PATH = path.join(tempDir, 'rent_robot_runtime.db');
process.env.ORDER_DB_FILE_PATH = path.join(tempDir, 'rent_robot_order.db');
process.env.STATS_DB_FILE_PATH = path.join(tempDir, 'rent_robot_stats.db');
process.env.PRICE_DB_FILE_PATH = path.join(tempDir, 'rent_robot_price.db');

const runtimeDb = require('../database/runtime_task_db');
const dingNotifyPath = require.resolve('../report/dingding/ding_notify');
const telegramNotifyPath = require.resolve('../report/telegram/tg_notify');

let dingSendCount = 0;
let telegramSendCount = 0;
let failNextDing = false;
const dingMessages = [];
require.cache[dingNotifyPath] = {
    id: dingNotifyPath,
    filename: dingNotifyPath,
    loaded: true,
    exports: {
        sendDingdingMessage: async (message) => {
            dingSendCount += 1;
            if (failNextDing) {
                failNextDing = false;
                throw new Error('stub ding failure');
            }
            dingMessages.push(String(message || ''));
            return true;
        }
    }
};
require.cache[telegramNotifyPath] = {
    id: telegramNotifyPath,
    filename: telegramNotifyPath,
    loaded: true,
    exports: {
        sendTelegramMessage: async () => {
            telegramSendCount += 1;
            return { ok: true, chunks: 1 };
        }
    }
};

const dedupPath = require.resolve('../report/dingding/ding_report_dedup');
const dedup = require(dedupPath);
const { buildDingdingMessage } = require('../report/dingding/ding_style');
delete require.cache[require.resolve('../report/report_rent_status')];
const { notifyUserByPayload } = require('../report/report_rent_status');

function buildPayload(overrides = {}) {
    return {
        ok: true,
        hhmm: '10:00',
        report_owner: 'dedup-owner',
        recentActions: [
            '• 09:58:00 🟢上架 A -> 悠悠 (自动处理)',
            '• 09:59:00 🔴下架 B -> 租号王 (检测到出租)'
        ],
        accounts: [
            {
                account: 'account-b',
                game_id: '2',
                remark: 'B',
                youpin: '上架',
                uhaozu: '上架',
                zuhaowan: '上架',
                today_order_count: 1,
                online_tag: 'OFF'
            },
            {
                account: 'account-a',
                game_id: '1',
                remark: 'A',
                youpin: '下架',
                uhaozu: '下架',
                zuhaowan: '下架',
                today_order_count: 0,
                online_tag: ''
            }
        ],
        master_total: 2,
        sync_anomalies: [
            { platform: 'zuhaowang', expected_count: 2, pulled_count: 1, missing_count: 1, sample_missing_text: 'B' },
            { platform: 'uuzuhao', expected_count: 2, pulled_count: 2, missing_count: 0, sample_missing_text: '' }
        ],
        authorized_platforms: ['zuhaowang', 'uuzuhao', 'uhaozu'],
        allNormal: false,
        ...overrides
    };
}

function buildUser(id, webhook = 'https://oapi.dingtalk.com/robot/send?access_token=group-a') {
    return {
        id,
        account: `user-${id}`,
        notify_config: {
            dingding: { webhook, secret: 'stub-secret' }
        }
    };
}

async function createProductTask(userId, suffix) {
    return await runtimeDb.createRuntimeTask({
        task_id: `product-sync-${userId}-${suffix}`,
        user_id: userId,
        task_type: 'product_sync',
        trigger_source: 'test',
        status: 'running',
        stage: 'probe_and_notify',
        progress_text: '测试通知去重',
        result_json: {},
        desc: 'dingding report dedup smoke'
    });
}

async function finishTask(task, notifyResult, status = 'success') {
    await runtimeDb.markRuntimeTaskFinished(task.task_id, {
        status,
        stage: status === 'success' ? 'done' : 'pipeline_failed',
        result_json: { ok: status === 'success', notify_result: notifyResult }
    });
}

async function main() {
    const payload = buildPayload();
    const reorderedPayload = buildPayload({
        hhmm: '10:05',
        accounts: [...payload.accounts].reverse(),
        recentActions: [...payload.recentActions].reverse(),
        sync_anomalies: [...payload.sync_anomalies].reverse(),
        authorized_platforms: [...payload.authorized_platforms].reverse()
    });
    const firstFingerprint = dedup.buildDingdingReportFingerprint(payload, 'group-a');
    const reorderedFingerprint = dedup.buildDingdingReportFingerprint(reorderedPayload, 'group-a');
    assert.strictEqual(firstFingerprint.content_hash, reorderedFingerprint.content_hash, '仅时间或列表顺序变化不应改变内容指纹');
    assert.strictEqual(firstFingerprint.destination_hash, reorderedFingerprint.destination_hash, '同一群地址应得到相同目标指纹');
    assert.notStrictEqual(
        firstFingerprint.destination_hash,
        dedup.buildDingdingReportFingerprint(payload, 'group-b').destination_hash,
        '群地址变化必须改变目标指纹'
    );
    assert.notStrictEqual(
        firstFingerprint.content_hash,
        dedup.buildDingdingReportFingerprint(buildPayload({
            accounts: payload.accounts.map((row, index) => index === 0 ? { ...row, online_tag: 'ON' } : row)
        }), 'group-a').content_hash,
        '账号状态变化必须改变内容指纹'
    );
    assert.strictEqual(
        dedup.buildDingdingReportFingerprint({
            ...payload,
            dingding_changes: { available: true, accounts: { ignored: { type: 'changed' } } }
        }, 'group-a').content_hash,
        firstFingerprint.content_hash,
        '变化标记不得参与内容指纹'
    );
    assert.deepStrictEqual(dedup.normalizeDingdingReportPayload({}), {
        accounts: [],
        authorized_platforms: [],
        recentActions: [],
        sync_anomalies: []
    }, '空 payload 应安全归一化');
    const authProblemSnapshot = dedup.buildDingdingReportSnapshot(buildPayload({
        accounts: [{
            account: 'auth-problem',
            channel_prd_info: { uuzuhao: { off_type: 'ACCOUNT_ERROR' } }
        }],
        allNormal: true
    }));
    assert.strictEqual(authProblemSnapshot.summary.auth_problems.length, 1, '授权异常应进入通知快照');
    assert.strictEqual(authProblemSnapshot.summary.footer_normal, false, '授权异常时底部状态不应为正常');
    const authProblemMessage = buildDingdingMessage({
        ...buildPayload({
            accounts: [{
                account: 'auth-problem',
                remark: '授权异常账号',
                channel_prd_info: { uuzuhao: { off_type: 'ACCOUNT_ERROR' } }
            }]
        }),
        dingding_changes: {
            available: true,
            summary: {
                auth_problems_changed: true,
                order_count: { before: 3, after: 0 }
            }
        }
    });
    assert.match(authProblemMessage, /🔄 悠悠授权异常/, '授权异常区变化应显示标记');
    assert.match(authProblemMessage, /🔄 📈 今日订单: 3 → 0/, '订单汇总变化应显示前后值');
    const malformedDiff = dedup.diffDingdingReportSnapshots(
        { version: dedup.SNAPSHOT_VERSION, summary: null, accounts: null },
        { version: dedup.SNAPSHOT_VERSION, summary: null, accounts: null }
    );
    assert.strictEqual(malformedDiff.change_count, 0, '不完整快照应安全降级为无变化');

    const userId = 8801;
    const user = buildUser(userId);
    const noCheckpoint = await dedup.findLatestDingdingReportCheckpoint(0);
    assert.strictEqual(noCheckpoint, null, '无效用户不应查询历史指纹');
    assert.deepStrictEqual(
        await dedup.recordDingdingReportCheckpoint(0, firstFingerprint),
        { recorded: false, reason: 'invalid_user' },
        '无效用户不应写入指纹'
    );
    assert.deepStrictEqual(
        await dedup.recordDingdingReportCheckpoint(userId, firstFingerprint),
        { recorded: false, reason: 'active_task_missing' },
        '没有活动任务时应等待最终任务结果持久化指纹'
    );

    const firstTask = await createProductTask(userId, 'first');
    const first = await notifyUserByPayload(user, payload);
    assert.strictEqual(first.ok, true, '首次通知应成功');
    assert.strictEqual(first.channels.dingding.status, 'sent', '首次通知应发送');
    assert.strictEqual(first.channels.dingding.checkpoint_recorded, true, '发送成功后应立即记录指纹');
    assert.strictEqual(dingSendCount, 1, '首次通知应调用一次钉钉');
    const activeAfterSend = await runtimeDb.getRuntimeTaskByTaskId(firstTask.task_id);
    const activeResult = JSON.parse(activeAfterSend.result_json || '{}');
    assert.ok(activeResult.notification_checkpoint.dingding_rent_status.content_hash, '活动任务应保存通知指纹');
    assert.strictEqual(
        activeResult.notification_checkpoint.dingding_rent_status.snapshot.accounts.length,
        2,
        '活动任务应保存精简账号快照'
    );
    assert.ok(!dingMessages[0].includes('🔄'), '首次通知没有可比基线，不应标记变化');
    await finishTask(firstTask, first);

    const secondTask = await createProductTask(userId, 'unchanged');
    const unchanged = await notifyUserByPayload(user, reorderedPayload);
    assert.strictEqual(unchanged.ok, true, '未变化跳过应视为成功');
    assert.strictEqual(unchanged.reason, 'unchanged', '未变化应返回明确原因');
    assert.strictEqual(unchanged.channels.dingding.status, 'skipped_unchanged', '未变化不应发送');
    assert.strictEqual(unchanged.skipped_count, 1, '应统计跳过渠道');
    assert.strictEqual(unchanged.channels.dingding.snapshot_task_id, firstTask.task_id, '跳过任务应引用最近成功快照');
    assert.strictEqual(dingSendCount, 1, '未变化不得再次调用钉钉');
    await finishTask(secondTask, unchanged);

    const changedPayload = buildPayload({
        hhmm: '10:10',
        accounts: payload.accounts.map((row, index) => index === 0 ? { ...row, online_tag: 'ON' } : row)
    });
    const changedTask = await createProductTask(userId, 'changed');
    const changed = await notifyUserByPayload(user, changedPayload);
    assert.strictEqual(changed.ok, true, '内容变化应发送成功');
    assert.strictEqual(changed.channels.dingding.status, 'sent', '内容变化应发送');
    assert.strictEqual(changed.channels.dingding.reason, 'content_changed', '应标记内容变化');
    assert.strictEqual(dingSendCount, 2, '内容变化应新增一次钉钉调用');
    assert.strictEqual(changed.channels.dingding.change_count, 1, '应识别一个变化账号');
    assert.match(
        dingMessages[1],
        /🔄 .+\(ON\) B .+〔在线 OFF→ON〕/,
        '在线状态变化应在账号行标记出具体差异'
    );
    await finishTask(changedTask, changed);

    const stableAfterChangeTask = await createProductTask(userId, 'stable-after-change');
    const stableAfterChange = await notifyUserByPayload(user, {
        ...changedPayload,
        hhmm: '10:11',
        accounts: [...changedPayload.accounts].reverse()
    });
    assert.strictEqual(stableAfterChange.channels.dingding.status, 'skipped_unchanged', '变化标记不应导致下一轮重复发送');
    assert.strictEqual(stableAfterChange.channels.dingding.snapshot_task_id, changedTask.task_id, '新快照生效后应更新引用任务');
    assert.strictEqual(dingSendCount, 2, '变化后内容稳定时不得再次发送');
    await finishTask(stableAfterChangeTask, stableAfterChange);

    const movedUser = buildUser(userId, 'https://oapi.dingtalk.com/robot/send?access_token=group-b');
    const movedTask = await createProductTask(userId, 'moved');
    const moved = await notifyUserByPayload(movedUser, changedPayload);
    assert.strictEqual(moved.ok, true, '更换通知群后应发送成功');
    assert.strictEqual(moved.channels.dingding.status, 'sent', '更换通知群必须发送');
    assert.strictEqual(dingSendCount, 3, '更换通知群应新增一次调用');
    assert.ok(!dingMessages[2].includes('🔄'), '新通知群没有同目标基线，不应标记历史变化');
    await finishTask(movedTask, moved);

    const failedPayload = buildPayload({ hhmm: '10:15', master_total: 3 });
    const failedTask = await createProductTask(userId, 'failed');
    failNextDing = true;
    const failed = await notifyUserByPayload(movedUser, failedPayload);
    assert.strictEqual(failed.ok, false, '钉钉发送失败应使通知失败');
    assert.strictEqual(failed.reason, 'notify_failed', '失败原因应保持兼容');
    assert.strictEqual(failed.channels.dingding.status, 'failed', '渠道结果应记录失败');
    assert.match(failed.errors[0], /stub ding failure/, '应返回钉钉错误');
    await finishTask(failedTask, failed, 'failed');

    const retryTask = await createProductTask(userId, 'retry');
    const retried = await notifyUserByPayload(movedUser, failedPayload);
    assert.strictEqual(retried.ok, true, '失败后的下一轮应重试成功');
    assert.strictEqual(retried.channels.dingding.status, 'sent', '失败不能形成成功指纹');
    assert.strictEqual(dingSendCount, 5, '失败调用和重试调用都应实际发起');
    assert.match(dingMessages[3], /🔄 📦 商品主档总数: 2 → 3个/, '汇总字段变化应显示前后值');
    await finishTask(retryTask, retried);

    const baseSnapshot = dedup.buildDingdingReportSnapshot(payload);
    const expandedPayload = buildPayload({
        master_total: 3,
        recentActions: ['• 新操作'],
        sync_anomalies: [],
        allNormal: true,
        accounts: [
            ...payload.accounts.map((row, index) => index === 0
                ? {
                    ...row,
                    remark: 'B2',
                    today_order_count: 2,
                    online_tag: 'ON',
                    youpin: '下架',
                    suffix: ' 🔸已按测试规则下架',
                    hint: ' -> 处理中'
                }
                : row),
            {
                account: 'account-c',
                game_id: '1',
                remark: 'C',
                youpin: '上架',
                uhaozu: '上架',
                zuhaowan: '上架'
            }
        ]
    });
    const expandedDiff = dedup.diffDingdingReportSnapshots(
        baseSnapshot,
        dedup.buildDingdingReportSnapshot(expandedPayload)
    );
    assert.strictEqual(expandedDiff.available, true, '有新版快照时应支持字段对比');
    assert.strictEqual(expandedDiff.accounts['1::account-c'].type, 'added', '新账号应标记为新增');
    assert.match(expandedDiff.accounts['2::account-b'].detail, /订单 1→2/, '订单数变化应列出前后值');
    assert.match(expandedDiff.accounts['2::account-b'].detail, /在线 OFF→ON/, '在线状态变化应列出前后值');
    assert.match(expandedDiff.accounts['2::account-b'].detail, /悠悠 上→下/, '渠道状态变化应列出前后值');
    assert.match(expandedDiff.accounts['2::account-b'].detail, /提示有变化/, '长提示字段变化应使用精简说明');
    assert.strictEqual(expandedDiff.summary.recent_actions_changed, true, '自动操作变化应标记汇总区');
    assert.strictEqual(expandedDiff.summary.sync_anomalies_changed, true, '同步异常变化应标记汇总区');

    const onlineOffDiff = dedup.diffDingdingReportSnapshots(
        dedup.buildDingdingReportSnapshot(changedPayload),
        baseSnapshot
    );
    assert.match(
        onlineOffDiff.accounts['2::account-b'].detail,
        /在线 ON→OFF/,
        '生产案例中的在线转离线也应准确标记'
    );

    const removedDiff = dedup.diffDingdingReportSnapshots(
        baseSnapshot,
        dedup.buildDingdingReportSnapshot(buildPayload({
            master_total: 1,
            accounts: [payload.accounts[0]]
        }))
    );
    assert.strictEqual(removedDiff.removed_accounts.length, 1, '移除账号应保留旧账号摘要');
    const removedMessage = buildDingdingMessage({
        ...buildPayload({ master_total: 1, accounts: [payload.accounts[0]] }),
        dingding_changes: removedDiff
    });
    assert.match(removedMessage, /➖ 已移出商品主档\n• A（account-a）/, '移除账号应在明细后单独列出');
    assert.strictEqual(
        dedup.diffDingdingReportSnapshots(null, baseSnapshot).available,
        false,
        '历史任务没有快照时不应猜测变化'
    );

    const otherTask = await createProductTask(8802, 'isolated');
    const other = await notifyUserByPayload(buildUser(8802, movedUser.notify_config.dingding.webhook), failedPayload);
    assert.strictEqual(other.channels.dingding.status, 'sent', '不同用户不得共享去重状态');
    assert.strictEqual(dingSendCount, 6, '不同用户应独立发送');
    await finishTask(otherTask, other);

    const telegramOnly = await notifyUserByPayload({
        id: 8803,
        notify_config: { telegram: { bot_token: 'token', chat_id: 'chat', proxy: '' } }
    }, payload);
    assert.strictEqual(telegramOnly.ok, true, '仅 Telegram 配置应保持正常');
    assert.strictEqual(telegramOnly.channels.telegram.status, 'sent', 'Telegram 应发送');
    assert.strictEqual(telegramOnly.channels.dingding.status, 'not_configured', '未配置钉钉应明确标记');
    assert.strictEqual(telegramSendCount, 1, 'Telegram 应调用一次');

    const missingConfig = await notifyUserByPayload({ id: 8804, notify_config: {} }, payload);
    assert.strictEqual(missingConfig.ok, false, '无通知配置应保持原有失败行为');
    assert.strictEqual(missingConfig.reason, 'notify_config_missing', '无配置原因应保持兼容');

    const originalListForMalformed = runtimeDb.listRuntimeTasksByUserAndType;
    runtimeDb.listRuntimeTasksByUserAndType = async () => [{ task_id: 'malformed', result_json: '{bad-json' }];
    delete require.cache[dedupPath];
    const malformedHistoryDedup = require(dedupPath);
    assert.strictEqual(
        await malformedHistoryDedup.findLatestDingdingReportCheckpoint(userId),
        null,
        '损坏的历史 result_json 应被忽略'
    );
    runtimeDb.listRuntimeTasksByUserAndType = originalListForMalformed;

    const originalList = runtimeDb.listRuntimeTasksByUserAndType;
    runtimeDb.listRuntimeTasksByUserAndType = async () => { throw new Error('stub read failure'); };
    delete require.cache[dedupPath];
    const failingDedup = require(dedupPath);
    const failOpen = await failingDedup.buildDingdingReportDeliveryDecision({
        userId,
        payload,
        webhook: movedUser.notify_config.dingding.webhook
    });
    assert.strictEqual(failOpen.should_send, true, '读取指纹失败时必须放行发送');
    assert.strictEqual(failOpen.reason, 'dedup_read_failed', '应标记去重读取失败');
    assert.match(failOpen.dedup_error, /stub read failure/, '应保留读取失败原因');
    runtimeDb.listRuntimeTasksByUserAndType = originalList;

    const originalUpdate = runtimeDb.updateRuntimeTask;
    runtimeDb.updateRuntimeTask = async () => { throw new Error('stub checkpoint write failure'); };
    delete require.cache[dedupPath];
    delete require.cache[require.resolve('../report/report_rent_status')];
    const { notifyUserByPayload: notifyWithCheckpointFailure } = require('../report/report_rent_status');
    const checkpointFailureTask = await createProductTask(8805, 'checkpoint-failure');
    const checkpointFailure = await notifyWithCheckpointFailure(buildUser(8805), payload);
    assert.strictEqual(checkpointFailure.ok, true, '指纹落库失败不应影响已成功发送的通知');
    assert.strictEqual(checkpointFailure.channels.dingding.status, 'sent', '指纹落库失败时渠道仍应标记发送成功');
    assert.match(
        checkpointFailure.channels.dingding.checkpoint_error,
        /stub checkpoint write failure/,
        '应记录指纹落库失败原因'
    );
    await finishTask(checkpointFailureTask, checkpointFailure);
    runtimeDb.updateRuntimeTask = originalUpdate;

    console.log(`[PASS] dingding_report_dedup_smoke_test temp_dir=${tempDir}`);
}

main().catch((error) => {
    console.error(`[FAIL] dingding_report_dedup_smoke_test: ${error.stack || error.message}`);
    process.exit(1);
});
