# 企业应收账款台账系统

基于 **Supabase（自托管）+ 原生 JavaScript** 的企业应收账款台账管理系统，面向财务部门与各实体部门。账号体系完全独立（`ar_users`），与月报/证照等系统互不影响。

线上地址：`https://www.safety.sx.cn/ledger/`（同域 Nginx 反代 Supabase API）。

## 功能（v3 · 新指标体系）

依据《应收系统统计指标.xlsx》28 列指标与五条要求：

- **一个项目一个界面**：编辑弹窗单屏分区展示全部要素——基本信息 / 状态与金额（实时计算）/ 债权与催收 / 附件上传区 / 开票明细
- **28 列指标**：部门名称、单位、合同编号、客户名称、客户属性、项目名称、工作性质、八大板块、项目状态、附件类别及数量、附件上传区、决算方式、最新挂账时间、决算金额、开票金额、到账金额、核销金额、账内应收、账外应收、债权状态、清收责任人、最新催收时间、沟通方式、对方反馈、最新进展、下一步计划、备注
- **自动计算**：账内应收 = 开票 − 到账；账外应收 = 决算 − 开票；应收余额 = 决算 − 到账 − 核销（表单实时联动、表格/看板/导出同口径）
- **附件上传区**（要求四）：每条记录可上传多个附件（决算 / 中止证明 / 其他），存 Supabase Storage 私有桶，签名 URL 下载，「附件类别及数量」列自动汇总
- **选项字典**（要求三）：项目状态、债权状态、沟通方式、对方反馈、最新进展、下一步计划等下拉选项均由财务在「选项管理」页自行增删排序，即时生效；支持「其他（自由填写）」
- **字段级权限**（要求五）：实体部门账号仅可编辑催收跟踪类字段（项目状态 / 决算方式 / 债权状态 / 清收责任人 / 最新催收时间 / 沟通方式 / 对方反馈 / 最新进展 / 下一步计划）与附件；金额等财务字段由数据库触发器强制保护，前端锁定显示 🔒
- **开票明细**：逐笔登记开票日期/发票号/金额，一键同步「开票金额」合计（仅财务）
- **Excel 导入**：字段位置自动匹配 + 人工调整映射；「部门名称」列自动归属部门；按合同编号跳过 / 覆盖 / 允许重复；按批次管理可整批或勾选删除
- **汇总表导出**（要求二）：按筛选（部门 / 项目状态 / 债权状态 / 关键词）自选字段导出，末尾自动追加「合计」行
- **回款明细**：逐笔登记到账日期/金额/备注，一键同步「到账金额」合计（仅财务；与开票明细对称）
- **台账口径**（CONTEXT.md，详见 docs/adr/）：一行 = 一个合同；决算方式非「工作量」时合同金额自动带入决算金额（导入与录入均生效）；决算金额为空时账外应收/应收余额显示"—"且不参与看板与导出合计；核销可逆，总览默认筛「未结」（应收余额 ≠ 0）
- **数据看板**：账内 / 账外应收、应收余额 KPI（决算未定笔数附注），**月度开票/回款趋势（近 12 个月，明细聚合）**，各部门余额 TOP8，**各单位（债权主体法人口径）余额**，**客户应收余额 TOP10 与客户属性欠款构成（大类着色）**，债权状态构成，催收跟踪 TOP10
- **权限模型**：超级管理员 / 管理员 / 报账员三级 + 7 项逐人权限；列显示设置按账号独立保存
- **系统设置**：前端构建版本 / 数据库实例 / 明细表就绪状态 / 当前账号与权限一览 + 数据维护工具（按开票明细重算「最新挂账时间」）。业务下拉选项统一在「选项管理」页维护

## 目录结构

```
├── index.html              # 单页应用入口
├── css/style.css           # 样式
├── js/
│   ├── config.js           # Supabase 连接配置（当前指向 www.safety.sx.cn 同源反代）
│   ├── fields.js           # 字段定义（28 列指标 / 表单分组 / 字典类别 / 权限标记）
│   ├── dict.js             # 选项字典缓存（ar_dict 读取 + 内置兜底）
│   ├── colprefs.js         # 列显示偏好（按账号独立保存）
│   ├── utils.js            # 工具函数
│   ├── auth.js             # 登录 / 会话 / 权限（ar_users 独立体系）
│   ├── dashboard.js        # 数据看板
│   ├── ledger.js           # 台账列表 + 一屏编辑 + 附件 + 开票明细
│   ├── attachments.js      # 附件上传 / 下载 / 删除 / 汇总
│   ├── importer.js         # Excel 导入（字段映射）
│   ├── detailimporter.js   # 开票/回款明细批量导入（按合同编号匹配，自动同步金额与挂账时间，仅财务）
│   ├── exporter.js         # 汇总表导出（含合计行；可选附带开票/回款明细工作表）
│   ├── batches.js          # 导入批次管理
│   ├── admin.js            # 用户 / 部门管理 / 系统设置
│   ├── dictadmin.js        # 选项管理（财务维护下拉选项）
│   └── app.js              # 应用入口
├── sql/
│   ├── init-new-instance.sql            # ★ 全新 Supabase 项目一键初始化（推荐，含回款明细）
│   ├── schema-standalone.sql            # 基础建表（departments/profiles/ar_ 核心表）
│   ├── schema.sql                       # v1 共用实例版（历史存档，勿用于新库）
│   ├── ar-users-v2.sql                  # 独立账号体系 ar_users（覆盖前者同名函数）
│   ├── ar-user-management.sql           # 旧版用户管理（已被 ar-users-v2 取代，历史存档）
│   ├── upgrade-v3-indicators.sql        # v3 升级：新列 + 选项字典 + 附件 + 字段保护
│   └── upgrade-v3.1-receipts.sql        # v3.1 升级：ar_receipts 回款明细表（已运行 v3 的库执行）
│   └── upgrade-v3.2-admin-rls.sql       # v3.2 修复：管理员判定策略（is_admin → ar_is_admin）+ 挂账时间重算函数
└── vendor/                 # supabase-js / SheetJS（gitignore，正式部署拷贝到服务器；
                            # 缺失时自动回退 jsDelivr CDN）
```

### 已运行 v3 的库升级到 v3.1（回款明细）

Supabase Studio SQL Editor 粘贴运行 `sql/upgrade-v3.1-receipts.sql`（幂等），前端版本号需 ≥ `?v=20260915a`。

### 已运行 v3 的库升级到 v3.2（管理员判定修复，必做）

Supabase Studio SQL Editor 粘贴运行 `sql/upgrade-v3.2-admin-rls.sql`（幂等），前端版本号需 ≥ `?v=20260915h`。

**为什么必须执行**：早期那批 RLS 策略用了月报系统的 `public.is_admin()`（读 `profiles.role`），而台账管理员身份自 ar-users-v2 起存在 `ar_users`（=`public.ar_is_admin()`）。本库的 `profiles` 由注册触发器生成、`role` 恒为 `reporter`，即 `is_admin()` 恒为 **FALSE**，症状：

| 症状 | 原因 |
|---|---|
| 用户管理页里报账员的「台账权限」全部显示未勾选、保存权限报错 | `ar_user_perms` 读写策略走 `is_admin()` |
| 系统设置保存被拒 | `ar_settings` 更新策略走 `is_admin()` |
| 新增台账记录（带部门）被拒 | 部门校验子查询走 `profiles.department_id`（为空） |

修复后策略统一改用 `ar_is_admin()`，并附带一个维护函数 `ar_recalc_charge_date()`（系统设置页的「重算挂账时间」按钮）。

## 部署 / 升级

### v3 升级（已运行 v1/v2 的环境）

1. **数据库**：SSH 到服务器执行（或 Supabase Studio SQL Editor 粘贴运行）：
   ```bash
   ssh ubuntu@服务器IP "sudo docker exec -i supabase-db psql -U supabase_admin -d postgres" < sql/upgrade-v3-indicators.sql
   ```
   脚本幂等可重复执行；包含新列、ar_dict 选项字典、ar_attachments 附件表、Storage 私有桶、字段级保护触发器，并回收历史补丁（列偏好表、批次可见性修复）。
2. **前端**：将 `index.html`、`css/`、`js/` 上传到服务器站点目录（如 `/var/www/ledger/`），浏览器 Ctrl+F5 强刷（资源版本号已升级）。

### 全新环境

依次执行 `sql/init-new-instance.sql`（一键初始化：schema-standalone + ar-users-v2 + upgrade-v3-indicators + upgrade-v3.1-receipts + v3.2 管理员判定修复，按依赖顺序拼接、幂等），首个超级管理员用文件末尾注释里的 SQL 设置（`ar_users.ar_role='admin', ar_super_admin=TRUE`）。

### 前端配置

`js/config.js`：`SUPABASE_URL` 与 `SUPABASE_ANON_KEY` 指向自托管 Supabase（当前走 Nginx 同域反代 `https://www.safety.sx.cn`，需保证 `/rest/v1`、`/auth/v1`、`/storage/v1` 已代理到 Kong:8000）。
