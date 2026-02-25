# PROD_GUARD_PRD

## 2026-02-24

### 功能点1：在线状态查询与异常告警拆分

- 背景：
  - 目前“在线状态查询结果展示”与“在线但非租赁中异常告警”逻辑耦合，导致主通知中查询信息缺失。
  - 业务期望是两类通知分离：
    - 商品状态主通知按 5 分钟节奏持续发送。
    - 在线状态查询结果按 10 分钟节奏附加在主通知中。
    - “在线但非租赁中”属于异常告警，只有命中异常才单独通知，无异常静默。

- 目标：
  - 保持 5 分钟商品状态主通知不受影响。
  - 每 10 分钟在主通知中增加“在线状态查询结果摘要”区块（查询成功/失败、ON/OFF数量等）。
  - 异常告警仍独立发送，且无异常不额外发告警消息。

- 方案：
  - 在 `product/prod_status_guard.js` 拆分能力：
    - 探测层：只做在线状态查询并返回快照结果（不发告警）。
    - 告警层：基于探测快照判断“在线且非租赁中”，并执行告警发送。
  - 主流程 `rent_robot_main.js`：
    - 每次 5 分钟主流程都发商品状态通知。
    - 命中 10 分钟探测窗口时，将在线探测摘要注入主通知 payload。
    - 告警逻辑异步触发，并复用同一份探测快照，避免重复调用平台查询接口。
  - 通知模板 `report/telegram/tg_style.js` 与 `report/dingding/ding_style.js`：
    - 新增“在线状态查询(10分钟)”展示区块。
    - 仅在本次命中探测窗口且有查询结果时展示。

- 验收：
  - 每 5 分钟可收到商品状态主通知。
  - 每隔 10 分钟的主通知包含在线查询摘要。
  - 无“在线但非租赁中”异常时，不发送额外异常告警。
  - 命中异常时，发送独立异常告警。

## 2026-02-25

### 功能点1：薅羊毛一键自动处置（黑名单 + 禁玩 + 离线后自动恢复）

- 背景：
  - 当前在线告警只能提示“在线且非租赁中”的异常账号，处置仍需人工执行。
  - 业务希望命中后可自动完成完整闭环：
    1. 先控风险（加黑名单 + 开启禁玩）。
    2. 自动轮询在线状态。
    3. 账号离线后自动恢复（解除禁玩 + 移出黑名单）。
  - 同时，最近订单结束的豁免窗口调整为 20 分钟（`ONLINE_ALERT_RECENT_END_SUPPRESS_SEC=1200`）。

- 目标：
  - 将“发现异常”升级为“自动处置闭环”。
  - 保障重启可恢复、任务幂等、不会重复创建同一账号的处置任务。
  - 不影响现有 5 分钟主通知与 10 分钟在线探测节奏。

- 方案：
  - 角色拆分：
    - `product/prod_status_guard.js`：
      - 继续负责异常检测。
      - 对命中账号只做任务下发（enqueue），不做长轮询。
    - 新增 `product/prod_status_guard_worker.js`：
      - 每 2 分钟扫描任务并推进处置状态机。
      - 执行禁玩开关、在线查询、黑名单恢复等动作。
  - 数据持久化：
    - 新增 `prod_guard_task` 表（包含公共字段：`id/create_date/modify_date/is_deleted/desc`）。
    - 关键业务字段：`user_id`、`game_account`、`task_type`、`status`、`next_check_at`、`last_online_tag`、`blacklist_applied`、`forbidden_applied`、`finished_at`、`error_msg`。
    - 幂等键：同一 `user_id + game_account + task_type + active_status` 仅保留一条活动任务。
  - 状态机：
    - `pending`：
      - 立即执行“加入黑名单(reason=检测在线)+开启禁玩”。
      - 成功后置为 `watching`，`next_check_at=now+120s`。
    - `watching`：
      - 每 2 分钟查询在线状态。
      - 若在线：更新时间与 `next_check_at`，继续轮询。
      - 若离线：执行“解除禁玩 + 移出黑名单”，任务置 `done`。
    - `failed`：
      - 记录错误并按重试策略回退重试（上限可配）。
  - 能力复用：
    - 在线状态/禁玩：复用 `uuzuhao_api.js` 的 `queryAccountOnlineStatus`、`enableForbiddenPlay`、`disableForbiddenPlay`。
    - 黑名单：复用 `user_blacklist_db` 与 `blacklist_release_guard`（保证在线/禁玩守卫一致）。
  - 并发控制：
    - worker 进程加全局锁，避免多实例并发重复执行。
    - 每个任务步骤均幂等执行，允许重试。

- 配置项：
  - `ONLINE_ALERT_RECENT_END_SUPPRESS_SEC=1200`（20分钟豁免窗口）。
  - `SHEEP_FIX_SCAN_INTERVAL_SEC=120`（轮询间隔）。
  - `SHEEP_FIX_ENABLE=true`（总开关）。
  - `SHEEP_FIX_MAX_RETRY=5`（失败重试上限）。

- 验收：
  - 命中异常账号后，自动进入黑名单并开启禁玩。
  - 账号在线时每 2 分钟持续轮询，不提前恢复。
  - 账号离线后自动解除禁玩并移出黑名单，任务转 `done`。
  - 服务重启后任务可继续推进，不重复新增活动任务。

### 功能点2：风控中心扩展能力（策略可插拔、统一事件与任务模型）

- 背景：
  - H5 将新增“风控中心”菜单，需要统一展示风控命中记录与处置状态。
  - 当前仅有“非租赁中且在线”一种策略，后续会增加“租赁后发广告”等新策略。
  - 若按单策略单表实现，后续会频繁改库与改前端协议，维护成本高。

- 目标：
  - 让风控策略可扩展，新增策略时尽量只新增策略实现，不改通用存储与UI主结构。
  - 风控中心可统一展示：命中记录、策略类型、当前状态、处置进度、最近更新时间。
  - 保持自动处置流程与展示解耦：策略负责“判定”，任务引擎负责“执行”。

- 方案：
  - 统一“风险事件”与“处置任务”双模型：
    - 风险事件（命中事实）：记录“为什么命中”。
    - 处置任务（执行流程）：记录“如何处理及处理到哪一步”。
  - 建议新增通用事件表 `prod_risk_event`（含公共字段）：
    - `user_id`、`game_account`
    - `risk_type`（示例：`online_non_renting`、`post_rent_ad`）
    - `risk_level`（`low/medium/high`）
    - `status`（`open/resolved/ignored`）
    - `hit_at`、`resolved_at`
    - `snapshot`（JSON，存策略命中上下文）
  - 处置任务表沿用/升级为通用任务模型：
    - 现有 `prod_guard_task` 增加 `risk_type`、`strategy_version` 字段。
    - 一个事件可关联一个活动任务，防止重复执行。
  - 策略注册机制（代码层）：
    - 在 `prod_status_guard.js` 增加策略注册表（registry）：
      - 每个策略实现统一接口：`detect()`、`plan()`、`executeStep()`。
      - 当前“在线非租赁”作为首个策略实现。
      - 新策略（如“租赁后发广告”）只需新增策略模块并注册。
  - H5 风控中心接口输出统一结构：
    - `risk_type`、`risk_type_label`
    - `game_account`、`display_name`
    - `event_status`、`task_status`
    - `last_action`、`last_update_time`
    - `snapshot_summary`（简版命中信息）
  - 与现有告警关系：
    - 告警仍由策略命中触发。
    - 风控中心展示的是“可追踪状态”，不是瞬时告警文本。

- 验收：
  - 风控中心可展示“在线非租赁”命中事件和任务进度。
  - 新增策略时不需要修改风控中心页面主数据结构。
  - 同一账号同一策略重复命中不会创建多条并行活动任务。
  - 事件闭环后状态可从 `open` 变为 `resolved`，可追溯历史。
