# PRD_BLACKLIST

## 1. 背景与问题

当前黑名单存在多入口直接写 `user_blacklist` 的情况（`order_3_off`、`order_cooldown`、`guard`、手工操作），导致：

- reason 覆盖顺序不透明，优先级不一致。
- 出黑名单逻辑分散，出现“谁也不释放”的悬挂状态。
- 线上排查依赖人工串日志，缺少统一可观测口径。

## 2. 目标

- 引入统一来源状态模型，明确各来源职责。
- 黑名单最终进出统一收敛到单一出口。
- 一次部署完成代码，次日仅调开关完成切换。
- 不停写发布，阶段1即启用每5分钟巡检与告警。

## 3. 方案总览

### 3.1 新表 `user_blacklist_source`

记录“账号在各来源下是否命中黑名单”。

- 唯一约束：`(user_id, game_account, source, is_deleted)`
- 关键字段：
  - `user_id`
  - `game_account`
  - `source`（如 `order_cooldown` / `order_n_off` / `guard_online` / `guard_forbidden` / `manual_maintenance` / `manual_block` / `legacy_carryover`）
  - `active`（0/1）
  - `reason`
  - `priority`
  - `detail`（JSON）
  - `expire_at`
  - 公共字段：`id/create_date/modify_date/is_deleted/desc`

### 3.2 两类收敛职责

- `reconcile(source)`：来源级收敛
  - 只更新 `user_blacklist_source` 当前来源状态。
  - 不直接写 `user_blacklist`。

- `reconcileBlacklist(userId, gameAccount)`：全局级收敛
  - 汇总该账号所有 `active=1` 来源。
  - 按优先级裁决最终 reason。
  - 统一执行进/出黑名单（写/删 `user_blacklist`）。

### 3.3 单开关切换

`BL_V2_MODE`：

- `1`：双写 + 读旧（shadow）
- `2`：双写 + 读新（灰度）
- `3`：单写新 + 读新（正式）

建议保留 `0` 作为应急：单写旧 + 读旧。

## 4. 黑名单优先级

高 -> 低：

1. `manual_recover`（账号找回）
2. `manual_maintenance`（维护中）
3. `manual_block`（人工下架）
4. `guard_forbidden`（禁玩中）
5. `guard_online`（检测在线）
6. `order_cooldown`（冷却期下架）
7. `order_n_off`（N单下架）
8. `legacy_carryover`（历史兜底，默认高于自动规则，低于人工）

## 5. 来源重置时机

- `order_cooldown`：`now >= cooldown_until` 或订单退款。
- `order_n_off`：统计不再命中阈值（受恢复阻断时段影响）。
- `guard_online`：离线且无活跃订单/无租赁信号。
- `guard_forbidden`：禁玩状态关闭。
- `manual_maintenance`：手工结束维护。
- `manual_block/manual_recover`：手工移除。

任何来源状态变化后必须触发 `reconcileBlacklist`。

## 6. 发布与切换

### 6.1 一次部署（当天）

发布包含：

- 新表 + DAO
- `reconcileBlacklist`
- `BL_V2_MODE` 分支
- 巡检器（5分钟）+ 钉钉告警

默认开关：`BL_V2_MODE=1`。

### 6.2 次日切换（无需再发布）

- 11:00 切 `BL_V2_MODE=2` 观察。
- 稳定后切 `BL_V2_MODE=3`。

## 7. 巡检与告警

### 7.1 巡检职责

每5分钟对比：

- 旧视图：`user_blacklist`
- 新推理：`user_blacklist_source` + 优先级裁决

对比项：

- 账号集合差异
- 同账号 reason 差异

### 7.2 异步与锁

- 巡检在独立异步定时器运行，不阻塞主流程。
- 使用 `lock_db` 分布式锁（如 `blacklist_inspector_worker`）。
- 必须 `try/finally` 解锁。

### 7.3 告警策略

- 有异常：按 user 发各自钉钉群，30分钟同指纹去重。
- 无异常：打印一条总体一致日志（全局汇总）。

通知规范：

- 模板在 `report/dingding/ding_style.js`
- 发送在 `report/dingding/ding_notify.js`

## 8. 历史兼容

- 上线后后台幂等回填 `user_blacklist -> user_blacklist_source`。
- 无法准确反推来源写 `legacy_carryover`。
- 在 `BL_V2_MODE=1` 期间靠巡检暴露差异并修正映射。

## 9. 验收标准

- 阶段1：巡检稳定运行，异常可告警，无异常有汇总日志。
- 阶段2：切到 `BL_V2_MODE=2/3` 后黑名单进出与预期一致。
- 回归 case：N单 -> guard 命中 -> 订单结束后可统一释放，不再出现悬挂。
