# 下面是U号租的商品列表接口
curl -X POST 'https://mapi.uhaozu.com/merchants/goods/list?v=20260210103549' \
  -H 'User-Agent: Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/144.0.0.0 Safari/537.36' \
  -H 'Accept: application/json, text/plain, */*' \
  -H 'Accept-Encoding: gzip, deflate, br, zstd' \
  -H 'tml: {"platform":"20","terminal":"0"}' \
  -H 'sec-ch-ua-platform: "macOS"' \
  -H 'sec-ch-ua: "Not(A:Brand";v="8", "Chromium";v="144", "Google Chrome";v="144"' \
  -H 'sec-ch-ua-mobile: ?0' \
  -H 'X-Requested-With: XMLHttpRequest' \
  -H 'Content-Type: application/json;charset=UTF-8' \
  -H 'Origin: https://b.uhaozu.com' \
  -H 'Sec-Fetch-Site: same-site' \
  -H 'Sec-Fetch-Mode: cors' \
  -H 'Sec-Fetch-Dest: empty' \
  -H 'Referer: https://b.uhaozu.com/goods' \
  -H 'Accept-Language: zh-CN,zh;q=0.9' \
  -H 'Cookie: Hm_lvt_d8c87cd1dcbd946bc8798d9aa99e46d1=1769791464; HMACCOUNT=1DCDE0E60BCD2A08; Hm_lvt_8ea4fcb9d0854f54b423c1e75b3cefdc=1769791464; Hm_lvt_a3300660f0e3ddfe9253e1e7323179cf=1769791464; uid=d8AZUpWrOsfV1GUYswbdixom5hesDuIqndUAwxfIWTq40TPVW8GhMh6nKisy8WbcbNN8uDqb4Cww36oydKpT_jwBA2Kn8_07llHmzdFQd1-pUcSHW4eGzQ8BRPKKE-O9uleirQbzuXOT1MjwW0SEOlmoXb_VrXyCVVLY1NKdH47NIGcDLuH6nMZUOhdBxu6Yzg..; Hm_lpvt_a3300660f0e3ddfe9253e1e7323179cf=1770818425; Hm_lpvt_d8c87cd1dcbd946bc8798d9aa99e46d1=1770818425; Hm_lpvt_8ea4fcb9d0854f54b423c1e75b3cefdc=1770818425' \
  --data-raw '{"gameId":-1,"serverId":"","carrierId":"","operationType":2,"goodsBaseType":-1,"hasNoDeposit":"","hasDiscounts":"","loginMethod":"","keyWords":"","options":[],"optionsSize":0,"selfSupport":1,"order":"","pageSize":30,"page":1,"originRentalByHourStart":"","originRentalByHourEnd":"","shardingProperties":[],"antiAddictionGoods":0,"loginRate":false,"loginMethodV2":"","checkCotenantForB":"","auditReason":"","hidden":null}' \
  --compressed

# 商品状态描述
# goodsStatus=4表示下架，此时rentStatus含义忽略
# goodsStatus=3表示上架，此时rentStatus=1表示待租
# goodsStatus=3表示上架，此时rentStatus=0表示出租中


# 以下是关于**时间戳**和**分页规则**的详细解析：
### 1. 时间戳 (`v`) 的拼凑规则
URL 参数中的 `v=20260210103549` 是一个非常标准的 **`YYYYMMDDHHmmss`** 格式的时间字符串。
* **格式分解**：
* `2026`: 年 (Year)
* `02`: 月 (Month)
* `10`: 日 (Day)
* `10`: 时 (Hour, 24小时制)
* `35`: 分 (Minute)
* `49`: 秒 (Second)

* **作用**：通常用于**防止缓存**（Cache Busting）或者作为**请求时效性校验**（防止重放攻击）。服务端会对比这个时间，如果与当前服务器时间相差太大（比如超过 5 分钟），可能会拒绝请求。
* **代码生成示例**：
* **JavaScript (Node.js)**:
```javascript
const now = new Date();
const v = now.getFullYear() +
          String(now.getMonth() + 1).padStart(2, '0') +
          String(now.getDate()).padStart(2, '0') +
          String(now.getHours()).padStart(2, '0') +
          String(now.getMinutes()).padStart(2, '0') +
          String(now.getSeconds()).padStart(2, '0');
console.log(v); // 输出类似 20260212032014
```

* **Python**:
```python
import datetime
v = datetime.datetime.now().strftime('%Y%m%d%H%M%S')
print(v)

```
---

### 2. 分页参数与规则
分页控制在 **POST 请求体（JSON Body）** 中。
* **关键参数**：
* **`"page": 1`** ->  **当前页码**（从 1 开始）。
* **`"pageSize": 30`** -> **每页显示数量**。

* **翻页规则**：
如果你想抓取下一页的数据，只需要修改 JSON Body 中的 `page` 字段。
* **第 1 页**: `{"page": 1, "pageSize": 30, ...}`
* **第 2 页**: `{"page": 2, "pageSize": 30, ...}`
* **第 N 页**: `{"page": N, "pageSize": 30, ...}`

* **如何判断爬完了？**
在你之前提供的响应 JSON 中，有一个 **`totalCount`** 字段（例如 `10`）。
* 逻辑：如果 `(page * pageSize) >= totalCount`，说明已经爬取了所有数据，不需要再请求下一页了。

### 总结
在写脚本时：
1. **URL**: 每次请求前动态生成 `v` 参数（当前时间）。
2. **Body**: 循环递增 `page` 字段，直到获取到的列表为空或达到总数。




# 这是一个“下架”操作
从 URL `.../unShelves/1132473733` 可以看出，执行此命令会将 ID 为 **1132473733** 的商品**下架**。

```bash
curl -X POST 'https://mapi.uhaozu.com/merchants/goods/unShelves/1132473733' \
  -H 'User-Agent: Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/144.0.0.0 Safari/537.36' \
  -H 'Accept: application/json, text/plain, */*' \
  -H 'Accept-Encoding: gzip, deflate, br, zstd' \
  -H 'tml: {"platform":"20","terminal":"0"}' \
  -H 'sec-ch-ua-platform: "macOS"' \
  -H 'X-Requested-With: XMLHttpRequest' \
  -H 'sec-ch-ua: "Not(A:Brand";v="8", "Chromium";v="144", "Google Chrome";v="144"' \
  -H 'sec-ch-ua-mobile: ?0' \
  -H 'Origin: https://b.uhaozu.com' \
  -H 'Sec-Fetch-Site: same-site' \
  -H 'Sec-Fetch-Mode: cors' \
  -H 'Sec-Fetch-Dest: empty' \
  -H 'Referer: https://b.uhaozu.com/goods' \
  -H 'Accept-Language: zh-CN,zh;q=0.9' \
  -H 'Cookie: Hm_lvt_d8c87cd1dcbd946bc8798d9aa99e46d1=1769791464; HMACCOUNT=1DCDE0E60BCD2A08; Hm_lvt_8ea4fcb9d0854f54b423c1e75b3cefdc=1769791464; Hm_lvt_a3300660f0e3ddfe9253e1e7323179cf=1769791464; uid=d8AZUpWrOsfV1GUYswbdixom5hesDuIqndUAwxfIWTq40TPVW8GhMh6nKisy8WbcbNN8uDqb4Cww36oydKpT_jwBA2Kn8_07llHmzdFQd1-pUcSHW4eGzQ8BRPKKE-O9uleirQbzuXOT1MjwW0SEOlmoXb_VrXyCVVLY1NKdH47NIGcDLuH6nMZUOhdBxu6Yzg..; Hm_lpvt_a3300660f0e3ddfe9253e1e7323179cf=1770818425; Hm_lpvt_d8c87cd1dcbd946bc8798d9aa99e46d1=1770818425; Hm_lpvt_8ea4fcb9d0854f54b423c1e75b3cefdc=1770818425' \
  -d '' \
  --compressed

```
### 💡 如何操作其他商品？
如果你想下架其他商品，只需要替换 URL 最后的数字 ID：
`https://mapi.uhaozu.com/merchants/goods/unShelves/【这里换成新的商品ID】`





# 这是一个“上架”操作
从 URL `.../goods/shelves/1132473733` 和 Body 参数可以看出，这是将 ID 为 **1132473733** 的商品**重新上架**。

**JSON Body**：保留了 `forbidplayConfirm: false` 参数，这通常是确认“没有禁赛风险”或类似的二次确认。

```bash
curl -X POST 'https://mapi.uhaozu.com/api/goods/shelves/1132473733' \
  -H 'User-Agent: Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/144.0.0.0 Safari/537.36' \
  -H 'Accept: application/json, text/plain, */*' \
  -H 'Accept-Encoding: gzip, deflate, br, zstd' \
  -H 'tml: {"platform":"20","terminal":"0"}' \
  -H 'sec-ch-ua-platform: "macOS"' \
  -H 'sec-ch-ua: "Not(A:Brand";v="8", "Chromium";v="144", "Google Chrome";v="144"' \
  -H 'sec-ch-ua-mobile: ?0' \
  -H 'X-Requested-With: XMLHttpRequest' \
  -H 'Content-Type: application/json;charset=UTF-8' \
  -H 'Origin: https://b.uhaozu.com' \
  -H 'Sec-Fetch-Site: same-site' \
  -H 'Sec-Fetch-Mode: cors' \
  -H 'Sec-Fetch-Dest: empty' \
  -H 'Referer: https://b.uhaozu.com/goods' \
  -H 'Accept-Language: zh-CN,zh;q=0.9' \
  -H 'Cookie: Hm_lvt_d8c87cd1dcbd946bc8798d9aa99e46d1=1769791464; HMACCOUNT=1DCDE0E60BCD2A08; Hm_lvt_8ea4fcb9d0854f54b423c1e75b3cefdc=1769791464; Hm_lvt_a3300660f0e3ddfe9253e1e7323179cf=1769791464; uid=d8AZUpWrOsfV1GUYswbdixom5hesDuIqndUAwxfIWTq40TPVW8GhMh6nKisy8WbcbNN8uDqb4Cww36oydKpT_jwBA2Kn8_07llHmzdFQd1-pUcSHW4eGzQ8BRPKKE-O9uleirQbzuXOT1MjwW0SEOlmoXb_VrXyCVVLY1NKdH47NIGcDLuH6nMZUOhdBxu6Yzg..; Hm_lpvt_a3300660f0e3ddfe9253e1e7323179cf=1770818425; Hm_lpvt_d8c87cd1dcbd946bc8798d9aa99e46d1=1770818425; Hm_lpvt_8ea4fcb9d0854f54b423c1e75b3cefdc=1770818425' \
  -d '{"goodsId":1132473733,"forbidplayConfirm":false}' \
  --compressed

```
### 💡 关键区别
* **下架 (Unshelf)**: URL 包含 `/goods/unShelves/ID`，Body 通常为空。
* **上架 (Shelf)**: URL 包含 `/api/goods/shelves/ID`，Body 需要包含 `goodsId` 和确认参数。
如果要上架其他商品，需要修改 **URL 结尾的数字** 和 **`-d` 参数里的 `goodsId**`，**两处都要改**。





# 这是一个“改价 / 修改商品信息”接口
从 URL `.../api/goods/modify/1132393091` 可以看出，这是对商品 `goodsId=1132393091` 的整体修改接口，不只是改价格，而是把整份商品资料重新提交一次。

## 接口概览
- 方法：`POST`
- URL：`https://mapi.uhaozu.com/api/goods/modify/{goodsId}`
- 当前样例商品：`1132393091`
- `Content-Type`：`application/json;charset=UTF-8`
- 鉴权：依赖登录态 `Cookie`
- 来源页面：`https://b.uhaozu.com/goods`

## 请求体结构
顶层主要有这些字段：

```json
{
  "goodsId": 1132393091,
  "info": { "...核心商品信息..." },
  "options": [ "...商品标签/属性选项..." ],
  "urls": [ "...商品图片..." ],
  "goodsDiscountOptions": [ "...多租优惠..." ],
  "rentDiscountOptions": [],
  "authSource": "LB",
  "mode": 0,
  "randStr": "L9XCEgq00lMu",
  "authVersion": 2
}
```

## 关键理解
- `goodsId`：商品 ID，URL 和 Body 内要保持一致。
- `info`：核心商品信息，价格、标题、账号、描述、租赁策略基本都在这里。
- `options`：商品标签/属性明细，本质是“英雄/皮肤/段位/V 等”等勾选项，不是价格核心字段。
- `urls`：商品图片列表。
- `goodsDiscountOptions`：多租优惠。
- `rentDiscountOptions`：额外租期折扣，当前样例为空。

## `info` 字段解析
这部分是最关键的。

### 1. 商品基础身份
- `gameId: "A2705"`：游戏 ID，当前是王者荣耀。
- `platformId: "A2705PT1002"`：平台 ID。
- `carrierId: "A2775P001"`：渠道/运营商区服维度。
- `goodsTitle`：商品标题。
- `goodsDescription`：商品详情描述。
- `tencentGroupId: "1542"`：区服/大区 ID。
- `tencentGroupName: "手Q532区-琥珀纪元"`：区服名称。

### 2. 账号信息
- `gameAccount: "2874231439"`：游戏账号。
- `gamePassword: "1024=1kb"`：游戏密码。
- `gameRoleName: "٩小妤妈妈"`：角色名。
- `gameRoleLevel: "30"`：角色等级。
- `loginMethod: 2`：登录方式。

说明：
- 这个接口会把账号密码一起带上，说明它是“整单覆盖式修改”接口，不是纯价格 patch。
- 如果后续程序化调用，日志里不要打印 `gamePassword`。

### 3. 价格字段
样例里的核心价格如下：

- `rentalByHour: "4"`：小时价，4 元/小时
- `rentalByNight: 15.2`：包夜价，15.2 元/晚
- `rentalByDay: 22.8`：包天价，22.8 元/天
- `rentalByWeek: 152`：包周价，152 元/周
- `deposit: 3`：押金，3 元

补充字段：
- `discount: 1`：折扣倍率，当前看起来表示不打折
- `goodsDiscountOptions: [{"buy":5,"checked":true,"free":1}]`

`goodsDiscountOptions` 这条样例可理解为：
- 租满 `5` 个计费单位
- 赠送 `1` 个计费单位
- `checked=true` 表示当前启用

但它最终按“小时 / 夜 / 天 / 周”哪一种口径生效，还需要继续结合前端交互或接口响应确认。

### 4. 租赁规则
- `minRentTime: 2`：最短租期 2 小时
- `payPeriod: 10`：支付时长/结算周期字段，当前值 10
- `rentTimesLimit: 0`：租用次数限制，0 通常表示不限
- `isAppointment: 0`：不支持预约
- `freePlay: false`：不是免押/免玩
- `isBargain: false`：不支持议价
- `isOrderRebate: 0`：订单返利关闭

### 5. 其它业务字段
- `channelSupply: false`：非渠道代供
- `provinceName: null` / `cityName: null`：未设置地域
- `cotenantId: ""`：无合租配置
- `minGuaranteeMoney: ""`：最低保障金未填
- `commission: ""`：佣金字段未填
- `remark: ""`：备注为空

## `options` 字段怎么理解
`options` 很长，但本质是“商品属性勾选列表”。

常见结构：

```json
{
  "optionId": "A2705YX1089",
  "optionName": "英雄",
  "propertyId": "A2705YX",
  "optionNum": 1
}
```

可以这样理解：
- `propertyId`：属性分类
- `optionId`：具体选项
- `optionName`：展示名或数量值
- `optionNum`：勾选/数量，一般为 `1`

从当前样例看，`options` 主要包含：
- 英雄明细：`propertyId = A2705YX`
- 皮肤明细：`propertyId = A2705PF`
- 部分细分皮肤池/专题标签：如 `A2705S7334X...`
- 汇总属性：
  - `A2705S4108` -> `V10`
  - `A2705DW` -> `至尊星耀`
  - `A2705XYF` -> `100`
  - `A2705PFSL` -> `575`
  - `A2705S2833` -> `7`
  - `A2705YXSL` -> `129`

说明：
- 这些汇总值和 `goodsTitle/goodsDescription` 文案可能不完全一致。
- 例如文案写了“英雄 128、皮肤 572”，但 `options` 末尾汇总看起来是“英雄 129、皮肤 575”。
- 如果后续做自动改价，价格建议优先依据 `info` 里的显式价格字段；如果要做商品信息校验，再把 `options` 当作属性真值源单独处理。

## `urls` 字段
- 是商品图片数组
- 样例里共 8 张图
- 有 `picture.uhaozu.com` 和 `picture.nj-ss.com` 两类地址

## 这个接口适合怎么用
- 改价格：改 `info.rentalByHour / rentalByNight / rentalByDay / rentalByWeek / deposit`
- 改标题或描述：改 `info.goodsTitle / goodsDescription`
- 改商品标签：改 `options`
- 改图片：改 `urls`

结论：
- 这是一个“整商品提交”接口
- 其中价格等关键信息确实主要在 `info`
- 真正做自动改价时，最小关注字段通常是：
  - `goodsId`
  - `info.rentalByHour`
  - `info.rentalByNight`
  - `info.rentalByDay`
  - `info.rentalByWeek`
  - `info.deposit`
  - `goodsDiscountOptions`

## 敏感信息提示
这类报文里包含：
- 登录态 Cookie
- `gameAccount`
- `gamePassword`

后续如果要在代码里沉淀样例，建议：
- Cookie 不落盘，改成占位符
- `gamePassword` 不落盘，改成 `***`
- 文档中只保留字段结构和语义


在`curl` 命令中，**身份验证信息（相当于您的账号密码）完全包含在 `Cookie` 字段里**。
具体来说，是 `-H 'Cookie: ...'` 这一行。
### 核心凭证分析
在这一长串 Cookie 中，真正起决定性作用（代表“你是谁”）的是 **`uid`** 字段：
```bash
uid=d8AZUpWrOsfV1GUYswbdixom5hesDuIqndUAwxfIWTq40TPVW8GhMh6nKisy8WbcbNN8uDqb4Cww36oydKpT_jwBA2Kn8_07llHmzdFQd1-pUcSHW4eGzQ8BRPKKE-O9uleirQbzuXOT1MjwW0SEOlmoXb_VrXyCVVLY1NKdH47NIGcDLuH6nMZUOhdBxu6Yzg..
```
* **`uid=...`**: 这是您的用户会话 ID（Session ID）。服务器通过这一长串乱码来识别您是“mac”用户。如果这个过期了，您的脚本就会报“未登录”或 401 错误。
* **`Hm_lvt_...` / `Hm_lpvt_...` / `HMACCOUNT**`: 这些是以 `Hm` 开头的，通常是 **百度统计 (Baidu Analytics)** 的追踪 Cookie。虽然它们主要用于统计流量，但很多网站的防火墙（WAF）会检查这些字段是否存在，用来判断“是不是真人浏览器”。**建议保留，不要删除**。
### ⚠️ 重要提示
1. **保密性**：这个 `Cookie`（特别是 `uid` 部分）等同于您的登录密码。任何拿到这一串字符的人都可以操作您的账号（上架、下架、改价）。**请勿泄露给他人**。
2. **有效期**：这个 Cookie 是有有效期的（可能是一天，也可能是一个月）。
* 如果某天脚本突然跑不通了（返回 `401 Unauthorized` 或跳转到登录页），您需要**重新在浏览器登录**，按 F12 抓包，复制**最新**的 Cookie 替换到脚本里。





# 这是一个用商品编号goodsId换取QQ账号gameAccount的接口
curl -X POST 'https://mapi.uhaozu.com/merchants/query/actual/1132473733' \
  -H 'User-Agent: Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/144.0.0.0 Safari/537.36' \
  -H 'Accept: application/json, text/plain, */*' \
  -H 'Accept-Encoding: gzip, deflate' \
  -H 'tml: {"platform":"20","terminal":"0"}' \
  -H 'sec-ch-ua-platform: "macOS"' \
  -H 'X-Requested-With: XMLHttpRequest' \
  -H 'sec-ch-ua: "Not(A:Brand";v="8", "Chromium";v="144", "Google Chrome";v="144"' \
  -H 'sec-ch-ua-mobile: ?0' \
  -H 'Origin: https://b.uhaozu.com' \
  -H 'Sec-Fetch-Site: same-site' \
  -H 'Sec-Fetch-Mode: cors' \
  -H 'Sec-Fetch-Dest: empty' \
  -H 'Referer: https://b.uhaozu.com/goods' \
  -H 'Accept-Language: zh-CN,zh;q=0.9' \
  -H 'Cookie: Hm_lvt_d8c87cd1dcbd946bc8798d9aa99e46d1=1769791464; HMACCOUNT=1DCDE0E60BCD2A08; Hm_lvt_8ea4fcb9d0854f54b423c1e75b3cefdc=1769791464; Hm_lvt_a3300660f0e3ddfe9253e1e7323179cf=1769791464; uid=d8AZUpWrOsfV1GUYswbdixom5hesDuIqndUAwxfIWTq40TPVW8GhMh6nKisy8WbcbNN8uDqb4Cww36oydKpT_jwBA2Kn8_07llHmzdFQd1-pUcSHW4eGzQ8BRPKKE-O9uleirQbzuXOT1MjwW0SEOlmoXb_VrXyCVVLY1NKdH47NIGcDLuH6nMZUOhdBxu6Yzg..; Hm_lpvt_a3300660f0e3ddfe9253e1e7323179cf=1770818425; Hm_lpvt_d8c87cd1dcbd946bc8798d9aa99e46d1=1770818425; Hm_lpvt_8ea4fcb9d0854f54b423c1e75b3cefdc=1770818425' \
  -d '' \
  --compressed

{"object":{"createTime":1770744866000,"gameAccount":"2630403808","goodsId":1132473733,"groupId":"1191","groupName":"手Q181区-大魔术师","modifyTime":1770744866000,"serverId":"1","serverName":"手Q-安卓"},"responseCode":"0000","responseMsg":"success","success":true}
# 注意：这个接口是一个一个商品去查的，避免调用次数过多，要在本地保存goodsId和gameAccount的关系，只第一次去查询，后续如果本地有关系，则不去查了
