# 租号王（元宝授权）SOP

## 1. 目标

统一租号王渠道授权结构，后续仅保留：

- `platform = "zuhaowang"`
- `auth_payload` 仅包含 `yuanbao` 节点

禁止再写入平级 `zuhaowang.token_get/token_post/device_id/package_name` 旧结构。

## 2. 触发口令

当用户表达以下意图时，按本 SOP 执行：

- “根据这个 request/response 生成租号王授权插入命令”
- “更新 uid=xx 的 yuanbao 授权”
- “帮我测租号王商品/订单是否通畅”

## 3. 输入要求

用户需提供：

1. 目标 `uid`
2. 元宝登录 `response`（完整 JSON）
3. （可选）登录 `request` 头信息：`packagename/appversion/mainversion/x-versioncode/x-versionnumber/x-channel/User-Agent`

## 4. 授权落库格式

固定存储为：

```json
{
  "yuanbao": {
    "code": "0",
    "desc": "ok",
    "timestamp": 0,
    "data": { "...": "..." },
    "token": "...",
    "deviceId": "...",
    "package_name": "com.duodian.merchant"
  }
}
```

字段取值规则：

- `yuanbao.code/desc/timestamp/data`：来自登录 `response`
- `yuanbao.token`：优先 `response.data.token`
- `yuanbao.deviceId`：优先 `response.data.deviceId`
- `yuanbao.package_name`：优先请求头 `packagename`，缺省 `com.duodian.merchant`

## 5. SQL 执行规范

使用 `INSERT ... ON CONFLICT(user_id, platform, is_deleted) DO UPDATE`。

- `platform='zuhaowang'`
- `auth_type='token'`
- `auth_status='valid'`
- `expire_at=''`
- `desc` 写明本次更新来源

## 6. 更新后强制校验

### 6.1 数据校验

检查该用户授权记录：

- 顶层仅有 `yuanbao`
- 不得存在 `auth_payload.zuhaowang`

### 6.2 接口通畅性校验

对同一 `uid` 执行：

1. 拉取租号王商品列表（`getAccountList`）
2. 拉取租号王订单列表（`getOrderList`）

返回结果至少包含：

- `ok`
- `code/desc`
- `total`
- 失败时返回错误信息和关键报文

## 7. 输出规范

每次执行本 SOP 时，输出顺序固定：

1. 可直接执行的 `sqlite3` 命令
2. 数据校验结果
3. 商品拉取结果
4. 订单拉取结果

