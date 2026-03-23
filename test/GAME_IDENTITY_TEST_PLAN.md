# Game Identity 测试文档

本轮测试针对本地未提交改动中最核心的行为变化：

- 身份主键从纯 `game_account` 升级为 `game_id + game_account`
- 数据库迁移需要为历史表补充 `game_id/game_name`
- 同账号跨游戏时，限挂、上下架历史、备注、最近动作聚合不能串数据
- `stats/order_stats.js` 的“全部看板按纯账号聚合”属于保留行为，需要人工回归确认

## 执行方式

自动化用例：

```bash
cd /Users/rs/Downloads/Code/rent_task
npm run test:game-identity
npm run test:identity-regression
```

说明：

- `test:game-identity`
  - 使用临时 SQLite 库，不污染当前本地 `database/*.db`
  - 覆盖迁移、身份隔离、备注映射、最近动作聚合
- `test:identity-regression`
  - 在上面基础上，再回归一次已有的 `prod_guard_account_switch_smoke_test`

## 自动化用例清单

### T1 平台限挂表迁移补列

- 级别：P0
- 覆盖文件：
  - `database/user_platform_restrict_db.js`
- 前置：
  - 构造旧版 `user_platform_restrict` 表，只包含 `game_account`
  - `user_game_account` 中该账号唯一归属到 `game_id=2`
- 步骤：
  - 调用 `initUserPlatformRestrictDb()`
- 预期：
  - 自动补齐 `game_id/game_name`
  - 历史记录回填为唯一归属游戏
  - 唯一索引切换到 `user_id + game_id + game_account + platform`

### T2 平台限挂按游戏身份隔离

- 级别：P0
- 覆盖文件：
  - `database/user_platform_restrict_db.js`
  - `action_engine/action_engine.js`
  - `h5/local_h5_server.js`
- 前置：
  - 同一用户存在 `game_id=1/account=A`
  - 同一用户存在 `game_id=2/account=A`
- 步骤：
  - 对两个 identity 分别 `upsertPlatformRestrict`
  - 删除其中一个 identity
- 预期：
  - 两条限挂记录可并存
  - 删除 `gid=1` 不影响 `gid=2`

### T3 上下架历史迁移安全回填

- 级别：P0
- 覆盖文件：
  - `database/product_onoff_history_db.js`
- 前置：
  - 构造旧版 `product_onoff_history`
  - 一个账号唯一归属单游戏
  - 一个账号同时归属多个游戏
- 步骤：
  - 调用 `initProductOnoffHistoryDb()`
- 预期：
  - 唯一归属账号被正确回填
  - 多游戏账号不被强猜到非默认 `game_id`

### T4 备注按 identity 返回

- 级别：P1
- 覆盖文件：
  - `database/user_game_account_db.js`
- 前置：
  - 同账号在两个游戏下备注不同
- 步骤：
  - 调用 `listAccountRemarksByUserAndIdentities()`
- 预期：
  - 返回 key 为 `gid::account`
  - 两条备注不串

### T5 最近动作聚合按 identity 分组

- 级别：P0
- 覆盖文件：
  - `database/product_onoff_history_db.js`
  - `report/report_rent_status.js`
- 前置：
  - 同账号在两个游戏下各写入一条 `off_y`
- 步骤：
  - 调用 `buildRecentActionsForUser()`
- 预期：
  - 生成两条最近动作
  - 文案分别使用对应游戏的备注

### T6 在线风控开关回归

- 级别：P1
- 覆盖文件：
  - `product/prod_status_guard.js`
- 步骤：
  - 执行现有 `test/prod_guard_account_switch_smoke_test.js`
- 预期：
  - 关闭在线风控的账号不会进入探测列表

## 人工回归清单

### M1 商品页更多操作弹层

- 路径：`/products`
- 步骤：
  - 准备两个卡片，账号相同但 `game_id` 不同
  - 分别打开“更多操作”
- 预期：
  - 两次弹层中的操作目标不会串到另一个游戏卡片

### M2 商品页禁挂/解禁挂

- 路径：`/products`
- 步骤：
  - 对双游戏同账号卡片分别操作禁挂和解禁挂
- 预期：
  - 只刷新当前卡片的 loading 和状态

### M3 风控中心聚合

- 路径：`/risk-center/list`
- 步骤：
  - 准备同账号多游戏的风险事件和守护任务
- 预期：
  - 事件、任务、账号展示按 `game_id::game_account::risk_type` 聚合

### M4 订单页关联商品

- 路径：`/orders`
- 步骤：
  - 准备同账号多游戏订单
- 预期：
  - 不再通过纯账号 fallback 关联到错误商品

### M5 统计看板

- 路径：统计页
- 步骤：
  - 查看单游戏看板与“全部”看板
- 预期：
  - 单游戏看板只统计本游戏
  - “全部”看板仍按纯账号聚合，这是当前保留行为

## 本次建议执行顺序

1. 先跑 `npm run test:game-identity`
2. 再跑 `npm run test:identity-regression`
3. 自动化通过后，再做 M1-M5 人工回归
