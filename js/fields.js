/**
 * fields.js - 台账字段定义（新指标体系 v3，依据《应收系统统计指标.xlsx》28 列）
 *
 * 台账表格 / 编辑表单 / Excel 导入映射 / 导出 共用。
 *
 * type: text | money | date | select | combo | textarea
 *   - select: 下拉选择（dict 指定 ar_dict 类别；freeOther=true 时带「其他」自由填写）
 *   - combo : 可输可选（datalist，dict 选项作建议，允许自由输入）
 * width: 表格列宽（px）；money/date 列右对齐
 * aliases: Excel 导入时用于自动匹配的候选表头名
 * dict: 选项字典类别（ar_dict.category，选项可由财务管理员在「选项管理」页编辑）
 * deptEditable: 实体部门（非管理员）可编辑（要求五：仅催收跟踪类字段）
 *
 * 自动计算口径（要求：账内应收 = 开票金额 − 到账金额；账外应收 = 决算金额 − 开票金额）：
 *   receivable_internal / receivable_external / receivable_balance 均为虚拟计算列，不入库。
 *
 * 旧版字段（合同金额/开工完工日期/工程进度/付款节点/成本费用/应收合计/催收反馈等）
 * 数据库保留、界面隐藏，需要时可随时恢复。
 */

const FIELD_DEFS = [
  /* ---- 基本信息 ---- */
  { key: 'contract_no',    label: '合同编号',     type: 'text',   width: 110, aliases: ['合同编号', '编号', '合同号'] },
  { key: 'project_name',   label: '项目名称',     type: 'text',   width: 200, clamp: true, aliases: ['项目名称', '项目', '工程项目'] },
  { key: 'owner_unit',     label: '客户名称',     type: 'text',   width: 170, aliases: ['客户名称', '甲方单位', '甲方', '建设单位'], datalist: true },
  { key: 'client_attr',    label: '客户属性',     type: 'select', width: 96,  dict: 'client_attr', freeOther: true, aliases: ['客户属性'] },
  { key: 'creditor_unit',  label: '单位',         type: 'combo',  width: 130, dict: 'unit', aliases: ['单位', '债权单位', '乙方单位'] },
  { key: 'work_nature',    label: '工作性质',     type: 'combo',  width: 96,  dict: 'work_nature', aliases: ['工作性质', '性质'] },
  { key: 'sector',         label: '八大板块',     type: 'combo',  width: 96,  dict: 'sector', aliases: ['八大板块', '板块'] },

  /* ---- 状态与金额 ---- */
  { key: 'project_status', label: '项目状态',     type: 'select', width: 88,  dict: 'project_status', freeOther: true,
    deptEditable: true, aliases: ['项目状态', '工程进度'] },
  { key: 'final_method',   label: '决算方式',     type: 'select', width: 92,  dict: 'final_method', freeOther: true,
    deptEditable: true, aliases: ['决算方式'] },
  { key: 'charge_date',    label: '最新挂账时间', type: 'date',   width: 108, aliases: ['最新挂账时间', '挂账时间', '挂账日期'] },
  { key: 'final_amount',   label: '决算金额',     type: 'money',  width: 92,  aliases: ['决算金额'] },
  { key: 'invoiced_amount',label: '开票金额',     type: 'money',  width: 92,  aliases: ['开票金额', '已开发票金额'] },
  { key: 'received_amount',label: '到账金额',     type: 'money',  width: 92,  aliases: ['到账金额', '已到账金额', '已回款'] },
  { key: 'writeoff_amount',label: '核销金额',     type: 'money',  width: 92,  aliases: ['核销金额', '核销'] },

  /* ---- 债权与催收（实体部门可编辑区） ---- */
  { key: 'debt_status',    label: '债权状态',     type: 'select', width: 88,  dict: 'debt_status', freeOther: true,
    deptEditable: true, aliases: ['债权状态'] },
  { key: 'collector',      label: '清收责任人',   type: 'text',   width: 100,
    deptEditable: true, aliases: ['清收责任人', '责任人'] },
  { key: 'dunning_date',   label: '最新催收时间', type: 'date',   width: 108,
    deptEditable: true, aliases: ['最新催收时间', '催收时间', '催收/询证日期', '催收日期', '询证日期'] },
  { key: 'comm_method',    label: '沟通方式',     type: 'select', width: 104, dict: 'comm_method', freeOther: true,
    deptEditable: true, aliases: ['沟通方式'] },
  { key: 'feedback',       label: '对方反馈',     type: 'select', width: 150, dict: 'feedback', freeOther: true,
    deptEditable: true, aliases: ['对方反馈', '反馈'] },
  { key: 'latest_progress',label: '最新进展',     type: 'select', width: 140, dict: 'progress_note', freeOther: true,
    deptEditable: true, aliases: ['最新进展', '进展'] },
  { key: 'next_plan',      label: '下一步计划',   type: 'select', width: 130, dict: 'next_plan', freeOther: true,
    deptEditable: true, aliases: ['下一步计划', '计划'] },
  { key: 'remark',         label: '备注',         type: 'textarea', width: 150, aliases: ['备注'] },
];

/* 自动计算列（不对应数据库字段，前端实时计算） */
const COMPUTED_DEFS = [
  { key: 'receivable_internal', label: '账内应收金额', type: 'money', width: 102, formula: '= 开票 − 到账' },
  { key: 'receivable_external', label: '账外应收金额', type: 'money', width: 102, formula: '= 决算 − 开票' },
  { key: 'receivable_balance',  label: '应收余额',     type: 'money', width: 96,  formula: '= 决算 − 到账 − 核销' },
  { key: 'attach_summary',      label: '附件类别及数量', type: 'text',  width: 130 },
];

const ALL_FIELDS = FIELD_DEFS.map(f => f.key);

const MONEY_KEYS = FIELD_DEFS.filter(f => f.type === 'money').map(f => f.key);

/* 编辑表单分组（要求一：一个项目一个界面，按业务分区展示全部要素） */
const FORM_GROUPS = [
  { key: 'base',    label: '基本信息', fields: ['contract_no', 'project_name', 'owner_unit', 'client_attr', 'creditor_unit', 'work_nature', 'sector'] },
  { key: 'finance', label: '状态与金额', fields: ['project_status', 'final_method', 'charge_date', 'final_amount', 'invoiced_amount', 'received_amount', 'writeoff_amount'] },
  { key: 'dunning', label: '债权与催收', fields: ['debt_status', 'collector', 'dunning_date', 'comm_method', 'feedback', 'latest_progress', 'next_plan', 'remark'] },
];

/* 字典类别定义（「选项管理」页展示顺序与说明） */
const DICT_CATEGORIES = [
  { key: 'project_status',  label: '项目状态' },
  { key: 'final_method',    label: '决算方式' },
  { key: 'debt_status',     label: '债权状态' },
  { key: 'client_attr',     label: '客户属性' },
  { key: 'comm_method',     label: '沟通方式' },
  { key: 'feedback',        label: '对方反馈' },
  { key: 'progress_note',   label: '最新进展' },
  { key: 'next_plan',       label: '下一步计划' },
  { key: 'attach_category', label: '附件类别' },
  { key: 'unit',            label: '单位（债权单位）' },
  { key: 'work_nature',     label: '工作性质' },
  { key: 'sector',          label: '八大板块' },
];

/* 客户名称建议（内置 + 库内历史值自动并入 datalist） */
const OWNER_UNIT_PRESETS = [
  '山西省第十地质工程勘察院',
];

/* 权限定义（左侧权限栏 + 管理员授权页共用） */
const PERM_DEFS = [
  { key: 'view',     label: '查看本部门台账' },
  { key: 'view_all', label: '查看全部台账' },
  { key: 'add',      label: '新增记录' },
  { key: 'edit',     label: '编辑记录' },
  { key: 'delete',   label: '删除记录' },
  { key: 'import',   label: 'Excel 导入' },
  { key: 'export',   label: '导出 Excel' },
];

/* 标签颜色映射（表格中状态列的胶囊配色） */
const TAG_COLORS = {
  '完工': 'tag-green', '施工中': 'tag-blue', '中止': 'tag-orange', '取消或作废': 'tag-gray',
  '正常': 'tag-green', '逾期': 'tag-overdue', '诉讼': 'tag-red', '和解': 'tag-teal',
};
