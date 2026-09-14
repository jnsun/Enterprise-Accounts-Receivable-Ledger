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
  ('client_attr', '国有企业', 1),
  ('client_attr', '民营企业', 2),
  ('client_attr', '政府机关', 3),
  ('client_attr', '事业单位', 4),
  ('client_attr', '其他', 5),
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
