-- ============================================================================
-- 企业应收账款台账系统 · v3.1 升级脚本（回款明细）
--
-- 需求背景（CONTEXT.md「金额口径 · 回款明细」）：
--   与开票明细对称的逐笔回款登记（日期 / 金额 / 备注），
--   到账金额 = 回款明细合计（前端一键同步），仅财务管理员可维护。
--   核销金额维持累计数，不建明细。
--
-- 幂等：可重复执行。适用环境：
--   ① 云端 Supabase（bttnxyexkbsskmqttbzi）Studio SQL Editor 粘贴运行；
--   ② 腾讯云自托管：ssh ubuntu@IP "sudo docker exec -i supabase-db psql
--      -U supabase_admin -d postgres" < sql/upgrade-v3.1-receipts.sql
-- ============================================================================

-- --------------------------------------------------------------------------
-- 1. ar_receipts 回款明细表（随台账行级联删除）
-- --------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.ar_receipts (
  id           UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  ledger_id    UUID REFERENCES public.ar_ledger(id) ON DELETE CASCADE NOT NULL,
  receipt_date DATE NOT NULL,                                -- 到账日期
  amount       NUMERIC(18,4) NOT NULL CHECK (amount >= 0),   -- 到账金额
  remark       TEXT,                                         -- 备注（选填）
  created_by   UUID REFERENCES auth.users(id),
  created_at   TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_ar_receipts_ledger ON public.ar_receipts(ledger_id);

ALTER TABLE public.ar_receipts ENABLE ROW LEVEL SECURITY;

-- 读：可见性跟随台账行（能看到该行的人能看到回款明细）
DROP POLICY IF EXISTS "ar_receipts_select" ON public.ar_receipts;
CREATE POLICY "ar_receipts_select" ON public.ar_receipts
  FOR SELECT TO authenticated USING (
    EXISTS (SELECT 1 FROM public.ar_ledger l
            WHERE l.id = ar_receipts.ledger_id
              AND public.ar_can_see_row(l.department_id))
  );

-- 写：到账金额属财务字段，仅财务管理员可登记/删除（比开票明细更严：
--     开票允许部门 edit 权限，回款一律 admin）
DROP POLICY IF EXISTS "ar_receipts_insert" ON public.ar_receipts;
CREATE POLICY "ar_receipts_insert" ON public.ar_receipts
  FOR INSERT TO authenticated WITH CHECK (
    public.ar_is_admin()
    AND EXISTS (SELECT 1 FROM public.ar_ledger l WHERE l.id = ledger_id)
  );

DROP POLICY IF EXISTS "ar_receipts_delete" ON public.ar_receipts;
CREATE POLICY "ar_receipts_delete" ON public.ar_receipts
  FOR DELETE TO authenticated USING (public.ar_is_admin());

GRANT SELECT, INSERT, DELETE ON public.ar_receipts TO authenticated;

-- --------------------------------------------------------------------------
-- 2. 开票明细登记权限收紧：统一仅财务管理员（与回款明细一致，2026-09-15 决策）
--    此前 ar_invoices 允许部门账号（有 edit 权限时）登记开票；现统一为仅财务。
--    读策略不变（可见性仍随台账行）。
-- --------------------------------------------------------------------------
DROP POLICY IF EXISTS "ar_invoices_insert" ON public.ar_invoices;
CREATE POLICY "ar_invoices_insert" ON public.ar_invoices
  FOR INSERT TO authenticated WITH CHECK (
    public.ar_is_admin()
    AND EXISTS (SELECT 1 FROM public.ar_ledger l WHERE l.id = ledger_id)
  );

DROP POLICY IF EXISTS "ar_invoices_update" ON public.ar_invoices;
CREATE POLICY "ar_invoices_update" ON public.ar_invoices
  FOR UPDATE TO authenticated USING (public.ar_is_admin());

DROP POLICY IF EXISTS "ar_invoices_delete" ON public.ar_invoices;
CREATE POLICY "ar_invoices_delete" ON public.ar_invoices
  FOR DELETE TO authenticated USING (public.ar_is_admin());

-- ============================================================================
-- 完成。执行后前端「编辑台账」弹窗出现「回款明细」区块（需前端 ≥ v20260915a）。
-- ============================================================================
