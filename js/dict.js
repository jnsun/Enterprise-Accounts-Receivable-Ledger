/**
 * dict.js - 选项字典模块（要求三：蓝色内置可选项，财务可自行编辑）
 *
 * 数据来源：ar_dict 表（财务管理员在「选项管理」页维护）；
 * 表未建 / 无网络 / 类别为空时自动降级为内置默认选项，功能不受影响。
 * 编辑表单中的下拉（select/combo）均从这里取值。
 */

/* 内置默认选项（与 sql/upgrade-v3-indicators.sql 种子一致，作兜底） */
const DICT_BUILTIN = {
  project_status:  ['完工', '施工中', '中止', '取消或作废'],
  final_method:    ['合同金额', '工作量'],
  debt_status:     ['正常', '逾期', '诉讼', '和解'],
  client_attr:     ['国有企业', '民营企业', '政府机关', '事业单位', '其他'],
  comm_method:     ['电话', '上门拜访', '邮件', '微信', '函件+电话', '函件+微信'],
  feedback:        ['承认欠款，但资金紧张', '拒接电话', '对质量提出异议', '正在筹款，近期付',
                   '工程量结算有争议', '承认欠款，要求分期'],
  progress_note:   ['已发送第二次催款函', '停工', '需协商', '已安排对账', '对方提出分期', '移交法务部'],
  next_plan:       ['升级催收手段', '需实地调查', '需核实情况', '跟踪付款进度', '申请财产保全', '提供分期计划'],
  attach_category: ['决算', '中止证明', '其他'],
  unit:            [],
  work_nature:     [],
  sector:          [],
};

const Dicts = {

  cache: {},        // category -> [value, ...]（仅存 ar_dict 中实际存在的）
  dbOk: false,      // ar_dict 表是否可用

  /** 登录后调用：加载全部字典 */
  async load() {
    this.cache = {};
    this.dbOk = false;
    try {
      const { data, error } = await sb.from('ar_dict')
        .select('category, value').order('category').order('sort_order').limit(2000);
      if (!error && data) {
        this.dbOk = true;
        data.forEach(d => {
          (this.cache[d.category] = this.cache[d.category] || []).push(d.value);
        });
      }
    } catch (e) { /* 表未建等情况，静默降级 */ }
  },

  /** 某类别的选项列表（数据库优先，空则用内置默认） */
  get(category) {
    const list = this.cache[category];
    if (list && list.length) return list;
    return DICT_BUILTIN[category] || [];
  },

  /** 类别是否在数据库中有维护（「选项管理」页区分内置/自定义） */
  isManaged(category) {
    return !!(this.cache[category] && this.cache[category].length);
  },
};
