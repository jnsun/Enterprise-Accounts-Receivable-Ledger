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

-- 种子部门（按需增删；管理员也可后续在数据中维护）
INSERT INTO public.departments (name, code, sort_order) VALUES
  ('工程一部', 'DEPT-01', 1),
  ('工程二部', 'DEPT-02', 2),
  ('财务部',   'DEPT-03', 3)
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
