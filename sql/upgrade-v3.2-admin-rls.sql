-- ============================================================================
-- v3.2 台账管理员判定修复（P0）
-- ============================================================================
-- 问题（2026-09-15 发现）：
--   独立实例（本库）里，早期那批 RLS 策略沿用了**月报系统**的 public.is_admin()，
--   它读的是 profiles.role；而台账的管理员身份自 ar-users-v2 起存在
--   ar_users.ar_role（函数 public.ar_is_admin()）。
--   本库的 profiles 由注册触发器自动生成，role 恒为 'reporter' —— 也就是
--   public.is_admin() 恒为 FALSE。后果：
--     ① ar_user_perms 读不到（用户管理页里报账员的「台账权限」全部显示未勾选，
--        点「保存权限」还会被 RLS 拒绝）；
--     ② 系统设置（ar_settings）保存被拒；
--     ③ 新增台账记录时「部门归属」校验走 profiles.department_id（为空）→ 带部门
--        的新记录被拒；
--     ④ 导入批次/台账的写策略绕道 is_admin() 时同样失效。
--   修复方式：这批策略统一改用台账自己的 public.ar_is_admin()（读 ar_users）。
--
-- 依赖：必须先执行 ar-users-v2.sql（提供 ar_is_admin / ar_can / ar_can_see_row）。
-- 幂等：可重复执行。
-- 注：v3 / v3.1 新增的策略（ar_dict / ar_attachments / ar_receipts / ar_invoices 写）
--     本来就是 ar_is_admin()，本脚本不重复处理。
-- ============================================================================

-- ----------------------------------------------------------------------------
-- 1. 权限表 ar_user_perms：本人可读自己；管理员（台账口径）可读写全部
-- ----------------------------------------------------------------------------
DROP POLICY IF EXISTS "ar_perms_select" ON public.ar_user_perms;
CREATE POLICY "ar_perms_select" ON public.ar_user_perms
  FOR SELECT TO authenticated USING (
    user_id = auth.uid() OR public.ar_is_admin()
  );

DROP POLICY IF EXISTS "ar_perms_insert_admin" ON public.ar_user_perms;
CREATE POLICY "ar_perms_insert_admin" ON public.ar_user_perms
  FOR INSERT TO authenticated WITH CHECK (public.ar_is_admin());

DROP POLICY IF EXISTS "ar_perms_update_admin" ON public.ar_user_perms;
CREATE POLICY "ar_perms_update_admin" ON public.ar_user_perms
  FOR UPDATE TO authenticated
  USING (public.ar_is_admin()) WITH CHECK (public.ar_is_admin());

DROP POLICY IF EXISTS "ar_perms_delete_admin" ON public.ar_user_perms;
CREATE POLICY "ar_perms_delete_admin" ON public.ar_user_perms
  FOR DELETE TO authenticated USING (public.ar_is_admin());

-- ----------------------------------------------------------------------------
-- 2. 系统设置 ar_settings：所有人可读，仅台账管理员可写
-- ----------------------------------------------------------------------------
DROP POLICY IF EXISTS "ar_settings_select" ON public.ar_settings;
CREATE POLICY "ar_settings_select" ON public.ar_settings
  FOR SELECT TO authenticated USING (true);

DROP POLICY IF EXISTS "ar_settings_update_admin" ON public.ar_settings;
CREATE POLICY "ar_settings_update_admin" ON public.ar_settings
  FOR UPDATE TO authenticated
  USING (public.ar_is_admin()) WITH CHECK (public.ar_is_admin());

-- ----------------------------------------------------------------------------
-- 3. 台账 ar_ledger
--    新增：管理员，或「新增」权限且写入本部门（部门取 ar_users，不再取 profiles）
--    编辑 / 删除：管理员，或对应权限且行在其可见范围
-- ----------------------------------------------------------------------------
DROP POLICY IF EXISTS "ar_ledger_insert" ON public.ar_ledger;
CREATE POLICY "ar_ledger_insert" ON public.ar_ledger
  FOR INSERT TO authenticated WITH CHECK (
    public.ar_is_admin() OR (
      public.ar_can('add') AND (
        department_id IS NULL OR department_id IN (
          SELECT department_id FROM public.ar_users WHERE user_id = auth.uid()
        )
      )
    )
  );

DROP POLICY IF EXISTS "ar_ledger_update" ON public.ar_ledger;
CREATE POLICY "ar_ledger_update" ON public.ar_ledger
  FOR UPDATE TO authenticated USING (
    public.ar_is_admin() OR (
      public.ar_can('edit') AND public.ar_can_see_row(department_id)
    )
  );

DROP POLICY IF EXISTS "ar_ledger_delete" ON public.ar_ledger;
CREATE POLICY "ar_ledger_delete" ON public.ar_ledger
  FOR DELETE TO authenticated USING (
    public.ar_is_admin() OR (
      public.ar_can('delete') AND public.ar_can_see_row(department_id)
    )
  );

-- ----------------------------------------------------------------------------
-- 4. 导入批次 ar_import_batches（select 已被 v3 的可见性策略覆盖，这里补写权限）
-- ----------------------------------------------------------------------------
DROP POLICY IF EXISTS "ar_batches_insert" ON public.ar_import_batches;
CREATE POLICY "ar_batches_insert" ON public.ar_import_batches
  FOR INSERT TO authenticated WITH CHECK (
    public.ar_is_admin() OR public.ar_can('import')
  );

DROP POLICY IF EXISTS "ar_batches_update" ON public.ar_import_batches;
CREATE POLICY "ar_batches_update" ON public.ar_import_batches
  FOR UPDATE TO authenticated USING (
    public.ar_is_admin() OR public.ar_can('import')
  );

DROP POLICY IF EXISTS "ar_batches_delete" ON public.ar_import_batches;
CREATE POLICY "ar_batches_delete" ON public.ar_import_batches
  FOR DELETE TO authenticated USING (
    public.ar_is_admin() OR public.ar_can('delete')
  );

-- ----------------------------------------------------------------------------
-- 5. profiles：台账侧已不再使用（用户信息在 ar_users），仅补台账管理员可读，
--    便于排障；月报系统的 is_admin() 判断保持原样。
-- ----------------------------------------------------------------------------
DROP POLICY IF EXISTS "ar_profiles_select" ON public.profiles;
CREATE POLICY "ar_profiles_select" ON public.profiles
  FOR SELECT TO authenticated USING (
    id = auth.uid() OR public.is_admin() OR public.ar_is_admin()
  );

-- ----------------------------------------------------------------------------
-- 6. 维护工具：重算「最新挂账时间」（= 该合同最近一笔开票日期）
--    口径见 CONTEXT.md：挂账时间由系统按开票明细自动维护；本条用于把
--    手工填写/导入的历史值批量校正为明细口径。仅台账管理员可执行。
-- ----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.ar_recalc_charge_date()
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_updated INTEGER := 0;
BEGIN
  IF NOT public.ar_is_admin() THEN
    RAISE EXCEPTION '只有台账管理员才能执行维护操作';
  END IF;

  WITH latest AS (
    SELECT ledger_id, MAX(invoice_date) AS d
    FROM public.ar_invoices
    WHERE invoice_date IS NOT NULL
    GROUP BY ledger_id
  ), upd AS (
    UPDATE public.ar_ledger l
       SET charge_date = latest.d
      FROM latest
     WHERE l.id = latest.ledger_id
       AND l.charge_date IS DISTINCT FROM latest.d
    RETURNING 1
  )
  SELECT count(*) INTO v_updated FROM upd;

  RETURN jsonb_build_object('updated', v_updated);
END;
$$;

GRANT EXECUTE ON FUNCTION public.ar_recalc_charge_date() TO authenticated;

-- ============================================================================
-- 校验（可选，逐个执行查看结果）：
--   SELECT count(*) FROM public.ar_user_perms;          -- 权限行数应 > 0
--   SELECT public.ar_is_admin();                        -- 用管理员账号登录后执行应为 true
--   SELECT public.is_admin();                           -- 本库应为 false（月报口径，正常）
-- ============================================================================
