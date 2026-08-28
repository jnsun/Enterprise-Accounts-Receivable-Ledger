-- ==========================================================================
-- 企业应收账款台账系统 - 用户与角色管理（v2 · 独立角色体系）
-- ==========================================================================
-- 在共用实例上为台账系统建立独立于月报系统的角色体系：
--   profiles.ar_role        台账角色：'admin' 普通管理员 | 'user' 报账员(默认)
--                           | 'disabled' 已停用
--   profiles.ar_super_admin 台账超级管理员标记
--
-- 角色三层（与月报系统的 role/is_super_admin 完全独立、互不影响）：
--   超级管理员  ar_super_admin=true（且 ar_role='admin'）
--               → 管理「用户管理」页：新增/编辑/停用管理员与报账员
--   普通管理员  ar_role='admin'
--               → 台账全部权限（7 项）+ 系统设置，但不能管理账号
--   报账员      ar_role='user'
--               → 权限由 ar_user_perms 逐人开放（沿用原机制）
--
-- 设置第一个台账超级管理员（执行完本文件后，把邮箱换成实际管理员）：
--   UPDATE public.profiles SET ar_role='admin', ar_super_admin=true
--   WHERE email='admin@example.com';
--
-- 执行方法：psql 或 SQL Editor 粘贴执行。幂等可重复执行。
-- ==========================================================================

-- --------------------------------------------------------------------------
-- 1. profiles 新列（幂等）
-- --------------------------------------------------------------------------
ALTER TABLE public.profiles
  ADD COLUMN IF NOT EXISTS ar_role TEXT NOT NULL DEFAULT 'user';
ALTER TABLE public.profiles
  ADD COLUMN IF NOT EXISTS ar_super_admin BOOLEAN NOT NULL DEFAULT FALSE;

ALTER TABLE public.profiles DROP CONSTRAINT IF EXISTS profiles_ar_role_check;
ALTER TABLE public.profiles
  ADD CONSTRAINT profiles_ar_role_check CHECK (ar_role IN ('admin','user','disabled'));

-- --------------------------------------------------------------------------
-- 2. 角色判断函数
-- --------------------------------------------------------------------------

-- 2.1 台账管理员（普通管理员 + 超级管理员）
CREATE OR REPLACE FUNCTION public.ar_is_admin()
RETURNS BOOLEAN AS $$
  SELECT EXISTS (
    SELECT 1 FROM public.profiles
    WHERE id = auth.uid() AND ar_role = 'admin'
  );
$$ LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public;

-- 2.2 台账超级管理员
CREATE OR REPLACE FUNCTION public.ar_is_super_admin()
RETURNS BOOLEAN AS $$
  SELECT EXISTS (
    SELECT 1 FROM public.profiles
    WHERE id = auth.uid() AND ar_super_admin = TRUE AND ar_role = 'admin'
  );
$$ LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public;

-- 2.3 权限判断（改用台账自己的角色，不再复用月报 is_admin()）
CREATE OR REPLACE FUNCTION public.ar_can(p_key TEXT)
RETURNS BOOLEAN AS $$
  SELECT EXISTS (
      SELECT 1 FROM public.profiles
      WHERE id = auth.uid() AND ar_role = 'admin'
    )
    OR COALESCE(
         (SELECT CASE WHEN ar_role = 'disabled' THEN FALSE
                      ELSE (perms ->> p_key)::boolean END
          FROM public.ar_user_perms WHERE user_id = auth.uid()),
         FALSE);
$$ LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public;

CREATE OR REPLACE FUNCTION public.ar_can_see_row(p_department_id UUID)
RETURNS BOOLEAN AS $$
  SELECT public.ar_is_admin()
      OR public.ar_can('view_all')
      OR p_department_id IN (
           SELECT department_id FROM public.profiles WHERE id = auth.uid()
         );
$$ LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public;

GRANT EXECUTE ON FUNCTION public.ar_is_admin() TO authenticated;
GRANT EXECUTE ON FUNCTION public.ar_is_super_admin() TO authenticated;

-- --------------------------------------------------------------------------
-- 3. 重刷 ar_* RLS 策略（is_admin() → ar_is_admin()）
-- --------------------------------------------------------------------------

DROP POLICY IF EXISTS "ar_settings_update_admin" ON public.ar_settings;
CREATE POLICY "ar_settings_update_admin" ON public.ar_settings
  FOR UPDATE TO authenticated USING (public.ar_is_admin());

DROP POLICY IF EXISTS "ar_batches_select" ON public.ar_import_batches;
CREATE POLICY "ar_batches_select" ON public.ar_import_batches
  FOR SELECT TO authenticated USING (
    imported_by = auth.uid() OR public.ar_can('import') OR public.ar_can('delete')
  );

DROP POLICY IF EXISTS "ar_batches_insert" ON public.ar_import_batches;
CREATE POLICY "ar_batches_insert" ON public.ar_import_batches
  FOR INSERT TO authenticated WITH CHECK (public.ar_can('import'));

DROP POLICY IF EXISTS "ar_batches_update" ON public.ar_import_batches;
CREATE POLICY "ar_batches_update" ON public.ar_import_batches
  FOR UPDATE TO authenticated USING (public.ar_can('import'));

DROP POLICY IF EXISTS "ar_batches_delete" ON public.ar_import_batches;
CREATE POLICY "ar_batches_delete" ON public.ar_import_batches
  FOR DELETE TO authenticated USING (public.ar_can('delete'));

DROP POLICY IF EXISTS "ar_ledger_select" ON public.ar_ledger;
CREATE POLICY "ar_ledger_select" ON public.ar_ledger
  FOR SELECT TO authenticated USING (public.ar_can_see_row(department_id));

DROP POLICY IF EXISTS "ar_ledger_insert" ON public.ar_ledger;
CREATE POLICY "ar_ledger_insert" ON public.ar_ledger
  FOR INSERT TO authenticated WITH CHECK (
    public.ar_is_admin() OR (
      public.ar_can('add') AND (
        department_id IS NULL OR department_id IN (
          SELECT department_id FROM public.profiles WHERE id = auth.uid()
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

DROP POLICY IF EXISTS "ar_invoices_select" ON public.ar_invoices;
CREATE POLICY "ar_invoices_select" ON public.ar_invoices
  FOR SELECT TO authenticated USING (
    EXISTS (SELECT 1 FROM public.ar_ledger l
            WHERE l.id = ledger_id AND public.ar_can_see_row(l.department_id))
  );

DROP POLICY IF EXISTS "ar_invoices_insert" ON public.ar_invoices;
CREATE POLICY "ar_invoices_insert" ON public.ar_invoices
  FOR INSERT TO authenticated WITH CHECK (
    EXISTS (SELECT 1 FROM public.ar_ledger l
            WHERE l.id = ledger_id
              AND (public.ar_is_admin() OR (public.ar_can('edit') AND public.ar_can_see_row(l.department_id))))
  );

DROP POLICY IF EXISTS "ar_invoices_update" ON public.ar_invoices;
CREATE POLICY "ar_invoices_update" ON public.ar_invoices
  FOR UPDATE TO authenticated USING (
    EXISTS (SELECT 1 FROM public.ar_ledger l
            WHERE l.id = ledger_id
              AND (public.ar_is_admin() OR (public.ar_can('edit') AND public.ar_can_see_row(l.department_id))))
  );

DROP POLICY IF EXISTS "ar_invoices_delete" ON public.ar_invoices;
CREATE POLICY "ar_invoices_delete" ON public.ar_invoices
  FOR DELETE TO authenticated USING (
    EXISTS (SELECT 1 FROM public.ar_ledger l
            WHERE l.id = ledger_id
              AND (public.ar_is_admin() OR (public.ar_can('edit') AND public.ar_can_see_row(l.department_id))))
  );

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
  FOR UPDATE TO authenticated USING (public.ar_is_admin());

DROP POLICY IF EXISTS "ar_perms_delete_admin" ON public.ar_user_perms;
CREATE POLICY "ar_perms_delete_admin" ON public.ar_user_perms
  FOR DELETE TO authenticated USING (public.ar_is_admin());

-- profiles：台账超级管理员可读取全部用户（用户管理页需要）
DROP POLICY IF EXISTS "ar_profiles_select" ON public.profiles;
CREATE POLICY "ar_profiles_select" ON public.profiles
  FOR SELECT TO authenticated USING (
    id = auth.uid() OR public.is_admin() OR public.ar_is_super_admin()
  );

-- --------------------------------------------------------------------------
-- 4. 账号管理 RPC（仅台账超级管理员可调用）
-- --------------------------------------------------------------------------

-- 4.1 最后一个超级管理员保护
CREATE OR REPLACE FUNCTION public.ar_super_admin_count_excluding(p_user_id UUID)
RETURNS INTEGER AS $$
  SELECT count(*)::int FROM public.profiles
  WHERE ar_super_admin = TRUE AND ar_role = 'admin' AND id <> p_user_id;
$$ LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public;

-- 4.2 新增账号（auth.users + profiles 一并创建）
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
  IF NOT public.ar_is_super_admin() THEN
    RAISE EXCEPTION '只有台账超级管理员才能管理账号';
  END IF;
  IF v_email = '' OR v_email !~* '^[^@\s]+@[^@\s]+\.[^@\s]+$' THEN
    RAISE EXCEPTION '邮箱格式不正确';
  END IF;
  IF p_password IS NULL OR length(p_password) < 6 THEN
    RAISE EXCEPTION '密码长度至少 6 位';
  END IF;
  IF p_ar_role NOT IN ('admin','user') THEN
    RAISE EXCEPTION '角色不合法';
  END IF;
  IF p_ar_role = 'user' AND p_department_id IS NULL THEN
    RAISE EXCEPTION '报账员必须分配部门';
  END IF;
  IF EXISTS (SELECT 1 FROM auth.users WHERE lower(email) = v_email) THEN
    RAISE EXCEPTION '该邮箱已被使用';
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

  -- GoTrue v2 需要 identities 记录
  INSERT INTO auth.identities (
    id, user_id, provider_id, provider_name, identity_data,
    last_sign_in_at, created_at, updated_at
  ) VALUES (
    gen_random_uuid(), v_user_id, 'email', 'email',
    jsonb_build_object('sub', v_user_id::text, 'email', v_email, 'email_verified', false),
    now(), now(), now()
  );

  -- 触发器会自动建 profile（仅 id+email），此处覆盖补全
  INSERT INTO public.profiles (id, email, full_name, phone, department_id, ar_role)
  VALUES (v_user_id, v_email, p_full_name, p_phone, p_department_id, p_ar_role)
  ON CONFLICT (id) DO UPDATE
    SET full_name = COALESCE(p_full_name, profiles.full_name),
        phone = p_phone,
        department_id = p_department_id,
        ar_role = p_ar_role;

  IF p_perms <> '{}'::jsonb THEN
    INSERT INTO public.ar_user_perms (user_id, perms, updated_by)
    VALUES (v_user_id, p_perms, auth.uid())
    ON CONFLICT (user_id) DO UPDATE SET perms = p_perms, updated_by = auth.uid(), updated_at = now();
  END IF;

  RETURN jsonb_build_object('id', v_user_id, 'email', v_email);
END;
$$;

-- 4.3 编辑账号（资料 / 角色 / 停用恢复 / 重置密码 / 权限）
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
  v_target    public.profiles;
  v_new_role  TEXT;
BEGIN
  IF NOT public.ar_is_super_admin() THEN
    RAISE EXCEPTION '只有台账超级管理员才能管理账号';
  END IF;
  IF p_user_id IS NULL THEN
    RAISE EXCEPTION '缺少用户';
  END IF;
  SELECT * INTO v_target FROM public.profiles WHERE id = p_user_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION '用户不存在';
  END IF;

  v_new_role := COALESCE(p_ar_role, v_target.ar_role);
  IF v_new_role NOT IN ('admin','user','disabled') THEN
    RAISE EXCEPTION '角色不合法';
  END IF;
  IF v_new_role = 'user' AND p_department_id IS NULL AND v_target.department_id IS NULL THEN
    RAISE EXCEPTION '报账员必须分配部门';
  END IF;
  IF p_password IS NOT NULL AND length(p_password) < 6 THEN
    RAISE EXCEPTION '密码长度至少 6 位';
  END IF;

  -- 最后一个超级管理员保护：降级/停用仅剩的超级管理员时拒绝
  IF v_target.ar_super_admin = TRUE
     AND (v_new_role <> 'admin')
     AND public.ar_super_admin_count_excluding(p_user_id) = 0 THEN
    RAISE EXCEPTION '不能停用或降级最后一个超级管理员，请先把其他账号设为超级管理员';
  END IF;
  -- 超级管理员的角色/停用状态仅超级管理员可改（本函数入口已保证），超级管理员不能改自己的角色
  IF v_target.ar_super_admin = TRUE AND p_user_id = auth.uid() AND p_ar_role IS NOT NULL AND p_ar_role <> 'admin' THEN
    RAISE EXCEPTION '不能修改自己的角色';
  END IF;

  UPDATE public.profiles
     SET full_name     = COALESCE(p_full_name, full_name),
         phone         = COALESCE(p_phone, phone),
         department_id = COALESCE(p_department_id, department_id),
         ar_role       = v_new_role
   WHERE id = p_user_id;

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

-- --------------------------------------------------------------------------
-- 5. 验证
--   SELECT id, email, ar_role, ar_super_admin FROM public.profiles;
--   SELECT public.ar_is_admin(), public.ar_is_super_admin();
-- ==========================================================================
