# PRODUCT PRD

## 2026-11-04：U号租异常恢复名单与通用配置

### 配置存储及生效

- 主业务库新增全局 `system_config` 表：`config_key` 标识场景，`config_value` 保存 JSON，`id + version` 用于并发更新校验，并保留 `create_date/modify_date/is_deleted/desc` 公共字段。有效 key 使用部分唯一索引。
- 本次场景 key 为 `uhaozu.auto_reshelf_reasons`，value 为 `{ "reasons": ["检测游戏在线，请确认游戏离线后手动上架", "账号人脸识别", "商品开启禁玩,已自动下架"] }`。
- 建表迁移只在该 key 从未存在时初始化默认值，不覆盖已维护值，也不复活逻辑删除配置。通用读取不建表或补默认；`null/false/0` 与不存在的配置可区分。
- 用户流水线执行决策前读取一次不可变快照，人脸来源收敛和上下架规划共用相同版本；下一轮重新读取，所以维护名单后无需重启。号主个人规则和定价专用配置继续使用原表。
- 名单结构必须是只含 `reasons` 的对象；最多100条，每条非空且不超过1000字符。匹配归一首尾及文内空白、中英文逗号、末尾冒号；其他内容精确匹配。旧在线检测容错识别仅在该条目仍列入名单时启用。
- 有效空数组表示关闭全部异常恢复；缺失、不可读或结构不合法时也停止这类恢复并记录错误码，不扩大匹配范围。

### 上下架及历史黑名单兼容

- 命中名单仅允许进入已有自动上架判断，黑名单、出租和渠道限制继续优先。
- 已关联悠悠/租号王商品均在架时，使用已有原价重新提交商品配置补上架路径；其余情况使用普通上架接口。原始异常文案与商品事实保留，动作记录增加命中的原因及配置ID、版本。
- 名单内的 U号租人脸原因不再生成 `platform_face_verify` 来源。既有来源只移除有证据且符合名单的 U号租部分，随下一轮流水线自动收敛；来源不明或未列入名单的证据保留。
- 混合来源中的悠悠/租号王人脸证据保留原有12小时窗口，即使该平台本轮原文暂时消失也不因名单调整提前释放；没有当前命中时不续期其他平台的旧窗口。
- 人工维护、订单冷却及其他来源仍经原收敛器独立投影。配置释放不写入 `manual_suppressed_platforms`；撤销名单后可恢复原限制，既有人工抑制标记仍保留。

### 维护方式

在目标环境主库上执行，默认不触发建表或迁移；可用 `MAIN_DB_FILE_PATH` 显式指定主库：

```bash
node scripts/system_config.js list
node scripts/system_config.js get --key uhaozu.auto_reshelf_reasons
```

更新时填写上一步返回的实际 `id/version`，以下 `1/1` 仅为示例：

```bash
node scripts/system_config.js set --key uhaozu.auto_reshelf_reasons --expected-id 1 --expected-version 1 --value '{"reasons":["检测游戏在线，请确认游戏离线后手动上架","账号人脸识别","商品开启禁玩,已自动下架"]}'
```

- 新 key 使用 `--expected-id 0 --expected-version 0`。版本冲突明确失败，需重新读取后确认。
- 写入前在仓库外 `~/Library/Application Support/rent_task/config-backups` 备份旧记录，文件权限为0600；可用 `--backup-dir` 指定目录。备份失败时不写配置。
- 如需恢复旧值，读取备份中的 `previous.value`，结合当前记录新的 `id/version` 再执行更新。`version` 不是历史存储。
- 代码回滚保留新增表；名单清空或条目移除后，下轮恢复相应原因的原拦截规则。新增场景 key 需要对应业务接入读取，不会自动生成业务行为。
- 本次验证命令：`npm run coverage:uhaozu-auto-reshelf`。覆盖范围和结果见 `test/UHAOZU_AUTO_RESHELF_TEST_REPORT.md`。

## 多渠道商品状态统一枚举与卡片展示（需求记录）

### 1. 背景
当前商品卡片依赖各平台原始字段进行状态展示，字段语义存在平台差异：
- U号租通过 `auditReason/goodsStatus/rentStatus` 表达异常与上下架状态。
- 租号王通过 `exceptionMsg/rentInfo.status` 表达异常与上下架状态。
- 悠悠租号使用自身状态字段。

导致问题：
- 同类状态在不同平台文案不一致，前端判定逻辑分散。
- 异常状态（授权异常、审核失败）与普通上下架状态混用，易误判可操作性。

### 2. 目标
- 在商品域提供统一状态模型，前端卡片只消费统一枚举，不直接依赖平台原始字段。
- 支持“异常优先”展示与操作限制，避免在异常态继续误触发上架动作。
- 保留原始字段用于排查，且不破坏现有主流程。

### 3. 统一状态枚举（跨平台）
统一 code：
- `auth_abnormal`：授权/账号异常（高优先级）
- `review_fail`：审核失败（高优先级）
- `restricted`：平台限制/禁玩
- `renting`：租赁中
- `listed`：上架待租
- `off_shelf`：下架
- `unknown`：未知

统一展示 label（默认中文）：
- `auth_abnormal` -> `授权异常`
- `review_fail` -> `审核失败`
- `restricted` -> `平台限制`
- `renting` -> `租赁中`
- `listed` -> `上架`
- `off_shelf` -> `下架`
- `unknown` -> `未知`

### 4. 状态优先级
同一渠道若命中多个条件，按以下优先级取最终状态：
`auth_abnormal > review_fail > restricted > renting > listed > off_shelf > unknown`

设计意图：
- 异常态优先于业务态（上架/下架/租赁中）。
- 避免“明明异常却展示成可上架”。

### 5. 渠道映射规则

#### 5.1 U号租（`uhaozu`）
输入字段参考：`auditReason`, `goodsStatus`, `rentStatus`

建议映射：
1. `auditReason` 非空 -> `auth_abnormal`（`reason = auditReason`）
2. `goodsStatus = 4` -> `off_shelf`
3. `goodsStatus = 3 && rentStatus = 0` -> `renting`
4. `goodsStatus = 3 && rentStatus = 1` -> `listed`
5. 其他 -> `unknown`

#### 5.2 租号王（`zuhaowang`）
输入字段参考：`exceptionMsg`, `rentInfo.status`

建议映射：
1. `exceptionMsg` 非空 -> `auth_abnormal`（`reason = exceptionMsg`）
2. `rentInfo.status = 2` -> `renting`
3. `rentInfo.status = 1` -> `listed`
4. `rentInfo.status = -1` -> `off_shelf`
5. 其他 -> `unknown`

#### 5.3 悠悠租号（`uuzuhao`）
延续现有规则，但输出统一枚举：
- 授权/审核异常 -> `auth_abnormal` 或 `review_fail`
- 租赁中 -> `renting`
- 上架 -> `listed`
- 下架 -> `off_shelf`
- 其他 -> `unknown`

### 6. 输出数据结构（建议）
在商品列表接口中，每个账号新增：

```json
{
  "platform_status_norm": {
    "uuzuhao": {
      "code": "off_shelf",
      "label": "下架",
      "reason": "",
      "level": 60,
      "raw": {}
    },
    "uhaozu": {
      "code": "auth_abnormal",
      "label": "授权异常",
      "reason": "账号异常，暂时无法完成游戏授权",
      "level": 100,
      "raw": {}
    },
    "zuhaowang": {
      "code": "auth_abnormal",
      "label": "授权异常",
      "reason": "解除异常",
      "level": 100,
      "raw": {}
    }
  },
  "overall_status_norm": {
    "code": "auth_abnormal",
    "label": "授权异常",
    "reason": "U号租: 账号异常，暂时无法完成游戏授权"
  }
}
```

说明：
- `level` 用于前端排序/染色，可由后端固定映射（如 `auth_abnormal=100`）。
- `raw` 可选，仅用于调试（线上可裁剪，避免响应过大）。

### 7. 前端卡片展示规则
- 每个渠道状态徽章展示统一 `label`。
- 异常态（`auth_abnormal/review_fail`）使用高危样式（红色），并可点开查看 `reason`。
- 当任一渠道为异常态时：
  - 对该渠道上架按钮置灰，提示“需先处理渠道异常”。
- 顶部账号主状态使用 `overall_status_norm`（取三渠道最高优先级）。

### 8. 实施边界
- 本需求先做“状态归一化 + 展示与交互约束”，不调整自动上下架核心策略。
- 不新增数据库表；若后续需审计可追加状态快照表。

### 9. 验收口径
以账号样本对比：
- 异常样本：`1903036159`
  - U号租应识别为 `auth_abnormal`（reason 非空）
  - 租号王应识别为 `auth_abnormal`（`exceptionMsg` 非空）
- 正常样本：`2874231439`
  - U号租应识别为 `listed`（`auditReason` 为空，`goodsStatus=3,rentStatus=1`）
  - 租号王应识别为 `listed`（`rentInfo.status=1`, `exceptionMsg` 为空）

### 10. 待确认
- 悠悠平台“授权异常”和“审核失败”字段口径最终采用哪组字段。
- `restricted` 的归属来源（平台限制表/接口字段）是否在本期纳入统一状态。

右上角的同步商品、同步订单，统计看板的手工刷新，都是uid维度执行的吧？
