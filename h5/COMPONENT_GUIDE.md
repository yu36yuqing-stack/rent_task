# H5 Component Guide

## 1. 目标

统一 H5 页面视觉与交互，避免新页面重复造样式。  
新需求优先复用已有组件类，只有在确实无法满足时才新增组件或变体。

## 2. 设计 Token（基础变量）

来源：`h5/public/css/app.css` 的 `:root`。

- 颜色：`--bg` `--ink` `--muted` `--line` `--card` `--brand` `--ok` `--warn` `--danger`
- 按钮：`--btn-green-bg` `--btn-green-border` `--btn-green-text`
- 阴影：`--shadow`

规则：

- 不直接硬编码新颜色，优先复用 token。
- 新增颜色前先评估是否可由现有 token 组合实现。

## 3. 通用组件清单

来源：`h5/public/css/app.css`

- Layout
  - `.wrap`：主容器
  - `.orders-view`：列表页垂直栅格容器
  - `.panel`：通用卡片容器
- Header / Drawer
  - `.hero` `.hero-toolbar` `.hero-menu-trigger` `.hero-menu-title`
  - `.drawer-item` `.drawer-item.active`
- Button
  - `.btn` `.btn-primary` `.btn-ghost` `.btn-ok` `.btn-danger`
- Tabs / Filters
  - `.orders-tabs-row`
  - `.orders-tabs` + `.orders-tab`
  - `.orders-quick` + `.orders-quick-item`
- Card
  - `.order-card` `.order-card-top` `.order-card-role` `.order-card-line`
- Status Chip / Tag
  - `.order-chip`（状态 badge）
  - `.plat` / `.plat-renting` / `.plat-abnormal`（信息标签）
- Pager
  - `.pager` `.page-info`
- Overlay / Sheet
  - `.overlay` `.overlay-card`
  - `.sheet` `.sheet-card` `.sheet-actions` `.sheet-btn`

## 4. 复用优先级

1. 优先直接复用已有类（不新增样式）。
2. 其次新增“变体类”（如 `order-chip.xxx`），不改基础组件语义。
3. 最后才新增新组件；新增时需补齐本指南组件清单。

## 5. 命名规范

- 使用“基础类 + 变体类”：
  - 例：`.order-chip` + `.order-chip.progress`
- 页面专属样式必须带页面锚点，避免污染全局：
  - 例：`#riskView .order-card { ... }`
- 禁止无语义缩写类名（如 `.x1` `.box2`）。

## 6. 页面落地规范

- 新页面应优先按“订单页结构”搭建：
  - 顶部筛选：`orders-tabs-row`
  - 列表卡片：`order-card`
  - 分页：`pager`
- 文案调整优先在 JS 渲染层处理，不新增仅为文案存在的样式类。

## 7. 变更流程

当前端新增/修改组件时，必须同步：

1. 更新 `h5/public/css/app.css`（组件定义）
2. 更新 `h5/COMPONENT_GUIDE.md`（组件清单或规范）
3. 说明“复用了哪些类、为何新增变体”

