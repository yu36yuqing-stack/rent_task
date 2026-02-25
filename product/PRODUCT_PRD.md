# PRODUCT PRD

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