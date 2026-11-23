# GTA6 主机商品：本地验收

2026-11-23，本地 H5、Node 24、临时 SQLite、模拟悠悠接口、Chrome 375px 和 1280px。未发布生产。

| 范围 | 结果 |
| --- | --- |
| 真实渠道只读验证 | UID=8 返回 1 台，轻舟Xbox / Xbox Series X / 8.50 元每小时 / 租赁中。只执行主机列表查询，成本测试不操作此主机。 |
| 拉取与存储 | 验证 HTTP 方法、签名、商家隔离、分页、重复项、长整数 ID、无效响应、不前进分页、中途失败保持快照、数据库事务回滚。有效空列表隐藏旧设备，重新出现后保留原成本。 |
| 列表及成本 | GTA6、全部分页、租赁中、已售隔离；采购修改、维护成本、成本明细和删除、租户隔离。主机不写入账号主档；主机身份请求在线查询和解除授权返回 400。 |
| 视觉与交互 | 桌面和手机检查王者/GTA6/和平顺序、图标加载、页面宽度、卡片单一操作、成本弹窗及查看明细。截图位于 coverage/rental-device/preview-{375,1280}.png，使用测试主机。 |
| 相关回归 | product_rent_income_h5_test、h5_csgo_more_ops_smoke_test、five_e_product_sync_smoke_test、game_identity_smoke_test、product_income_summary_frontend_test 全部通过。后者的模拟 DOM 补全 dataset，不更改原断言。 |

## 复测

- `npm run test:rental-device`：隔离的渠道、数据库、H5 API 集成测试。
- `npm run coverage:rental-device`：含浏览器交互和核心行覆盖率门禁。可用 `CHROME_PATH` 指定 Chrome。
- 新增主机服务、数据访问、迁移三个文件：行 100%、分支 92%、函数 100%。这是新增核心范围，不代表全仓或既有 H5/渠道大文件。共享入口使用定向回归验证。

## 启用和回退

随商品同步运行的前提是启用悠悠授权，并且当前 UID 在系统配置 `uuzuhao.rental_device_sync` 的 `user_ids` 里。无配置、空列表均不发起主机请求。例：`{"user_ids":[8]}`；通过现有 `scripts/system_config.js get/set` 查看版本后更新，不硬编码商家。回退采集时移除 UID；不删除任何设备或成本。若需撤回展示，回退应用版本即可。

H5「刷新列表」只重读快照，不触发账号自动化；开通用户的全局商品同步才更新渠道快照。本地预览采用 UID=8 的一次查询快照，没有改生产或自动同步名单。没有跨多轮真实定时调度或生产压测。
