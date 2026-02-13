# PRD - USER 模块（多用户优先）

## 1. 背景与问题
当前系统以“单租号机器人”视角运行，账号与平台授权信息未按用户隔离，导致：
- 无法表达“账号属于哪个用户”
- 无法按用户发送扫描结果
- 无法支持多用户分别管理自己的平台登录态（租号王/U号租/悠悠租号）
- 缺少标准登录入口和权限边界

本次先聚焦“多用户能力”基础建设，不一次性改造全部业务逻辑。

## 2. 目标（本阶段）
1. 建立用户体系（登录入口 + 基础权限）
2. 通过用户完成平台授权后自动拉取账号，并天然归属该用户
3. 支持用户级平台授权入口（模拟登录后持久化身份信息）
4. 扫描结果可按账号归属路由到对应用户通知渠道
5. 保持现有单机流程可渐进迁移，不中断当前运行

## 3. 非目标（本阶段不做）
- 不做完整多租户运营后台
- 不做复杂组织架构（部门/团队层级）
- 不做开放注册（仍由管理员创建用户）
- 不做全部历史脚本一次性重写

## 4. 用户角色与标记（现阶段）
- 管理员（admin）
  - 创建/禁用用户
  - 查看系统状态
- 内部用户（internal）
  - 维护自己平台授权
- 外部用户（external）
  - 维护自己平台授权

说明：
- `internal/external` 当前仅用于用户类型标记（后续收费策略），不体现功能权限差异。
- 用户暂不提供账号管理能力；账号以平台拉取结果为准，不允许手工编辑或分配。

## 5. 关键业务能力

### 5.1 用户登录入口
- 能力：账号密码登录，返回会话（建议 JWT + RefreshToken）
- 最小接口：
  - `POST /api/user/login`
  - `POST /api/user/logout`
  - `GET /api/user/me`

### 5.2 账号归属管理
- 能力：用户完成平台授权后，系统自动拉取账号并归属该用户
- 规则：
  - 不提供管理员分配归属能力
  - 不提供用户手工改账号能力
  - 同一个游戏账号在数据库中只保留一行记录；多个平台的上架/状态信息统一放在一个 JSON 字段中维护
- 最小接口：
  - `POST /api/user/accounts/sync`（按当前用户授权从三平台拉取并刷新）
  - `GET /api/user/accounts`（按当前用户查看）

### 5.3 平台授权入口（模拟登录）
- 能力：用户进入对应平台授权流程，保存登录态/凭据
- 平台：租号王、U号租、悠悠租号
- 最小接口：
  - `POST /api/platform-auth/start`（选择平台，生成授权会话）
  - `POST /api/platform-auth/callback`（回填授权结果）
  - `GET /api/platform-auth/status`

### 5.4 扫描结果按归属路由
- 扫描输出中每个账号根据 `owner_user_id` 路由到对应用户通知配置
- 通知渠道：Telegram / DingTalk（后续可扩展）
- 本阶段重点为钉钉群通知，不做页面查看
- 用户授权过期时，通知该用户重新登录授权

## 6. 数据模型设计（新增）
> 规则：所有新表必须包含公共字段 `id`、`modify_date`、`is_deleted`、`desc`

### 6.1 `user`（已有，需补强）
- 字段：
  - `id`
  - `account`（登录账号，唯一）
  - `password`（哈希）
  - `name`
  - `phone`
  - `notify_config`（JSON 文本）
  - `user_type`（管理员/内部/外部）
  - `modify_date`
  - `is_deleted`
  - `desc`
- 建议新增：`status`（启用/禁用）、`last_login_at`

### 6.2 `user_game_account`（账号归属表）
- 字段：
  - `id`
  - `user_id`
  - `game_account`（如 987437118）
  - `game_name`（可为空，后续多游戏用）
  - `has_zuhaowang`（0/1）
  - `has_uhaozu`（0/1）
  - `has_uuzuhao`（0/1）
  - `platform_status`（JSON，按平台保存状态；示例：`{"zuhaowang":"上架","uhaozu":"审核失败","uuzuhao":"下架"}`）
  - `modify_date`
  - `is_deleted`
  - `desc`
- 约束建议：`UNIQUE(user_id, game_account, is_deleted)`

### 6.3 `user_platform_auth`（用户平台授权）
- 字段：
  - `id`
  - `user_id`
  - `platform`（`zuhaowang`/`uhaozu`/`uuzuhao`）
  - `auth_type`（cookie/token/session）
  - `auth_payload`（加密 JSON）
  - `auth_status`（valid/expired/revoked）
  - `expire_at`
  - `modify_date`
  - `is_deleted`
  - `desc`
- 约束建议：`UNIQUE(user_id, platform, is_deleted)`

### 6.4 `scan_result`（可选，本阶段可后补）
- 字段：
  - `id`
  - `run_id`
  - `user_id`
  - `game_account`
  - `snapshot`（JSON）
  - `action_summary`（JSON）
  - `modify_date`
  - `is_deleted`
  - `desc`

## 7. 技术方案改动点

### 7.1 认证与会话
- 现状：无登录层
- 改动：新增 `api/user_api.js` + 中间件 `auth_middleware.js`
- 方案：
  - Access Token（短期）+ Refresh Token（长期）
  - Token 中包含 `user_id`, `user_type`

### 7.2 业务查询加“用户上下文”
- 所有账号查询/变更操作带 `user_id` 过滤
- `action_engine` 执行前增加“账号归属映射”装配
- 未归属账号归到“系统池”并发管理员告警

### 7.3 平台授权管理
- 把当前硬编码 Cookie/API 凭据迁移到 `user_platform_auth`
- 调用 API 时按 `user_id + platform` 动态取授权
- 授权失效时：
  - 标记 `auth_status=expired`
  - 通知对应用户重新登录授权

### 7.4 通知改造
- `report` 生成时按账号归属分组
- 每个用户读取 `notify_config` 发送独立消息
- 本阶段以消息通知为主，不做页面查询入口

### 7.5 安全
- 敏感信息加密存储（至少 AES-GCM；密钥来自环境变量）
- 密码已哈希，继续保留 PBKDF2 或升级 Argon2
- 日志脱敏（token/cookie 不落盘）

## 8. 分阶段实施计划

### Phase 1（基础可用）
- 完成用户登录 API
- 完成账号归属表与自动同步 API（基于授权拉取）
- 扫描后按用户分组发送通知（先只通知，不改执行策略）

### Phase 2（授权收口）
- 完成平台授权入口与凭据表
- 读取用户级授权替代全局硬编码凭据
- 处理授权失效告警与重试

### Phase 3（执行隔离）
- 扫描/执行按用户维度串行或限流并行
- 操作审计（谁触发、作用于哪些账号）
- 管理员可视化查看用户任务状态

## 9. 兼容与迁移策略
- 保留当前“系统全局模式”作为兜底
- 增量迁移：
  1. 先写新表与 API
  2. 再把现有账号批量绑定到默认管理员
  3. 再逐步迁移到用户级授权
- 开关控制：`USER_MODE_ENABLED=true/false`

## 10. 验收标准（本阶段）
1. 管理员可创建用户并登录
2. 用户完成平台授权后可自动拉取并归属账号
3. 扫描结果可按用户路由通知
4. 不影响现有单用户流程（开关关闭时行为不变）

## 11. 风险与待确认

### 11.1 风险
- 平台登录态稳定性（反爬/验证码）
- 多用户并发导致 API 限流
- 错误归属引起误通知或误操作

### 11.2 待确认问题
1. 一个账号是否允许多用户共享？（建议默认不允许） 答案：不允许
2. 平台授权过期后的通知重试策略（频率/次数）？ 答案：把异常同步到钉钉群，并且对应平台账号的逻辑阻断，每次触发任务都同步异常
3. 通知路由失败时是否回退给管理员？ 答案：不用，把异常通知到用户对应的钉钉群
4. 多游戏字段是否现在就强制必填？ 答案：必填，默认是王者荣耀，WZRY即可。

---

## 附：建议优先落地的最小接口
- `POST /api/user/login`
- `GET /api/user/me`
- `POST /api/user/create`（管理员）
- `POST /api/user/accounts/sync`（当前用户）
- `GET /api/user/accounts`（按当前用户）
- `POST /api/user/platform-auth/upsert`（当前用户）
- `GET /api/user/platform-auth/list`（当前用户）
