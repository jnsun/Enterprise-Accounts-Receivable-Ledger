-- ==========================================================================
-- 企业应收账款台账系统 - Supabase 数据库 Schema（v1 · 共用实例版）
-- ==========================================================================
-- 适用环境：腾讯云自托管 Supabase（140.143.247.55，与「施工项目月报管理
-- 系统」「资质证照管理」共用同一实例、同一账号体系）。
--
-- 本文件只创建台账系统自己的对象（全部 ar_ 前缀）：
--   1. ar_settings          全局设置（超期预警天数，单行表）
--   2. ar_import_batches    Excel 导入批次（支持按批次全部/部分删除）
--   3. ar_ledger            应收账款台账（核心表）
--   4. ar_invoices          开票明细（每笔开票日期与金额，1:N）
--   5. ar_user_perms        部门用户权限（管理员逐人开放）
--   6. ar_can()/ar_can_see_row() 权限辅助函数
--   7. RLS 行级安全（管理员全量；部门用户按权限 + 本部门数据）
--
-- 【不复用也不修改】月报系统的共享对象：
--   departments / profiles / handle_new_user 触发器 /
--   is_admin() / resolve_login_identifier() —— 台账直接引用，零改动。
--
-- 账号说明：
--   - 账号在月报系统后台创建（管理员/部门账号通用）；
--   - 首个台账管理员 = 把某账号的 profiles.role 改为 'admin'
--     （该账号在月报系统里通常已是管理员，无需改动）；
--   - 部门用户权限由台账系统内「用户权限」页逐人开放（存 ar_user_perms）。
--
-- 执行方法：
--   Studio（ssh -L 隧道 http://127.0.0.1:3000）或通过 Nginx 暴露的入口
--   → SQL Editor → 粘贴本文件全部内容 → Run。幂等可重复执行。
-- ==========================================================================

-- --------------------------------------------------------------------------
-- 1. 全局设置（单行：超期预警天数）
-- --------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.ar_settings (
  id         INTEGER PRIMARY KEY DEFAULT 1 CHECK (id = 1),
  warn_days  INTEGER NOT NULL DEFAULT 90 CHECK (warn_days >= 1 AND warn_days <= 3650),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

INSERT INTO public.ar_settings (id, warn_days) VALUES (1, 90)
  ON CONFLICT (id) DO NOTHING;

-- --------------------------------------------------------------------------
-- 2. 导入批次（一次 Excel 导入 = 一个批次；支持整批或部分删除）
-- --------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.ar_import_batches (
  id          UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  file_name   TEXT NOT NULL,                     -- 导入文件名
  row_count   INTEGER NOT NULL DEFAULT 0,        -- 成功导入行数
  imported_by UUID REFERENCES auth.users(id),
  created_at  TIMESTAMPTZ DEFAULT NOW()
);

-- --------------------------------------------------------------------------
-- 3. 应收账款台账（核心表）
--    department_id：数据归属部门（RLS 按此隔离部门可见范围）。
--    导入时按"施工部门"名称自动匹配 departments.name（复用月报系统部门表），
--    匹配不上由管理员在编辑中手工指定；金额单位默认万元（与导入模板一致）。
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

-- updated_at 自动维护（update_updated_at() 函数月报/证照系统已建，直接复用；
-- 若不存在则在此补建，保证脚本自洽）
CREATE OR REPLACE FUNCTION public.update_updated_at()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = NOW();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_ar_ledger_updated_at ON public.ar_ledger;
CREATE TRIGGER trg_ar_ledger_updated_at
  BEFORE UPDATE ON public.ar_ledger
  FOR EACH ROW EXECUTE FUNCTION public.update_updated_at();

-- --------------------------------------------------------------------------
-- 4. 开票明细（每笔开票：日期 + 金额；随台账行级联删除）
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
-- 5. 部门用户权限（管理员逐人开放；管理员账号天然拥有全部权限）
--    perms JSONB 键：view / view_all / add / edit / delete / import / export
-- --------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.ar_user_perms (
  user_id    UUID PRIMARY KEY REFERENCES public.profiles(id) ON DELETE CASCADE,
  perms      JSONB NOT NULL DEFAULT '{}'::jsonb,
  updated_by UUID REFERENCES auth.users(id),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

-- --------------------------------------------------------------------------
-- 6. 权限辅助函数（is_admin() 复用月报/证照系统已有定义）
-- --------------------------------------------------------------------------

-- 6.1 当前用户是否拥有某项台账权限（管理员恒真）
CREATE OR REPLACE FUNCTION public.ar_can(p_key TEXT)
RETURNS BOOLEAN AS $$
  SELECT public.is_admin()
      OR COALESCE(
           (SELECT (perms ->> p_key)::boolean
            FROM public.ar_user_perms WHERE user_id = auth.uid()),
         FALSE);
$$ LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public;

-- 6.2 当前用户是否可见某条台账（管理员 / view_all 全量；否则限本部门）
CREATE OR REPLACE FUNCTION public.ar_can_see_row(p_department_id UUID)
RETURNS BOOLEAN AS $$
  SELECT public.is_admin()
      OR public.ar_can('view_all')
      OR p_department_id IN (
           SELECT department_id FROM public.profiles WHERE id = auth.uid()
         );
$$ LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public;

-- --------------------------------------------------------------------------
-- 7. RLS 行级安全（仅台账自己的表；departments/profiles 沿用月报系统策略）
-- --------------------------------------------------------------------------

ALTER TABLE public.ar_settings       ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.ar_import_batches ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.ar_ledger         ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.ar_invoices       ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.ar_user_perms     ENABLE ROW LEVEL SECURITY;

-- 7.1 设置：已登录可读（前端计算超期预警需要），写仅管理员
DROP POLICY IF EXISTS "ar_settings_select" ON public.ar_settings;
CREATE POLICY "ar_settings_select" ON public.ar_settings
  FOR SELECT TO authenticated USING (true);

DROP POLICY IF EXISTS "ar_settings_update_admin" ON public.ar_settings;
CREATE POLICY "ar_settings_update_admin" ON public.ar_settings
  FOR UPDATE TO authenticated USING (public.is_admin());

-- 7.2 导入批次：本人可见自己的批次；有导入/删除权限者与管理员可见全部
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

-- 7.3 台账
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

-- 7.4 开票明细：读/写跟随所属台账行的权限
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

-- 7.5 权限表：本人可读自己的权限（左侧权限栏展示），管理员可读写全部
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
-- 8. 授权
-- --------------------------------------------------------------------------
GRANT ALL ON public.ar_settings       TO authenticated;
GRANT ALL ON public.ar_import_batches TO authenticated;
GRANT ALL ON public.ar_ledger         TO authenticated;
GRANT ALL ON public.ar_invoices       TO authenticated;
GRANT ALL ON public.ar_user_perms     TO authenticated;

-- ==========================================================================
-- 验证 SQL：
--   SELECT * FROM public.ar_settings;
--   SELECT count(*) FROM public.ar_ledger;
--   SELECT id, full_name, role, department_id FROM public.profiles;  -- 复用月报账号
--
-- 台账管理员：月报系统里的管理员自动拥有台账全部权限（is_admin 共用）；
-- 部门用户登录台账后，由台账「用户权限」页逐人开放 7 项权限。
-- ==========================================================================
