# 企业应收账款台账系统

基于 **Supabase + 原生 JavaScript** 的企业应收账款台账管理系统。多部门账号密码登录，管理员统一管理数据与权限，各部门权限由管理员逐人开放，权限清单在界面左侧一目了然。

## 功能

- **登录**：复用既有账号体系，支持邮箱 / 手机号 / 部门名称 / 部门编码登录
- **台账管理**：合同编号、项目名称、合同金额、决算金额、已开发票金额、已到账金额、账内/账外应收金额、应收合计（自动计算）、甲方单位（内置常用单位可选）、债权单位、开工/完工日期、工程进度、付款节点、施工部门、工作性质、八大板块、成本费用、催收/询证日期、催收反馈
- **自动计算**：应收合计 = 账内应收 + 账外应收；应收余额 = 应收合计 − 已到账金额；超期预警按完工日期 + 预警天数自动判定（天数可在系统设置中调整）
- **开票明细**：每条合同可逐笔登记开票日期与金额，一键汇总回「已开发票金额」
- **Excel 导入**：上传后自动匹配字段位置，匹配过程可人工选择修改；支持按合同编号跳过重复 / 覆盖更新；按施工部门自动归属部门
- **Excel 导出**：可自选要素字段，按当前筛选结果或全部数据导出
- **导入批次管理**：对导错的批次可整批删除，或查看本批后勾选部分删除
- **编辑效率**：全选、筛选胶囊（施工部门 / 工程进度 / 收款状态）、关键词搜索、列排序、批量勾选删除
- **权限模型**：查看本部门 / 查看全部 / 新增 / 编辑 / 删除 / 导入 / 导出，管理员逐人开放

## 目录结构

```
├── index.html              # 单页应用入口
├── css/style.css           # 样式
├── js/
│   ├── config.js           # Supabase 连接配置
│   ├── fields.js           # 台账字段定义（表格/导入/导出/表单共用）
│   ├── utils.js            # 工具函数
│   ├── auth.js             # 登录 / 会话 / 权限
│   ├── ledger.js           # 台账列表 + 编辑 + 开票明细
│   ├── importer.js         # Excel 导入（字段映射）
│   ├── exporter.js         # Excel 导出
│   ├── batches.js          # 导入批次管理
│   ├── admin.js            # 用户权限 / 系统设置
│   └── app.js              # 应用入口
├── sql/schema.sql          # Supabase 数据库脚本（幂等可重复执行）
└── vendor/                 # supabase-js v2 / SheetJS（本地引入，正式部署用；
                             # GitHub Pages 试运行时若缺失会自动回退 jsDelivr CDN）
```

> 导入模板无需单独下载维护：系统按字段定义在前端动态生成「应收账款导入模板.xlsx」，永远与最新字段同步。

## 部署

### 1. 数据库初始化（腾讯云自部署 Supabase，独立实例）

1. 浏览器打开 Supabase Studio（通常为 `http://服务器IP:8000`）；
2. 左侧 **SQL Editor** → **New query** → 将 `sql/schema.sql` 全部内容粘贴 → **Run**；
3. 脚本自包含（含部门表 / 用户档案 / 权限函数 / RLS），幂等可重复执行；
4. **创建管理员**：Studio → **Authentication → Users → Add user**（填邮箱、密码，勾选 Auto Confirm），再到 SQL Editor 执行：

```sql
UPDATE public.profiles SET role = 'admin', full_name = '管理员'
WHERE id = (SELECT id FROM auth.users WHERE email = '你的管理员邮箱');
```

> 本系统为**独立数据存储**：所有表均以 `ar_` 前缀，账号体系（departments / profiles）也独立，与安全生产管理系统互不依赖、互不影响。

### 2. 前端配置

编辑 `js/config.js`，填入自部署 Supabase 的 `SUPABASE_URL`（如 `http://服务器IP:8000`）与 `SUPABASE_ANON_KEY`（服务器 docker/.env 中的 ANON_KEY，或 Studio → Settings → API 的 anon public key）。

### 3. 发布

任意静态托管均可（GitHub Pages / Nginx / Caddy）。本仓库已开启 GitHub Pages 试运行；正式上线时将整个目录上传至腾讯云服务器，用 Nginx 托管静态文件并指向自部署 Supabase 即可。
