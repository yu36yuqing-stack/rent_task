# 商品列表渠道档位与时租价测试报告

日期：2026-10-02。结果：通过；仅本地实现与验证，未发布生产。

## 1. 范围与实现

- 保留渠道原上下架/租赁状态，后面追加 ` · 2档 · ¥2.30/时`。
- 当前档位来自各渠道 `applied_tier`，不使用目标档位、订单数或最新配置推导。
- 时租价复用渠道 Adapter 解析最新商品同步快照；不是实时价格查询。
- 不展示调价失败、待调价、目标档位等附加状态。未知档为“未应用”，缺价为 `--`。
- 停用渠道、未关联商品及已售商品不追加定价。5E 保持原展示，不虚构阶梯档位。
- 新增 `price/product_channel_price_service.js` 与公共格式化组件 `h5/public/js/ui/channel_price_summary.js`。
- 商品列表分页后传入该页原账号快照；授权及阶梯运行状态按用户批量读取，不逐卡请求，不调用渠道调价 API。
- 读取运行状态失败时保留快照价、档位显示未应用；授权读取失败时不追加摘要，商品列表仍可用。
- 修改 `h5/local_h5_server.js`、`menu_products.js`、`app.css`、`index.html`、组件指南与 npm 测试入口。无新表、新迁移或阶梯执行规则变更。

## 2. 环境与执行结果

环境：macOS，本机 Node.js、SQLite、c8、无头 Chrome。
新增接口集成测试使用临时目录下五个独立数据库、临时端口，关闭风控后台 Worker；浏览器使用真实 H5 HTML/CSS/JS，拦截资源并提供 fixture，不连接业务 API。

| 执行项 | 命令 | 结果 |
| --- | --- | --- |
| 服务、前端、真实 HTTP 集成三组定向测试及覆盖率门禁 | `npm run coverage:product-channel-price` | 全部通过 |
| 既有阶梯定价、订单、迁移相关回归 20 组 | `npm run test:price-ladder` | 全部通过 |
| 手机/桌面与四游戏组合 | `npm run test:product-channel-price-visual` | 24 组合通过 |
| 解除授权卡片回归 | `node test/h5_auth_revoke_card_smoke_test.js` | 通过 |
| CS2 更多操作回归 | `node test/h5_csgo_more_ops_smoke_test.js` | 通过 |
| 差异格式检查 | `git diff --check` | 通过 |

主要用例：不同渠道档位、失败保留旧档、待执行/阻塞状态、档位边界、缺失/非法价格、金额格式、缺少运行记录、停用渠道、未关联商品、软删除、已售、同账号跨用户/跨游戏隔离、输入不变、批量读取、运行库读取异常、授权读取异常、鉴权、分页、空页、游戏筛选、租赁中筛选、静态脚本加载顺序、无目标/异常文案、无额外业务 API 调用。

视觉范围：320/375/390/430/768/1280px，王者荣耀、和平精英、CFM、CS2；真实列表渲染，长名称及较长金额，不出现渠道标签文本裁剪或页面横向溢出。CSS 换行限制仅作用于商品渠道标签，不改变解除授权按钮或其他页面状态标签。

## 3. 覆盖率

口径：新核心模块全文件统计；两个既有大文件另按 HEAD 差异统计改动行。未排除新核心代码、未以目标档替代已应用档。门禁要求各文件改动行及新核心全文件行覆盖率至少 90%。

| 文件 | 改动/新增行覆盖 | 全文件行 | 全文件分支 | 全文件函数 |
| --- | --- | --- | --- | --- |
| `price/product_channel_price_service.js` | 58/58，100% | 100% | 100% | 100% |
| `h5/public/js/ui/channel_price_summary.js` | 14/14，100% | 100% | 100% | 100% |
| `h5/local_h5_server.js` | 7/7，100% | 26.30% | 43.69% | 21% |
| `h5/public/js/menu_products.js` | 2/2，100% | 11.01% | 72.22% | 5.74% |

合计改动/新增可执行行：81/81，100%。这是本次变更覆盖率，不是全仓覆盖率。既有 H5 大文件仅测试本次相关链路，未对其全部其他功能宣称 90% 覆盖。

报告：`coverage/product-channel-price/index.html`。
明细：`coverage/product-channel-price/changed-lines.json`、`coverage-summary.json`。
视觉检查：`coverage/product-channel-price/visual-results.json`。
截图：`coverage/product-channel-price/product-price-390.png`、`product-price-1280.png`。
覆盖率目录继续保持 Git 忽略，不提交生成物。

## 4. 本地预览与剩余风险

- 已通过现有 launchd 服务 `com.renttask.h5.local` 重启本地 H5，端口 8080。
- `/api/ping` 返回 200、`ok: true`，新版公共脚本返回 200；前端资源版本已更新以避免旧缓存。
- 时租价是同步快照，渠道手工修改后的价格需等待商品同步更新；档位仍表示最后成功应用记录，两者不保证实时一致。
- 本地 `rent_robot_price.db` 的只读 `quick_check` 报告原有损坏：`price_publish_item_log`（rootpage 9）出现无效页号；本次没有修复、替换或清空该库。新摘要不读取价格发布日志表，且覆盖了运行状态读取异常的降级路径。
- 本次不涉及生产发布、生产数据库写入、数据迁移或修复；未提交/覆盖用户已有数据库变更。回滚仅需回退本次代码，保留业务库。
