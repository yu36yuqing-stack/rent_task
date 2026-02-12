appkey:d8303c79f9354ea2bed061cb28609f3b
app_secret:902d9ba500a84c81b80115b1d7fd51e2


# 第三方号商对接接口文档（V1.1）

## 1. 通用说明

### 1.1  接口协议

*   协议：HTTPS
    
*   数据格式：JSON
    
*   编码：UTF-8
    
*   认证：参数签名校验
    

---

### 1.2 通用请求参数

所有参数都放到请求body里

| **字段名** | **类型** | **必填** | **说明** |
| --- | --- | --- | --- |
| appkey | long | 是 | 分配给第三方号商应用唯一标识（目前平台侧会手动绑定商家） |
| timestamp | long | 是 | 秒级时间戳，用于防重放攻击，有效期 ±5 分钟 |
| sign | string | 是 | 按签名算法生成的签名 |
| 业务参数 | \- | 是 | 各接口独有的参数 |

```json
{
    "appKey": "fb4aa76af1b543efba848e6f5ba774b7",
    "timestamp": 1764745684,
    "sign": "aaaa",
    "productId": "202511261000051787"
}
```

---

### 1.3 通用响应参数

```json
{
  "code": 0, // 0标识成功，失败会返回对应的错误码
  "msg": "成功",
  "timestamp": 1763101407268,
  "data": {}
}
```
---

## 签名机制

### 2.1 签名规则

**将所有参数（除 sign 外）按 ASCII 升序排列 → 拼接成字符串 → 最后拼接秘钥（ app\_secret） → MD5 → 大写。**

### 步骤：

1.  所有了请求参数（除sign外）按 ASCII 升序排序（key 从小到大），空值不参与排名
    
2.  拼接格式为：
    
    ```plaintext
    key1=value1&key2=value2appSecret
    注意最后是直接追加 appSecret 值，没有 key 名称
    ```
    
3.  如果值是数组格式，签名时把数组各个值用英文逗号（,）拼接成字符串
    
4.  对拼接后的字符串进行 MD5
    
5.  结果转大写作为 sign
    

---

### 2.2 示例

#### 示例参数：

```json
{
    "tabKey": "SALE",
    "appKey": "fb4aa76af1b543efba848e6f5ba774b7",
    "timestamp": 1764745447,
    "productIds": [
        "202511261000051787",
        "202511181000051738"
    ]
}
```

假设秘钥为appSecret为：68d708c87f494b47890e01745285d8f6

#### 按 key （ 按 ASCII 升序排序）排序后待签名字符串：

```plaintext
appKey=fb4aa76af1b543efba848e6f5ba774b7&productIds=202511261000051787,202511181000051738&tabKey=SALE&timestamp=176474544768d708c87f494b47890e01745285d8f6
```

#### 计算 sign：

```plaintext
sign = UPPERCASE(MD5(待签名字符串))
```

##### 关键要点：

*   **sign 字段被移除**，不参与签名计算
    
*   最后追加 **appSecret**（不是 `&appSecret=xxx`，而是直接拼接 `appSecret`）
    
*   如果值为数组要把每项值 改成用都英文逗号拼接的字符串
    

### 2.3 Java 签名示例代码

```java
public String createSign(Map<String, Object> params, String appSecret) {
		// 使用副本，避免修改外部参数
		Map<String, Object> safeParams = new LinkedHashMap<>(params);
		// 移除 sign 字段
		safeParams.remove("sign");

		// 按 ASCII 升序排序
		List<String> keys = new ArrayList<>(safeParams.keySet());
		Collections.sort(keys);

		// 拼接 key=value&...&appKey=...
        List<String> kvList = new ArrayList<>();
		for (String key : keys) {
			Object value = safeParams.get(key);
			if (value == null) {
				continue;
			}
            String valueStr = toDeterministicString(value);
            if (StringUtils.isBlank(valueStr)) {
                continue;
            }
            kvList.add(key + "=" + valueStr);
		}
        String result = String.join("&", kvList);
		String expected = md5Hex(result + appSecret);
		if (!sign.equalsIgnoreCase(expected)) {
			throw new BusinessException(BusinessExceptionEnum.ROP_SIGN_FAILED.getCode(), BusinessExceptionEnum.ROP_SIGN_FAILED.getMessage());
		}
	}


	/**
	 * 将对象转换为可签名的确定性字符串：
	 * - Map：按键 ASCII 升序遍历，格式 {k1:v1,k2:v2}
	 * - Collection/数组：保持原有顺序，格式 [v1,v2]
	 * - 其他：直接 toString，null 为空串
	 */
	private static String toDeterministicString(Object value) {
		if (value == null) {
			return "";
		}
		if (value instanceof Map<?, ?>) {
			Map<String, Object> sorted = new TreeMap<>();
			((Map<?, ?>) value).forEach((k, v) -> sorted.put(String.valueOf(k), v));
			StringBuilder sb = new StringBuilder("{");
			boolean first = true;
			for (Map.Entry<String, Object> entry : sorted.entrySet()) {
				if (!first) {
					sb.append(",");
				}
				first = false;
				sb.append(entry.getKey())
					.append(":")
					.append(toDeterministicString(entry.getValue()));
			}
			sb.append("}");
			return sb.toString();
		}
		if (value instanceof Collection<?>) {
			StringBuilder sb = new StringBuilder();
			boolean first = true;
			for (Object item : (Collection<?>) value) {
				if (!first) {
					sb.append(",");
				}
				first = false;
				sb.append(toDeterministicString(item));
			}
			return sb.toString();
		}
		if (value.getClass().isArray()) {
			StringBuilder sb = new StringBuilder("[");
			int len = java.lang.reflect.Array.getLength(value);
			for (int i = 0; i < len; i++) {
				if (i > 0) {
					sb.append(",");
				}
				sb.append(toDeterministicString(java.lang.reflect.Array.get(value, i)));
			}
			sb.append("]");
			return sb.toString();
		}
		return String.valueOf(value);
	}


private String md5Hex(String input) {
		try {
			MessageDigest md5 = MessageDigest.getInstance("MD5");
			byte[] bytes = md5.digest(input.getBytes(StandardCharsets.UTF_8));
			StringBuilder hex = new StringBuilder();
			for (byte b : bytes) {
				hex.append(String.format("%02X", b));
			}
			return hex.toString();
		} catch (Exception e) {
			throw new RuntimeException(e);
		}
	}
```
---

## 业务接口详情

### 3.1 商品

#### 3.1.1 获取商品（账号）列表接口

#### 接口地址

```plaintext
POST /api/youpin/rent-connector/product/v1/list
```

#### 接口说明

第三方调用此接口，拉取商品数据，包括：

*   商品 ID
    
*   上下架状态
    
*   销售状态
    
*   下架原因
    
*   账号 / 密码
    

#### 请求参数

| **字段** | **类型** | **必填** | 示例值 | **说明** |
| --- | --- | --- | --- | --- |
| appKey | string | 是 |  | 应用唯一标识 |
| timestamp | long | 是 |  | 秒时间戳 |
| sign | string | 是 |  | 签名 |
| tabKey | String | 否 | SALE | "SALE":在租<br>"RENT":出租中<br>"OFF":已下架 |
| productIds | array | 否 | \[<br>        "202511261000051787",<br>        "202511181000051738"<br>    \] | tabKey和productIds，两者比传其一 |
| searchWord | String |  |  | 搜索词<br>支持商家备注或者游戏账号搜索，前缀匹配 |
| limit | integer | 否 |  | 每页数量<br>默认 20，最大 50 |
| lastId | String | 否 |  | 分页使用滚动查询方式<br>上页该出参值，作为本页查询使用。首次传空 |

#### 请求示例

```json
{
    "tabKey": "SALE",
    "appKey": "fb4aa76af1b543efba848e6f5ba774b7",
    "timestamp": 1764745447,
    "productIds": [
        "202511261000051787",
        "202511181000051738"
    ]
}
```

#### 出参实例

```mysql
  {
    "code": 0,
    "msg": "成功",
    "timestamp": 1764748409670,
    "data": {
        "productPublishList": [
            {
                "productId": "202511261000051787",
                "productTitle": "42皮 游园惊梦/遇见飞天/未来纪元/乱世虎臣/冰雪圆舞曲",
                "productImageUrl": "https://acctrade-images-test.oss-cn-shenzhen.aliyuncs.com/rent/product/kohDefault-5.png",
                "roleName": "༺傾國傾城༻",   //角色名称
                "productHourRentPrice": 8.8, //时租价格
                "productRentPriceUnit": "￥",
                "productStatus": 1000, 
                "offType": "ACCOUNT_ERROR",
                "saleStatus": 1000,
                "productOffDesc": null,
                "productOffReasonDesc": null,
                "accountNo": "507810152",
                "password": "123456",
                "gameServerId": "1020",
                "offTime": 1764745690214,
                "remarkName": ""
            }
        ],
        "lastId": "690"
    }
}
```

商品状态 productStatus：

```plaintext
PRODUCT_ON(1000, "上架"),
PRODUCT_OFF_SYSTEM(2100, "系统自动下架"),
PRODUCT_OFF_CUSTOMER(2200, "客服下架"),
PRODUCT_OFF_SELLER(2300, "卖家下架"),
```

销售状态saleStatus：

```mysql
SALE_ON(1000, "在租"),
SALE_OUT(2000, "出租中"),
```

下架类型：offType

```mysql
FACE("FACE", "检测到登录账号需人脸识别系统自动下架，系统检测人脸识别取消后将自动进行上架"),
ACCOUNT_ERROR("ACCOUNT_ERROR","检测到登录账号密码错误，请重新编辑后发布账号"),
INFO_NO_MATCH("INFO_NO_MATCH","检测到登录账号信息描述不符，请重新编辑后发布账号"),
CUSTOMER("CUSTOMER","人工客服后台下架"),
SELLER("SELLER" ,"号主主动下架"),
SELLER_BLACK("SELLER_BLACK","系统下架")
```

#### 3.1.2 商品上架接口

#### 接口地址

```plaintext
POST /api/youpin/rent-connector/product/v1/on
```

#### 请求参数

| **字段** | **类型** | **必填** | 示例值 | **说明** |
| --- | --- | --- | --- | --- |
| appKey | string | 是 |  | 应用唯一标识 |
| timestamp | long | 是 |  | 秒时间戳 |
| sign | string | 是 |  | 签名 |
| productId | String | 是 |  | 平台商品ID |

#### 请求示例

```mysql
{
    "appKey": "fb4aa76af1b543efba848e6f5ba774b7",
    "timestamp": 1764745684,
    "sign": "aaaa",
    "productId": "202511261000051787"
}
```

#### 出参示例

```mysql
{
    "code": 0, // code为0表示成功
    "msg": "成功",
    "timestamp": 1764745770876,
}
```

#### 3.1.3 商品下架接口

#### 接口地址

```plaintext
POST /api/youpin/rent-connector/product/v1/off
```

#### 请求参数

| **字段** | **类型** | **必填** | 示例值 | **说明** |
| --- | --- | --- | --- | --- |
| appKey | string | 是 |  | 应用唯一标识 |
| timestamp | long | 是 |  | 秒时间戳 |
| sign | string | 是 |  | 签名 |
| productId | String | 是 |  | 平台商品ID |

#### 请求示例

```mysql
{
    "appKey": "fb4aa76af1b543efba848e6f5ba774b7",
    "timestamp": 1764745684,
    "sign": "aaaa",
    "productId": "202511261000051787"
}
```

#### 出参示例

```mysql
{
    "code": 0, //code为0表示成功
    "msg": "成功",
    "timestamp": 1764745770876,
}
```

#### 3.1.4 商品修改密码接口

#### 接口地址

```plaintext
POST /api/youpin/rent-connector/product/v1/modifyPassword
```

#### 请求参数

| **字段** | **类型** | **必填** | 示例值 | **说明** |
| --- | --- | --- | --- | --- |
| appKey | string | 是 |  | 应用唯一标识 |
| timestamp | long | 是 |  | 秒时间戳 |
| sign | string | 是 |  | 签名 |
| productId | String | 是 |  | 平台商品ID |
| oldPassword | String | 是 |  | 旧密码 |
| newPassword | String | 是 |  | 新密码 |

#### 请求示例

```mysql
{
    "productId": "202511261000051787",
    "oldPassword": "1111111",
    "newPassword": "newPassword_test",
    "appKey": "fb4aa76af1b543efba848e6f5ba774b7",
    "timestamp": 1764745934
}
```

#### 出参示例

```mysql
{
    "code": 0, //code为0表示成功
    "msg": "成功",
    "timestamp": 1764745770876,
}
```

#### 3.1.5 商品修改备注

#### 接口地址

```plaintext
POST /api/youpin/rent-connector/product/v1/modifyRemarkName
```

#### 请求参数

| **字段** | **类型** | **必填** | 示例值 | **说明** |
| --- | --- | --- | --- | --- |
| appKey | string | 是 |  | 应用唯一标识 |
| timestamp | long | 是 |  | 秒时间戳 |
| sign | string | 是 |  | 签名 |
| productId | String | 是 |  | 平台商品ID |
| remarkName | String | 是 |  | 备注,<br>备注名最多32个字符 |

#### 请求示例

```mysql
{
    "productId": "202511261000051787",
    "remarkName": "remarkName123",
    "appKey": "fb4aa76af1b543efba848e6f5ba774b7",
    "timestamp": 1764745934,
    "sign": ""
}
```

#### 出参示例

```mysql
{
    "code": 0, //code为0表示成功
    "msg": "成功",
    "timestamp": 1764745770876,
}
```

### 3.2 订单

#### 3.2.1 获取订单详情接口

#### 接口地址

```plaintext
POST /api/youpin/rent-connector/order/v1/detail
```

#### 请求参数

| **参数名** | **类型** | **必填** | **说明** |
| --- | --- | --- | --- |
| purchaseOrderNo | String | 是 | 卖家订单号 |
| appKey | String | 是 | 卖家唯一标识（由平台分配）。 |
| userId | Long | 否 | 用户ID（由AOP自动填充，无需手动传递）。 |
| sign | String | 是 | 请求签名（需按规则生成）。 |
| timestamp | Long | 是 | 秒时间戳 5分钟内有效（秒级，需确保服务器时间同步）。 |

#### 请求示例

```json
{
  "purchaseOrderNo": "RP176241805933643620",
  "appKey": "1234",
  "sign": "9F80EF2A1C6DBFE4392426B7F55A8898",
  "timestamp": 1764657248
}
```

#### 出参示例

```mysql
{
    "code": 0,
    "msg": "成功",
    "timestamp": 1764657561586,
    "data": {
        "purchaseOrderNo": "RP176241805933643620", 
        "productId": "202511021000000190",//商品id
        "gameId": 1,
        "gameName": "王者荣耀",
        "gameLogoUrl": "https://acctrade-images-test.oss-cn-shenzhen.aliyuncs.com/",
        "orderStatus": 8000,//订单状态
        "productPicUrl": "https://acctrade-images-test.oss-cn-shenzhen.aliyuncs.com/rent/img/game_data/81078c13069f44cbb939f5a76af4e558.png",
        "title": "【V6】 典藏数「18」 无限飓风号/ 九霄神辉/ 天鹅之梦/ 倪克斯神谕/ 最初的交响",
        "rentPrice": 3.60, //时租价格
        "createTime": 1762418060000,
        "rentStartTime": 1762418059000, //租赁开始时间戳
        "rentEndTime": 1763894059000, //租赁结束时间戳
        "rentHour": 2, //租赁时长
        "systemTime": 1764657561566,
        "receivableAmount": 6.00,//应收金额 = 结算金额+退款金额
        "settlementAmount": 0.00,//结算金额
        "returnAmount": null, //退款金额
        "settlementStatus": 0, //分账状态 0, "未结算" 2, "已结算"
        "complaintStatus": 2,//投诉状态
        "complaintId": "202511061000000011",//投诉id
        "rentGiveList": null,
        "accountNo":"",
        "remarkName":""
    }
}
```

```mysql
3000, "租赁中"
4000, "已完成"
4100, "退款中"
4200, "已退款"
8000, "结算中"
```

#### 3.2.2 获取订单列表接口

#### 接口地址

```plaintext
POST /api/youpin/rent-connector/order/v1/list
```

#### 请求参数

以下是根据提供的参数信息生成的表格：

| **参数名** | **类型** | **必填** | **说明** |
| --- | --- | --- | --- |
| orderStatus | int | 是 | 订单状态：<br>0, "全部状态"<br>3000, "租赁中",<br>4000, "已完成", <br>9900, "投诉/撤单" |
| updateStartTime | long | \- | 更新时间起，给北京时间，秒级时间戳 默认查询最近30天，时间限制30天 |
| updateEndTime | long | \- | 更新时间止，给北京时间，秒级时间戳 |
| page | int | \- | 页码 |
| pageSize | int | \- | 每页数量，默认10，最大50，限制查询5W条 |
| appKey | string | 是 | 卖家唯一标识 |
| userId | long | \- | 自动根据appKey填充 |
| sign | string | 是 | 签名值 |
| timestamp | long | 是 | 时间戳 5分钟内有效（秒级，需确保服务器时间同步）。 |

#### 请求示例

```mysql
{
  "orderStatus": 0,
  "updateStartTime": 1761745522,
  "updateEndTime":  1762757628,
  "page": 1,
  "pageSize": 20,
  "appKey": "1234",
  "sign": "F26FD44D0A3089A84E1D168AD483743D",
  "timestamp": 1764662809
}
```

#### 出参示例

```mysql
{
    "code": 0,
    "msg": "成功",
    "timestamp": 1764662817469,
    "data": {
        "orderList": [
            {
                "purchaseOrderNo": "RP176241805933643620",
                "productId": "202511021000000190",
                "gameId": 1,
                "gameName": "王者荣耀",
                "gameLogoUrl": "https://acctrade-images-test.oss-cn-shenzhen.aliyuncs.com/",
                "orderStatus": 4000,
                "productPicUrl": "https://acctrade-images-test.oss-cn-shenzhen.aliyuncs.com/rent/img/game_data/81078c13069f44cbb939f5a76af4e558.png",
                "createTime": 1762418060000,
                "receivableAmount": 6.00,
                "settlementAmount": 0.00,
                "returnAmount": null,
                "title": "【V6】 典藏数「18」 无限飓风号/ 九霄神辉/ 天鹅之梦/ 倪克斯神谕/ 最初的交响",
                "rentPrice": 3.60,
                "rentStartTime": 1762418059000,
                "rentEndTime": 1763894059000,
                "rentHour": 2,
                "systemTime": 1764662817464,
                "complaintStatus": 2,
                "complaintId": "202511061000000011",
                "accountNo":"",
                "remarkName":""
            },
            {
                "purchaseOrderNo": "RP176241637723514313",
                "productId": "202511021000000191",
                "gameId": 1,
                "gameName": "王者荣耀",
                "gameLogoUrl": "https://acctrade-images-test.oss-cn-shenzhen.aliyuncs.com/",
                "orderStatus": 8000,
                "productPicUrl": "https://acctrade-images-test.oss-cn-shenzhen.aliyuncs.com/rent/img/game_data/400ec0ada63e4bbbac27fb3bb266f3f4.png",
                "createTime": 1762416378000,
                "receivableAmount": 6.00,
                "settlementAmount": 0.00,
                "returnAmount": null,
                "title": "锐锐用",
                "rentPrice": 3.60,
                "rentStartTime": 1762416377000,
                "rentEndTime": 1762423577000,
                "rentHour": 2,
                "systemTime": 1764662817464,
                "complaintStatus": 2,
                "complaintId": "202511061000000010"
            },
            {
                "purchaseOrderNo": "RP176182089522353159",
                "productId": "202510291000000150",
                "gameId": 1,
                "gameName": "王者荣耀",
                "gameLogoUrl": "https://acctrade-images-test.oss-cn-shenzhen.aliyuncs.com/",
                "orderStatus": 8000,
                "productPicUrl": "https://acctrade-images-test.oss-cn-shenzhen.aliyuncs.com/",
                "createTime": 1761820896000,
                "receivableAmount": 3.60,
                "settlementAmount": 3.60,
                "returnAmount": null,
                "title": "【V10】 苍天翔龙/ 山林之子/ 破灭刃锋/ 传说之刃/ 叛逆吟游/",
                "rentPrice": 3.60,
                "rentStartTime": 1761820895000,
                "rentEndTime": 1761824495000,
                "rentHour": 1,
                "systemTime": 1764662817464,
                "complaintStatus": 0,
                "complaintId": null,
                "accountNo":"",
                "remarkName":""
            },
            {
                "purchaseOrderNo": "RP176181875945607926",
                "productId": "202510291000000150",
                "gameId": 1,
                "gameName": "王者荣耀",
                "gameLogoUrl": "https://acctrade-images-test.oss-cn-shenzhen.aliyuncs.com/",
                "orderStatus": 8000,
                "productPicUrl": "https://acctrade-images-test.oss-cn-shenzhen.aliyuncs.com/",
                "createTime": 1761818760000,
                "receivableAmount": 3.60,
                "settlementAmount": 3.60,
                "returnAmount": null,
                "title": "【V10】 苍天翔龙/ 山林之子/ 破灭刃锋/ 传说之刃/ 叛逆吟游/",
                "rentPrice": 3.60,
                "rentStartTime": 1762537492000,
                "rentEndTime": 1762541092000,
                "rentHour": 1,
                "systemTime": 1764662817464,
                "complaintStatus": 0,
                "complaintId": null,
                "accountNo":"",
                "remarkName":""
            },
            {
                "purchaseOrderNo": "RP176181749181147618",
                "productId": "202510291000000150",
                "gameId": 1,
                "gameName": "王者荣耀",
                "gameLogoUrl": "https://acctrade-images-test.oss-cn-shenzhen.aliyuncs.com/",
                "orderStatus": 4000,
                "productPicUrl": "https://acctrade-images-test.oss-cn-shenzhen.aliyuncs.com/",
                "createTime": 1761817492000,
                "receivableAmount": 720.00,
                "settlementAmount": 720.00,
                "returnAmount": 0.00,
                "title": "【V10】 苍天翔龙/ 山林之子/ 破灭刃锋/ 传说之刃/ 叛逆吟游/",
                "rentPrice": 3.60,
                "rentStartTime": 1761817492000,
                "rentEndTime": 1762537492000,
                "rentHour": 200,
                "systemTime": 1764662817464,
                "complaintStatus": 0,
                "complaintId": null,
                "accountNo":"",
                "remarkName":""
            },
            {
                "purchaseOrderNo": "RP176179325931538537",
                "productId": "202510291000000150",
                "gameId": 1,
                "gameName": "王者荣耀",
                "gameLogoUrl": "https://acctrade-images-test.oss-cn-shenzhen.aliyuncs.com/",
                "orderStatus": 8000,
                "productPicUrl": "https://acctrade-images-test.oss-cn-shenzhen.aliyuncs.com/",
                "createTime": 1761793260000,
                "receivableAmount": 3.60,
                "settlementAmount": 3.60,
                "returnAmount": null,
                "title": "【V10】 苍天翔龙/ 山林之子/ 破灭刃锋/ 传说之刃/ 叛逆吟游/",
                "rentPrice": 3.60,
                "rentStartTime": 1761793259000,
                "rentEndTime": 1761796859000,
                "rentHour": 1,
                "systemTime": 1764662817464,
                "complaintStatus": 0,
                "complaintId": null,
                "accountNo":"",
                "remarkName":""
            },
            {
                "purchaseOrderNo": "RP176174552161356975",
                "productId": "202510291000000150",
                "gameId": 1,
                "gameName": "王者荣耀",
                "gameLogoUrl": "https://acctrade-images-test.oss-cn-shenzhen.aliyuncs.com/",
                "orderStatus": 8000,
                "productPicUrl": "https://acctrade-images-test.oss-cn-shenzhen.aliyuncs.com/",
                "createTime": 1761745522000,
                "receivableAmount": 3.60,
                "settlementAmount": 3.60,
                "returnAmount": null,
                "title": "【V10】 苍天翔龙/ 山林之子/ 破灭刃锋/ 传说之刃/ 叛逆吟游/",
                "rentPrice": 3.60,
                "rentStartTime": 1761745522000,
                "rentEndTime": 1761749122000,
                "rentHour": 1,
                "systemTime": 1764662817464,
                "complaintStatus": 0,
                "complaintId": null,
                "accountNo":"",
                "remarkName":""
            }
        ],
        "totalCount": 7
    }
}
```

## 4. 版本更新

1.  新增修改备注接口
    
2.  商品列表接口入参增加账号和备注搜索，出参增加remarkName（商家备注）字段
    
3.  订单列表和详情接口增加remarkName（备注）和accountNo（游戏账号）字段