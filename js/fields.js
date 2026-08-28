/**
 * fields.js - 台账字段定义（表格 / 编辑表单 / Excel 导入映射 / 导出 共用）
 *
 * type: text | money | date | select | textarea
 * width: 表格列宽（px）；money/date 列右对齐
 * aliases: Excel 导入时用于自动匹配的候选表头名
 * auto: 自动计算列（不存储、不导入、导出可选）
 */
const FIELD_DEFS = [
  { key: 'contract_no',         label: '合同编号',      type: 'text',   width: 110, aliases: ['合同编号', '编号', '合同号'] },
  { key: 'project_name',        label: '项目名称',      type: 'text',   width: 200, clamp: true, aliases: ['项目名称', '项目', '工程项目'] },
  { key: 'contract_amount',     label: '合同金额',      type: 'money',  width: 92,  aliases: ['合同金额'] },
  { key: 'final_amount',        label: '决算金额',      type: 'money',  width: 92,  aliases: ['决算金额'] },
  { key: 'invoiced_amount',     label: '已开发票金额',  type: 'money',  width: 104, aliases: ['已开发票金额', '开票金额'] },
  { key: 'received_amount',     label: '已到账金额',    type: 'money',  width: 96,  aliases: ['已到账金额', '到账金额', '已回款'] },
  { key: 'receivable_internal', label: '账内应收金额',  type: 'money',  width: 102, aliases: ['账内应收金额', '账内应收'] },
  { key: 'receivable_external', label: '账外应收金额',  type: 'money',  width: 102, aliases: ['账外应收金额', '账外应收'] },
  { key: 'receivable_total',    label: '应收合计',      type: 'money',  width: 96,  aliases: ['应收合计'] },
  { key: 'owner_unit',          label: '甲方单位',      type: 'text',   width: 160, aliases: ['甲方单位', '甲方', '建设单位'],
    datalist: true },
  { key: 'creditor_unit',       label: '债权单位',      type: 'text',   width: 160, aliases: ['债权单位', '乙方单位', '债权方'] },
  { key: 'start_date',          label: '开工日期',      type: 'date',   width: 96,  aliases: ['开工日期'] },
  { key: 'end_date',            label: '完工日期',      type: 'date',   width: 96,  aliases: ['完工日期', '竣工日期'] },
  { key: 'progress',            label: '工程进度',      type: 'select', width: 82,  aliases: ['工程进度', '进度'],
    options: ['未开工', '施工中', '已完工', '已决算'] },
  { key: 'payment_node',        label: '付款节点',      type: 'text',   width: 96,  aliases: ['付款节点', '付款条件'] },
  { key: 'dept_name',           label: '施工部门',      type: 'text',   width: 96,  aliases: ['施工部门', '部门', '施工队'] },
  { key: 'work_nature',         label: '工作性质',      type: 'text',   width: 88,  aliases: ['工作性质', '性质'] },
  { key: 'sector',              label: '八大板块',      type: 'text',   width: 88,  aliases: ['八大板块', '板块'] },
  { key: 'cost_expense',        label: '成本费用',      type: 'money',  width: 88,  aliases: ['成本费用', '成本'] },
  { key: 'dunning_date',        label: '催收/询证日期', type: 'date',   width: 108, aliases: ['催收/询证日期', '催收日期', '询证日期', '催收/询证'] },
  { key: 'dunning_feedback',    label: '催收反馈',      type: 'textarea', width: 120, aliases: ['催收反馈', '反馈'] },
];

// 自动计算列（不对应数据库字段）
const COMPUTED_DEFS = [
  { key: 'receivable_balance', label: '应收余额', type: 'money', width: 96 },
  { key: 'overdue_status',     label: '超期预警', type: 'text',  width: 96 },
];

// 全部列（台账表格渲染顺序：编号/项目 + 金额 + 信息 + 催收 + 计算）
const ALL_FIELDS = FIELD_DEFS.map(f => f.key);

const MONEY_KEYS = FIELD_DEFS.filter(f => f.type === 'money').map(f => f.key);
const DATE_KEYS  = FIELD_DEFS.filter(f => f.type === 'date').map(f => f.key);

// 甲方单位内置常用选项（导入历史数据会自动并入下拉建议）
const OWNER_UNIT_PRESETS = [
  '山西省第十地质工程勘察院',
];

// 工程进度选项
const PROGRESS_OPTIONS = ['未开工', '施工中', '已完工', '已决算'];

// 权限定义（左侧权限栏 + 管理员授权页共用）
const PERM_DEFS = [
  { key: 'view',     label: '查看本部门台账' },
  { key: 'view_all', label: '查看全部台账' },
  { key: 'add',      label: '新增记录' },
  { key: 'edit',     label: '编辑记录' },
  { key: 'delete',   label: '删除记录' },
  { key: 'import',   label: 'Excel 导入' },
  { key: 'export',   label: '导出 Excel' },
];
