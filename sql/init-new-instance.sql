-- ==========================================================================
-- 企业应收账款台账系统 - 全新 Supabase 实例一键初始化脚本（v3 · 2026-09-14）
-- ==========================================================================
-- 适用环境：全新的 Supabase 项目（云端或自托管均可，项目内无任何业务表）。
--
-- 本文件 = schema-standalone.sql + ar-users-v2.sql + upgrade-v3-indicators.sql
-- 按依赖顺序拼接（三者单独更新时需同步本文件，或改为按顺序分别执行）。
-- 已含真实字典种子（客户属性15/单位4/工作性质18/八大板块8）与真实部门30个。
-- 全部语句幂等：中断后修复可整体重跑，已建对象不受影响。
--
-- 使用方法：
--   Supabase Studio → SQL Editor → New query → 粘贴本文件全部内容 → Run。
--
-- 执行后必须完成两步（见文件末尾注释）：
--   ① Authentication → Users → Add user 创建首个登录账号；
--   ② 执行文件末尾的「首个超级管理员」SQL（把邮箱换成实际管理员邮箱）。
-- ==========================================================================

-- ==========================================================================
-- 以下拼接自 schema-standalone.sql
-- ==========================================================================

-- ==========================================================================
-- 企业应收账款台账系统 - Supabase 数据库 Schema（v1 · 独立版）
-- ==========================================================================
-- 适用环境：腾讯云服务器自部署 Supabase（独立实例，与安全生产管理系统
-- 数据完全分开，互不依赖）。
--
-- 本文件自包含，在新实例上一次性执行即可，包含：
--   1. departments          部门表 + 种子数据
--   2. profiles             用户档案表（角色 / 部门）+ 注册触发器
--   3. is_admin() 等辅助函数（含登录标识符解析 resolve_login_identifier）
--   4. ar_settings          全局设置（超期预警天数，单行表）
--   5. ar_import_batches    Excel 导入批次（支持按批次全部/部分删除）
--   6. ar_ledger            应收账款台账（核心表）
--   7. ar_invoices          开票明细（每笔开票日期与金额，1:N）
--   8. ar_user_perms        部门用户权限（管理员逐人开放）
--   9. RLS 行级安全（管理员全量；部门用户按权限 + 本部门数据）
--
-- 执行方法：
--   浏览器打开 Supabase Studio（通常为 http://服务器IP:8000）→ 左侧
--   SQL Editor → New query → 粘贴本文件全部内容 → Run。
--   幂等可重复执行。
--
-- 执行后创建管理员账号（两步）：
--   ① Studio → Authentication → Users → Add user → 填邮箱和密码、
--      勾选 Auto Confirm User；
--   ② 在 SQL Editor 执行（把邮箱换成上一步的）：
--      UPDATE public.profiles SET role = 'admin', full_name = '管理员'
--      WHERE id = (SELECT id FROM auth.users WHERE email = 'admin@xxx.com');
-- ==========================================================================

-- --------------------------------------------------------------------------
-- 1. 部门表
-- --------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.departments (
  id         UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  name       TEXT NOT NULL UNIQUE,               -- 部门名称
  code       TEXT UNIQUE,                        -- 部门编码（可作为登录标识）
  sort_order INTEGER DEFAULT 0,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

-- 种子部门（按需增删；管理员也可后续在「部门管理」页维护）
INSERT INTO public.departments (name, code, sort_order) VALUES
  ('地调所', 'D001', 1),
  ('地勘分院', 'D002', 2),
  ('岩土所', 'D003', 3),
  ('地灾所', 'D004', 4),
  ('实验室', 'D005', 5),
  ('禹地公司', 'D006', 6),
  ('资环所', 'D007', 7),
  ('测绘院太原分院', 'D008', 8),
  ('大地测绘中心', 'D009', 9),
  ('工程测绘中心', 'D010', 10),
  ('遥感中心', 'D011', 11),
  ('大数据中心', 'D012', 12),
  ('测绘咨询中心', 'D013', 13),
  ('晋城分院', 'D014', 14),
  ('能源所', 'D015', 15),
  ('地震物探', 'D016', 16),
  ('工程物探所', 'D017', 17),
  ('综合研究所', 'D018', 18),
  ('广州分院', 'D019', 19),
  ('电磁所', 'D020', 20),
  ('碳中和', 'D021', 21),
  ('矿产咨询', 'D022', 22),
  ('六勘院太原分院', 'D023', 23),
  ('一测', 'D024', 24),
  ('二测', 'D025', 25),
  ('综勘三', 'D026', 26),
  ('原物探/太原', 'D027', 27),
  ('翟悟飞', 'D028', 28),
  ('孙勇军', 'D029', 29),
  ('其他', 'D030', 30)
ON CONFLICT (name) DO NOTHING;

-- --------------------------------------------------------------------------
-- 2. 用户档案表（登录账号在 Supabase Auth 中，档案在此）
--    role: 'admin' 管理员（全部权限） | 'reporter' 部门用户（权限逐人开放）
-- --------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.profiles (
  id            UUID PRIMARY KEY REFERENCES auth.users(id) ON DELETE CASCADE,
  full_name     TEXT,                            -- 姓名
  phone         TEXT UNIQUE,                     -- 手机号（可作为登录标识）
  role          TEXT NOT NULL DEFAULT 'reporter'
                CHECK (role IN ('admin', 'reporter')),
  department_id UUID REFERENCES public.departments(id) ON DELETE SET NULL,
  created_at    TIMESTAMPTZ DEFAULT NOW()
);

-- 新用户注册时自动建档（Studio 手工添加用户同样触发）
CREATE OR REPLACE FUNCTION public.handle_new_user()
RETURNS TRIGGER AS $$
BEGIN
  INSERT INTO public.profiles (id, full_name, role)
  VALUES (
    NEW.id,
    COALESCE(NEW.raw_user_meta_data ->> 'full_name', NEW.raw_user_meta_data ->> 'name', split_part(NEW.email, '@', 1)),
    'reporter'
  )
  ON CONFLICT (id) DO NOTHING;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public;

DROP TRIGGER IF EXISTS trg_on_auth_user_created ON auth.users;
CREATE TRIGGER trg_on_auth_user_created
  AFTER INSERT ON auth.users
  FOR EACH ROW EXECUTE FUNCTION public.handle_new_user();

-- --------------------------------------------------------------------------
-- 3. 辅助函数
-- --------------------------------------------------------------------------

-- 3.1 updated_at 自动维护
CREATE OR REPLACE FUNCTION public.update_updated_at()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = NOW();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

-- 3.2 管理员判断
CREATE OR REPLACE FUNCTION public.is_admin()
RETURNS BOOLEAN AS $$
  SELECT EXISTS (
    SELECT 1 FROM public.profiles
    WHERE id = auth.uid() AND role = 'admin'
  );
$$ LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public;

-- 3.3 登录标识符解析：邮箱 / 手机号 / 部门名称 / 部门编码 -> 登录邮箱
CREATE OR REPLACE FUNCTION public.resolve_login_identifier(p_identifier TEXT)
RETURNS JSONB
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public
AS $$
DECLARE
  v_id     TEXT := trim(COALESCE(p_identifier, ''));
  v_email  TEXT;
BEGIN
  IF v_id = '' THEN RETURN NULL; END IF;

  -- 邮箱直接返回
  IF v_id ~* '^[^@\s]+@[^@\s]+\.[^@\s]+$' THEN
    RETURN jsonb_build_object('email', lower(v_id));
  END IF;

  -- 手机号 -> 该用户档案对应的登录邮箱
  IF v_id ~ '^1[0-9]{10}$' THEN
    SELECT lower(u.email) INTO v_email
    FROM public.profiles p
    JOIN auth.users u ON u.id = p.id
    WHERE p.phone = v_id
    LIMIT 1;
    IF v_email IS NOT NULL THEN
      RETURN jsonb_build_object('email', v_email);
    END IF;
  END IF;

  -- 部门名称 / 部门编码 -> 该部门任一账号的登录邮箱（优先普通用户）
  SELECT lower(u.email) INTO v_email
  FROM public.departments d
  JOIN public.profiles p ON p.department_id = d.id
  JOIN auth.users u ON u.id = p.id
  WHERE d.name = v_id OR d.code = v_id
  ORDER BY (p.role = 'admin'), p.created_at
  LIMIT 1;
  IF v_email IS NOT NULL THEN
    RETURN jsonb_build_object('email', v_email);
  END IF;

  RETURN NULL;
END;
$$;

GRANT EXECUTE ON FUNCTION public.resolve_login_identifier(TEXT) TO authenticated, anon;

-- --------------------------------------------------------------------------
-- 4. 全局设置（单行：超期预警天数）
-- --------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.ar_settings (
  id         INTEGER PRIMARY KEY DEFAULT 1 CHECK (id = 1),
  warn_days  INTEGER NOT NULL DEFAULT 90 CHECK (warn_days >= 1 AND warn_days <= 3650),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

INSERT INTO public.ar_settings (id, warn_days) VALUES (1, 90)
  ON CONFLICT (id) DO NOTHING;

-- --------------------------------------------------------------------------
-- 5. 导入批次（一次 Excel 导入 = 一个批次；支持整批或部分删除）
-- --------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.ar_import_batches (
  id          UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  file_name   TEXT NOT NULL,                     -- 导入文件名
  row_count   INTEGER NOT NULL DEFAULT 0,        -- 成功导入行数
  imported_by UUID REFERENCES auth.users(id),
  created_at  TIMESTAMPTZ DEFAULT NOW()
);

-- --------------------------------------------------------------------------
-- 6. 应收账款台账（核心表）
--    department_id：数据归属部门（RLS 按此隔离部门可见范围）。
--    导入时按"施工部门"名称自动匹配 departments.name，匹配不上由管理员
--    在编辑中手工指定；金额单位默认万元（与导入模板一致）。
-- --------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.ar_ledger (
  id                   UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  department_id        UUID REFERENCES public.departments(id) ON DELETE SET NULL,
  batch_id             UUID REFERENCES public.ar_import_batches(id) ON DELETE SET NULL,
  -- 基本信息
  contract_no          TEXT,                     -- 合同编号（重复导入可据此覆盖/跳过）
  project_name         TEXT,                     -- 项目名称
  owner_unit           TEXT,                     -- 甲方单位（表单内置常用单位可选，可自由输入）
  creditor_unit        TEXT,                     -- 债权单位
  start_date           DATE,                     -- 开工日期
  end_date             DATE,                     -- 完工日期
  progress             TEXT,                     -- 工程进度（未开工/施工中/已完工/已决算等）
  payment_node         TEXT,                     -- 付款节点
  dept_name            TEXT,                     -- 施工部门（文本，随模板）
  work_nature          TEXT,                     -- 工作性质
  sector               TEXT,                     -- 八大板块
  -- 金额
  contract_amount      NUMERIC(18,4),            -- 合同金额
  final_amount         NUMERIC(18,4),            -- 决算金额
  invoiced_amount      NUMERIC(18,4),            -- 已开发票金额（汇总展示，明细见 ar_invoices）
  received_amount      NUMERIC(18,4),            -- 已到账金额
  receivable_internal  NUMERIC(18,4),            -- 账内应收金额
  receivable_external  NUMERIC(18,4),            -- 账外应收金额
  receivable_total     NUMERIC(18,4),            -- 应收合计（前端默认 = 账内 + 账外，可手工修改）
  cost_expense         NUMERIC(18,4),            -- 成本费用
  -- 催收
  dunning_date         DATE,                     -- 催收/询证日期
  dunning_feedback     TEXT,                     -- 催收反馈
  -- 审计
  created_by           UUID REFERENCES auth.users(id),
  created_at           TIMESTAMPTZ DEFAULT NOW(),
  updated_at           TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_ar_ledger_dept      ON public.ar_ledger(department_id);
CREATE INDEX IF NOT EXISTS idx_ar_ledger_batch     ON public.ar_ledger(batch_id);
CREATE INDEX IF NOT EXISTS idx_ar_ledger_contract  ON public.ar_ledger(contract_no);

DROP TRIGGER IF EXISTS trg_ar_ledger_updated_at ON public.ar_ledger;
CREATE TRIGGER trg_ar_ledger_updated_at
  BEFORE UPDATE ON public.ar_ledger
  FOR EACH ROW EXECUTE FUNCTION public.update_updated_at();

-- --------------------------------------------------------------------------
-- 7. 开票明细（每笔开票：日期 + 金额；随台账行级联删除）
-- --------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.ar_invoices (
  id           UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  ledger_id    UUID REFERENCES public.ar_ledger(id) ON DELETE CASCADE NOT NULL,
  invoice_no   TEXT,                                 -- 发票号码（选填）
  invoice_date DATE NOT NULL,                        -- 开票日期
  amount       NUMERIC(18,4) NOT NULL CHECK (amount >= 0),  -- 开票金额
  remark       TEXT,                                 -- 备注（选填）
  created_by   UUID REFERENCES auth.users(id),
  created_at   TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_ar_invoices_ledger ON public.ar_invoices(ledger_id);

-- --------------------------------------------------------------------------
-- 8. 部门用户权限（管理员逐人开放；管理员账号天然拥有全部权限）
--    perms JSONB 键：view / view_all / add / edit / delete / import / export
-- --------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.ar_user_perms (
  user_id    UUID PRIMARY KEY REFERENCES public.profiles(id) ON DELETE CASCADE,
  perms      JSONB NOT NULL DEFAULT '{}'::jsonb,
  updated_by UUID REFERENCES auth.users(id),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

-- --------------------------------------------------------------------------
-- 9. 权限辅助函数
-- --------------------------------------------------------------------------

-- 9.1 当前用户是否拥有某项台账权限（管理员恒真）
CREATE OR REPLACE FUNCTION public.ar_can(p_key TEXT)
RETURNS BOOLEAN AS $$
  SELECT public.is_admin()
      OR COALESCE(
           (SELECT (perms ->> p_key)::boolean
            FROM public.ar_user_perms WHERE user_id = auth.uid()),
         FALSE);
$$ LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public;

-- 9.2 当前用户是否可见某条台账（管理员 / view_all 全量；否则限本部门）
CREATE OR REPLACE FUNCTION public.ar_can_see_row(p_department_id UUID)
RETURNS BOOLEAN AS $$
  SELECT public.is_admin()
      OR public.ar_can('view_all')
      OR p_department_id IN (
           SELECT department_id FROM public.profiles WHERE id = auth.uid()
         );
$$ LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public;

-- --------------------------------------------------------------------------
-- 10. RLS 行级安全
-- --------------------------------------------------------------------------

ALTER TABLE public.departments       ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.profiles          ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.ar_settings       ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.ar_import_batches ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.ar_ledger         ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.ar_invoices       ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.ar_user_perms     ENABLE ROW LEVEL SECURITY;

-- 10.1 部门：已登录用户可读
DROP POLICY IF EXISTS "ar_depts_select" ON public.departments;
CREATE POLICY "ar_depts_select" ON public.departments
  FOR SELECT TO authenticated USING (true);

-- 10.2 用户档案：本人可读自己，管理员可读全部；本人与管理员可更新
DROP POLICY IF EXISTS "ar_profiles_select" ON public.profiles;
CREATE POLICY "ar_profiles_select" ON public.profiles
  FOR SELECT TO authenticated USING (
    id = auth.uid() OR public.is_admin()
  );

DROP POLICY IF EXISTS "ar_profiles_update" ON public.profiles;
CREATE POLICY "ar_profiles_update" ON public.profiles
  FOR UPDATE TO authenticated USING (
    id = auth.uid() OR public.is_admin()
  );

-- 10.3 设置：已登录可读（前端计算超期预警需要），写仅管理员
DROP POLICY IF EXISTS "ar_settings_select" ON public.ar_settings;
CREATE POLICY "ar_settings_select" ON public.ar_settings
  FOR SELECT TO authenticated USING (true);

DROP POLICY IF EXISTS "ar_settings_update_admin" ON public.ar_settings;
CREATE POLICY "ar_settings_update_admin" ON public.ar_settings
  FOR UPDATE TO authenticated USING (public.is_admin());

-- 10.4 导入批次：本人可见自己的批次；有导入/删除权限者与管理员可见全部
DROP POLICY IF EXISTS "ar_batches_select" ON public.ar_import_batches;
CREATE POLICY "ar_batches_select" ON public.ar_import_batches
  FOR SELECT TO authenticated USING (
    imported_by = auth.uid() OR public.ar_can('import') OR public.ar_can('delete')
  );

DROP POLICY IF EXISTS "ar_batches_insert" ON public.ar_import_batches;
CREATE POLICY "ar_batches_insert" ON public.ar_import_batches
  FOR INSERT TO authenticated WITH CHECK (
    public.is_admin() OR public.ar_can('import')
  );

DROP POLICY IF EXISTS "ar_batches_update" ON public.ar_import_batches;
CREATE POLICY "ar_batches_update" ON public.ar_import_batches
  FOR UPDATE TO authenticated USING (public.is_admin() OR public.ar_can('import'));

DROP POLICY IF EXISTS "ar_batches_delete" ON public.ar_import_batches;
CREATE POLICY "ar_batches_delete" ON public.ar_import_batches
  FOR DELETE TO authenticated USING (public.is_admin() OR public.ar_can('delete'));

-- 10.5 台账
-- 读：管理员 / view_all 全量；部门用户限本部门
DROP POLICY IF EXISTS "ar_ledger_select" ON public.ar_ledger;
CREATE POLICY "ar_ledger_select" ON public.ar_ledger
  FOR SELECT TO authenticated USING (
    public.ar_can_see_row(department_id)
  );

-- 新增：管理员 / add 权限（部门用户新增时只能写入本部门或空）
DROP POLICY IF EXISTS "ar_ledger_insert" ON public.ar_ledger;
CREATE POLICY "ar_ledger_insert" ON public.ar_ledger
  FOR INSERT TO authenticated WITH CHECK (
    public.is_admin() OR (
      public.ar_can('add') AND (
        department_id IS NULL OR department_id IN (
          SELECT department_id FROM public.profiles WHERE id = auth.uid()
        )
      )
    )
  );

-- 编辑：管理员 / edit 权限（部门用户限本部门数据）
DROP POLICY IF EXISTS "ar_ledger_update" ON public.ar_ledger;
CREATE POLICY "ar_ledger_update" ON public.ar_ledger
  FOR UPDATE TO authenticated USING (
    public.is_admin() OR (
      public.ar_can('edit') AND public.ar_can_see_row(department_id)
    )
  );

-- 删除：管理员 / delete 权限（部门用户限本部门数据）
DROP POLICY IF EXISTS "ar_ledger_delete" ON public.ar_ledger;
CREATE POLICY "ar_ledger_delete" ON public.ar_ledger
  FOR DELETE TO authenticated USING (
    public.is_admin() OR (
      public.ar_can('delete') AND public.ar_can_see_row(department_id)
    )
  );

-- 10.6 开票明细：读/写跟随所属台账行的权限
DROP POLICY IF EXISTS "ar_invoices_select" ON public.ar_invoices;
CREATE POLICY "ar_invoices_select" ON public.ar_invoices
  FOR SELECT TO authenticated USING (
    EXISTS (
      SELECT 1 FROM public.ar_ledger l
      WHERE l.id = ledger_id AND public.ar_can_see_row(l.department_id)
    )
  );

DROP POLICY IF EXISTS "ar_invoices_insert" ON public.ar_invoices;
CREATE POLICY "ar_invoices_insert" ON public.ar_invoices
  FOR INSERT TO authenticated WITH CHECK (
    EXISTS (
      SELECT 1 FROM public.ar_ledger l
      WHERE l.id = ledger_id
        AND (public.is_admin() OR (public.ar_can('edit') AND public.ar_can_see_row(l.department_id)))
    )
  );

DROP POLICY IF EXISTS "ar_invoices_update" ON public.ar_invoices;
CREATE POLICY "ar_invoices_update" ON public.ar_invoices
  FOR UPDATE TO authenticated USING (
    EXISTS (
      SELECT 1 FROM public.ar_ledger l
      WHERE l.id = ledger_id
        AND (public.is_admin() OR (public.ar_can('edit') AND public.ar_can_see_row(l.department_id)))
    )
  );

DROP POLICY IF EXISTS "ar_invoices_delete" ON public.ar_invoices;
CREATE POLICY "ar_invoices_delete" ON public.ar_invoices
  FOR DELETE TO authenticated USING (
    EXISTS (
      SELECT 1 FROM public.ar_ledger l
      WHERE l.id = ledger_id
        AND (public.is_admin() OR (public.ar_can('edit') AND public.ar_can_see_row(l.department_id)))
    )
  );

-- 10.7 权限表：本人可读自己的权限（左侧权限栏展示），管理员可读写全部
DROP POLICY IF EXISTS "ar_perms_select" ON public.ar_user_perms;
CREATE POLICY "ar_perms_select" ON public.ar_user_perms
  FOR SELECT TO authenticated USING (
    user_id = auth.uid() OR public.is_admin()
  );

DROP POLICY IF EXISTS "ar_perms_insert_admin" ON public.ar_user_perms;
CREATE POLICY "ar_perms_insert_admin" ON public.ar_user_perms
  FOR INSERT TO authenticated WITH CHECK (public.is_admin());

DROP POLICY IF EXISTS "ar_perms_update_admin" ON public.ar_user_perms;
CREATE POLICY "ar_perms_update_admin" ON public.ar_user_perms
  FOR UPDATE TO authenticated USING (public.is_admin());

DROP POLICY IF EXISTS "ar_perms_delete_admin" ON public.ar_user_perms;
CREATE POLICY "ar_perms_delete_admin" ON public.ar_user_perms
  FOR DELETE TO authenticated USING (public.is_admin());

-- --------------------------------------------------------------------------
-- 11. 授权
-- --------------------------------------------------------------------------
GRANT ALL ON public.ar_import_batches TO authenticated;
GRANT ALL ON public.ar_ledger TO authenticated;
GRANT ALL ON public.ar_invoices TO authenticated;
GRANT ALL ON public.ar_user_perms TO authenticated;

-- ==========================================================================
-- 验证 SQL：
--   SELECT * FROM public.departments ORDER BY sort_order;
--   SELECT * FROM public.ar_settings;
--   SELECT id, full_name, role, department_id FROM public.profiles;
-- 首个管理员（先在 Authentication → Users 添加用户，再执行）：
--   UPDATE public.profiles SET role = 'admin', full_name = '管理员'
--   WHERE id = (SELECT id FROM auth.users WHERE email = 'admin@example.com');
-- ==========================================================================
-- ==========================================================================
-- 以下拼接自 ar-users-v2.sql
-- ==========================================================================

-- ==========================================================================
-- 企业应收账款台账系统 - 用户表与月报系统彻底分离（v2）
-- ==========================================================================
-- 背景：此前台账用户信息写在共用的 profiles 表上（ar_role/department_id），
-- 导致台账创建的报账员在月报系统里被识别为「该部门报送员」，能看到部门
-- 报送信息。本文件把台账用户拆到独立表 ar_users：
--   · 台账用户（角色/部门/手机号）全部存 ar_users，不再写 profiles；
--   · 台账建号时 profiles 仅由触发器生成最小记录（id+email，无部门无角色
--     变更）→ 该账号登录月报系统时无部门、无报送数据，互不干扰；
--   · 月报系统的用户（profiles.role / is_super_admin）完全不受影响。
--
-- 角色三层（存于 ar_users）：
--   超级管理员  ar_super_admin=true → 用户管理 + 全部权限
--   管理员      ar_role='admin'     → 全部台账权限 + 系统设置
--   报账员      ar_role='user'      → 按 ar_user_perms 逐人授权
--   已停用      ar_role='disabled'  → 无任何权限，可恢复
--
-- 幂等可重复执行；兼容 v1（profiles.ar_role 方案）已有数据自动迁移。
-- ==========================================================================

-- --------------------------------------------------------------------------
-- 1. 台账用户表
-- --------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.ar_users (
  user_id        UUID PRIMARY KEY REFERENCES auth.users(id) ON DELETE CASCADE,
  email          TEXT NOT NULL,
  full_name      TEXT,
  phone          TEXT,
  department_id  UUID REFERENCES public.departments(id) ON DELETE SET NULL,
  ar_role        TEXT NOT NULL DEFAULT 'user'
                 CHECK (ar_role IN ('admin','user','disabled')),
  ar_super_admin BOOLEAN NOT NULL DEFAULT FALSE,
  created_at     TIMESTAMPTZ DEFAULT NOW()
);

-- 主管理员保护标记（受保护账号不可被任何人删除/停用/降级）
ALTER TABLE public.ar_users ADD COLUMN IF NOT EXISTS ar_protected BOOLEAN NOT NULL DEFAULT FALSE;
UPDATE public.ar_users SET ar_protected = TRUE WHERE email = 'jnsun@qq.com';

-- v1 迁移：若 profiles 上存在旧角色列，把管理员/停用账号迁入 ar_users 后移除旧列
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM information_schema.columns
             WHERE table_schema = 'public' AND table_name = 'profiles'
               AND column_name = 'ar_role') THEN
    INSERT INTO public.ar_users (user_id, email, full_name, phone, department_id, ar_role, ar_super_admin)
    SELECT p.id, p.email, p.full_name, p.phone, p.department_id, p.ar_role, p.ar_super_admin
    FROM public.profiles p
    WHERE p.ar_role IN ('admin','disabled') OR p.ar_super_admin = TRUE
    ON CONFLICT (user_id) DO NOTHING;

    ALTER TABLE public.profiles DROP CONSTRAINT IF EXISTS profiles_ar_role_check;
    ALTER TABLE public.profiles DROP COLUMN IF EXISTS ar_role;
    ALTER TABLE public.profiles DROP COLUMN IF EXISTS ar_super_admin;
  END IF;
END $$;

-- --------------------------------------------------------------------------
-- 2. 角色判断函数（改读 ar_users）
-- --------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.ar_is_admin()
RETURNS BOOLEAN AS $$
  SELECT EXISTS (
    SELECT 1 FROM public.ar_users
    WHERE user_id = auth.uid() AND ar_role = 'admin'
  );
$$ LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public;

CREATE OR REPLACE FUNCTION public.ar_is_super_admin()
RETURNS BOOLEAN AS $$
  SELECT EXISTS (
    SELECT 1 FROM public.ar_users
    WHERE user_id = auth.uid() AND ar_super_admin = TRUE AND ar_role = 'admin'
  );
$$ LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public;

CREATE OR REPLACE FUNCTION public.ar_can(p_key TEXT)
RETURNS BOOLEAN AS $$
  SELECT EXISTS (
      SELECT 1 FROM public.ar_users
      WHERE user_id = auth.uid() AND ar_role = 'admin'
    )
    OR COALESCE(
         (SELECT CASE WHEN u.ar_role = 'disabled' THEN FALSE
                      ELSE (p.perms ->> p_key)::boolean END
            FROM public.ar_users u
            JOIN public.ar_user_perms p ON p.user_id = u.user_id
           WHERE u.user_id = auth.uid()),
         FALSE);
$$ LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public;

CREATE OR REPLACE FUNCTION public.ar_can_see_row(p_department_id UUID)
RETURNS BOOLEAN AS $$
  SELECT public.ar_is_admin()
      OR public.ar_can('view_all')
      OR p_department_id IN (
           SELECT department_id FROM public.ar_users WHERE user_id = auth.uid()
         );
$$ LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public;

GRANT EXECUTE ON FUNCTION public.ar_is_admin() TO authenticated;
GRANT EXECUTE ON FUNCTION public.ar_is_super_admin() TO authenticated;

-- --------------------------------------------------------------------------
-- 3. ar_users RLS：本人可读自己，超级管理员可读全部；写入一律走 RPC
-- --------------------------------------------------------------------------
ALTER TABLE public.ar_users ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "ar_users_select" ON public.ar_users;
CREATE POLICY "ar_users_select" ON public.ar_users
  FOR SELECT TO authenticated USING (
    user_id = auth.uid() OR public.ar_is_admin()
  );

-- --------------------------------------------------------------------------
-- 4. profiles 策略还原（去掉 v1 加的台账超管读取，恢复月报原状）
-- --------------------------------------------------------------------------
DROP POLICY IF EXISTS "ar_profiles_select" ON public.profiles;
CREATE POLICY "ar_profiles_select" ON public.profiles
  FOR SELECT TO authenticated USING (id = auth.uid() OR public.is_admin());

-- --------------------------------------------------------------------------
-- 5. 账号管理 RPC（仅台账超级管理员；只写 ar_users，绝不碰 profiles）
-- --------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION public.ar_super_admin_count_excluding(p_user_id UUID)
RETURNS INTEGER AS $$
  SELECT count(*)::int FROM public.ar_users
  WHERE ar_super_admin = TRUE AND ar_role = 'admin' AND user_id <> p_user_id;
$$ LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public;

CREATE OR REPLACE FUNCTION public.ar_create_user(
  p_email         TEXT,
  p_password      TEXT,
  p_full_name     TEXT DEFAULT NULL,
  p_phone         TEXT DEFAULT NULL,
  p_department_id UUID DEFAULT NULL,
  p_ar_role       TEXT DEFAULT 'user',
  p_perms         JSONB DEFAULT '{}'::jsonb
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, extensions
AS $$
DECLARE
  v_user_id UUID;
  v_email   TEXT := lower(trim(COALESCE(p_email,'')));
BEGIN
  IF NOT public.ar_is_admin() THEN
    RAISE EXCEPTION '只有管理员才能新增账号';
  END IF;
  IF NOT public.ar_is_super_admin() AND p_ar_role <> 'user' THEN
    RAISE EXCEPTION '普通管理员只能新增报账员账号';
  END IF;
  IF v_email = '' OR v_email !~* '^[^@\s]+@[^@\s]+\.[^@\s]+$' THEN
    RAISE EXCEPTION '邮箱格式不正确';
  END IF;
  -- 强密码：至少 8 位，含大小写字母、数字、符号
  IF p_password IS NULL OR length(p_password) < 8
     OR p_password !~ '[A-Z]' OR p_password !~ '[a-z]'
     OR p_password !~ '[0-9]' OR p_password !~ '[^A-Za-z0-9]' THEN
    RAISE EXCEPTION '密码须至少 8 位，且同时包含大写字母、小写字母、数字和符号';
  END IF;
  IF p_ar_role NOT IN ('admin','user') THEN
    RAISE EXCEPTION '角色不合法';
  END IF;
  IF p_ar_role = 'user' AND (p_department_id IS NULL
     OR NOT EXISTS (SELECT 1 FROM public.ar_departments WHERE id = p_department_id)) THEN
    RAISE EXCEPTION '报账员必须分配有效部门';
  END IF;
  IF EXISTS (SELECT 1 FROM auth.users WHERE lower(email) = v_email) THEN
    -- 已有登录账号（月报建过，或曾被移出台账）：直接加入台账，不重设密码
    SELECT u.id INTO v_user_id FROM auth.users u WHERE lower(u.email) = v_email;
    IF EXISTS (SELECT 1 FROM public.ar_users WHERE user_id = v_user_id) THEN
      RAISE EXCEPTION '该账号已在台账用户列表中';
    END IF;
    INSERT INTO public.ar_users (user_id, email, full_name, phone, department_id, ar_role)
    VALUES (v_user_id, v_email, p_full_name, p_phone, p_department_id, p_ar_role);
    IF p_perms <> '{}'::jsonb THEN
      INSERT INTO public.ar_user_perms (user_id, perms, updated_by)
      VALUES (v_user_id, p_perms, auth.uid())
      ON CONFLICT (user_id) DO UPDATE SET perms = p_perms, updated_by = auth.uid(), updated_at = now();
    END IF;
    RETURN jsonb_build_object('id', v_user_id, 'email', v_email);
  END IF;

  INSERT INTO auth.users (
    instance_id, id, aud, role, email, encrypted_password,
    email_confirmed_at, confirmation_token, recovery_token,
    email_change, email_change_token_new,
    raw_app_meta_data, raw_user_meta_data,
    created_at, updated_at
  ) VALUES (
    '00000000-0000-0000-0000-000000000000',
    gen_random_uuid(),
    'authenticated',
    'authenticated',
    v_email,
    crypt(p_password, gen_salt('bf', 10)),
    now(), '', '', '', '',
    '{"provider":"email","providers":["email"]}'::jsonb,
    '{}'::jsonb,
    now(), now()
  )
  RETURNING id INTO v_user_id;

  -- 注：不插 auth.identities——新版 GoTrue 表结构已变且密码登录不需要；
  -- 月报系统的 create_dept_user 同样不插，生产验证可用。

  -- 只写台账自己的用户表；profiles 由触发器生成最小记录（无部门无角色）
  INSERT INTO public.ar_users (user_id, email, full_name, phone, department_id, ar_role)
  VALUES (v_user_id, v_email, p_full_name, p_phone, p_department_id, p_ar_role);

  IF p_perms <> '{}'::jsonb THEN
    INSERT INTO public.ar_user_perms (user_id, perms, updated_by)
    VALUES (v_user_id, p_perms, auth.uid())
    ON CONFLICT (user_id) DO UPDATE SET perms = p_perms, updated_by = auth.uid(), updated_at = now();
  END IF;

  RETURN jsonb_build_object('id', v_user_id, 'email', v_email);
END;
$$;

CREATE OR REPLACE FUNCTION public.ar_update_user(
  p_user_id       UUID,
  p_full_name     TEXT DEFAULT NULL,
  p_phone         TEXT DEFAULT NULL,
  p_department_id UUID DEFAULT NULL,
  p_ar_role       TEXT DEFAULT NULL,   -- admin | user | disabled；NULL 不变
  p_password      TEXT DEFAULT NULL,   -- NULL 不改密码
  p_perms         JSONB DEFAULT NULL   -- NULL 不改权限
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, extensions
AS $$
DECLARE
  v_target   public.ar_users;
  v_new_role TEXT;
BEGIN
  IF NOT public.ar_is_admin() THEN
    RAISE EXCEPTION '只有管理员才能编辑账号';
  END IF;
  IF p_user_id IS NULL THEN
    RAISE EXCEPTION '缺少用户';
  END IF;
  SELECT * INTO v_target FROM public.ar_users WHERE user_id = p_user_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION '用户不存在';
  END IF;
  -- 受保护的主管理员：不能被停用或降级（防绕道变相删除）
  IF v_target.ar_protected = TRUE AND p_ar_role IS NOT NULL AND p_ar_role <> 'admin' THEN
    RAISE EXCEPTION '受保护的主管理员账号不能被停用或降级';
  END IF;

  -- 普通管理员只能编辑报账员（含自己停用的，可恢复；不能提权为管理员）
  IF NOT public.ar_is_super_admin() THEN
    IF v_target.ar_super_admin = TRUE OR v_target.ar_role = 'admin' THEN
      RAISE EXCEPTION '普通管理员只能编辑报账员账号';
    END IF;
    IF p_ar_role IS NOT NULL AND p_ar_role NOT IN ('user','disabled') THEN
      RAISE EXCEPTION '普通管理员只能停用或恢复报账员，不能调整角色';
    END IF;
  END IF;

  v_new_role := COALESCE(p_ar_role, v_target.ar_role);
  IF v_new_role NOT IN ('admin','user','disabled') THEN
    RAISE EXCEPTION '角色不合法';
  END IF;
  IF p_department_id IS NOT NULL
     AND NOT EXISTS (SELECT 1 FROM public.ar_departments WHERE id = p_department_id) THEN
    RAISE EXCEPTION '部门不存在';
  END IF;
  IF v_new_role = 'user' AND p_department_id IS NULL AND v_target.department_id IS NULL THEN
    RAISE EXCEPTION '报账员必须分配部门';
  END IF;
  IF p_password IS NOT NULL AND (length(p_password) < 8
     OR p_password !~ '[A-Z]' OR p_password !~ '[a-z]'
     OR p_password !~ '[0-9]' OR p_password !~ '[^A-Za-z0-9]') THEN
    RAISE EXCEPTION '密码须至少 8 位，且同时包含大写字母、小写字母、数字和符号';
  END IF;

  IF v_target.ar_super_admin = TRUE
     AND v_new_role <> 'admin'
     AND public.ar_super_admin_count_excluding(p_user_id) = 0 THEN
    RAISE EXCEPTION '不能停用或降级最后一个超级管理员，请先把其他账号设为超级管理员';
  END IF;
  IF v_target.user_id = auth.uid() AND p_ar_role IS NOT NULL AND p_ar_role <> 'admin' THEN
    RAISE EXCEPTION '不能修改自己的角色';
  END IF;

  UPDATE public.ar_users
     SET full_name     = COALESCE(p_full_name, full_name),
         phone         = COALESCE(p_phone, phone),
         department_id = COALESCE(p_department_id, department_id),
         ar_role       = v_new_role
   WHERE user_id = p_user_id;

  IF p_password IS NOT NULL THEN
    UPDATE auth.users
       SET encrypted_password = crypt(p_password, gen_salt('bf', 10)),
           updated_at = now()
     WHERE id = p_user_id;
  END IF;

  IF p_perms IS NOT NULL THEN
    INSERT INTO public.ar_user_perms (user_id, perms, updated_by)
    VALUES (p_user_id, p_perms, auth.uid())
    ON CONFLICT (user_id) DO UPDATE SET perms = p_perms, updated_by = auth.uid(), updated_at = now();
  END IF;

  RETURN jsonb_build_object('id', p_user_id, 'ar_role', v_new_role);
END;
$$;

GRANT EXECUTE ON FUNCTION public.ar_create_user(TEXT,TEXT,TEXT,TEXT,UUID,TEXT,JSONB) TO authenticated;
GRANT EXECUTE ON FUNCTION public.ar_update_user(UUID,TEXT,TEXT,UUID,TEXT,TEXT,JSONB) TO authenticated;

-- 4.5 台账登录标识解析（手机号只查台账用户表，绝不解析到月报账号）
CREATE OR REPLACE FUNCTION public.ar_resolve_login_identifier(p_identifier TEXT)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_id TEXT := trim(COALESCE(p_identifier, ''));
BEGIN
  IF v_id = '' THEN RETURN NULL; END IF;
  -- 邮箱：直接返回
  IF v_id ~* '^[^@\s]+@[^@\s]+\.[^@\s]+$' THEN
    RETURN jsonb_build_object('email', lower(v_id));
  END IF;
  -- 手机号：只匹配台账用户（ar_users.phone）
  IF v_id ~ '^1[0-9]{10}$' THEN
    RETURN (
      SELECT jsonb_build_object('email', lower(email))
      FROM public.ar_users WHERE phone = v_id LIMIT 1
    );
  END IF;
  RETURN NULL;
END;
$$;

GRANT EXECUTE ON FUNCTION public.ar_resolve_login_identifier(TEXT) TO anon, authenticated;

-- 4.4 删除账号
--     超级管理员：可删除除自己以外的任何账号
--     普通管理员：仅可删除报账员（ar_role='user'）
--     行为：仅从台账移除（ar_users / ar_user_perms），绝不删除登录账号，
--           对月报系统零影响；该邮箱今后可通过「新增账号」重新加入台账。
CREATE OR REPLACE FUNCTION public.ar_delete_user(p_user_id UUID)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, extensions
AS $$
DECLARE
  v_caller_super BOOLEAN := public.ar_is_super_admin();
  v_target       public.ar_users;
BEGIN
  IF NOT public.ar_is_admin() THEN
    RAISE EXCEPTION '只有管理员才能删除账号';
  END IF;
  IF p_user_id IS NULL THEN
    RAISE EXCEPTION '缺少用户';
  END IF;
  IF p_user_id = auth.uid() THEN
    RAISE EXCEPTION '不能删除自己的账号';
  END IF;

  SELECT * INTO v_target FROM public.ar_users WHERE user_id = p_user_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION '用户不存在';
  END IF;
  IF v_target.ar_protected THEN
    RAISE EXCEPTION '该账号是受保护的主管理员，不能删除';
  END IF;

  IF NOT v_caller_super THEN
    -- 普通管理员：只能删报账员
    IF v_target.ar_role <> 'user' THEN
      RAISE EXCEPTION '普通管理员只能删除报账员账号';
    END IF;
  END IF;

  -- 只移出台账（ar_users / ar_user_perms），绝不删除登录账号——对月报系统零影响；
  -- 该邮箱今后可随时通过「新增账号」重新加入台账（不设密码，保留原登录方式）
  DELETE FROM public.ar_user_perms WHERE user_id = p_user_id;
  DELETE FROM public.ar_users WHERE user_id = p_user_id;
  RETURN jsonb_build_object('id', p_user_id);
END;
$$;

GRANT EXECUTE ON FUNCTION public.ar_delete_user(UUID) TO authenticated;

-- --------------------------------------------------------------------------
-- 6. 设置第一个台账超级管理员（首次执行后手动跑一次，换成实际邮箱）：
--   INSERT INTO public.ar_users (user_id, email, full_name, ar_role, ar_super_admin)
--   SELECT id, email, full_name, 'admin', true FROM public.profiles
--   WHERE email = '你的管理员邮箱'
--   ON CONFLICT (user_id) DO UPDATE SET ar_role='admin', ar_super_admin=true;
-- ==========================================================================

-- --------------------------------------------------------------------------
-- 12. 台账独立部门表（与月报 departments 彻底分离，两边互不影响）
-- --------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.ar_departments (
  id         UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name       TEXT NOT NULL UNIQUE,
  sort_order INTEGER DEFAULT 0,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

-- 首次部署：复制当前月报部门清单作为初始数据（同名即跳过，之后各自独立）
INSERT INTO public.ar_departments (id, name, sort_order)
SELECT d.id, d.name, COALESCE(d.sort_order, 0)
FROM public.departments d
WHERE NOT EXISTS (SELECT 1 FROM public.ar_departments);

-- 台账用户 / 台账数据的部门外键切换到 ar_departments（沿用原部门 id，无缝迁移）
ALTER TABLE public.ar_users DROP CONSTRAINT IF EXISTS ar_users_department_id_fkey;
ALTER TABLE public.ar_users
  ADD CONSTRAINT ar_users_department_id_fkey
  FOREIGN KEY (department_id) REFERENCES public.ar_departments(id) ON DELETE RESTRICT;

ALTER TABLE public.ar_ledger DROP CONSTRAINT IF EXISTS ar_ledger_department_id_fkey;
ALTER TABLE public.ar_ledger
  ADD CONSTRAINT ar_ledger_department_id_fkey
  FOREIGN KEY (department_id) REFERENCES public.ar_departments(id) ON DELETE RESTRICT;

-- RLS：所有人可读（下拉字典），增删改仅限管理员；被用户/数据引用的部门删不掉（RESTRICT）
ALTER TABLE public.ar_departments ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "ar_dept_select" ON public.ar_departments;
CREATE POLICY "ar_dept_select" ON public.ar_departments
  FOR SELECT TO authenticated USING (true);

DROP POLICY IF EXISTS "ar_dept_insert" ON public.ar_departments;
CREATE POLICY "ar_dept_insert" ON public.ar_departments
  FOR INSERT TO authenticated WITH CHECK (public.ar_is_admin());

DROP POLICY IF EXISTS "ar_dept_update" ON public.ar_departments;
CREATE POLICY "ar_dept_update" ON public.ar_departments
  FOR UPDATE TO authenticated USING (public.ar_is_admin());

DROP POLICY IF EXISTS "ar_dept_delete" ON public.ar_departments;
CREATE POLICY "ar_dept_delete" ON public.ar_departments
  FOR DELETE TO authenticated USING (public.ar_is_admin());
-- ==========================================================================
-- 以下拼接自 upgrade-v3-indicators.sql
-- ==========================================================================

-- ============================================================================
-- 企业应收账款台账系统 · v3 升级脚本（新指标体系）
-- 依据《应收系统统计指标.xlsx》28 列指标 + 五条要求
--  - 一、一个项目一个录入界面（前端实现，无数据库改动）
--  - 二、筛选要素生成汇总表（前端导出实现，无数据库改动）
--  - 三、蓝色内置可选项、财务可自行编辑        → ar_dict 选项字典表
--  - 四、附件上传区                            → ar_attachments 表 + Storage 桶
--  - 五、实体部门仅可编辑催收跟踪类字段         → 字段级保护触发器
--
-- 幂等：可重复执行；在服务器 psql 或 Supabase Studio SQL Editor 中运行均可。
-- ============================================================================

-- --------------------------------------------------------------------------
-- 1. ar_ledger 新增 12 列（新指标体系）
--    旧字段（合同金额/开工完工日期/付款节点/成本费用/工程进度等）保留不删、界面隐藏
-- --------------------------------------------------------------------------
ALTER TABLE public.ar_ledger ADD COLUMN IF NOT EXISTS client_attr      TEXT;            -- 客户属性
ALTER TABLE public.ar_ledger ADD COLUMN IF NOT EXISTS project_status   TEXT;            -- 项目状态（完工/施工中/中止/取消或作废）
ALTER TABLE public.ar_ledger ADD COLUMN IF NOT EXISTS final_method     TEXT;            -- 决算方式（合同金额/工作量）
ALTER TABLE public.ar_ledger ADD COLUMN IF NOT EXISTS charge_date      DATE;            -- 最新挂账时间
ALTER TABLE public.ar_ledger ADD COLUMN IF NOT EXISTS writeoff_amount  NUMERIC(18,4);   -- 核销金额
ALTER TABLE public.ar_ledger ADD COLUMN IF NOT EXISTS debt_status      TEXT;            -- 债权状态（正常/逾期/诉讼/和解）
ALTER TABLE public.ar_ledger ADD COLUMN IF NOT EXISTS collector        TEXT;            -- 清收责任人
ALTER TABLE public.ar_ledger ADD COLUMN IF NOT EXISTS comm_method      TEXT;            -- 沟通方式
ALTER TABLE public.ar_ledger ADD COLUMN IF NOT EXISTS feedback         TEXT;            -- 对方反馈
ALTER TABLE public.ar_ledger ADD COLUMN IF NOT EXISTS latest_progress  TEXT;            -- 最新进展
ALTER TABLE public.ar_ledger ADD COLUMN IF NOT EXISTS next_plan        TEXT;            -- 下一步计划
ALTER TABLE public.ar_ledger ADD COLUMN IF NOT EXISTS remark           TEXT;            -- 备注

CREATE INDEX IF NOT EXISTS idx_ar_ledger_status ON public.ar_ledger(project_status);
CREATE INDEX IF NOT EXISTS idx_ar_ledger_debt   ON public.ar_ledger(debt_status);

-- 旧数据轻量迁移（测试数据口径切换，best-effort）：
--   工程进度 → 项目状态；催收反馈 → 对方反馈
UPDATE public.ar_ledger SET project_status = CASE progress
    WHEN '已完工' THEN '完工'
    WHEN '已决算' THEN '完工'
    WHEN '施工中' THEN '施工中'
    WHEN '未开工' THEN '施工中'
    ELSE progress END
  WHERE project_status IS NULL AND progress IS NOT NULL;
UPDATE public.ar_ledger SET feedback = dunning_feedback
  WHERE feedback IS NULL AND dunning_feedback IS NOT NULL;

-- --------------------------------------------------------------------------
-- 2. ar_dict 选项字典（要求三：内置可选项，财务/管理员可自行编辑）
--    category：client_attr / project_status / final_method / debt_status /
--              comm_method / feedback / progress_note / next_plan /
--              attach_category / unit / work_nature / sector
-- --------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.ar_dict (
  id          UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  category    TEXT NOT NULL,
  value       TEXT NOT NULL,
  sort_order  INT  DEFAULT 0,
  created_at  TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE (category, value)
);

ALTER TABLE public.ar_dict ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "ar_dict_select" ON public.ar_dict;
CREATE POLICY "ar_dict_select" ON public.ar_dict
  FOR SELECT TO authenticated USING (TRUE);

DROP POLICY IF EXISTS "ar_dict_write" ON public.ar_dict;
CREATE POLICY "ar_dict_write" ON public.ar_dict
  FOR ALL TO authenticated
  USING (public.ar_is_admin())
  WITH CHECK (public.ar_is_admin());

GRANT SELECT, INSERT, UPDATE, DELETE ON public.ar_dict TO authenticated;

-- 种子选项（已存在的不重复插入；财务可在「选项管理」页随时增删改）
INSERT INTO public.ar_dict (category, value, sort_order) VALUES
  ('project_status', '完工', 1),
  ('project_status', '施工中', 2),
  ('project_status', '中止', 3),
  ('project_status', '取消或作废', 4),
  ('final_method', '合同金额', 1),
  ('final_method', '工作量', 2),
  ('debt_status', '正常', 1),
  ('debt_status', '逾期', 2),
  ('debt_status', '诉讼', 3),
  ('debt_status', '和解', 4),
  ('client_attr', '内部单位', 1),
  ('client_attr', '政府部门--省', 2),
  ('client_attr', '政府部门--市', 3),
  ('client_attr', '政府部门--县', 4),
  ('client_attr', '政府部门--县以下', 5),
  ('client_attr', '煤矿集团--晋能控股', 6),
  ('client_attr', '煤矿集团--山西焦煤', 7),
  ('client_attr', '煤矿集团--潞安化工', 8),
  ('client_attr', '煤矿集团--华阳新材', 9),
  ('client_attr', '煤矿集团--华新燃气', 10),
  ('client_attr', '煤矿集团--其他煤矿', 11),
  ('client_attr', '社会客户-省内', 12),
  ('client_attr', '社会客户-省外', 13),
  ('client_attr', '社会客户-海外', 14),
  ('client_attr', '其他', 15),
  ('unit', '物化院', 1),
  ('unit', '六勘院', 2),
  ('unit', '测绘院', 3),
  ('unit', '禹地公司', 4),
  ('work_nature', '二、三维地震', 1),
  ('work_nature', '宅基地', 2),
  ('work_nature', '农经权', 3),
  ('work_nature', '房地一体', 4),
  ('work_nature', '其他测绘', 5),
  ('work_nature', '工民建勘察', 6),
  ('work_nature', '报告编写、设计方案', 7),
  ('work_nature', '政府性灾害勘察', 8),
  ('work_nature', '地灾评估、勘察、设计', 9),
  ('work_nature', '市场地质', 10),
  ('work_nature', '价款项目', 11),
  ('work_nature', '综合物探', 12),
  ('work_nature', '基础施工', 13),
  ('work_nature', '灾害施工', 14),
  ('work_nature', '生态修复', 15),
  ('work_nature', '化验、基础检测', 16),
  ('work_nature', '土工试验', 17),
  ('work_nature', '其他', 18),
  ('sector', '能源资源勘查开发', 1),
  ('sector', '生态保护修复', 2),
  ('sector', '地质灾害治理', 3),
  ('sector', '工程勘察与施工', 4),
  ('sector', '地质延伸产业', 5),
  ('sector', '实验测试', 6),
  ('sector', '测绘地理信息', 7),
  ('sector', '海外勘查贸易', 8),
  ('comm_method', '电话', 1),
  ('comm_method', '上门拜访', 2),
  ('comm_method', '邮件', 3),
  ('comm_method', '微信', 4),
  ('comm_method', '函件+电话', 5),
  ('comm_method', '函件+微信', 6),
  ('feedback', '承认欠款，但资金紧张', 1),
  ('feedback', '拒接电话', 2),
  ('feedback', '对质量提出异议', 3),
  ('feedback', '正在筹款，近期付', 4),
  ('feedback', '工程量结算有争议', 5),
  ('feedback', '承认欠款，要求分期', 6),
  ('progress_note', '已发送第二次催款函', 1),
  ('progress_note', '停工', 2),
  ('progress_note', '需协商', 3),
  ('progress_note', '已安排对账', 4),
  ('progress_note', '对方提出分期', 5),
  ('progress_note', '移交法务部', 6),
  ('next_plan', '升级催收手段', 1),
  ('next_plan', '需实地调查', 2),
  ('next_plan', '需核实情况', 3),
  ('next_plan', '跟踪付款进度', 4),
  ('next_plan', '申请财产保全', 5),
  ('next_plan', '提供分期计划', 6),
  ('attach_category', '决算', 1),
  ('attach_category', '中止证明', 2),
  ('attach_category', '其他', 3)
ON CONFLICT (category, value) DO NOTHING;

-- --------------------------------------------------------------------------
-- 3. ar_attachments 附件表（要求四：附件上传区）+ Storage 私有桶
-- --------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.ar_attachments (
  id           UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  ledger_id    UUID NOT NULL REFERENCES public.ar_ledger(id) ON DELETE CASCADE,
  category     TEXT NOT NULL DEFAULT '其他',                 -- 决算 / 中止证明 / 其他
  file_name    TEXT NOT NULL,
  file_size    BIGINT,
  content_type TEXT,
  storage_path TEXT NOT NULL UNIQUE,                         -- {ledger_id}/{uuid}.{ext}
  uploaded_by  UUID REFERENCES auth.users(id),
  created_at   TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_ar_att_ledger ON public.ar_attachments(ledger_id);

ALTER TABLE public.ar_attachments ENABLE ROW LEVEL SECURITY;

-- 可见性跟随台账行：能看到该行数据的人才能看到附件清单
DROP POLICY IF EXISTS "ar_att_select" ON public.ar_attachments;
CREATE POLICY "ar_att_select" ON public.ar_attachments
  FOR SELECT TO authenticated USING (
    EXISTS (SELECT 1 FROM public.ar_ledger l
            WHERE l.id = ar_attachments.ledger_id
              AND public.ar_can_see_row(l.department_id))
  );

-- 上传：有编辑权限且对该行可见
DROP POLICY IF EXISTS "ar_att_insert" ON public.ar_attachments;
CREATE POLICY "ar_att_insert" ON public.ar_attachments
  FOR INSERT TO authenticated WITH CHECK (
    public.ar_can('edit') AND
    EXISTS (SELECT 1 FROM public.ar_ledger l
            WHERE l.id = ledger_id
              AND public.ar_can_see_row(l.department_id))
  );

-- 删除：财务管理员，或上传者本人
DROP POLICY IF EXISTS "ar_att_delete" ON public.ar_attachments;
CREATE POLICY "ar_att_delete" ON public.ar_attachments
  FOR DELETE TO authenticated USING (
    public.ar_is_admin() OR uploaded_by = auth.uid()
  );

GRANT SELECT, INSERT, DELETE ON public.ar_attachments TO authenticated;

-- Storage 私有桶（下载走签名 URL，路径不可猜测）
INSERT INTO storage.buckets (id, name, public)
VALUES ('ar-attachments', 'ar-attachments', FALSE)
ON CONFLICT (id) DO NOTHING;

DROP POLICY IF EXISTS "ar_att_obj_select" ON storage.objects;
CREATE POLICY "ar_att_obj_select" ON storage.objects
  FOR SELECT TO authenticated USING (bucket_id = 'ar-attachments');

DROP POLICY IF EXISTS "ar_att_obj_insert" ON storage.objects;
CREATE POLICY "ar_att_obj_insert" ON storage.objects
  FOR INSERT TO authenticated WITH CHECK (bucket_id = 'ar-attachments');

DROP POLICY IF EXISTS "ar_att_obj_delete" ON storage.objects;
CREATE POLICY "ar_att_obj_delete" ON storage.objects
  FOR DELETE TO authenticated USING (
    bucket_id = 'ar-attachments' AND (public.ar_is_admin() OR owner = auth.uid())
  );

-- --------------------------------------------------------------------------
-- 4. 字段级保护触发器（要求五：实体部门仅可编辑催收跟踪类字段）
--    非管理员 UPDATE 仅允许变更：
--      项目状态/决算方式/债权状态/清收责任人/最新催收时间/
--      沟通方式/对方反馈/最新进展/下一步计划（附件走 ar_attachments 独立表）
--    财务类字段（金额/客户/合同/挂账时间/备注等）任何变更将被数据库拒绝。
-- --------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.ar_ledger_guard_fields()
RETURNS TRIGGER AS $$
BEGIN
  IF public.ar_is_admin() THEN
    RETURN NEW;
  END IF;
  IF (to_jsonb(NEW) - ARRAY[
        'project_status', 'final_method', 'debt_status', 'collector',
        'dunning_date', 'comm_method', 'feedback', 'latest_progress',
        'next_plan', 'updated_at'
      ])
     IS DISTINCT FROM
     (to_jsonb(OLD) - ARRAY[
        'project_status', 'final_method', 'debt_status', 'collector',
        'dunning_date', 'comm_method', 'feedback', 'latest_progress',
        'next_plan', 'updated_at'
      ]) THEN
    RAISE EXCEPTION 'AR_FIELD_LOCKED: 财务类字段仅财务管理员可修改，部门账号只能更新催收跟踪信息';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public;

DROP TRIGGER IF EXISTS trg_ar_ledger_guard ON public.ar_ledger;
CREATE TRIGGER trg_ar_ledger_guard
  BEFORE UPDATE ON public.ar_ledger
  FOR EACH ROW EXECUTE FUNCTION public.ar_ledger_guard_fields();

-- --------------------------------------------------------------------------
-- 5. 补丁回收（历史上已手工执行过的脚本，此处幂等重放，保证任何环境一致）
-- --------------------------------------------------------------------------

-- 5.1 列显示偏好表（按账号一行）
CREATE TABLE IF NOT EXISTS public.ar_user_prefs (
  user_id    UUID PRIMARY KEY REFERENCES auth.users(id) ON DELETE CASCADE,
  prefs      JSONB NOT NULL DEFAULT '{}'::jsonb,
  updated_at TIMESTAMPTZ DEFAULT NOW()
);
ALTER TABLE public.ar_user_prefs ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "ar_prefs_select_self" ON public.ar_user_prefs;
CREATE POLICY "ar_prefs_select_self" ON public.ar_user_prefs
  FOR SELECT TO authenticated USING (user_id = auth.uid());
DROP POLICY IF EXISTS "ar_prefs_insert_self" ON public.ar_user_prefs;
CREATE POLICY "ar_prefs_insert_self" ON public.ar_user_prefs
  FOR INSERT TO authenticated WITH CHECK (user_id = auth.uid());
DROP POLICY IF EXISTS "ar_prefs_update_self" ON public.ar_user_prefs;
CREATE POLICY "ar_prefs_update_self" ON public.ar_user_prefs
  FOR UPDATE TO authenticated USING (user_id = auth.uid()) WITH CHECK (user_id = auth.uid());
GRANT SELECT, INSERT, UPDATE ON public.ar_user_prefs TO authenticated;

-- 5.2 导入批次可见性修复（批次含本部门可见数据才可见）
DROP POLICY IF EXISTS "ar_batches_select" ON public.ar_import_batches;
CREATE POLICY "ar_batches_select" ON public.ar_import_batches
  FOR SELECT TO authenticated USING (
    public.ar_is_admin()
    OR imported_by = auth.uid()
    OR EXISTS (
         SELECT 1 FROM public.ar_ledger l
         WHERE l.batch_id = public.ar_import_batches.id
           AND public.ar_can_see_row(l.department_id)
       )
  );

-- ============================================================================
-- 完成。执行后：
--   前端配置无需改动（js/config.js 已指向 https://www.safety.sx.cn）
--   「选项管理」页可由财务管理员维护全部下拉选项
-- ============================================================================


-- ==========================================================================
-- 首个超级管理员设置（建好 Authentication 用户后执行，换掉邮箱）
-- ==========================================================================
-- ① Studio → Authentication → Users → Add user：
--    填邮箱和密码，勾选 Auto Confirm User（会经触发器自动建 profiles 档案）。
--
-- ② 然后在 SQL Editor 执行（把 admin@example.com 换成上一步的邮箱）：
--
-- INSERT INTO public.ar_users (user_id, email, full_name, ar_role, ar_super_admin, ar_protected)
-- SELECT u.id, u.email, COALESCE(p.full_name, ''), 'admin', TRUE, TRUE
-- FROM auth.users u
-- LEFT JOIN public.profiles p ON p.id = u.id
-- WHERE u.email = 'admin@example.com'
-- ON CONFLICT (user_id) DO UPDATE SET ar_role = 'admin', ar_super_admin = TRUE;
--
-- 之后即可用该邮箱登录系统，在「用户管理」页创建其他账号。
-- ==========================================================================
