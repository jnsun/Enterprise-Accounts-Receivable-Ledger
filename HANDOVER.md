# 企业应收账款台账系统 · 开发交接文档

> **本文给接手写代码的人看。**
> `README.md` 讲「这个系统有什么功能、怎么部署」；本文讲「代码是怎么组织的、每个模块对外暴露什么、
> 改一处会牵动哪些地方、哪些坑已经踩过」。
> 业务术语的准确定义在 `CONTEXT.md`；设计语言（配色/字号/间距）在 `.impeccable.md`；
> 三个架构决策在 `docs/adr/`。本文会引用它们，但不重复抄录。

最后同步的版本：`v20260915s`（提交 `8cb2036`）　文档编写日期：2026-09-15

---

## 0. 30 秒速览

| 问题 | 答案 |
|---|---|
| 这是什么 | 地质勘查单位（山西省第十地质工程勘察院）财务部门的**应收账款台账**，一行 = 一个合同 |
| 谁用 | 财务（管理员，管全部）+ 30 个实体部门的报账员（只管填催收信息） |
| 技术栈 | **原生 HTML/CSS/JS（无框架、无构建）+ Supabase JS SDK v2 + SheetJS**，静态托管 |
| 数据库 | Supabase 云端项目 `bttnxyexkbsskmqttbzi`（独立实例，**与月报/证照/安全生产系统完全隔离**） |
| 后端逻辑 | 全部在数据库：RLS 策略 + PostgreSQL 函数（RPC）。**没有自建后端服务** |
| 前端规模 | 16 个 JS 模块 5546 行 + 1622 行 CSS + 1 个 HTML 入口 |
| 数据库规模 | 13 张表（含 2 张月报系统共用）+ 15 个函数 + 40 条 RLS 策略 + 3 个触发器 + 8 个索引 |
| 怎么跑 | 直接双击 `index.html`（需联网）或用任意静态服务器；**无 npm install、无构建步骤** |
| 版本号机制 | `index.html` 里所有 `<script>/<link>` 带 `?v=20260915s`，改前端后必须升这个号，否则用户浏览器用旧缓存 |

**一句话架构**：浏览器直接调 Supabase 的 REST/Auth/Storage 接口，权限由数据库 RLS 强制；
前端只做「渲染 + 组装请求」，任何绕过前端直接调 API 的请求同样会被 RLS 拦住。

---

## 1. 快速上手

### 1.1 跑起来（不需要任何安装）

```bash
# 方式一：直接开文件（最简单，适合看界面）
start index.html            # Windows

# 方式二：本地静态服务器（推荐，避免个别浏览器对 file:// 的 CORS 限制）
python -m http.server 8080  # 然后访问 http://localhost:8080
```

必需的两个 vendor 库（`vendor/supabase.min.js`、`vendor/xlsx.full.min.js`）**不在仓库里**
（`.gitignore` 忽略，见 3.3）。缺失时 `index.html` 里那两行 `document.write` 会自动从
jsDelivr CDN 加载 —— 所以联网就能跑，断网才需要手动补 vendor。

### 1.2 测试账号

系统用的是**独立账号体系** `ar_users`，与月报系统共用 `auth.users` 但不共用角色。

| 角色 | 登录方式 | 说明 |
|---|---|---|
| 超级管理员 | 邮箱 + 密码 | 建库时用 SQL 指定（`ar_users.ar_role='admin' AND ar_super_admin=TRUE`），可管全部账号 |
| 管理员（财务） | 邮箱 + 密码 | 全部台账权限；可管报账员账号、部门、选项字典 |
| 报账员 | 邮箱**或手机号** + 密码 | 权限逐人开放（7 项），只能编辑催收跟踪字段 |

登录标识符支持 **邮箱 / 手机号**。手机号走数据库函数 `ar_resolve_login_identifier()` 换成邮箱
再登录（`js/auth.js: 86`）。注意它**只查 `ar_users`**，不会误命中月报系统的账号。

> **要新建测试账号**：用超管登录 → 「用户管理」→ 新增账号（走 RPC `ar_create_user`）。
> 直接建库后的首个超管只能用 SQL 建，方法在 `sql/init-new-instance.sql` 末尾注释里。

### 1.3 环境信息（交接时必须一并给到）

| 项 | 值 | 位置 |
|---|---|---|
| Supabase URL | `https://bttnxyexkbsskmqttbzi.supabase.co` | `js/config.js: 13` |
| 发布密钥（= 旧 anon key） | `sb_publishable_IHE3a0i6REFt9NOY5d7QhQ_mbgcfTQO` | `js/config.js: 14` |
| Supabase 控制台账号 | 交接时另行交付 | — |
| GitHub 仓库 | `github.com/jnsun/Enterprise-Accounts-Receivable-Ledger`（**公开仓库**） | — |
| 试运行地址 | `https://jnsun.github.io/Enterprise-Accounts-Receivable-Ledger/` | GitHub Pages |
| 正式地址 | `https://www.safety.sx.cn/ledger/` | 腾讯云静态站点 |
| 旧数据库（已弃用） | 腾讯云自托管实例（IP 交接时另行告知） | 见 10.4 |

> ⚠ `sb_publishable_` 是**发布密钥**，设计上就是给前端用的，放进源码仓库不算泄露
> （真正的保护来自 RLS）。但**数据库密码、Supabase 控制台账号、服务器 SSH 私钥绝不能进仓库**。

---

## 2. 技术栈与关键架构决策

### 2.1 技术栈清单

| 层 | 选型 | 为什么 |
|---|---|---|
| 前端 | **原生 JS（ES6+）+ 全局对象模块** | 无构建、无依赖地狱；改完刷新即见效果（详见 2.2） |
| 样式 | 单文件 `css/style.css`，CSS 自定义属性做设计令牌 | 令牌集中，改主题不用搜全站 |
| 数据库 | Supabase（PostgreSQL 15） | 自带 Auth / REST / Storage + RLS，省掉整个后端 |
| 认证 | Supabase Auth（邮箱密码） | 自带会话持久化、刷新令牌 |
| 文件 | Supabase Storage 私有桶 `ar-attachments` | 签名 URL 下载，路径不可猜测 |
| 表格 | **手写** `<table>` + CSS `position: sticky` | 台账是宽表（24+ 列、3000px+），第三方表格库在这个场景下更难调 |
| 看板图表 | **手写 SVG**（`js/dashboard.js`） | 只有条形图/堆叠条/分组柱三种，引 ECharts 是 1MB 换 200 行 |
| Excel | SheetJS（`xlsx.full.min.js`） | 读写 .xlsx，导入导出共用 |
| 部署 | 纯静态文件 | 无服务端进程要维护 |

### 2.2 为什么不用框架（**接手后请先读这条**）

这个决定是刻意的，不是历史遗留：

1. **用户是编程新手，这个项目同时也是他的学习载体**。React/Vue 的构建链、状态管理、
   生命周期会把「数据从哪来、怎么落到 DOM」这件事藏起来。
2. **系统就 7 个页面、1 张主表**。没有复杂状态流，用全局对象 + 全量重渲染完全够用。
3. **调试成本**：出问题时能在浏览器 Elements 面板直接看到最终 DOM 与源码一一对应，
   不需要 sourcemap、不需要区分「是框架的问题还是我的问题」。

**代价**（接手时要接受）：

- 模块间靠**全局对象**通信（`Ledger`、`Auth`、`ColPrefs`…都挂在 `window` 上）。
  没有 import/export，**加载顺序写死在 `index.html` 里**，调整顺序可能引发 `undefined`。
- 渲染是**拼字符串 + `innerHTML`**。好处是直观，代价是**反复重渲染会丢焦点、丢滚动位置、
  丢事件绑定**，必须用局部刷新（见 8.3 铁律）。
- 没有类型检查。字段名拼错要等运行时才发现，所以 `js/fields.js` 的 `FIELD_DEFS`
  是唯一的字段真相源，到处都以它为准。

### 2.3 「无后端」的具体含义

```
浏览器 ──── HTTPS ────► Supabase（Kong 网关）
                          ├── /auth/v1    认证，发 JWT
                          ├── /rest/v1    PostgREST：把表变成 REST API
                          └── /storage/v1 对象存储
                                │
                                ▼
                          PostgreSQL + RLS 策略 ← 真正的权限边界
```

- 前端 `sb.from('ar_ledger').select('*')` 实际发的是 `GET /rest/v1/ar_ledger?select=*`。
- **权限不靠前端判断**：`Auth.can('delete')` 只用来决定「按钮显不显示」，
  真正阻止越权的是 RLS。前端隐藏按钮 + 数据库拒绝，两层都要有。
- 复杂逻辑（建账号、删账号、重算挂账时间、手机号换邮箱）走 **RPC**（数据库函数），
  因为这些操作需要 `SUPERUSER`/`SECURITY DEFINER` 权限或跨表事务。

---

## 3. 目录与文件职责

### 3.1 全量文件清单（含行数，便于估工作量）

```
index.html                          35 行   单页应用入口；所有脚本的加载顺序在这里
css/style.css                     1622 行   全部样式（设计令牌 + 组件 + 响应式 + 打印）

js/  （16 个模块，5546 行）
  config.js                         36 行   Supabase 连接配置 + 客户端实例
  fields.js                        129 行   ★ 字段定义（唯一真相源）
  dict.js                           64 行   下拉选项缓存（ar_dict + 内置兜底）
  colprefs.js                      416 行   列偏好：显示/顺序/左侧冻结
  utils.js                         217 行   格式化 / DOM / toast / confirm / 防抖
  auth.js                          139 行   登录 / 会话 / 权限
  app.js                           277 行   应用入口：路由、侧边栏、登录页
  dashboard.js                     581 行   数据看板（手写 SVG 图表）
  ledger.js                       1316 行   ★ 台账核心（列表/筛选/编辑/附件/明细）
  attachments.js                   186 行   附件上传下载
  importer.js                      574 行   Excel 导入（台账）
  detailimporter.js                292 行   开票/回款明细批量导入
  exporter.js                      183 行   Excel 导出
  batches.js                        76 行   导入批次管理
  admin.js                         530 行   用户管理 + 部门管理 + 系统设置
  dictadmin.js                     530 行   选项管理（含「在用」统计与孤儿值提示）

sql/  （10 个脚本，3461 行）
  init-new-instance.sql           1461 行   ★ 全新库一键初始化（其余脚本的拼接）
  schema-standalone.sql            475 行   基础建表
  schema.sql                       319 行   v1 共用实例版（历史存档，勿用）
  ar-users-v2.sql                  451 行   独立账号体系 ar_users
  ar-user-management.sql           379 行   旧版（已被 ar-users-v2 取代，存档）
  upgrade-v3-indicators.sql        300 行   v3：新列 + 字典 + 附件 + 字段保护
  upgrade-v3.1-receipts.sql         78 行   v3.1：回款明细表
  upgrade-v3.2-admin-rls.sql       166 行   v3.2：管理员判定修复（必做）
  update-dict-seeds.sql            115 行   真实字典/部门种子
  verify-setup.sql                 115 行   ★ 部署自检（只读）

docs/
  adr/0001-contract-granularity.md          台账以合同为粒度
  adr/0002-manual-debt-status.md            不做自动逾期判定
  adr/0003-contract-amount-into-final.md    合同额自动带入决算
  preview/                                 视觉预览工具链（见第 9 节）
    mock-data.js                     164 行
    build-dashboard-preview.js        64 行
    build-admin-preview.js           173 行
    build-ledger-preview.js          570 行
    build-dict-preview.js            352 行
    build-import-preview.js          235 行
    verify-import-dept.js            230 行   导入归属链路回归测试

根目录其他
  README.md                        333 行   功能说明 + 部署步骤
  CONTEXT.md                                业务术语表（需求拷问产出）
  .impeccable.md                            设计上下文（受众/场景/设计原则）
  HANDOVER.md                               本文
```

### 3.2 模块依赖关系（谁调谁）

```
                    ┌─────────────┐
                    │  index.html │  决定加载顺序
                    └──────┬──────┘
                           ▼
  config.js ──► fields.js ──► dict.js ──► colprefs.js ──► utils.js ──► auth.js
                                                                        │
                                    ┌───────────────────────────────────┤
                                    ▼                                   ▼
                              dashboard.js                        (Auth 被所有模块用)
                                    ▲
  ledger.js ◄───────────────────────┘
     │  ├──► attachments.js   （Ledger.load 后调 loadCounts；Editor 里渲染附件区）
     │  ├──► importer.js      （工具栏「导入 Excel」）
     │  ├──► exporter.js      （工具栏「导出 Excel」）
     │  └──► colprefs.js      （列设置面板）
     ├──► detailimporter.js   （由 importer.js 打开）
     └──► batches.js          （批次视图）

  admin.js    ──► 会写 Ledger.departments（loadDepts 同步部门字典）
  dictadmin.js──► 依赖 fields.js(FIELD_DEFS) + dict.js(Dicts)
  app.js      ──► 串起所有模块（唯一的路由 + 启动入口）
```

**关键依赖事实**（改代码时会用到）：

- `fields.js` 必须在 `app.js` 之前加载 —— 但真正做到的是**所有模块都在全局作用域**
  且**函数体内才引用**，所以只要 `app.js` 的 `boot()` 在 `DOMContentLoaded` 后跑，
  顺序其实不严格。**唯一严格的是 `config.js` 第一**（它建 `sb` 实例）。
- `admin.js` 的 `loadDepts()` 会把部门写回 `Ledger.departments` —— 用户在用户管理页
  新增部门后，台账页的部门下拉/筛选会同步更新。这是**跨模块写状态**的刻意设计。
- `dictadmin.js` 保存选项后调 `Dicts.load()` 刷新全局字典缓存 —— 保存后全站下拉即时生效。

### 3.3 `.gitignore` 忽略了什么

```
vendor/          # supabase-js / xlsx（几十 MB 的第三方库，不入库；缺失走 CDN）
.workbuddy/      # 本地工作区（截图、记忆、临时脚本），不入库
node_modules/
```

**注意**：`.workbuddy/` 里存着项目长期记忆（`.workbuddy/memory/`）与预览截图
（`.workbuddy/shots/`）。它**不是缓存，是项目资料**，不要删。但它也不进仓库，
所以它记录的经验在交接时**不会自动传过去** —— 重要结论已汇总进本文第 8 节。

---

## 4. 数据模型

### 4.1 表清单与关系图

共 **13 张表**，全部在 `public` schema（另有 1 个 Storage 桶）。
其中 **2 张是月报系统的表**（`departments` / `profiles`），台账只读复用、不负责维护。

```
auth.users（Supabase 内置，登录账号）
    │
    ├──► profiles ──────────────► departments      ← 【月报系统的表，本系统只读复用】
    │    （注册触发器自动建）        （部门编码/名称，30 个种子）
    │      role 恒为 'reporter'
    │      department_id → departments.id
    │
    └──► ar_users ──────────────► ar_departments   ← 【台账自己的表，两套互不相干】
         （台账身份：ar_role）       （台账部门，31 个，可被增删改）
           role: admin / user / disabled
           ar_super_admin, ar_protected

ar_users.user_id ──► ar_user_perms（7 项权限，jsonb）
ar_users.user_id ──► ar_user_prefs（列偏好，jsonb）

ar_departments.id ──► ar_ledger.department_id      【ON DELETE RESTRICT】
ar_ledger.id ──► ar_invoices      【ON DELETE CASCADE】
ar_ledger.id ──► ar_receipts      【ON DELETE CASCADE】
ar_ledger.id ──► ar_attachments   【ON DELETE CASCADE】──► Storage: ar-attachments/
ar_import_batches.id ──► ar_ledger.batch_id        【ON DELETE SET NULL】

ar_dict（下拉选项字典，12 个 category）
ar_settings（全局设置，恒 1 行）
```

> ### ⚠ 最容易搞混的一点：**两套部门表**
>
> | | 月报系统 | 台账系统 |
> |---|---|---|
> | 表名 | `departments` | **`ar_departments`** |
> | 谁在用 | `profiles.department_id` | **`ar_users.department_id`**、**`ar_ledger.department_id`** |
> | 谁维护 | 月报系统（本系统不碰） | 台账「用户管理」页的部门卡片 |
> | 前端的部门下拉 | ✗ 不用 | ✓ `Ledger.departments`（来自 `ar_departments`） |
>
> **台账的一切业务只认 `ar_departments`。** 建库时它从 `departments` 复制了一份初始数据
> （沿用原 UUID，`sql/init-new-instance.sql: 919`），之后两边各自独立演进。
> 看到 `profiles.department_id` 出现在台账代码里，基本就是 bug。

### 4.2 各表列定义

#### `ar_ledger` — 台账主表（核心）

业务粒度：**一行 = 一个合同**（见 `docs/adr/0001`）。

| 列名 | 类型 | 界面标签 | 说明 |
|---|---|---|---|
| `id` | UUID PK | — | 主键 |
| `department_id` | UUID → `ar_departments(id)` | **归属部门** | **RLS 按此列隔离**；`ON DELETE RESTRICT`（有数据时部门删不掉） |
| `batch_id` | UUID → `ar_import_batches(id)` | — | 来源批次，整批删除靠它 |
| `contract_no` | TEXT | 合同编号 | **业务唯一标识**，导入判重就按它（库层没加唯一约束，判重在前端） |
| `project_name` | TEXT | 项目名称 | 界面按 3 行 × 12 字截断（`Utils.clampName`） |
| `owner_unit` | TEXT | 客户名称 | 带 datalist 建议（预设 + 库内历史值） |
| `client_attr` | TEXT | 客户属性 | 字典 `client_attr`，15 个选项，带「其他」自由填写 |
| `creditor_unit` | TEXT | 单位 | 字典 `unit`，**债权主体法人口径**（物化院/六勘院/测绘院/禹地公司） |
| `work_nature` | TEXT | 工作性质 | 字典 `work_nature` |
| `sector` | TEXT | 八大板块 | 字典 `sector` |
| `project_status` | TEXT | 项目状态 | 字典 `project_status`（完工/施工中/中止/取消或作废），可编辑区 |
| `final_method` | TEXT | 决算方式 | 字典 `final_method`（合同金额/工作量），可编辑区 |
| `charge_date` | DATE | 最新挂账时间 | **自动** = 开票明细最近一笔日期（`ar_recalc_charge_date`） |
| `final_amount` | NUMERIC(18,4) | 决算金额 | **金额口径的锚点**；为空 → 账外应收/应收余额为 `null` |
| `invoiced_amount` | NUMERIC(18,4) | 开票金额 | 可一键同步自 `ar_invoices` 合计 |
| `received_amount` | NUMERIC(18,4) | 到账金额 | 可一键同步自 `ar_receipts` 合计 |
| `writeoff_amount` | NUMERIC(18,4) | 核销金额 | 可逆数值事件（不是终态标记） |
| `debt_status` | TEXT | 债权状态 | 字典 `debt_status`（正常/逾期/诉讼/和解），**人工维护**，可编辑区 |
| `collector` | TEXT | 清收责任人 | 可编辑区 |
| `dunning_date` | DATE | 最新催收时间 | 可编辑区 |
| `comm_method` | TEXT | 沟通方式 | 字典 `comm_method`，可编辑区 |
| `feedback` | TEXT | 对方反馈 | 字典 `feedback`，可编辑区 |
| `latest_progress` | TEXT | 最新进展 | 字典 `progress_note`，可编辑区 |
| `next_plan` | TEXT | 下一步计划 | 字典 `next_plan`，可编辑区 |
| `remark` | TEXT | 备注 | — |
| `created_by` | UUID → `auth.users` | — | 审计 |
| `created_at` / `updated_at` | TIMESTAMPTZ | — | `updated_at` 由触发器维护 |

**v3 之前的旧列仍在表里、界面已隐藏**（`computeRow` 与 `FIELD_DEFS` 都不含它们）：

```
start_date, end_date, progress, payment_node, dept_name,
contract_amount, receivable_internal(存储列), receivable_external(存储列),
receivable_total, cost_expense, dunning_feedback
```

> ⚠ 注意**列名撞车**：`receivable_internal` / `receivable_external` **数据库里有实体列**
> （v1 遗留），但前端把它们当作**虚拟计算列**（`COMPUTED_DEFS`）同名使用。
> `Ledger.computeRow()` 返回的值会覆盖 `r[key]`，所以表格显示的是算出来的，
> 不是库里存的。**数据库那两列已废弃，别去写它。**
> `contract_amount` 是唯一仍在用的旧列 —— 它承载「合同金额自动带入决算」（ADR-0003），
> 但**刻意不在 `FIELD_DEFS` 里**，只在编辑弹窗与导入目标里单独处理（见 6.8）。

#### `ar_departments` — 台账部门

| 列名 | 类型 | 说明 |
|---|---|---|
| `id` | UUID PK | 沿用月报部门的 UUID（初始复制时） |
| `name` | TEXT **UNIQUE** | 部门名；**重名会报错**，含首尾空格视为不同 |
| `sort_order` | INTEGER | 展示顺序（下拉、筛选、部门卡片都按它） |
| `created_at` | TIMESTAMPTZ | — |

> **「暂无上级」的扁平结构**：部门没有父子关系。「翟悟飞」「孙勇军」是合法的台账归属主体
> （个人独立核算挂靠），不是填错（`CONTEXT.md`）。

#### `ar_users` — 台账身份

| 列名 | 类型 | 说明 |
|---|---|---|
| `user_id` | UUID PK → `auth.users(id)` | 主键，与登录账号一对一 |
| `email` | TEXT NOT NULL | 与 `auth.users.email` 冗余存一份（列表展示用） |
| `full_name` / `phone` | TEXT | 姓名 / 手机号（手机号可用于登录） |
| `department_id` | UUID → `ar_departments(id)` | 归属部门，`ON DELETE SET NULL` |
| `ar_role` | TEXT CHECK | **`admin` \| `user` \| `disabled`** |
| `ar_super_admin` | BOOLEAN | 超管标记 |
| `ar_protected` | BOOLEAN | **主管理员保护**：不能被删除/降级（建库时按邮箱硬编码 `TRUE`） |

> ⚠ `ar_role` 的三个值里 `disabled` 在「用户管理」界面上**没有入口**，
> 只能 SQL 改。`ar_protected` 也是纯 SQL 概念。

#### `ar_user_perms` / `ar_user_prefs`

| 表 | 列 | 说明 |
|---|---|---|
| `ar_user_perms` | `user_id` PK, `perms` JSONB, `updated_by`, `updated_at` | `perms` 的键 = 7 项权限名（见 7.1） |
| `ar_user_prefs` | `user_id` PK, `prefs` JSONB, `updated_at` | `prefs` = `{hidden_cols, col_order, frozen_cols}`（见 6.4） |

**两张表都是「一个账号一行」，jsonb 装全部内容** —— 加权限项/加列偏好维度**不需要改表结构**。

#### `ar_import_batches` — 导入批次

| 列名 | 类型 | 说明 |
|---|---|---|
| `id` | UUID PK | 批次 id，写进 `ar_ledger.batch_id` |
| `file_name` | TEXT | 导入的文件名（前端在**选文件时**就记下来，见 8.3） |
| `row_count` | INTEGER | 实际写入行数（导入完会回写一次） |
| `imported_by` | UUID → `auth.users` | 导入人 |
| `created_at` | TIMESTAMPTZ | — |

#### `ar_invoices` / `ar_receipts` — 明细表

| `ar_invoices` | 类型 | | `ar_receipts` | 类型 |
|---|---|---|---|---|
| `id` | UUID PK | | `id` | UUID PK |
| `ledger_id` | UUID → `ar_ledger` CASCADE | | `ledger_id` | UUID → `ar_ledger` CASCADE |
| `invoice_no` | TEXT | | — | — |
| `invoice_date` | DATE NOT NULL | | `receipt_date` | DATE NOT NULL |
| `amount` | NUMERIC(18,4) CHECK ≥ 0 | | `amount` | NUMERIC(18,4) CHECK ≥ 0 |
| `remark` | TEXT | | `remark` | TEXT |
| `created_by` / `created_at` | | | `created_by` / `created_at` | |

> **两张表的权限不对称是要注意的**：`ar_invoices` 有 `invoice_no`，
> `ar_receipts` 没有。RLS 上两者**都仅管理员可写**（`ar_invoices` 原本允许
> `ar_can('add')`，2026-09-15 收紧为与回款一致 —— 见 `sql/init-new-instance.sql: 1300`）。

#### `ar_attachments` — 附件

| 列名 | 类型 | 说明 |
|---|---|---|
| `id` | UUID PK | |
| `ledger_id` | UUID → `ar_ledger` CASCADE | |
| `category` | TEXT DEFAULT '其他' | 字典 `attach_category`（决算/中止证明/其他） |
| `file_name` / `file_size` / `content_type` | | 原始文件元信息 |
| `storage_path` | TEXT **UNIQUE** | `{ledger_id}/{uuid}.{ext}` |
| `uploaded_by` / `created_at` | | |

Storage 桶：`ar-attachments`（**private**，下载走 1 小时签名 URL）。

#### `ar_dict` — 选项字典

| 列名 | 类型 | 说明 |
|---|---|---|
| `id` | UUID PK | |
| `category` | TEXT NOT NULL | 12 个类别之一（见 `DICT_CATEGORIES`） |
| `value` | TEXT NOT NULL | 选项值 |
| `sort_order` | INT | **顺序即下拉顺序**；保存时整类重写（见 8.4） |
| | | **UNIQUE (category, value)** ← 同类别内值唯一 |

#### `ar_settings` — 全局设置（恒 1 行）

| 列名 | 类型 | 说明 |
|---|---|---|
| `id` | INTEGER PK CHECK (id = 1) | 单行表，永远只有 `id=1` |
| `warn_days` | INTEGER DEFAULT 90 | ⚠ **已废弃**：随自动逾期判定一起移除（ADR-0002），列保留但前端不再读取 |
| `updated_at` | TIMESTAMPTZ | |

#### `departments` / `profiles` — 月报系统共用（本系统只读）

| `departments` | 说明 | | `profiles` | 说明 |
|---|---|---|---|---|
| `id` UUID PK | | | `id` UUID PK → `auth.users` | 注册触发器自动建 |
| `name` TEXT UNIQUE | | | `full_name` / `phone` | `phone` UNIQUE，可登录 |
| `code` TEXT UNIQUE | 部门编码，可作登录标识 | | `role` TEXT DEFAULT `'reporter'` | ⚠ **本系统里恒为 `reporter`** |
| `sort_order` | | | `department_id` → `departments(id)` | ⚠ **不是** `ar_departments` |
| `created_at` | | | `created_at` | |

> **为什么 `profiles.role` 恒为 `reporter` 很重要** → 它就是 v3.2 那个 P0 bug 的根因（见 4.5）。

### 4.3 权限判定函数（RLS 的地基）

全部是 `SECURITY DEFINER`（越过 RLS 读元数据，避免策略递归）。

| 函数 | 返回 | 逻辑 |
|---|---|---|
| `ar_is_admin()` | boolean | `EXISTS(SELECT 1 FROM ar_users WHERE user_id=auth.uid() AND ar_role='admin')` |
| `ar_is_super_admin()` | boolean | 同上 **且** `ar_super_admin = TRUE` |
| `ar_can(p_key TEXT)` | boolean | 管理员恒 TRUE；否则读 `ar_user_perms.perms->>p_key`（`ar_role='disabled'` 直接 FALSE） |
| `ar_can_see_row(p_department_id UUID)` | boolean | `ar_is_admin() OR ar_can('view_all') OR p_department_id IN (当前用户的 ar_users.department_id)` |
| `is_admin()` | boolean | ⚠ **月报系统的**，读 `profiles.role`。在台账里**恒 FALSE** |
| `resolve_login_identifier(p_identifier)` | text | ⚠ **月报系统的**登录标识解析。台账**不用它**，用下面的 `ar_` 版本 |
| `handle_new_user()` | TRIGGER | 新用户注册时自动建 `profiles` 行（Studio 手工加用户也触发） |
| `update_updated_at()` | TRIGGER | 通用 `updated_at = NOW()` |

> **15 个函数的分工**：4 个是台账权限判定（`ar_is_admin` / `ar_is_super_admin` /
> `ar_can` / `ar_can_see_row`）、6 个是 RPC（见 4.4）、1 个是字段保护触发器
> （`ar_ledger_guard_fields`，见 4.6）、3 个是通用/月报遗留（`handle_new_user` /
> `update_updated_at` / `is_admin` / `resolve_login_identifier`）。
>
> **`is_admin()` 与 `ar_is_admin()` 是两个不同的函数**，这是 v3.2 那个 P0 的根源。
> **判断「我是不是台账管理员」永远用 `ar_is_admin()`。**

### 4.4 RPC（前端调用的数据库函数）

前端用 `sb.rpc('函数名', { 参数 })` 调用。**这四个都是「前端做不了」的事**：
需要 `SECURITY DEFINER` 权限、或需要跨表原子操作。

| RPC | 参数 | 作用 | 谁调 |
|---|---|---|---|
| `ar_resolve_login_identifier` | `p_identifier TEXT` | 手机号/部门名/编码 → 邮箱。**只查 `ar_users`** | `Auth.login` |
| `ar_create_user` | `p_email, p_password, p_full_name, p_phone, p_department_id, p_ar_role, p_perms` | 建 `auth.users` + `ar_users` + 权限 | `Admin.userDialog` |
| `ar_update_user` | `p_user_id, p_full_name, p_phone, p_department_id, p_ar_role, p_password, p_perms` | 改账号；`p_password` 为空则不改密码 | `Admin.userDialog` |
| `ar_delete_user` | `p_user_id` | **只移出台账**（删 `ar_users`），保留 `auth.users` 登录账号 | `Admin.deleteUser` |
| `ar_super_admin_count_excluding` | `p_user_id` | 数还剩几个超管 —— 防「删掉最后一个超管」 | 被 `ar_delete_user` 内部调用 |
| `ar_recalc_charge_date()` | 无 | 全量重算 `charge_date` = 该合同最近开票日期 | `Admin.loadSettings` 的按钮 |

> `ar_delete_user` 的语义值得注意：**「删除账号」不是删除登录账号**。
> 因为 `auth.users` 是与月报系统共用的，删掉会影响月报。所以只删台账身份。
> 界面上文案也刻意写成「移出台账（不影响月报系统）」。

### 4.5 RLS 策略（40 条）

策略是**追加制**：同一张表的多条策略之间是 OR 关系（都匹配才放行）。
`sql/upgrade-v3.2-admin-rls.sql` 会用 `DROP POLICY + CREATE POLICY` 覆盖旧版。

**读权限（SELECT）的分布**：

| 表 | 谁能读 |
|---|---|
| `departments` / `ar_departments` / `ar_dict` / `ar_settings` | 所有登录用户（下拉字典，不该藏） |
| `ar_ledger` | `ar_can_see_row(department_id)` —— 管理员全量；否则本部门；`view_all` 权限者全量 |
| `ar_invoices` / `ar_receipts` / `ar_attachments` | 子查询到 `ar_ledger` 再用 `ar_can_see_row` —— **可见性跟随台账行** |
| `ar_users` | 本人 or 管理员 |
| `ar_user_perms` | 本人 or 管理员 |
| `ar_user_prefs` | **仅本人**（列偏好是私人的） |
| `ar_import_batches` | 管理员 / 导入人 / 本批次下有本部门可见数据 |
| `profiles` | 本人 or `is_admin()` or **`ar_is_admin()`** |

**写权限（INSERT/UPDATE/DELETE）的关键规则**：

```
ar_ledger INSERT  : 管理员 OR ( ar_can('add') AND (department_id IS NULL OR department_id = 我的部门) )
ar_ledger UPDATE  : 管理员 OR ( ar_can('edit') AND ar_can_see_row(department_id) )
                    ↑ 注意：这层只管"行能不能改"；"哪些列能改"由触发器管（见 4.6）
ar_ledger DELETE  : 管理员 OR ar_can('delete')
ar_invoices / ar_receipts 写 : 仅 ar_is_admin()
ar_attachments INSERT       : ar_can('edit') AND 该行可见
ar_attachments DELETE       : 管理员 OR 上传者本人
ar_dict / ar_departments 写 : 仅 ar_is_admin()
ar_user_perms / ar_settings 写 : 仅 ar_is_admin()
ar_user_prefs 写            : 仅本人
```

> ### 🔴 v3.2 那个 P0：管理员判定用错了函数
>
> **症状**：用户管理页里报账员权限全显示未勾选、保存报错；系统设置存不了；
> 带部门的新台账被拒。
>
> **根因**：早期策略写的是月报系统的 `public.is_admin()`（读 `profiles.role`）。
> 而本库的 `profiles` 由注册触发器生成、`role` 恒为 `'reporter'` →
> `is_admin()` **恒 FALSE** → 管理员在数据库眼里什么都不是。
>
> **修复**：全部改用台账自己的 `public.ar_is_admin()`。
> 涉及 `ar_user_perms` / `ar_settings` / `ar_ledger` / `ar_import_batches` / `profiles`。
>
> **接手时怎么自查**：跑 `sql/verify-setup.sql`，它的第 ③ 节专门检查
> 「策略里是否还残留旧 `is_admin()`」。**残留就是没修。**

### 4.6 触发器（3 个）

| 触发器 | 时机 | 作用 |
|---|---|---|
| `trg_on_auth_user_created` | `auth.users` AFTER INSERT | 调 `handle_new_user()` 建 `profiles` 行 |
| `trg_ar_ledger_updated_at` | `ar_ledger` BEFORE UPDATE | `updated_at = NOW()` |
| **`trg_ar_ledger_guard`** | `ar_ledger` BEFORE UPDATE | **字段级权限**（要求五） |

`ar_ledger_guard_fields()` 是**整个权限模型里最巧妙也最容易踩的一块**：

```sql
IF public.ar_is_admin() THEN RETURN NEW; END IF;       -- 管理员直接放行
IF (to_jsonb(NEW) - ARRAY[ 白名单 ])  IS DISTINCT FROM
   (to_jsonb(OLD) - ARRAY[ 白名单 ]) THEN
  RAISE EXCEPTION 'AR_FIELD_LOCKED: ...';
END IF;
```

白名单（非管理员**可以**改的列）：

```
project_status, final_method, debt_status, collector, dunning_date,
comm_method, feedback, latest_progress, next_plan, updated_at
```

**做法是「整行转 jsonb 后减去白名单再比对」** —— 这样以后加数据库列时，
新列**默认是锁的**（安全默认），比逐个列举被保护的列更稳。
`updated_at` 在白名单里是因为它总在变，否则任何更新都会撞锁。

前端 `Editor.editableKeys()` 的逻辑必须与这份白名单**保持一致**，
否则会出现「前端能填、保存被数据库拒绝」。前端报错文案就是识别这个异常的：
`/AR_FIELD_LOCKED/.test(error.message)` → `js/ledger.js: 1097`。

### 4.7 SQL 脚本与执行顺序

| 脚本 | 什么时候用 | 幂等 |
|---|---|---|
| **`init-new-instance.sql`** | **★ 全新环境，一键搞定** | ✓ |
| `schema-standalone.sql` | 只想建基础表（被 init 拼接） | ✓ |
| `ar-users-v2.sql` | 独立账号体系（被 init 拼接） | ✓ |
| `upgrade-v3-indicators.sql` | 已跑过 v1/v2 的老库升到 v3 | ✓ |
| `upgrade-v3.1-receipts.sql` | v3 升 v3.1（回款明细） | ✓ |
| `upgrade-v3.2-admin-rls.sql` | **v3 升 v3.2（管理员判定修复，必做）** | ✓ |
| `update-dict-seeds.sql` | 把占位字典换成真实业务字典 | ✓ |
| `verify-setup.sql` | **★ 每次测试前跑，只读自检** | ✓（只读） |
| `schema.sql` / `ar-user-management.sql` | **历史存档，勿用于新库** | — |

`init-new-instance.sql` 是「按依赖顺序拼接上面几个脚本」，内容有重复但不冲突
（全部 `IF NOT EXISTS` / `DROP ... IF EXISTS`）。**维护原则：改基础脚本时同步
在 init 里补一段**，否则新库与升级库会长得不一样。

---

## 5. 前端代码地图：模块 API 参考

### 5.1 全局约定

**没有模块系统**。所有模块都是挂在全局的**对象字面量常量**：

```js
const Ledger = { ... };        // 不是 class，不能用 new
const Auth   = { ... };
```

命名规律：

| 模式 | 含义 | 例子 |
|---|---|---|
| `Xxx` 对象 | 单例模块 | `Ledger`、`Auth`、`ColPrefs` |
| `XXX_YYY` 常量 | 全大写 + 下划线 | `FIELD_DEFS`、`DEPT_NONE`、`PERM_DEFS` |
| `renderXxx()` | 渲染一段 HTML | `renderTable`、`renderModal` |
| `bindXxx()` | 挂事件监听 | `bindEvents`、`bindOverflow` |
| `syncXxx()` | **局部**同步（不重渲染） | `syncCalc`、`syncFrozen`、`syncFilterBar` |
| 以 `_` 开头 | 「内部」状态（约定，无强制） | `Ledger._emptyTips`、`Dashboard._ch` |
| `data-act="xxx"` | DOM 上的行为标记 | `<a data-act="edit">` |

**`data-act` 是这个项目的「事件总线」**：HTML 里写 `data-act="del"`，
JS 里统一用 `[data-act]` 查询并绑事件。新增交互时沿用这个模式，
不要在生成 HTML 时内联 `onclick`。

### 5.2 加载顺序（`index.html`）

```html
config.js      ← 必须第一（建 sb 客户端；且不能有 await）
fields.js      ← FIELD_DEFS，被后文大量引用
dict.js
colprefs.js    ← 用 FIELD_DEFS / COMPUTED_DEFS
utils.js
auth.js        ← 用 PERM_DEFS
dashboard.js
ledger.js      ← 用 FIELD_DEFS/COMPUTED_DEFS/ColPrefs/Attachments/Dicts/Utils/Auth
attachments.js
importer.js
detailimporter.js
exporter.js
batches.js
admin.js
dictadmin.js   ← 用 FIELD_DEFS/DICT_CATEGORIES/Dicts/Utils/Auth
app.js         ← 最后：注册 DOMContentLoaded → App.boot()
```

> 模块顶部立即执行的代码只有 `config.js` 的 IIFE（建 `sb`）。
> 其余模块的「顶部代码」只做 `const X = {...}` 定义，**真正的初始化都在
> `App.boot()` 里按序调用**（`app.js: 116`），所以顺序其实不敏感，
> 但**新增模块请照旧加在 `app.js` 之前**。

### 5.3 各模块 API

---

#### `Utils` — 工具函数（`js/utils.js`）

| 方法 | 签名 | 说明 |
|---|---|---|
| `escapeHtml` | `(str) → string` | **所有拼进 HTML 的用户数据都要过它** |
| `fmtMoney` | `(v) → string` | 千分位，最多 2 位小数；≥1000 用 `toLocaleString` |
| `parseMoney` | `(v) → number\|null` | 容忍千分位、`¥`、全角括号（`（` → 负号） |
| `fmtDate` | `(v) → 'YYYY-MM-DD'` | 容忍 `2024/7/1`、`2024年7月1日` |
| `parseExcelDate` | `(v) → 'YYYY-MM-DD'\|null` | 处理 Date 对象、Excel 序列号（20000~80000）、各种字符串 |
| `clampName` | `(str, maxLine=12, maxLineCount=3) → string` | 项目名截断：3 行 × 12 字，超出补 `…` |
| `debounce` | `(fn, wait=300) → fn` | — |
| `toast` | `(msg, type='info')` | type: `info` / `success` / `error`（error 显示 4.2s，其余 2.6s） |
| `confirm` | `(message, opts) → Promise<boolean>` | opts: `{title, danger, confirmText}`；`message` 支持 `\n` |
| `bindMaskClose` | `(mask, onClose)` | 点遮罩关闭，**带 6px 拖拽误触保护** |
| `pwdScore` / `pwdValid` | `(v) → 0..5 / boolean` | 强密码：≥8 位 + 大小写 + 数字 + 符号 |
| `bindPwdMeter` | `(input, bar, hint)` | 绑定实时强度进度条 |
| `daysBetween` | `(a, b) → number\|null` | b − a 的天数 |
| `today` | `() → 'YYYY-MM-DD'` | — |

> `Utils.overdueStatus()` **已被删除**（2026-09-15），原因见 `docs/adr/0002`：
> 本院「按合同期限几乎全部逾期」，自动判定无区分度，债权状态改人工维护。
> 如果你在旧文档/旧代码里看到它，那是过期的。

---

#### `Auth` — 认证与权限（`js/auth.js`）

| 状态字段 | 类型 | 说明 |
|---|---|---|
| `currentUser` | `auth.users` 对象 | Supabase 当前用户 |
| `currentProfile` | `profiles` 行 | 月报档案（含 `departments(*)`） |
| `arUser` | `ar_users` 行 | **台账身份**（含 `ar_departments(name)`）；模板里读 `au.full_name` |
| `perms` | `{ [key]: true }` | 仅本人被开放的权限项 |
| `isAdmin` | boolean | `ar_role === 'admin'` **或** `ar_super_admin` |
| `isSuperAdmin` | boolean | `ar_super_admin === true` |

| 方法 | 说明 |
|---|---|
| `init()` | `getSession()` → `fetchProfile()` → `loadPerms()`；返回 `{user, profile}` 或 `null` |
| `fetchProfile()` | 读 `profiles` join `departments` |
| `loadPerms()` | 读 `ar_users` + `ar_user_perms`，填充上面 4 个字段 |
| `can(key) → boolean` | **管理员恒 true**，否则查 `perms` |
| `permCount() → number` | 左侧「我的权限」栏用 |
| `login(identifier, password)` | identifier 是邮箱直接登录；否则走 RPC 解析 |
| `mapAuthError(msg)` | Supabase 英文报错 → 中文（「账号或密码错误」等） |
| `changePassword(newPwd)` | 校验强密码后 `updateUser` |
| `logout()` | 清空全部状态字段 |

> **`Auth.can()` 只管 UI，不是安全边界**。它决定按钮显不显示；
> 真正挡越权的是 RLS。改权限相关代码时**两层都要想一遍**。

---

#### `ColPrefs` — 列偏好（`js/colprefs.js`）

三个概念，**都在一个 jsonb 里**：

```js
{
  hidden_cols: ['remark'],                        // 不显示
  col_order:   ['contract_no', ...],              // 全部列的顺序（含隐藏列）
  frozen_cols: ['contract_no', 'project_name']    // 左侧冻结（必须是 order 的前缀区）
}
```

| 状态 | 说明 |
|---|---|
| `hidden` | `Set<string>` 隐藏的字段 key |
| `order` | `string[]` **全部列**顺序（唯一真相；隐藏列也在其中，恢复时回原位） |
| `frozen` | `string[]` 冻结列，有序 |
| `userId` / `dbOk` | 当前用户 / 表是否可读写（false = 仅本台生效） |
| **`MAX_FROZEN`** | **8** —— 冻结列上限 |

| 方法 | 说明 |
|---|---|
| `allDefs()` | `FIELD_DEFS + COMPUTED_DEFS` |
| `orderedDefs()` | 按 `order` 排好；未记录的列按定义顺序补末尾 |
| **`visibleDefs()`** | **当前显示的列，冻结区强制为前缀** ← 核心不变量 |
| `coreKeys()` | 「仅常用列」的 15 个 key |
| `applyPrefs(p)` | 兼容旧格式：**如果 `p` 是数组，当作旧版 `hidden` 裸数组** |
| `normalize()` | 丢不存在的列 / 补全 order / frozen 去重封顶 |
| `load(userId)` | 先读 localStorage，再读 `ar_user_prefs`（后者覆盖前者） |
| `prefs()` / `save()` / `saveLocal()` | 序列化 / 存库 / 存本地 |
| `isVisible(key)` / `hiddenCount()` / `isFrozen(key)` / `frozenVisible()` | 查询 |
| `zones()` | → `{frozen: [...], scroll: [...]}`（两块合起来 = 全部列） |
| `commit(zones)` | 写回并保存；**超上限的冻结列退回滚动区** |
| `toggle` / `showAll` / `onlyCore` / `resetOrder` / `freeze` / `unfreeze` | 变更 |
| `moveTo(dragKey, targetKey, after)` | 拖拽排序；**目标区块决定它是否冻结** |
| `openPanel(anchor, onChange)` / `renderPanel` / `placePanel` / `bindPanel` / `closePanel` | 列设置面板 |

> **`onChange` 必须传 `() => this.refreshTable()` 而不是 `() => this.render()`**。
> 传整页 `render()` 会把触发面板的那个按钮一起换掉，面板就丢了锚点、直接消失。
> 见 `js/ledger.js: 683`。

---

#### `Dicts` — 选项字典缓存（`js/dict.js`）

| 成员 | 说明 |
|---|---|
| `cache` | `{ [category]: [value, ...] }`，**只装 `ar_dict` 里真有的** |
| `dbOk` | `ar_dict` 是否可用 |
| `load()` | 登录后调一次；读全部 `ar_dict`（按 category、sort_order 排） |
| `get(category)` | **数据库优先，空则回退 `DICT_BUILTIN`** |
| `isManaged(category)` | 该类别是否已落库（「已自定义」vs「内置默认」） |

`DICT_BUILTIN`（同文件）是 12 个类别的兜底默认值，
与 `sql/update-dict-seeds.sql` 的种子一致。**表没建 / 断网时功能不受影响。**

---

#### `Ledger` — 台账核心（`js/ledger.js`，1316 行）

这是最大的模块。**它里面其实装了三个对象**：`Ledger`（列表）、
`Editor`（单条编辑弹窗）、以及若干模块级常量。

**模块级常量**

| 常量 | 值 | 说明 |
|---|---|---|
| `DEPT_NONE` | `'未指定'` | **显示值与筛选项必须是同一个常量**，否则会出现「胶囊里有『未指定』但点下去筛不出东西」 |

**状态**

| 字段 | 类型 | 说明 |
|---|---|---|
| `rows` | `ar_ledger[]` | 当前可见数据（RLS 已隔离） |
| `settings` | object | `ar_settings` 行（含已废弃的 `warn_days`） |
| `departments` | `[{id, name}]` | 来自 `ar_departments`（`admin.js` 也会写它） |
| **`filters`** | object | **`{search, dept, project_status, debt_status, client_attr, settled, batch}`** |
| `selected` | `Set<id>` | 勾选的行 |
| `sortKey` / `sortDir` | string / `1\|-1` | 排序状态 |

**筛选维度（`DIMS`）**

```js
DIMS: [
  { key: 'dept',           label: '部门' },
  { key: 'settled',        label: '结清状态', def: '未结' },   // ← 唯一的「默认非全部」维度
  { key: 'project_status', label: '项目状态' },
  { key: 'debt_status',    label: '债权状态' },
  { key: 'client_attr',    label: '客户属性' },
]
```

| 方法 | 说明 |
|---|---|
| `init()` | 读 `ar_settings` + `ar_departments` |
| `load()` | 读 `ar_ledger`（按 `created_at` 倒序，limit 5000；`filters.batch` 时按批次过滤）+ `Attachments.loadCounts()` |
| **`computeRow(r)`** | 派生列：三个金额 + `attach_summary` + **`department_id`（注意：这里返回的是部门名）** |
| **`balanceOf(r)`** | 应收余额；`final_amount` 空 → `null`。**单独抽出来给筛选用**（`computeRow` 还要拼附件摘要，逐行调用太慢） |
| `deptNameOf(r)` | `department_id`(UUID) → 部门名；查不到 → `'未指定'` |
| `dimDef` / `dimDefault` / `isDefaultDim(key)` | 维度定义与默认值 |
| **`dimValue(key, r)`** | 某行在某维度上的值。**显示与筛选共用这一个口径** |
| **`rowMatch(r, skip)`** | 单行是否命中；`skip` = 本次忽略哪个维度（算分面计数用） |
| `filteredRows()` | 筛选后的行 |
| **`facetCounts(key)`** | **分面计数**：其他维度已生效的前提下，本维度各选项各能筛出几条 |
| `facetTotal(key)` | 本维度选「全部」时剩几条 |
| `dimOptions(key)` | 下拉选项列表（只列数据里真实出现的值 + 一个「全部」） |
| `renderToolbar()` | 搜索框 + 操作按钮（按权限显示） |
| **`filterBarHTML()`** | 一行 chip 的筛选条 |
| `syncFilterBar()` | 只重画筛选条 |
| `bindFilterBar(root)` | 绑筛选条事件（含「清除筛选」） |
| `openDimPop(dimKey, anchor)` / `closeDimPop()` / `placePop()` | 维度下拉面板 |
| **`diagnoseEmpty()`** | 筛出 0 条时，逐个维度松一松看能看到几条 → 可点的放行建议 |
| `visibleDefs()` | 转调 `ColPrefs.visibleDefs()` |
| `renderTable()` | 表格（表头 + 行 + 合计行） |
| `renderEmpty()` | 空状态（**独立的 `.table-wrap`，不是 `<td colspan>`**） |
| `statusText(rows)` | 表格下沿状态条 |
| `syncOverflow()` | 横向滚动提示（只在真溢出的一侧投影） |
| **`syncFrozen()`** | 量**实测宽度**累加出 `.fz-N { left: Npx }` 写进 `<style id="cfz-style">` |
| **`fitHeight()`** | 量出可用高度写进 `#page-ledger`（表头常驻的前提） |
| `bindOverflow()` | scroll/resize/`ResizeObserver(topbar)` → fitHeight + syncOverflow + syncFrozen |
| `hasActiveFilter()` | 是否有生效筛选 |
| `render()` | 整页渲染（只在「首次」和「reload」时用） |
| **`refreshTable()`** | **只重绘表格区**（保留横向滚动位置、同步按钮文案）← 日常刷新走这个 |
| `bindEvents(root)` / `bindTableEvents(root)` | 事件绑定 |
| `deleteSelected()` / `reload()` | 批量删除 / 重载+重绘 |

**`Editor`（同文件的第二个对象）**

| 成员 | 说明 |
|---|---|
| `row` / `isNew` / `invoices[]` / `receipts[]` | 状态 |
| **`editableKeys()`** | 非管理员可编辑的字段集合（`null` = 全部可编辑）。**必须与数据库白名单一致** |
| `canEditField(key)` | 单字段是否可编辑（决定是否显示 🔒） |
| `open(row)` | 打开弹窗（`null` = 新增） |
| `loadOwnerUnits()` | 客户名称 datalist（预设 + 库内历史值） |
| `inputWidget(f, v, disabled)` | 按 `f.type` 渲染控件（text/money/date/textarea/select/combo） |
| `fieldCell(key)` | 带标签的字段单元格 |
| `renderModal()` | 整个弹窗（分区） |
| `bindModal(el)` | 事件 + 实时计算 + 「其他」联动 + **合同额自动带入决算** |
| `readField(el, f)` | 读控件值（处理 `select + freeOther` 组合） |
| **`syncCalc(el)`** | 实时算三个金额显示在 calc-bar |
| `save(el)` | 收集 → 校验 → insert/update |
| `renderAttachments()` | 附件区（转 `Attachments.render`） |
| `loadInvoices` / `renderInvoicePane` / `addInvoice` / `syncInvoiced` / `recalcChargeDate` | 开票明细 |
| `loadReceipts` / `renderReceiptPane` / `addReceipt` / `syncReceived` | 回款明细 |

---

#### `Dashboard` — 数据看板（`js/dashboard.js`）

纯 SVG 手绘图表，**无外部依赖**。模块级常量：

| 常量 | 说明 |
|---|---|
| `C_PRIMARY` `C_INK_950` `C_INK_600` `C_INK_500` `C_INK_400` `C_LINE` `C_SURFACE_3` `C_DANGER` `C_OK` `C_TEAL` `C_VIOLET` | sRGB 色值，**与 CSS `:root` 的 oklch 令牌等价**。改主题要两边同步 |
| `DASH_MAX_W` | **1120** —— 图表宽度上限 |
| `groupColorOf(name)` | 客户属性大类 → 颜色（内部单位/政府部门/煤矿集团/社会客户） |

| 方法 | 说明 |
|---|---|
| `render()` | 整页看板 |
| `paintCharts()` | **先量容器宽再生成 viewBox**（缩放比恒为 1） |
| `bindResize()` | 窗口变化防抖重绘（不重新拉数据） |
| `loadTrend()` | 月度开票/回款（明细聚合，近 12 个月；表未建则整卡移除） |
| `trendChart` / `deptChart` / `unitChart` / `custChart` / `attrChart` / `debtChart` | 各图表 |
| `barChart(bars, opts, W)` | **通用水平条形图**（两段堆叠：实色 = 应收余额，淡色 = 决算未定部分） |
| **`textW(str, fontSize)`** | **文本像素宽度估算**（汉字 ≈ 1em，半角 ≈ 0.55em） |
| **`fitLabel(str, maxPx, fontSize)`** | 按**像素**截断，**从尾部截** |
| `wan(n)` / `wanShort(n)` | 金额 → 万元/亿元 |

> **两条必须守住的规则**（都踩过坑，见 8.1）：
> ① **必须按容器实测宽度生成 viewBox**。SVG 用 `viewBox` + `width:100%` 时，
>   容器比 viewBox 宽多少，**图内文字就放大多少倍**（520 宽 viewBox 塞进 1400px 卡片
>   → 12px 文字渲染成 32px）。
> ② **标签截断必须按像素、且截尾部**。曾经按「字数」截 → 中英混排失准 →
>   配 `text-anchor="end"` 右对齐 → 文字向左溢出被 SVG 裁掉开头，
>   用户看到的是「名称只剩中间几个字」。

---

#### `Attachments` — 附件（`js/attachments.js`）

| 成员 | 说明 |
|---|---|
| `BUCKET` | `'ar-attachments'` |
| `MAX_SIZE` | `50 * 1024 * 1024`（50MB） |
| `rows` | 当前行的附件列表（编辑弹窗内） |
| `countMap` | `{ ledger_id: { 类别: 数量 } }` —— 表格「附件类别及数量」列用 |

| 方法 | 说明 |
|---|---|
| `loadCounts()` | 全量读附件计数（`Ledger.load` 后调用） |
| `summaryText(id)` | → `'决算×2、中止证明×1'` |
| `count(id)` | 附件总数 |
| `loadFor(ledgerId)` | 当前行附件 |
| `fmtSize(n)` | 文件大小格式化 |
| `render(canEdit)` | 附件区 HTML |
| `bind(container, onChange)` | 事件（含删除二次确认） |
| `upload(file, container, onChange)` | **先传 Storage 再写表；写表失败会回删文件** |
| `download(path, name)` | 签名 URL（3600s）后 `<a download>` |

---

#### `Importer` — Excel 导入台账（`js/importer.js`）

**模块级常量 `IMPORT_TARGETS`** = 可映射的导入目标列表：

```js
[
  { key: 'department',      label: '部门名称（归属部门）', virtual: true },   // 虚拟目标
  { key: 'contract_amount', label: '合同金额（自动带入决算）' },              // 旧列，不在 FIELD_DEFS
  ...FIELD_DEFS.filter(f => !f.noImport).map(...)                          // 其余台账字段
]
```

> `noImport: true` 的字段（目前只有 `department_id`）**不进这个列表** ——
> 它的职责已由虚拟目标 `department` 承担，否则会出现两个指向同一列的映射目标。

| 状态 | 说明 |
|---|---|
| `wb` / `sheetRows` / `headers` / `mapping` | 工作簿 / 二维数组 / 表头 / 每列→目标 key |
| **`targetDept`** | `'auto'` \| 部门 id \| `'none'` |
| **`dupMode`** | `'skip'` \| `'overwrite'` \| `'insert'` |
| `existingNos` | `Map<合同编号, 行id>`（覆盖更新用） |
| `fileName` | **选文件时**就记下来（写入批次记录） |
| `deptOverrides` | `Map<部门名, 部门id\|null>` —— 系统查不到的部门名 → 人工指定 |

| 方法 | 说明 |
|---|---|
| `downloadTemplate()` | 动态生成模板（与 `FIELD_DEFS` 自动同步，含示例行） |
| `open()` / `reset()` | 打开 / 重置状态 |
| `renderStepFile()` | 第 1 步 |
| `readFile(file)` | FileReader → SheetJS → `detectHeaderAndMapping` |
| `detectHeaderAndMapping()` | 前 10 行里找表头（匹配数最多的一行）；三档匹配（label > alias > 归一化） |
| `renderStepMapping()` | 第 2 步：字段映射（同一目标只允许映射一列） |
| **`deptPlan()`** | **部门归属计划**：一次算出每行归到哪个部门 + 哪些部门名查不到 |
| `renderDeptPlan(plan)` / `refreshDeptPlan(body)` / `commitLabel(left)` | 归属预检 UI |
| `buildPayload(colIdx, raw)` | 单格 → 字段值（按 type 转 money/date/text） |
| `renderStepPreview()` | 第 3 步：预览 + 归属预检 |
| **`commit()`** | 真写入：建批次 → 组装 → 分批 insert/update（CHUNK=200） |

---

#### `DetailImporter` — 明细批量导入（`js/detailimporter.js`）

按「合同编号」列匹配台账行，批量写 `ar_invoices` / `ar_receipts`，
并**自动同步台账金额与挂账时间**。

| 成员 | 说明 |
|---|---|
| `type` | `'invoice'` \| `'receipt'` |
| `colMap` | `{contract_no, date, amount, invoice_no, remark}` → 列下标 |
| `ledgerByNo` | `Map<合同编号, {id, project_name}>` |
| `matched` / `unmatched` / `invalid` | 三类结果 |

| 方法 | 说明 |
|---|---|
| `label()` / `table()` / `dateKey()` | 按 `type` 返回对应值（`ar_invoices`/`invoice_date` 等） |
| `open(type)` | **仅管理员**（开头就 `if (!Auth.isAdmin) return toast`） |
| `renderStepFile` / `readFile` / `detectColumns` / `matchLedger` / `renderStepPreview` / `commit` | 流程 |
| `syncAffected()` | 写完后重算受影响台账的 `invoiced_amount`/`received_amount`/`charge_date` |

> ⚠ **重复执行同一文件会重复登记**（无去重）。界面上提示了这一点但没拦。

---

#### `Exporter` — Excel 导出（`js/exporter.js`）

| 方法 | 说明 |
|---|---|
| `open()` | 导出弹窗（范围 / 合计行 / 明细工作表 / 字段多选） |
| `valueOf(r, key)` | 单行单字段值（含虚拟计算列） |
| `doExport(rows, keys, withTotal, withDetails)` | 主表 + 可选合计行 → `XLSX.writeFile` |
| `appendDetailSheets(wb, rows)` | 附带「开票明细 / 回款明细」两个 sheet；`in` 查询按 **200 个分块** |

---

#### `Batches` — 批次管理（`js/batches.js`）

| 方法 | 说明 |
|---|---|
| `load()` | 读批次 + 统计各批次**现存**行数（`current_rows`） |
| `render()` | 表格；「查看本批」→ `Ledger.filters.batch = id` + 跳转 |
| （内部）`del-all` | 删整批：先删 `ar_ledger`（级联清明细），再删批次行 |

---

#### `Admin` — 用户/部门/设置（`js/admin.js`）

| 状态 | 说明 |
|---|---|
| `users` | 用户列表（`ar_users` + `perms` 合并） |
| `depts` | `ar_departments` 列表 |
| **`permsWarning`** | **权限表读取异常时的页面横幅** —— 读不到时**必须让人看见**，否则表现成「所有报账员都没权限」 |

| 方法 | 说明 |
|---|---|
| `load()` | 读 `ar_users` + `ar_user_perms` → 生成 `permsWarning` → `loadDepts()` → `render()` |
| `loadDepts()` | 读 `ar_departments`，**并写回 `Ledger.departments`** |
| `roleTag(u)` | 角色标签 HTML |
| `render()` | 用户表 + 部门卡片网格 |
| `deleteUser(id)` | RPC `ar_delete_user` |
| `savePerms(id)` | upsert `ar_user_perms` |
| `userDialog(user)` | 新增/编辑账号弹窗（含密码强度条、角色↔权限联动） |
| `deptAdd()` / `moveDept(id, dir)` / `deptDialog(dept)` / `deleteDept(id)` | 部门增/排序/改名/删 |
| `loadSettings()` | 系统设置页（运行信息 + 「重算挂账时间」按钮） |

---

#### `DictAdmin` — 选项管理（`js/dictadmin.js`）

| 状态 | 说明 |
|---|---|
| `current` | 当前类别 key |
| `items` | 当前类别的选项值（有序） |
| `dirty` | 有未保存修改 |
| **`usage`** | `Map<值, 引用条数>`；**`null` = 读不到台账**（降级：整块使用情况隐藏） |
| `usageMax` | 最大条数（细条归一基准，缓存） |
| `loadedVals` | 打开时的数据库值（分辨「原本是选项」vs「数据里冒出来的值」） |
| `usageSrc` | `{table, col, unit, where}` |

| 方法 | 说明 |
|---|---|
| `load(catKey)` | 读 `ar_dict` → `loadUsage()` → `render()` |
| **`sourceOf(cat)`** | 类别 → 数据落点。**由 `FIELD_DEFS` 的 `dict` 反查**，不另抄映射；`attach_category` 是唯一例外（落 `ar_attachments.category`） |
| `loadUsage()` | 拉该列全量值客户端聚合 |
| `usageOf(v)` | 某值被引用几条 |
| **`outsideValues()`** | 数据里在用、选项表里没有的值。`wasOption=true` 表示「原本是选项、被删/改名了」 |
| `catItem(c)` / `usageCell(v)` / `rows()` / **`consistHTML()`** | 渲染（左栏 / 「在用」格 / 表格行 / 底部一致性卡片） |
| `render()` / `bind()` / `bindRowActs()` / `bindAdopt()` | 渲染与事件 |
| `adopt(i)` | 「加入选项」 |
| `focusRow(i, prefer)` | 重渲染后把焦点放回原位置 |
| `syncHead()` / `syncUsage()` | 局部同步（避免重渲染丢焦点） |
| `addItem()` / `save()` | 新增 / **整类重写保存（带补偿事务）** |

---

#### `App` — 应用入口（`js/app.js`）

| 成员 | 说明 |
|---|---|
| `currentView` | 当前视图（默认 `'dashboard'`） |
| `boot()` | 检查 `sb` → `Auth.init()` → `renderApp()` 或 `renderLogin()` |
| `renderLogin()` | 登录页 |
| `renderApp()` | 主界面骨架 + 首次数据加载 |
| `renderSidebar()` | 导航（按权限显示）+ 权限清单 |
| `navigate(view)` | 切页面 + 触发该页的加载 |
| `closeSidebar()` | 移动端抽屉 |
| `renderImportGuide()` | 导入引导页 |
| `bindTopbar()` / `changePwdDialog()` | 顶栏事件 / 改密码弹窗 |

**页面 id ↔ 导航 key ↔ 标题**

| nav key | 元素 id | 标题 | 谁能看 |
|---|---|---|---|
| `dashboard` | `#page-dashboard` | 数据看板 | `view` 或 `view_all` 或管理员 |
| `ledger` | `#page-ledger` | 台账总览 | 同上 |
| `import-guide` | `#page-import-guide` | Excel 导入 | `import` |
| `batches` | `#page-batches` | 导入批次管理 | `delete` 或 `import` |
| `admin` | `#page-admin` | 用户管理 | 管理员 |
| `dict` | `#page-dict` | 选项管理 | 管理员 |
| `settings` | `#page-settings` | 系统设置 | 管理员 |

---

## 6. 核心业务口径与算法

> 这一节是**最容易改错的地方**。所有口径在需求拷问中逐条敲定过（`CONTEXT.md`），
> 改动前请先读那个文件。

### 6.1 金额口径（最重要）

三个派生指标**全部是前端虚拟计算列，不入库**（`COMPUTED_DEFS`）：

| 指标 | 公式 | 出处 |
|---|---|---|
| **账内应收** | 开票金额 − 到账金额 | `Ledger.computeRow` |
| **账外应收** | 决算金额 − 开票金额 | 同上 |
| **应收余额** | 决算金额 − 到账金额 − 核销金额 | 同上 |

**决算未定时的行为**（`null` 语义，`CONTEXT.md`「决算未定时的计算规则」）：

```js
balanceOf(r) {
  const hasFinal = r.final_amount !== null && r.final_amount !== undefined && r.final_amount !== '';
  if (!hasFinal) return null;          // ← 关键：不是 0，是 null
  return Math.round((Number(r.final_amount) - Number(r.received_amount || 0)
    - Number(r.writeoff_amount || 0)) * 10000) / 10000;
}
```

| 指标 | 决算为空时 |
|---|---|
| 账内应收 | **照常计算**（开票、到账都是实际发生额，不依赖决算） |
| 账外应收 | `null` → 界面显示 `—`，**不参与合计** |
| 应收余额 | `null` → 界面显示 `—`，**不参与合计** |

> **`null` 与 `0` 的区别是整个金额体系的地基。** 写成 `0` 会引发两个具体故障：
> ① 合计被"虚减"（不存在的欠款被算成 0 额度）；
> ② 看板 `filter(v > 0)` 把决算未定的行**整张滤空**（用户 2026-09-15 反馈过
> 「各部门应收余额中没有显示各部门的余额」，就是这个）。
>
> 四舍五入统一用 `Math.round(x * 10000) / 10000`（保留 4 位小数，与 `NUMERIC(18,4)` 对齐）。

### 6.2 结清判定与生命周期

```
未结 = 应收余额 ≠ 0  或  决算未定（余额不可知，不能算已结清）
已结清 = 应收余额 === 0
```

```js
dimValue('settled', r) { return this.balanceOf(r) === 0 ? '已结清' : '未结'; }
```

**台账总览默认筛「未结」**（`filters.settled = '未结'`，是 `DIMS` 里唯一 `def` 非「全部」的维度）。
**不建物理归档** —— 所有记录永久留在一张表里，结清的行默认隐藏、可一键切「全部」。

> **核销是可逆的数值事件，不是终态标记**：核销后若再次回款，核销金额可下调、
> 应收余额自动恢复。**不引入「结案」状态字段**（避免与债权状态语义冲突）。

### 6.3 筛选与分面计数

筛选有 **5 个维度 + 1 个关键词 + 1 个批次**。维度定义在 `Ledger.DIMS`。

#### 分面计数（faceted counts）—— 一个真实 bug 的产物

**旧实现（错的）**：胶囊上写「这个部门一共有几条」。
**问题**：与默认「未结」叠加后，数字与实际能筛出的条数不符。

真实数据实测（2026-09-15，19 条台账）：

| 部门 | 旧胶囊说 | 点下去实际筛出 |
|---|---|---|
| 物探一公司 | 18 条 | 9 条 |
| 能源所 | 1 条 | **0 条** ← 那条恰好已结清 |

用户看到的是「部门筛选坏了：点进去一片空白」。

**新实现**：下拉里每个选项的数字 = **在当前其他维度生效的前提下，点下去真能筛出几条**。

```js
facetCounts(key) {              // 本维度各选项各能筛出几条
  const c = new Map();
  this.rows.forEach(r => {
    if (!this.rowMatch(r, key)) return;      // ← 跳过本维度，其他维度照常生效
    const k = this.dimValue(key, r);
    c.set(k, (c.get(k) || 0) + 1);
  });
  return c;
}
```

配套的三处 UI 反馈：

1. **chip 变警示色**：选中值筛出 0 条时加 `.is-zero` 类并显示 `0`（`filterBarHTML`）
2. **0 条的选项淡化但仍可点**（`.capsule.is-zero`）—— 它正是「这一维没错、是被别的
   默认条件挡住了」的证据
3. **空状态给可点的放行建议**（`diagnoseEmpty()`）

#### `diagnoseEmpty()` 的两个反直觉之处

```js
diagnoseEmpty() {
  this.DIMS.forEach(d => {
    const saved = f[d.key];
    if (saved === '全部') return;        // 本来就没限制，松它没意义
    f[d.key] = '全部';
    const n = this.filteredRows().length;
    f[d.key] = saved;
    if (n > 0) tips.push({ n, label: `把「${d.label}」放宽到「全部」可看到 ${n} 条`, ... });
  });
  this._emptyTips = tips.sort((a, b) => a.n - b.n).slice(0, 3);   // ← 从少到多
}
```

**① 不能跳过「停在默认值」的维度。**
初学者直觉是「用户没主动筛的维度不算，跳过它」。但**挡住用户的往往正是默认值**
（本项目的「结清状态 = 未结」）。跳过它 → 永远给不出正确解释 → 只会建议放宽
用户亲手选的那一维 → 反而让他以为筛选坏了。

**② 排序必须从少到多。**
用户报的那个案例里，正确解释是「放宽结清状态 → 1 条」（说明"你要的那条在，
只是被挡住了"）；如果排成「放宽部门 → 8 条」会把人带偏成"部门筛错了"。
**首选建议必须是最贴身的那条。**

#### 部门筛选的两个细节

```js
if (f.dept === DEPT_NONE) {
  if (this.deptNameOf(r) !== DEPT_NONE) return false;   // 按"部门名解析不出来"判断
} else {
  const d = this.departments.find(x => x.name === f.dept);
  if (!d || r.department_id !== d.id) return false;     // 查不到 → 命中 0 条，不"当成没筛"
}
```

- **「未指定」不能按 `department_id IS NULL` 判断**：部门 id 存在但字典里查不到
  （字典没加载全 / 跨标签页新增的部门）同样会**显示**成「未指定」。
  **显示与筛选必须同一个口径**，否则又是「胶囊里有但筛不出」。
- **选中的部门名在部门表里查不到**（部门被删/改名）→ 命中 0 条 + 空状态给出
  可点的清除建议，而不是静默「当成没筛」。

### 6.4 列偏好三维度

```js
{ hidden_cols, col_order, frozen_cols }      // 全塞在 ar_user_prefs.prefs 一个 jsonb 里
```

**`col_order` 是全部列（含隐藏列）的顺序 —— 这是唯一真相。**
这样「隐藏 → 再显示」能回到原位，而不是跑到最后。

**核心不变量：冻结区必须是渲染顺序的连续前缀。**

```js
visibleDefs() {
  const vis = this.orderedDefs().filter(f => this.isVisible(f.key));
  const fzSet = new Set(this.frozen);
  return [...vis.filter(f => fzSet.has(f.key)), ...vis.filter(f => !fzSet.has(f.key))];
  //      ↑ 冻结的排前面              ↑ 其余按 order
}
```

不守这条会怎样：多个 `position: sticky` 的列如果中间夹着滚动列，
粘住的列会**盖在正在滚动的列上面** —— 表现为「一列压着一列」。
所以在 `visibleDefs()` 里**强制成前缀**，任何来源的偏好数据都破坏不了它。

**兼容旧格式**（`applyPrefs`）：localStorage 里存过裸数组版本（只有 hidden），
所以 `if (Array.isArray(p)) { this.hidden = new Set(p); return; }`。

**`MAX_FROZEN = 8`**：超限时 `freeze()` 直接 toast 拒绝；`commit()` 里还会把
超出的退回滚动区（防止「面板里显示冻结着、表里没冻结」）。

### 6.5 表格版面：三条铁律

这三条都是**用户明确抱怨过**、修完写进 README 的。

#### 铁律一：`sticky` 冻结列的 `left` 必须等于**实测**宽度

表格是 `table-layout: auto`（24 列会溢出，不能改 `fixed`），
浏览器会把声明宽度**向内容最小宽度回缩**（声明 36px 实测只画到 29px）。

如果下一列仍按 `left:36px` 定位 → 两列间会露出正在横向滚动的单元格 →
表现为「序号冻结后左边一片空白 + 文字残片穿帮」。

**修法**（`syncFrozen()`）：

```js
const w = el => Math.round(el.getBoundingClientRect().width * 100) / 100;   // 实测
let acc = w(chk) + w(idx);
userFrozen.forEach((th, i) => { offsets[i] = acc; acc = Math.round((acc + w(th)) * 100) / 100; });
st.textContent = offsets.map((left, i) => `.ledger-table .fz-${i} { left: ${left}px; }`).join('\n');
```

同时把勾选列/序号列的实测宽度**回写 CSS 变量** `--fc-check` / `--fc-idx` / `--fc-w`，
但**只在 `hasOverflow` 时回写** —— 那时各列宽度之和必然大于容器，浏览器不会再去
分配多余空间，回写不会引起二次回流；表格窄到不需要横滚时偏移本来就无所谓。

`width` / `min-width` / `max-width` **三处要同时锁死到同一个变量**：

```css
.ledger-table { --fc-check: 36px; --fc-idx: 40px; }
.ledger-table td.col-check { width: var(--fc-check); min-width: var(--fc-check); max-width: var(--fc-check); }
```

> **自检口径**：量「冻结区右边界 x」与「下一列左边界 x」，**期望间隙恒为 0.0px**。

#### 铁律二：`height:100%` 链会断，`fitHeight()` 必须实测

**病根**：`#page-ledger { height:100% }` 但上层 `.app-main` 高度由内容决定 →
百分比解析不出具体值 → `.table-wrap { max-height:100% }` **退化成 `none`** →
表格没有内部滚动区、整页往下滚、**表头跟着滚走**、横向滚动条被推到几千像素高的表底。

**修法**（`fitHeight()`）——**关键是"实测"而不是"算术推导"**：

```js
fitHeight() {
  const page = document.getElementById('page-ledger');
  page.style.height = '';                            // ① 撤掉旧值，量自然顶边
  const rect = page.getBoundingClientRect();
  const top = rect.top + (window.scrollY || 0);
  const holder = page.parentElement;                 // .page-container
  const cs = getComputedStyle(holder || page);
  const padB = parseFloat(cs.paddingBottom) || 0;
  const mb = parseFloat(getComputedStyle(page).marginBottom) || 0;
  const vh = document.documentElement.clientHeight || window.innerHeight;
  page.style.height = Math.max(320, Math.round(vh - top - padB - mb)) + 'px';
}
```

**为什么不能算**：算术法「视口高 − 顶栏 − 内边距」只要**上方漏算任何一项**
（提示条、外边距、flex 间距、以后新增的一条工具行）就会溢出几像素 →
**页面立刻多出一条滚动条** —— 正是用户抱怨的「容器不要有滚动栏」。

**为什么收敛**：可用高度取 `documentElement.clientHeight`，若此刻已有滚动条它会
自动被扣掉 → 下次算出更小 → 滚动条消失 → 再量又变准。不会来回抖，因为
「高度恰好等于可用值」本身就满足 `scrollHeight === clientHeight`。

**配套**：`bindOverflow()` 里监听 `resize` + `ResizeObserver(topbar)`
（顶栏高度会变）→ 防抖 150ms 后重算。

> **自检口径**：`document.documentElement.scrollHeight === clientHeight`（±1px）。

#### 铁律三：筛选条压成一行 chip

原实现是 5 行平铺胶囊（约 150px+），31 个部门会占掉 4~5 行。
现在**一行 chip（30px）**，点开才是选项下拉。

**附带的安全设计**：空状态**不能**用 `<td colspan="N">` ——
台账表宽可达 3000px+，`colspan` 里的居中内容会落在**整表的中点**（约 x=1700），
落在可视区之外 → 「一片空白什么都没有」。所以 `renderEmpty()` 渲染的是
**独立的 `.table-wrap` 面板**。

### 6.6 看板聚合口径

**四张金额图统一口径**（与「催收跟踪」一致）：

```
决算已定 → 应收余额（决算 − 到账 − 核销）
决算未定 → 账内应收（开票 − 到账）        ← 照样子要催、也要看
```

```js
const owedParts = r => {
  const c = comp(r); const b = c.receivable_balance;
  return b === null ? { bal: 0, unfin: Number(c.receivable_internal) || 0 }
                    : { bal: Number(b) || 0, unfin: 0 };
};
```

**两个反例都踩过**（README 里也写了）：

- ❌ **只取应收余额** → 决算大面积未定的台账被 `filter(v > 0)` **整张滤空**
  （用户反馈「各部门应收余额中没有显示各部门的余额」）
- ❌ **直接相加** → 「应收余额」与「账内应收」是两个口径，**混成一个数字会让金额
  失去含义，财务无法核对**

所以图上做成**两段堆叠且颜色可分**：实色段 = 应收余额，淡色描边段 = 决算未定部分。
卡片头标注「决算未定 N 笔按账内应收计」。

**两个正交视角**（`CONTEXT.md`「组织」）：

| 视角 | 聚合依据 | 回答 |
|---|---|---|
| **部门**（责任口径） | `Ledger.deptNameOf(r)` | 这个合同是哪个团队干的 |
| **单位**（法人口径） | `r.creditor_unit` | 这笔钱法律上是谁的应收 |

部门与单位**正交**，同一部门可持有不同单位名头的合同。

**图表实现要点**（改图表前必读）：

```js
paintCharts() {
  const paint = (name, build) => {
    const el = page.querySelector(`[data-chart="${name}"]`);
    const w = Math.round(el.clientWidth);
    if (!w || w < 80) return;              // 容器不可见 → 稍后重绘
    el.innerHTML = build(Math.min(w, DASH_MAX_W));   // ← 先量宽，再生成 viewBox
  };
  ...
}
```

**为什么必须量宽**：SVG 用 `viewBox` + `width:100%` 时，容器比 viewBox 宽多少，
**图内文字就放大多少倍**（520 宽 viewBox 塞进 1400px 卡片 → 12px 文字渲染成 32px）。
先量宽再生成 viewBox，缩放比恒为 1，文字尺寸即设计尺寸。

**标签截断**（`fitLabel`）必须**按像素、从尾部截**：

```js
textW(str, fontSize) {                     // 汉字 ≈ 1em，半角 ≈ 0.55em
  let w = 0;
  for (const ch of String(str)) w += ch.charCodeAt(0) > 0x2e80 ? fontSize : fontSize * 0.55;
  return w;
}
```

历史 bug：原先按「字数」截断（labelMax = 12 字 → 144px），而该图标签区可用宽度
只有 122px，又用 `text-anchor="end"` 右对齐 → **文字向左溢出被 SVG 裁掉开头**，
用户看到「名称只剩中间几个字」（实测「山西普能控股集团某煤业有…」左溢 34px）。
现在标签**左对齐**（`x="0"`），截断只发生在尾部。

### 6.7 Excel 导入的「归属部门」从哪来

这是导入链路上最深的坑，`README.md` 里有专门一节，这里给代码级说明。

**优先级**：`统一指定部门` > `按「部门名称」列自动匹配` > `不指定`

```js
// commit() 里
obj.department_id = autoMatch ? ((plan.rows[ri] || {}).deptId || null) : deptId;
```

**`deptPlan()` 是预览页与正式写入共用的同一份判断** ——
杜绝「预览说没问题、落库却是空」。

```js
deptPlan() {
  const ci = this.mapping.indexOf('department');     // 「部门名称」列的下标
  const byName = new Map();
  Ledger.departments.forEach(d => {
    byName.set(d.name, d.id);
    byName.set(this.normDept(d.name), d.id);         // 归一化后再存一份（去空白+小写）
  });
  ...
}
```

**三条铁律**：

1. **部门名匹配不上绝不能静默写 `null`。** 归属部门是台账第一维度，静默丢弃会让
   「导入完成」与「列上全是未指定」同时成立，用户根本看不出问题在哪。
   现在：预览页预检（`renderDeptPlan`）+ 结果页点名告警 + 支持就地指定归属。
2. **归一化匹配**（`normDept`：去掉所有空白含全角空格 + 统一小写），降低
   「看着一样其实不等」的误判。
3. **模板的示例行必须取系统里真实存在的部门名**（`Ledger.departments[0].name`）。
   原先写死一个库里没有的名字，配上「部门名匹配不上会告警」的预检，
   **等于用示例教用户填出告警**。

**结果页的告警**（`noDeptHtml`）会给出两种补法：
① 先到「系统管理 → 部门」建好同名部门，再用「覆盖更新」重导；
② 把 Excel 里的部门名改成系统已有名称后重导。

### 6.8 合同额自动带入决算（ADR-0003）

业务惯例：**一般项目不专门做决算，直接以合同额替代**；只有按工作量结算的项目
才在完工后单独定案。

**规则**：`决算方式 ≠ '工作量'` **且** `决算金额为空` → 合同金额带入决算金额。

**两处实现，逻辑必须一致**：

```js
// ① 导入时（importer.js commit 内）
if (obj.final_amount === null || obj.final_amount === undefined) {
  if (obj.contract_amount !== null && obj.contract_amount !== undefined
      && obj.final_method && obj.final_method !== '工作量') {
    obj.final_amount = obj.contract_amount;
  }
}
```

```js
// ② 表单里（ledger.js bindModal 的 autoFillFinal）
if (m && m !== '工作量' && finalAmt.value === '' && contractAmt.value !== '') {
  finalAmt.value = contractAmt.value;
  Utils.toast('已按合同金额带入「决算金额」（决算方式非工作量），可手动修改', 'info');
}
```

> `contract_amount` 是**唯一仍在用的旧列**。它**刻意不在 `FIELD_DEFS` 里** ——
> 因为它不参与台账表格显示，只在编辑弹窗与导入目标里单独处理。
> 所以搜索 `contract_amount` 时你会看到它出现在 `ledger.js` 的 `renderModal` /
> `save`、`importer.js` 的 `IMPORT_TARGETS` / `buildPayload`，但**不在 `fields.js`**。
> 这是有意的，不要"顺手"把它加进 `FIELD_DEFS`（会多出一列不显示却又参与导出的字段）。

---

## 7. 权限模型

**三层角色 + 7 项逐人权 + 字段级保护 + 行级 RLS。四层是叠加的。**

### 7.1 三级角色

| 角色 | 判定 | 能力 |
|---|---|---|
| **超级管理员** | `ar_users.ar_super_admin = TRUE AND ar_role = 'admin'` | 全部 + 用户管理 + 部门管理 + 系统设置 |
| **管理员**（财务） | `ar_users.ar_role = 'admin'` | 台账全部字段（含金额）、开票/回款明细、导入导出、选项管理 |
| **报账员** | `ar_users.ar_role = 'user'` | **仅催收跟踪 9 字段 + 附件**；权限逐人开放 |

另有 `ar_role = 'disabled'`（停用，仅 SQL 可设，界面上无入口）。

### 7.2 7 项逐人权限（`PERM_DEFS`）

| key | 标签 | 影响 |
|---|---|---|
| `view` | 查看本部门台账 | 左侧导航「数据看板/台账总览」显不显示 |
| `view_all` | 查看全部台账 | 突破行级 RLS（`ar_can_see_row` 直接 TRUE） |
| `add` | 新增记录 | 「＋ 新增记录」按钮 + `ar_ledger` INSERT 策略 |
| `edit` | 编辑记录 | 「编辑」链接 + UPDATE 策略 + 附件上传 |
| `delete` | 删除记录 | 「删除」链接 + DELETE 策略 + 批次管理入口 |
| `import` | Excel 导入 | 导入入口 + 批次管理入口 |
| `export` | 导出 Excel | 「⇩ 导出 Excel」按钮 |

存于 `ar_user_perms.perms`（jsonb，键即上表 key）。
**管理员不需要这 7 项** —— `Auth.can()` 对管理员恒 `true`。

> **新增一项权限要改 4 处**：① `js/fields.js` 的 `PERM_DEFS`；
> ② `sql/` 里对应的 RLS 策略（如果它影响数据读写）；
> ③ 用到它的前端逻辑（`Auth.can('新key')`）；
> ④ `sql/verify-setup.sql` 的账号权限检查段（可选但推荐）。

### 7.3 字段级保护（数据库触发器 + 前端双保险）

**数据库**（`ar_ledger_guard_fields`，见 4.6）用 jsonb 白名单比对，
**非管理员只能改这 9 个业务字段**：

```
project_status, final_method, debt_status, collector, dunning_date,
comm_method, feedback, latest_progress, next_plan
```

**前端**（`Editor.editableKeys()`）必须与之一致：

```js
editableKeys() {
  if (Auth.isAdmin) return null;                     // null = 全部可编辑
  const keys = FIELD_DEFS.filter(f => f.deptEditable).map(f => f.key);
  if (this.isNew) {
    FORM_GROUPS[0].fields.forEach(k => { if (!keys.includes(k)) keys.push(k); });  // 新增时可填基本信息
  }
  return new Set(keys);
}
```

区别在于：**新增记录时**报账员可以额外填「基本信息」整组
（`FORM_GROUPS[0]`：合同编号/项目名称/客户名称/客户属性/单位/工作性质/八大板块），
**编辑时**只能改那 9 个。

> `deptEditable: true` 标记在 `FIELD_DEFS` 的 9 个字段上。
> **加一个「部门可编辑字段」要改 3 处**：① `fields.js` 加 `deptEditable: true`；
> ② SQL 触发器的白名单数组（两处！`NEW` 和 `OLD` 各一次）；
> ③ 跑 `verify-setup.sql` 确认。忘了 ② 会出现「前端能填、保存报错 `AR_FIELD_LOCKED`」。

### 7.4 行级 RLS（最后一道，也是最硬的）

见 4.5。要点：

- **管理员看到全部**；报账员默认只看**本部门**
  （`p_department_id IN (SELECT department_id FROM ar_users WHERE user_id = auth.uid())`）
- 子表（`ar_invoices` / `ar_receipts` / `ar_attachments`）**可见性跟随台账行**
- `ar_user_prefs` 只有本人能读写（列偏好是私人的）
- **前端 `Auth.can()` 只管 UI**，真拦截在数据库

### 7.5 账号管理的边界（易踩）

```
「删除账号」= 删除 ar_users 行（移出台账）
            ≠ 删除 auth.users（登录账号保留）
```

**因为 `auth.users` 与月报系统共用**，删掉会影响月报。所以 `ar_delete_user` RPC
只删 `ar_users`。界面文案刻意写成「移出台账（不影响月报系统）」。

**主管理员保护**：`ar_users.ar_protected = TRUE` 的账号（建库时按邮箱硬编码）
不能被删除/降级。`ar_delete_user` 内部调 `ar_super_admin_count_excluding`
防止「删掉最后一个超管」。

---

## 8. 开发铁律与已知陷阱

> 这一节是**用返工换来的**。每条都对应一次真实的 bug 或一次被工具坑的经历。

### 8.1 渲染层

1. **`innerHTML` 全量重绘会丢三样东西：焦点、滚动位置、事件绑定。**
   所以项目里区分两套刷新：
   - `render()` —— 整页重绘，**只在首次加载和 `reload()` 时用**
   - `refreshTable()` / `syncFilterBar()` / `syncHead()` / `syncUsage()` —— 局部刷新，**日常用这些**

   最典型的坑：搜索框输入时若走 `render()`，输入到第二个字就**失焦**。

2. **列设置面板的 `onChange` 必须是 `refreshTable()`，不能是 `render()`。**
   传 `render()` 会把**触发面板的那个按钮一起替换掉** → 面板失去锚点 → 面板消失。

3. **重绘后要手动恢复的东西，记得都恢复**：
   `refreshTable()` 里保留了 `.table-wrap` 的 `scrollLeft`（否则横向位置归零）。

4. **弹窗类组件用 `id` 去重后再 append**：
   ```js
   const old = document.getElementById('modal-xxx');
   if (old) old.remove();
   ```
   否则会叠出多个。

5. **所有用户数据拼进 HTML 都要过 `Utils.escapeHtml()`**。
   属性值里也要（`title="${Utils.escapeHtml(v)}"`）。

### 8.2 异步与状态

6. **「进入第 2 步时元素已被销毁」的经典 bug**。
   `Importer` 的「数据归属部门」「合同编号重复时」两个 `<select>` **只存在于第 1 步**；
   进入第 2 步时 `#import-body` 被 `innerHTML` 整体替换，元素销毁。
   旧写法在 `commit()` 里才去读 DOM → **恒得 `null`** → 两项设置静默失效
   （不管选什么都按 `auto + skip` 走）。
   **修法：选中时就写回实例状态**（`this.targetDept = deptSel.value`）。
   同理 `fileName` 也要在 `readFile` 时记住。

7. **PostgREST 单次请求没有事务。** 需要「多步原子操作」的地方必须自己补偿：
   `DictAdmin.save()` 是「先删后插」，插入失败会按**删除前的数据库快照**写回；
   `Attachments.upload()` 是先传 Storage 再写表，**写表失败会回删文件**。

8. **快照必须取自数据库，不能取内存。**
   `DictAdmin.save()` 的回滚快照若用内存里的 `items`，未落库的类别会
   「删 0 行 → 回滚」把内置默认值误写成"已自定义"。所以先 `select` 一次。

9. **判断「读不到」和「读到空」要分开。**
   `DictAdmin.usage === null` 表示读不到（整块隐藏），`usage.size === 0` 才是真没数据。
   显示一片「0 条」比不显示更糟 —— 会把财务吓一跳。
   同理 `Admin.permsWarning`：读不到权限表时**必须让人看见**，
   否则表现成「所有报账员都没权限」。

### 8.3 数据与口径

10. **`null` ≠ `0`**（见 6.1）。决算未定必须是 `null`。
11. **缩进一致的「显示值」与「筛选值」必须同源。**
    「归属部门」列显示的是**部门名**（`computeRow` 派生），
    所以筛选也必须按部门名（`deptNameOf`），不能按 `department_id IS NULL`。
    这类「显示一套、筛选另一套」是本项目**产生过两次 bug** 的模式
    （部门筛选、选项孤儿值），改筛选逻辑时优先检查这一条。
12. **`computeRow()` 比 `balanceOf()` 重。**
    `computeRow` 还要拼附件摘要，逐行调用会明显变慢。
    **筛选与分面计数一律用 `balanceOf()`**（这是它被单独抽出来的唯一理由）。

### 8.4 工具与环境

13. **同一文件不要并行发多个 Edit。** 本项目的工具链下，
    并行编辑同一文件时**后一个会覆盖前一个**（但两个都报成功）。
    改同文件一律一次一个，改完用 `sed -n` 复核。
14. **生成器模板串里的 `\n` 要写成 `\\n`。**
    `docs/preview/build-*.js` 是「用模板字符串生成一个 HTML 文件」，
    里面嵌的 JS 又有字符串。写 `\n` 会被**外层模板**先解析成真换行，
    把生成的脚本字符串截断 → 语法错误。
15. **Chrome `--dump-dom` / `--print-to-pdf` 在本机环境静默返回 0 字节。**
    （`headless=new` / `old` 两种模式、Bash 与 Node `spawnSync` 两种方式都试过。）
    **取不到渲染后的 DOM 文本** —— 读数值只能走「大字探针截图」，见 9.3。
16. **截图里的数字会看错。** 曾经把缩略图里的 `x235` 读成 `x226`，
    据此去修一个不存在的 9px bug。**几何数据一律走大字模式**。
17. **`git` 分支名避免用 `/`**（本地后台进程会干扰 `feature/xxx` 这类 refs 路径）。
18. **`vendor/` 不在仓库**。新机器上 `git clone` 后没有 `supabase.min.js`，
    靠 CDN 回退也能跑，但正式部署要手动拷。

---

## 9. 预览与验证工具链

**为什么要有这一套**：这个项目是静态页面 + 云数据库，**没有单元测试框架、没有 CI**。
「改完 CSS 想看一眼」如果每次都要部署到服务器、登录、点进去，反馈太慢。
所以做了一套**自包含 HTML 预览**：把 `css/style.css` + 真实 `js/*.js` + 模拟数据
内联进一个单文件 HTML，**双击就能看，不需要登录、不连数据库**。

### 9.1 五个预览页

```bash
node docs/preview/build-ledger-preview.js      # → docs/preview/ledger-preview.html
node docs/preview/build-dashboard-preview.js   # → docs/preview/dashboard-preview.html
node docs/preview/build-admin-preview.js       # → docs/preview/admin-preview.html
node docs/preview/build-dict-preview.js        # → docs/preview/dict-preview.html
node docs/preview/build-import-preview.js      # → docs/preview/import-preview.html
```

**生成器的共同结构**：读真实源码 → 拼进一个 HTML 模板 → `fs.writeFileSync`。
所以**产物是构建物，不要手改** —— 改了下次生成就没了。改样式后必须重新生成。

`docs/preview/mock-data.js` 提供共用的模拟数据与**最小 Supabase 桩件**
（`sb.from(...).select(...)` 之类，返回 Promise）。

> ### 🔴 仓库是公开的 —— 预览数据必须合成
>
> 预览页会把数据**内联进 HTML**，而 `docs/preview/*.html` **是入库的**。
> 所以：
> - **入库的预览一律用合成数据**（`@example.com` + `138000000xx` 这种）
> - 要看真实数据加 `--real`，产物写到 `.workbuddy/`（**已 gitignore**）而**不是** `docs/preview/`
> - 2026-09-15 修过一次：`admin-preview.html` 里内联着真实邮箱、姓名和 4 个手机号
>
> **还有一个已知未处理的遗留**：`mock-data.js` 与台账预览的合成数据里仍有**真实项目名/
> 客户公司名**（业务数据，不是人名）。改它们会牵动多个预览的断言，**需要业务方确认后再动**。

### 9.2 hash 场景开关（第 9.4 节有全表）

预览页支持用 URL hash 切场景，**便于重现「只在极端情况下才暴露」的问题**：

```
ledger-preview.html#scrolled        横向滚动 320px（冻结列 vs 滚动列的交界最容易穿帮）
ledger-preview.html#many            造 60 行（纵向滚动 + 表头常驻）
ledger-preview.html#measure2        大字模式：清空页面，只留一行 19px monospace 的实测读数
```

场景开关用**正则匹配**，所以**可以组合**：`#frozen-measure2` = 自定义冻结列场景 + 大字测量。

### 9.3 无头截图与「大字探针」（**本机工具，不在仓库**）

`.workbuddy/shot-ledger.js` 是一个无头 Chrome 截图脚本：

```bash
node .workbuddy/shot-ledger.js "#measure2" "#frozen-measure2" "#deptzero-measure2"
# 输出到 .workbuddy/shots/ledger-<name>.png

# 支持截别的预览页做冒烟测试
PREVIEW_PAGE=dict-preview.html SHOT_PREFIX=dict- node .workbuddy/shot-ledger.js "#measure"
```

> **这两个环境变量 + 这个脚本都在 `.workbuddy/`，不进仓库。**
> 接手人如果也想要这套能力，需要自己重建（约 60 行：`spawn` Chrome
> `--headless --screenshot`，轮询等文件大小稳定）。
> **为什么必须轮询**：Windows 下 `--screenshot` 是**异步落盘**的，
> Chrome 进程退出时文件可能还没写完 → 直接读会得到 0 字节（假失败）。

**「大字探针」是什么、为什么需要它**：

探针是一段注入的 JS，在页面上浮层打印实测几何数据。但**缩略截图里的数字会看错**
（曾经把 `x235` 读成 `x226`，据此去修一个不存在的 9px bug）。

所以加了 `#measure2` **大字模式**：清空整个页面，只留一行 19px monospace 的读数。
这样截图放大后数字不会认错。

> 本来更省事的办法是用 `chrome --dump-dom` 直接把 DOM 文本 dump 出来，
> 但**在本机环境它静默返回 0 字节**（`headless=new`/`old` 两种模式、
> Bash 与 Node `spawnSync` 两种方式都试过）。所以只能靠大字截图目视。
> 如果接手人的环境支持 `--dump-dom`，可以省掉这一步。

**测量类断言必须守的几条口径**（都踩过）：

| 口径 | 为什么 |
|---|---|
| 测「冻结列是否贴住容器左缘」基准要加 `wrap.clientLeft` | `overflow` 容器有 1px 边框，用 `wrap.left` 会把边框算成"偏移了 1px" |
| 测量前必须 `wrap.scrollLeft = 0; wrap.scrollTop = 0` | 残留的滚动位置会造出「间隙 -300px」这种假故障 |
| 量「右栏留白」要取「表格底缘 → 底部卡片顶缘」 | 卡片用 `margin-top:auto` 贴底时，「容器底缘 − 末块底缘」**恒为 0**，会把空白完全掩盖 |
| 预览外壳不要写死 `height` | `.preview-shell{height:900px}` 会和按实测写进来的内联高度打架，让断言测不准 |

### 9.4 预览场景 hash 全表

| 预览页 | hash | 场景 |
|---|---|---|
| **ledger** | （无） | 默认，表格左端 + 顶部 |
| | `#scrolled` | 横向滚动 320px |
| | `#far` | 滚到最右 |
| | `#core` | 只显示常用列 |
| | `#empty` | 空数据 |
| | `#many` | 造 60 行 |
| | `#nodept` | 测「未指定」部门筛选 |
| | `#deptzero` | **部门筛出 0 条**（复现用户报的「部门筛选有问题」） |
| | `#deptzero-relaxno` | 同上，但不点放行按钮（看空状态面板的实际观感） |
| | `#frozen` | 自定义冻结列 + 打乱列顺序 |
| | `#measure` / `#measure2` | 探针浮层 / 大字模式 |
| **dict** | （无） | 默认类别（`project_status`，内置未落库） |
| | `#managed` | 已落库类别（`client_attr`，15 项） |
| | `#orphan` | 存在孤儿值的类别 |
| | `#renamed` | 就地改首项名 → 原值当场变孤儿 |
| | `#saveimpact` | 保存前的影响面确认框 |
| | `#attach` | 附件类别（走 `ar_attachments`） |
| | `#many` | 18 项长列表 |
| | `#dirty` | 有未保存修改 |
| | `#confirm` | 删除二次确认 |
| | `#measure` / `#measure-clean` | 探针（15 项含孤儿值 / 4 项干净场景） |
| **import** | `#resolved` | 部门名全部匹配上 |
| | `#nodeptcol` | 表里没有可识别的「部门名称」列 |
| | `#unified` | 统一指定归属部门 |
| | `#measure` | 探针 |
| **admin** | （无） | 超级管理员视角 |
| | `#perm-modal` | 打开账号编辑弹窗 |
| **dashboard** | （无） | — |

### 9.5 回归测试（唯一一个"真测试"）

```bash
node docs/preview/verify-import-dept.js
# 期望输出：通过 18 项，失败 0 项
```

**它做什么**：把真实源码（`js/fields.js` + `js/importer.js`）在 Node `vm` 里跑起来，
喂一份 Excel 快照，断言 `mapping` / `deptPlan` / `commit` 落库载荷三处都对。
**不需要浏览器、不需要登录、不连数据库。**

> ### ⚠ 它依赖两个**不在仓库里**的快照文件
>
> ```
> .workbuddy/tmp-sheet.json    待测 Excel 的二维数组（首行表头，须含「部门名称」列）
> .workbuddy/tmp-depts.json    ar_departments 的 [{id, name}] 快照
> ```
>
> 缺文件时脚本会 **`exit(2)` 并打印怎么造**（`verify-import-dept.js: 30`）。
> **接手人第一次跑会直接失败 —— 这是预期行为，不是环境坏了。**
> 造数据的方法：用 SheetJS 把一份真实导入表解析成 `sheet_to_json(ws, {header:1})`
> 写进 `tmp-sheet.json`；从 `ar_departments` 查 `id,name` 写进 `tmp-depts.json`。
> 或者在 Supabase SQL Editor 跑 `select json_agg(json_build_object('id',id,'name',name)) from ar_departments;`

**设计上值得学的一点**：`verify-import-dept.js: 18` 开头写着 ——
「期望值一律**从数据推导**，不写死具体条数/名称。写死过一版，后来给线上库新建了一个
部门，断言立刻全红（脚本"腐烂"）。现在只会因真实缺陷而失败。」
**新增断言时请沿用这个原则。**

---

## 10. 部署流程

### 10.1 改完前端之后的标准动作

```bash
# ① 改代码
# ② 升版本号（关键！否则用户的浏览器用旧缓存）
#    index.html 里所有 ?v=20260915s 一起升（vscode 里 replace_all 或：）
sed -i 's/20260915s/20260915t/g' index.html

# ③ 重建全部预览产物（它们内联了 css/js，不重建就是旧的）
for f in dashboard admin ledger dict import; do node docs/preview/build-$f-preview.js; done

# ④ 跑回归
node docs/preview/verify-import-dept.js

# ⑤ 提交推送
git add -A && git commit -m "..." && git push origin main
```

### 10.2 试运行（GitHub Pages）

推送到 `main` 后，GitHub Pages 会自动更新：
`https://jnsun.github.io/Enterprise-Accounts-Receivable-Ledger/`

> 因为 `vendor/` 不在仓库，Pages 上永远走 CDN 回退。**这正好是个天然的
> "CDN 可用性" 测试** —— 如果 Pages 上能跑，说明 CDN 那两行没坏。

### 10.3 正式部署（腾讯云）

```bash
# 前端：拷静态文件到站点目录
scp -r index.html css js ubuntu@服务器IP:/var/www/ledger/
# （vendor/ 也要拷 —— 服务器上有本地库就不走 CDN，更稳）

# 数据库迁移（如果本次有 SQL 改动）
ssh ubuntu@服务器IP "sudo docker exec -i supabase-db psql -U supabase_admin -d postgres" < sql/upgrade-xxx.sql

# 然后浏览器 Ctrl+F5 强刷
```

### 10.4 ⚠ 现在有两套数据库，别搞混

| | 新库（**当前使用**） | 老库（**已弃用**） |
|---|---|---|
| 位置 | Supabase 云端 `bttnxyexkbsskmqttbzi.supabase.co` | 腾讯云自托管实例（IP 交接时另行告知），部署在 `/opt/supabase/docker` |
| 切换时间 | 2026-09-14 | — |
| 与谁同实例 | 独立实例，**与月报/证照/安全生产完全隔离** | 与月报/证照同实例（不同表） |
| 数据 | 新库是空的，需重新导入 | 老库只有测试数据，**未迁移** |

**两个必须知道的坑**：

1. **`js/config.js` 现在指向新库**。但**线上 `www.safety.sx.cn/ledger` 的前端
   config 可能还指着老库** —— 部署时**必须确认 `js/config.js` 是新的那一版**，
   否则前端连的是老库，数据对不上。
2. 老库的 SQL 部署命令（`ssh ... docker exec ...`）**只对老库有效**。
   新库是云端托管，只能在 **Supabase Studio 的 SQL Editor** 里粘贴执行，
   或者在 Supabase 控制台拿连接串用 `psql`。

### 10.5 部署自检（**每次测试前跑一遍**）

在 Supabase Studio SQL Editor 跑 `sql/verify-setup.sql`（**只读，不改数据**），
它会输出一张检查表：

| 段 | 检查什么 |
|---|---|
| ① 表结构 | 各表行数、字典条数、部门数 |
| ② 迁移状态 | v3 新列齐不齐、v3.1 回款明细表、v3.2 维护函数、附件桶 |
| ③ **策略口径** | **`ar_user_perms`/`ar_settings`/`ar_ledger` 是否还残留旧 `is_admin()`** |
| ④ 字典数据 | 四类选项条数、是否残留占位值 |
| ⑤ 账号权限 | 角色分布、未分配部门账号、权限全空的报账员 |
| ⑥ 数据健康 | 明细覆盖、决算为空行数、挂账时间与最近开票日期不一致的行数 |

**第 ③ 段最重要** —— 残留旧 `is_admin()` 就是 v3.2 没生效（见 4.5）。

---

## 11. 待办与已知问题

### 11.1 需要业务方决策的（不能自行改）

| # | 事项 | 说明 |
|---|---|---|
| 1 | **预览数据里的真实业务名** | `docs/preview/mock-data.js` 与台账预览的合成数据里含真实项目名/客户公司名。改它们会牵动多个预览的断言。**仓库是公开的，这属于数据暴露。** |
| 2 | **两个真实人名在公开仓库里** | 「翟悟飞」「孙勇军」在 `CONTEXT.md`、4 个 SQL 脚本、3 个预览产物里都有。它们是**合法的台账归属主体（个人独立核算挂靠），是刻意的部门名而非数据泄露**（`CONTEXT.md`「个人独立核算归属」）。但如果你认为个人信息敏感度不可接受，需要连同 SQL 种子一起改。 |
| 3 | **老库数据是否要迁** | 老库（腾讯云自托管）只有测试数据，从未迁移。如果实际生产数据在老库里，需要写迁移脚本。 |
| 4 | **微信扫码登录** | 原始规划里有，未实现。 |

### 11.2 代码层面的已知限制

| # | 事项 | 影响 | 位置 |
|---|---|---|---|
| 4 | **明细导入无去重** | 重复执行同一文件会重复登记开票/回款 | `detailimporter.js` 头部注释已声明 |
| 5 | **`contract_no` 无唯一约束** | 判重是前端做的（读全表建 Map），并发导入可能重复 | `ar_ledger` 表 |
| 6 | **`ar_role='disabled'` 无界面入口** | 停用账号只能 SQL 改 | `admin.js` |
| 7 | **`ar_protected` 是硬编码邮箱** | 换主管理员要手工改 SQL | `init-new-instance.sql: 539` |
| 8 | **查询有 `limit`** | `ar_ledger` 5000、附件 20000、字典 2000。超过会静默截断 | 各模块 `load()` |
| 9 | **`ar_settings.warn_days` 是死列** | 随自动逾期判定移除，前端已不读 | `ar_settings` |
| 10 | **老字段仍在库中** | `start_date`/`end_date`/`progress`/`cost_expense` 等 v1 列没删，界面隐藏 | `ar_ledger` |

### 11.3 已修但值得记住的「同类 bug 模式」

这个项目里有**一个 bug 模式反复出现了三次**，改代码时优先怀疑它：

> **「同一份数据有两套口径，其中一套是对的另一套是错的」**
>
> | 出现 | 错的那套 | 症状 |
> |---|---|---|
> | 部门筛选 | 胶囊计数按「该值总数」而不是分面计数 | 「能源所 1 条」点进去 0 条 |
> | 部门筛选 | 「未指定」按 `department_id IS NULL` 而不是按部门名解析 | 显示与筛选不一致 |
> | 选项管理 | 选项表与台账数据脱节（删了选项不告警） | 值还在，但下拉选不回、筛不出 |
> | 看板 | 金额图只取应收余额，忽略决算未定 | 整张图被滤空 |
>
> **新增任何「筛选 / 汇总 / 统计」逻辑时，先问：这个数字/条件的口径，
> 与它旁边显示的那个数字，是不是同一个？**

---

## 12. 术语表（速查）

完整定义见 `CONTEXT.md`，这里只列最常打交道的：

| 术语 | 含义 |
|---|---|
| **台账记录** | 一行 = **一个合同**（不是项目）。`contract_no` 是业务唯一标识 |
| **归属部门** | 台账的**责任主体**（内部考核归属），30 个。决定**行级权限** |
| **单位（债权单位）** | 应收账款的**债权主体**（法人），4 个：物化院/六勘院/测绘院/禹地公司 |
| **部门与单位正交** | 部门不隶属单位。同一部门可持有不同单位名头的合同 |
| **账内应收** | 开票 − 到账 |
| **账外应收** | 决算 − 开票 |
| **应收余额** | 决算 − 到账 − 核销 |
| **决算未定** | `final_amount` 为空。此时账外应收/应收余额显示 `—` 且不参与合计 |
| **未结 / 已结清** | 应收余额 ≠ 0 或决算未定 = 未结；= 0 = 已结清 |
| **核销** | **可逆的数值事件**，不是终态标记。核销后若再回款可下调 |
| **债权状态** | **人工维护**的催收处置阶段（正常/逾期/诉讼/和解），不是系统推导值 |
| **挂账时间** | = 开票明细中**最近一笔开票日期**，自动维护 |
| **批次** | 一次 Excel 导入 = 一个批次，可整批回滚 |
| **孤儿值** | 数据里在用、但选项表里没有的值 → 下拉选不回、筛选筛不到 |
| **分面计数** | 筛选下拉里每个选项后的数字 = 在当前**其他**维度生效前提下点下去能筛出几条 |

---

## 附录 A：字段定义速查（`js/fields.js`）

### A.1 `FIELD_DEFS`（26 个数据库字段）

| # | key | 界面标签 | type | width | dict | 可编辑区 |
|---|---|---|---|---|---|---|
| 1 | `contract_no` | 合同编号 | text | 110 | — | 新增时可填 |
| 2 | `project_name` | 项目名称 | text | 200 | — | 新增时可填 |
| 3 | `department_id` | 归属部门 | text | 110 | — | 仅管理员（`noImport: true`） |
| 4 | `owner_unit` | 客户名称 | text | 170 | datalist | 新增时可填 |
| 5 | `client_attr` | 客户属性 | select | 96 | `client_attr` | 新增时可填 |
| 6 | `creditor_unit` | 单位 | combo | 130 | `unit` | 新增时可填 |
| 7 | `work_nature` | 工作性质 | combo | 96 | `work_nature` | 新增时可填 |
| 8 | `sector` | 八大板块 | combo | 96 | `sector` | 新增时可填 |
| 9 | `project_status` | 项目状态 | select | 88 | `project_status` | ✅ `deptEditable` |
| 10 | `final_method` | 决算方式 | select | 92 | `final_method` | ✅ `deptEditable` |
| 11 | `charge_date` | 最新挂账时间 | date | 108 | — | 自动维护 |
| 12 | `final_amount` | 决算金额 | money | 92 | — | 仅管理员 |
| 13 | `invoiced_amount` | 开票金额 | money | 92 | — | 仅管理员 |
| 14 | `received_amount` | 到账金额 | money | 92 | — | 仅管理员 |
| 15 | `writeoff_amount` | 核销金额 | money | 92 | — | 仅管理员 |
| 16 | `debt_status` | 债权状态 | select | 88 | `debt_status` | ✅ `deptEditable` |
| 17 | `collector` | 清收责任人 | text | 100 | — | ✅ `deptEditable` |
| 18 | `dunning_date` | 最新催收时间 | date | 108 | — | ✅ `deptEditable` |
| 19 | `comm_method` | 沟通方式 | select | 104 | `comm_method` | ✅ `deptEditable` |
| 20 | `feedback` | 对方反馈 | select | 150 | `feedback` | ✅ `deptEditable` |
| 21 | `latest_progress` | 最新进展 | select | 140 | `progress_note` | ✅ `deptEditable` |
| 22 | `next_plan` | 下一步计划 | select | 130 | `next_plan` | ✅ `deptEditable` |
| 23 | `remark` | 备注 | textarea | 150 | — | 仅管理员 |

> 表格顺序 = 定义顺序 = 台账总览的**默认列顺序**。
> 这 23 个字段全部可以在表格里显示、可以导出、可以参与导入映射
> （例外：`department_id` 标了 `noImport: true`，由导入端的虚拟目标
> 「部门名称（归属部门）」承担）。
> 带 `freeOther: true` 的 select 会渲染成「下拉 + 其他（自由填写）」组合控件。

**`field` 属性含义**：

| 属性 | 作用 |
|---|---|
| `type` | `text` \| `money` \| `date` \| `select` \| `combo` \| `textarea` |
| `width` | 表格列宽（px）；money/date 自动右对齐 |
| `aliases` | **Excel 导入自动匹配的候选表头名** |
| `dict` | 选项字典类别（`ar_dict.category`） |
| `freeOther` | select 带「其他（自由填写）」 |
| `datalist` | 输入框带建议列表（`owner_unit` 用） |
| `clamp` | 表格里按 3 行 × 12 字截断 |
| `deptEditable` | **报账员可编辑**（与 SQL 白名单必须一致） |
| `cls` | 单元格附加 class |
| `noImport` | 不参与导入映射与模板生成 |
| `note` | 表单里的提示文字 |

### A.2 `COMPUTED_DEFS`（4 个虚拟列，不入库）

| key | 界面标签 | type | width | 公式 |
|---|---|---|---|---|
| `receivable_internal` | 账内应收金额 | money | 102 | 开票 − 到账 |
| `receivable_external` | 账外应收金额 | money | 102 | 决算 − 开票 |
| `receivable_balance` | 应收余额 | money | 96 | 决算 − 到账 − 核销 |
| `attach_summary` | 附件类别及数量 | text | 130 | 附件表聚合 |

### A.3 `FORM_GROUPS`（编辑弹窗分区）

| 分区 | 标签 | 字段 |
|---|---|---|
| `base` | 基本信息 | contract_no, project_name, owner_unit, client_attr, creditor_unit, work_nature, sector |
| `finance` | 状态与金额 | project_status, final_method, charge_date, final_amount, invoiced_amount, received_amount, writeoff_amount |
| `dunning` | 债权与催收 | debt_status, collector, dunning_date, comm_method, feedback, latest_progress, next_plan, remark |

> `FORM_GROUPS[0]`（`base`）被 `Editor.editableKeys()` 用来判断
> 「报账员新增记录时可填哪些」（见 7.3）。
> **`department_id` 刻意不在任何 group 里** —— 它的下拉由 `renderModal` 独立渲染
> （`#ed-department_id`，仅管理员可见），放进 `FORM_GROUPS` 会重复出现。

### A.4 `DICT_CATEGORIES`（12 个字典类别，即「选项管理」左栏顺序）

```
project_status 项目状态 · final_method 决算方式 · debt_status 债权状态
client_attr 客户属性 · comm_method 沟通方式 · feedback 对方反馈
progress_note 最新进展 · next_plan 下一步计划 · attach_category 附件类别
unit 单位（债权单位） · work_nature 工作性质 · sector 八大板块
```

## 附录 B：CSS 结构（`css/style.css`，1622 行）

**分层**：`① 设计令牌 → ② 基础与排版 → ③ 原子 → ④ 组件 → ⑤ 响应式 → ⑥ 打印`

| 段 | 行号 | 内容 |
|---|---|---|
| ① 设计令牌 | 9–98 | `:root` 的全部 CSS 变量 |
| ② 基础与排版 | 99–144 | reset、字体、滚动条 |
| ③ 原子 | 145–224 | 按钮、输入控件、登录页 |
| ④ 组件 | 225–1408 | 主框架 / 工具栏 / **表格容器** / 标签 / 弹窗 / 表单 / 导入 / 明细表 / 导出 / **选项管理** / 明细导入 / 引导设置 / 用户批次 / 部门卡片 / **列设置面板** / Toast |
| ⑤ 响应式 | 1499–1566 | `@media (max-width: 900px)` 与 `(max-width: 680px)` |
| ⑥ 打印 | 1567–1622 | `@media print` |

**设计令牌要点**（改主题从这里下手，同时要同步 `docs/.impeccable.md` 与 `dashboard.js` 的色常量）：

| 类别 | 变量 |
|---|---|
| 中性色阶 | `--ink-950` … `--ink-100`（冷调灰，色相偏主色 258°） |
| 分隔线 | `--line` / `--line-2` |
| 背景层 | `--bg` / `--surface` / `--surface-2` / `--surface-3` |
| 主色 | `--primary` / `--primary-600` / `--primary-soft` / `--primary-line`（深靛蓝 258°） |
| 语义色 | `--danger`（**朱砂红，唯一警示色**）/ `--ok` / `--warn` / `--teal` / `--violet` |
| 焦点 | `--focus` |
| 排版 | `--font`（PingFang SC / HarmonyOS Sans SC / Microsoft YaHei 兜底） |

> **色值用 `oklch()`** —— 现代浏览器支持，但如果你要拿到 `dashboard.js` 里当
> SVG `fill`，需要换算成 sRGB（`dashboard.js` 顶部那组 `C_*` 常量就是这么来的）。

**表格相关的重要 class**（改冻结列时必看）：

```
.table-wrap              横向滚动容器（页面唯一滚动区）
.table-wrap.is-scrolled  已向左滚 → 冻结列右缘投阴影
.table-wrap.has-more     右侧还有内容 → 投阴影
.ledger-table            表格本体（--fc-check / --fc-idx / --fc-w 变量在这里）
th.is-frozen / td.is-frozen   冻结列（position: sticky）
.fz-0 / .fz-1 / ...      left 偏移（由 syncFrozen 动态写进 <style id="cfz-style">）
.is-fz-last              冻结区最后一列（投阴影用）
.col-check / .col-idx    勾选列与序号列
```

## 附录 C：给接手人的第一周建议

1. **先跑起来再读代码。** `start index.html` → 用测试账号登录 → 点一遍 7 个页面。
   界面看到的东西比源码好理解得多。
2. **然后按这个顺序读源码**（从「数据」到「界面」）：
   `fields.js`（字段定义）→ `config.js`（连接）→ `auth.js`（谁是谁）→
   `ledger.js` 的 `computeRow`/`balanceOf`/`rowMatch`（口径）→
   `ledger.js` 的 `renderTable`（渲染）→ 最后才看 `colprefs.js`（列偏好最绕）。
3. **改任何东西前，先用预览页确认现象。** 有对应预览页就用预览页重现；
   没有就先补一个生成器（**「没有预览」本身就是最值得怀疑的地方**）。
4. **动 CSS 后一定重新生成全部预览产物**，否则你看到的还是旧样式。
5. **读完本文第 8 节（铁律）再动手。** 那 18 条都是返工换来的。
6. **有 SQL 改动时**：改基础脚本 → 同步补进 `init-new-instance.sql` →
   写一个幂等的 `upgrade-vX.Y-*.sql` → 跑 `verify-setup.sql` 确认。
7. **不确定业务口径时，先读 `CONTEXT.md` 和 `docs/adr/`**，再问业务方。
   这个系统的口径是逐条敲定过的，凭直觉改很可能会错。

---

*本文档由代码现状整理而成。如果发现文中描述与代码不符，**以代码为准并顺手更正本文**。*



