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
    user_id = auth.uid() OR public.ar_is_super_admin()
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
    RAISE EXCEPTION '该邮箱已被使用（可能已存在于月报系统，请改用「添加已有账号」）';
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

  INSERT INTO auth.identities (
    id, user_id, provider_id, provider_name, identity_data,
    last_sign_in_at, created_at, updated_at
  ) VALUES (
    gen_random_uuid(), v_user_id, 'email', 'email',
    jsonb_build_object('sub', v_user_id::text, 'email', v_email, 'email_verified', false),
    now(), now(), now()
  );

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
  IF NOT public.ar_is_super_admin() THEN
    RAISE EXCEPTION '只有台账超级管理员才能管理账号';
  END IF;
  IF p_user_id IS NULL THEN
    RAISE EXCEPTION '缺少用户';
  END IF;
  SELECT * INTO v_target FROM public.ar_users WHERE user_id = p_user_id;
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

-- --------------------------------------------------------------------------
-- 6. 设置第一个台账超级管理员（首次执行后手动跑一次，换成实际邮箱）：
--   INSERT INTO public.ar_users (user_id, email, full_name, ar_role, ar_super_admin)
--   SELECT id, email, full_name, 'admin', true FROM public.profiles
--   WHERE email = '你的管理员邮箱'
--   ON CONFLICT (user_id) DO UPDATE SET ar_role='admin', ar_super_admin=true;
-- ==========================================================================
