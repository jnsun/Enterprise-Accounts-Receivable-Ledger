-- ============================================================================
-- 部署自检（只读 · 不修改任何数据）
-- ============================================================================
-- 用途：测试前跑一遍，确认数据库是否已执行到最新版本、字典/部门/权限是否就绪。
-- 用法：Supabase Studio → SQL Editor → 整段粘贴执行 → 看下方 Results 表。
--
-- 说明：SQLEditor 里 auth.uid() 为空，所以不能直接调用 ar_is_admin() 验证身份；
--       本脚本改为检查「策略定义」与「函数是否存在」，等价且更可靠。
-- ============================================================================

-- 确保会话级临时 schema 存在（下面 pg_temp.chk 依赖它）
CREATE TEMP TABLE IF NOT EXISTS _verify_guard(x int);
DROP TABLE IF EXISTS _verify_guard;

CREATE OR REPLACE FUNCTION pg_temp.chk(q text) RETURNS text
LANGUAGE plpgsql AS $body$
DECLARE r text;
BEGIN
  EXECUTE q INTO r;
  RETURN COALESCE(r, '（空）');
EXCEPTION WHEN OTHERS THEN RETURN '✗ ' || SQLERRM;
END $body$;

SELECT v.grp AS "分组", v.item AS "检查项", v.result AS "结果" FROM (VALUES

-- ---------------------------------------------------------------- 1 表结构
('① 表结构', 'ar_ledger 台账行数',
 pg_temp.chk($q$SELECT count(*)::text FROM public.ar_ledger$q$)),
('① 表结构', 'ar_departments 部门数（期望 30）',
 pg_temp.chk($q$SELECT count(*)::text FROM public.ar_departments$q$)),
('① 表结构', 'ar_dict 字典条数（期望 51）',
 pg_temp.chk($q$SELECT count(*)::text FROM public.ar_dict$q$)),
('① 表结构', 'ar_invoices 开票明细条数',
 pg_temp.chk($q$SELECT count(*)::text FROM public.ar_invoices$q$)),
('① 表结构', 'ar_receipts 回款明细条数',
 pg_temp.chk($q$SELECT count(*)::text FROM public.ar_receipts$q$)),
('① 表结构', 'ar_attachments 附件条数',
 pg_temp.chk($q$SELECT count(*)::text FROM public.ar_attachments$q$)),
('① 表结构', 'ar_users 账号数 / ar_user_perms 权限行数',
 pg_temp.chk($q$SELECT (SELECT count(*) FROM public.ar_users)::text || ' / ' || (SELECT count(*) FROM public.ar_user_perms)::text$q$)),

-- ------------------------------------------------------------ 2 迁移到版本
('② 迁移状态', 'v3 新列是否齐（期望 12）',
 pg_temp.chk($q$SELECT count(*)::text FROM information_schema.columns WHERE table_schema='public' AND table_name='ar_ledger' AND column_name IN ('client_attr','project_status','final_method','charge_date','writeoff_amount','debt_status','collector','comm_method','feedback','latest_progress','next_plan','remark')$q$)),
('② 迁移状态', 'v3.1 ar_receipts 回款明细表',
 pg_temp.chk($q$SELECT CASE WHEN to_regclass('public.ar_receipts') IS NULL THEN '✗ 缺失（执行 upgrade-v3.1-receipts.sql）' ELSE '✓ 已建' END$q$)),
('② 迁移状态', 'v3.1 开票/回款明细写权限已收紧为仅财务',
 pg_temp.chk($q$SELECT CASE WHEN count(*)=0 THEN '✗ 无写策略' WHEN count(*) FILTER (WHERE (COALESCE(qual,'')||COALESCE(with_check,'')) LIKE '%ar_is_admin%') = count(*) THEN '✓ 全部仅 ar_is_admin（' || count(*) || ' 条）' ELSE '⚠ 部分策略仍按 ar_can 放开（共 ' || count(*) || ' 条）' END FROM pg_policies WHERE tablename IN ('ar_invoices','ar_receipts') AND cmd IN ('INSERT','UPDATE','DELETE')$q$)),
('② 迁移状态', 'v3 附件桶 ar-attachments',
 pg_temp.chk($q$SELECT CASE WHEN count(*)>0 THEN '✓ 已建（public=' || bool_or("public")::text || '）' ELSE '✗ 缺失（执行 upgrade-v3-indicators.sql）' END FROM storage.buckets WHERE id='ar-attachments'$q$)),
('② 迁移状态', 'v3.2 维护函数 ar_recalc_charge_date',
 pg_temp.chk($q$SELECT CASE WHEN count(*)>0 THEN '✓ 已建（v3.2 已执行）' ELSE '✗ 缺失（执行 upgrade-v3.2-admin-rls.sql）' END FROM pg_proc WHERE proname='ar_recalc_charge_date' AND pronamespace='public'::regnamespace$q$)),

-- ------------------------------------------------------- 3 v3.2 策略口径 ★
('③ 策略口径', 'ar_user_perms 策略改用 ar_is_admin 的条数（期望 4）',
 pg_temp.chk($q$SELECT count(*)::text FROM pg_policies WHERE tablename='ar_user_perms' AND (COALESCE(qual,'')||COALESCE(with_check,'')) LIKE '%ar_is_admin%'$q$)),
('③ 策略口径', 'ar_user_perms 仍引用旧 is_admin( 的策略（期望 0）',
 pg_temp.chk($q$SELECT COALESCE(string_agg(policyname, ', '), '0 ✓ 无') FROM pg_policies WHERE tablename='ar_user_perms' AND (COALESCE(qual,'')||COALESCE(with_check,'')) LIKE '%is_admin()%' AND (COALESCE(qual,'')||COALESCE(with_check,'')) NOT LIKE '%ar_is_admin()%'$q$)),
('③ 策略口径', 'ar_settings / ar_ledger / ar_import_batches 旧 is_admin( 残留',
 pg_temp.chk($q$SELECT COALESCE(string_agg(tablename||'.'||policyname, ', '), '0 ✓ 无') FROM pg_policies WHERE tablename IN ('ar_settings','ar_ledger','ar_import_batches') AND (COALESCE(qual,'')||COALESCE(with_check,'')) LIKE '%is_admin()%' AND (COALESCE(qual,'')||COALESCE(with_check,'')) NOT LIKE '%ar_is_admin()%'$q$)),
('③ 策略口径', 'ar_ledger / ar_receipts / ar_invoices / ar_user_perms 启用 RLS 的表数（期望 4）',
 pg_temp.chk($q$SELECT count(*)::text FROM pg_class WHERE relnamespace='public'::regnamespace AND relname IN ('ar_ledger','ar_receipts','ar_invoices','ar_user_perms') AND relrowsecurity$q$)),
('③ 策略口径', '遗留未启用 RLS 的 ar_ 表（期望 0）',
 pg_temp.chk($q$SELECT COALESCE(string_agg(relname,', '),'0 ✓ 无') FROM pg_class WHERE relnamespace='public'::regnamespace AND relkind='r' AND relname LIKE 'ar\_%' AND NOT relrowsecurity$q$)),

-- ------------------------------------------------------------------ 4 字典
('④ 字典数据', 'client_attr 客户属性（期望 15）',
 pg_temp.chk($q$SELECT count(*)::text FROM public.ar_dict WHERE category='client_attr'$q$)),
('④ 字典数据', 'unit 单位（期望 4）',
 pg_temp.chk($q$SELECT count(*)::text FROM public.ar_dict WHERE category='unit'$q$)),
('④ 字典数据', 'work_nature 工作性质（期望 18）',
 pg_temp.chk($q$SELECT count(*)::text FROM public.ar_dict WHERE category='work_nature'$q$)),
('④ 字典数据', 'sector 八大板块（期望 8）',
 pg_temp.chk($q$SELECT count(*)::text FROM public.ar_dict WHERE category='sector'$q$)),
('④ 字典数据', '残留占位选项（期望 0）',
 pg_temp.chk($q$SELECT count(*)::text FROM public.ar_dict WHERE value IN ('国有企业','民营企业','政府机关','事业单位')$q$)),
('④ 字典数据', '残留占位部门（期望 0）',
 pg_temp.chk($q$SELECT count(*)::text FROM public.ar_departments WHERE name IN ('工程一部','工程二部','财务部')$q$)),
('④ 字典数据', '单位取值',
 pg_temp.chk($q$SELECT COALESCE(string_agg(value,'、' ORDER BY sort_order),'（空）') FROM public.ar_dict WHERE category='unit'$q$)),

-- ------------------------------------------------------------- 5 账号与权限
('⑤ 账号权限', '角色分布（超管/管理员/报账员）',
 pg_temp.chk($q$SELECT COALESCE(string_agg(ar_role||'='||n, ' · ' ORDER BY ar_role),'（无账号）') FROM (SELECT ar_role, count(*) n FROM public.ar_users GROUP BY ar_role) t$q$)),
('⑤ 账号权限', '已分配部门的账号数 / 未分配',
 pg_temp.chk($q$SELECT (SELECT count(*) FROM public.ar_users WHERE department_id IS NOT NULL)::text || ' / ' || (SELECT count(*) FROM public.ar_users WHERE department_id IS NULL)::text$q$)),
('⑤ 账号权限', '报账员中权限记录缺失/为空的（期望 0）',
 pg_temp.chk($q$SELECT count(*)::text FROM public.ar_users u LEFT JOIN public.ar_user_perms p ON p.user_id=u.user_id WHERE u.ar_role='reporter' AND (p.perms IS NULL OR p.perms='{}'::jsonb)$q$)),
('⑤ 账号权限', '账号部门是否都有对应 ar_departments 行',
 pg_temp.chk($q$SELECT COALESCE(string_agg(DISTINCT u.department_id,','),'✓ 全部有效') FROM public.ar_users u WHERE u.department_id IS NOT NULL AND NOT EXISTS (SELECT 1 FROM public.ar_departments d WHERE d.id=u.department_id)$q$)),

-- ------------------------------------------------------------ 6 数据健康度
('⑥ 数据健康', '有开票明细的合同数',
 pg_temp.chk($q$SELECT count(DISTINCT ledger_id)::text FROM public.ar_invoices$q$)),
('⑥ 数据健康', '有回款明细的合同数',
 pg_temp.chk($q$SELECT count(DISTINCT ledger_id)::text FROM public.ar_receipts$q$)),
('⑥ 数据健康', '决算金额为空（显示为 —）的台账数',
 pg_temp.chk($q$SELECT count(*)::text FROM public.ar_ledger WHERE final_amount IS NULL$q$)),
('⑥ 数据健康', '挂账时间与最近开票日期不一致的行数',
 pg_temp.chk($q$SELECT count(*)::text FROM public.ar_ledger l JOIN (SELECT ledger_id, MAX(invoice_date) d FROM public.ar_invoices WHERE invoice_date IS NOT NULL GROUP BY ledger_id) i ON i.ledger_id=l.id WHERE l.charge_date IS DISTINCT FROM i.d$q$))

) AS v(grp, item, result);

-- ============================================================================
-- 结果解读（期望值）：
--   ① 行数只做存在性参考，新增库为 0 是正常的
--   ② 「12」列齐 / ar_receipts 已建 / ar-attachments 桶存在 / ar_recalc_charge_date 存在
--      任一项 ✗ 说明对应脚本没跑或没跑成功
--   ③ 最关键是这组：ar_user_perms 应为 4 条 ar_is_admin 策略、旧 is_admin( 残留为 0
--      —— 残留即 v3.2 未生效，报账员权限还会显示不正确
--   ④ 客户属性 15 / 单位 4 / 工作性质 18 / 八大板块 8；残留占位值为 0
--   ⑤ 报账员权限记录缺失为 0（若 >0，多半是页面「保存权限」没执行过）
--   ⑥ 只作数据现状参考：如「挂账时间与最近开票不一致」行数 >0，
--      到「系统设置 → 数据维护 → 重算挂账时间」点一次即可归零
-- ============================================================================
