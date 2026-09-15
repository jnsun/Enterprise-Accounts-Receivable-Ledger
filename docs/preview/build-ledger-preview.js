#!/usr/bin/env node
/**
 * build-ledger-preview.js - 生成自包含的「台账总览」页预览
 *
 * 用途：把 css/style.css + js/{fields,dict,colprefs,utils,attachments,ledger}.js
 *       内联成单个 HTML，用模拟台账数据渲染真实页面，无需登录、不连数据库。
 *       用于验收冻结列几何、横向滚动穿帮、表头/合计行、空状态等视觉问题。
 *
 * 用法：node docs/preview/build-ledger-preview.js
 * 产物：docs/preview/ledger-preview.html
 *
 * 附加开关（在 URL 后加 hash）：
 *   #scrolled   渲染后把表格横向滚到 320px，检查冻结列是否穿帮
 *   #far        横向滚到最右
 *   #core       启用「仅常用列」（隐藏非核心列），检查窄表下的表现
 *   #empty      清空数据，检查空状态
 *   #nodept     造 3 行"无归属部门"，检查警示色 + 部门下拉「未指定」筛选是否真的生效
 *   #deptzero   复现用户报的「部门筛出来是空的」：默认「未结」+ 该部门记录恰好都已结清
 *   #frozen     把「项目名称/合同编号」冻结到左侧、并打乱列顺序，60 行数据
 *   #many       60 行数据，检查纵向滚动下的表头常驻
 *   #measure    在页面顶部浮层打印冻结列几何 / 表头常驻 / 滚动区归属等测量结果
 *
 * 注：修改 style.css / ledger.js 后需重新运行本脚本。
 */
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..', '..');
const read = f => fs.readFileSync(path.join(ROOT, f), 'utf8');

const css = read('css/style.css');

const mockJs = `
/* ---------- 模拟数据 & 假依赖（仅预览用） ---------- */
const DEPTS = [
  { id: 'd1', name: '财务资产部', sort_order: 0 },
  { id: 'd2', name: '工程物探所', sort_order: 1 },
  { id: 'd3', name: '测绘地理信息院', sort_order: 2 },
  { id: 'd4', name: '地质勘查一分院', sort_order: 3 }
];

const R = (o) => Object.assign({
  department_id: 'd2', charge_date: '2024-06-18', final_method: '合同金额',
  writeoff_amount: 0, remark: '', collector: '翟悟飞', client_attr: '政府部门--省',
  creditor_unit: '物化院', work_nature: '综合物探', sector: '能源资源勘查开发',
  comm_method: '函件+电话', next_plan: '跟踪付款进度'
}, o);

const ROWS = [
  R({ id: 'r1', batch_id: 'b1', contract_no: 'SX2021-018', project_name: '山西省沁水煤田郑庄区块三维地震勘探',
      owner_unit: '山西晋城无烟煤矿业集团有限责任公司', client_attr: '煤矿集团--晋能控股',
      project_status: '完工', debt_status: '逾期', final_amount: 4862000, invoiced_amount: 4862000,
      received_amount: 1200000, writeoff_amount: 0, charge_date: '2024-03-12', dunning_date: '2026-07-02',
      feedback: '承认欠款，但资金紧张', latest_progress: '已发送第二次催款函', collector: '翟悟飞' }),
  R({ id: 'r2', batch_id: 'b1', contract_no: 'SX2022-073', project_name: '大同市云冈区宅基地和农房一体确权登记颁证项目',
      owner_unit: '大同市云冈区自然资源局', client_attr: '政府部门--市',
      project_status: '完工', debt_status: '诉讼', final_amount: 3120500, invoiced_amount: 2800000,
      received_amount: 1500000, charge_date: '2024-09-05', dunning_date: '2026-06-20',
      feedback: '工程量结算有争议', latest_progress: '移交法务部', next_plan: '申请财产保全', work_nature: '房地一体' }),
  R({ id: 'r3', batch_id: null, contract_no: 'SX2023-004', project_name: '临汾市尧都区地质灾害风险调查评价',
      owner_unit: '临汾市规划和自然资源局', client_attr: '政府部门--市',
      project_status: '施工中', debt_status: '正常', final_amount: null, invoiced_amount: 860000,
      received_amount: 600000, charge_date: '2025-11-14', dunning_date: '2026-08-01',
      feedback: '正在筹款，近期付', latest_progress: '已安排对账', next_plan: '跟踪付款进度',
      work_nature: '地灾评估、勘察、设计', sector: '地质灾害治理' }),
  R({ id: 'r4', batch_id: null, contract_no: 'SX2020-116', project_name: '吕梁市离石区煤矸石生态修复治理工程物探',
      owner_unit: '山西焦煤集团岚县正利煤业有限公司', client_attr: '煤矿集团--山西焦煤',
      project_status: '完工', debt_status: '和解', final_amount: 1740000, invoiced_amount: 1740000,
      received_amount: 900000, writeoff_amount: 120000, charge_date: '2023-12-01', dunning_date: '2026-05-09',
      feedback: '承认欠款，要求分期', latest_progress: '需协商', next_plan: '提供分期计划',
      work_nature: '生态修复', sector: '生态保护修复' }),
  R({ id: 'r5', batch_id: 'b2', contract_no: 'SX2024-009', project_name: '运城市盐湖区第三次土壤普查外业采样',
      owner_unit: '运城市农业农村局', client_attr: '政府部门--市',
      project_status: '完工', debt_status: '正常', final_amount: 2360000, invoiced_amount: 2360000,
      received_amount: 2360000, writeoff_amount: 0, charge_date: '2026-01-20', dunning_date: '2026-08-28',
      feedback: '正在筹款，近期付', latest_progress: '已安排对账', collector: '孙勇军',
      work_nature: '土工试验', sector: '实验测试' }),
  R({ id: 'r6', batch_id: null, contract_no: 'SX2019-052', project_name: '长治市潞州区工民建岩土工程勘察（一期）',
      owner_unit: '长治市城市建设开发有限公司', client_attr: '社会客户-省内',
      project_status: '中止', debt_status: '逾期', final_amount: 980000, invoiced_amount: 980000,
      received_amount: 200000, writeoff_amount: 0, charge_date: '2022-08-11', dunning_date: '2026-04-15',
      feedback: '拒接电话', latest_progress: '停工', next_plan: '需实地调查',
      work_nature: '工民建勘察', sector: '工程勘察与施工' }),
  R({ id: 'r7', batch_id: null, contract_no: 'SX2025-031', project_name: '忻州市五台县铁矿资源储量核实物探',
      owner_unit: '五台县兴旺铁矿有限公司', client_attr: '社会客户-省内',
      project_status: '施工中', debt_status: '正常', final_amount: null, invoiced_amount: 420000,
      received_amount: 0, charge_date: '2026-07-30', dunning_date: '', feedback: '',
      latest_progress: '', next_plan: '', work_nature: '综合物探', sector: '能源资源勘查开发',
      collector: '孙勇军' }),
  R({ id: 'r8', batch_id: 'b2', contract_no: 'SX2022-140', project_name: '晋中市榆次区地下管线普查及信息化建设',
      owner_unit: '晋中市城市管理局', client_attr: '政府部门--市',
      project_status: '完工', debt_status: '逾期', final_amount: 5640000, invoiced_amount: 5100000,
      received_amount: 2100000, writeoff_amount: 0, charge_date: '2024-05-27', dunning_date: '2026-07-18',
      feedback: '对质量提出异议', latest_progress: '需协商', next_plan: '升级催收手段',
      work_nature: '其他测绘', sector: '测绘地理信息', department_id: 'd3', creditor_unit: '测绘院' }),
  R({ id: 'r9', batch_id: null, contract_no: 'SX2018-088', project_name: '太原市杏花岭区基础施工降水工程',
      owner_unit: '太原市排水管理处', client_attr: '政府部门--市',
      project_status: '取消或作废', debt_status: '逾期', final_amount: 336000, invoiced_amount: 336000,
      received_amount: 0, writeoff_amount: 0, charge_date: '2021-10-09', dunning_date: '2026-03-02',
      feedback: '拒接电话', latest_progress: '移交法务部', next_plan: '申请财产保全',
      work_nature: '基础施工', sector: '工程勘察与施工', department_id: 'd4' }),
  R({ id: 'r10', batch_id: null, contract_no: 'SX2026-002', project_name: '阳泉市盂县地质灾害隐患点排危除险勘查设计',
      owner_unit: '盂县自然资源局', client_attr: '政府部门--县',
      project_status: '施工中', debt_status: '正常', final_amount: null, invoiced_amount: 150000,
      received_amount: 0, charge_date: '2026-08-25', dunning_date: '', feedback: '',
      latest_progress: '已安排对账', next_plan: '跟踪付款进度', department_id: 'd1',
      work_nature: '报告编写、设计方案', sector: '地质灾害治理' })
];

const ATTACH = {
  r1: { '决算': 2, '中止证明': 1 },
  r2: { '决算': 1 },
  r4: { '中止证明': 3 },
  r6: { '决算': 1, '其他': 2 }
};

/* 最小可用的 PostgREST 链式替身 */
function chain(result) {
  const o = {
    select: () => o, order: () => o, limit: () => o, eq: () => o,
    maybeSingle: () => Promise.resolve(result),
    then: (res, rej) => Promise.resolve(result).then(res, rej)
  };
  return o;
}
/* ar_departments 必须真的回数据：真实环境里 Ledger.init() 就是从这张表取部门字典，
   桩件若一律回 []，init() 会把 departments 覆盖成空 —— 「归属部门」列会全变成
   「未指定」（真实环境同理：该表的 SELECT 若被 RLS 挡住，这一列也会全空）。 */
const sb = {
  from: (t) => chain(t === 'ar_departments'
    ? { data: DEPTS.slice(), error: null }
    : { data: [], error: null }),
};

const Auth = {
  isAdmin: true, isSuperAdmin: true, currentUser: { id: 'u1' }, perms: {},
  can: () => true
};
const App = { navigate() {} };
/* 注意：Editor 由 ledger.js 自己声明（编辑弹窗在同一文件），此处不可重复声明 */
const Importer = { open() {} };
const Exporter = { open() {} };
const Batches = { load() {} };

(async () => {
  // 字典走内置兜底（不连库）；附件计数直接注入
  Attachments.countMap = ATTACH;

  /* 预览页的外壳是固定高度（.preview-shell），而真实的 fitHeight() 按 window.innerHeight
     算 —— 无头截图下视口高度不稳定，每次版面都不一样。这里用同一个公式，
     只把"视口高度"换成外壳高度，其余代码路径完全一致。 */
  const shell = document.querySelector('.preview-shell');
  /* 与真实 fitHeight() 同一思路（见 js/ledger.js）：撤掉内联高度、实测页面顶边，
     不做"视口高 − 顶栏 − 内边距"的算术推导 —— 少算一项就溢出几像素，
     页面就多出一条滚动条。这里只是把"可用高度"从视口换成外壳高度。 */
  Ledger.fitHeight = function () {
    const page = document.getElementById('page-ledger');
    if (!page) return;
    const note = document.querySelector('.preview-note');
    const noteH = note ? note.getBoundingClientRect().height : 0;
    /* 说明栏是预览页专有的，真实系统里没有 —— 先把它从可用高度里扣掉，
       否则"页面没有第二条滚动条"这条断言测的就是假东西。 */
    const avail = document.documentElement.clientHeight - noteH;
    shell.style.setProperty('height', Math.round(avail) + 'px', 'important');
    page.style.height = '';
    const top = page.getBoundingClientRect().top - shell.getBoundingClientRect().top;
    const holder = page.parentElement;
    const padB = parseFloat(getComputedStyle(holder).paddingBottom) || 0;
    const mb = parseFloat(getComputedStyle(page).marginBottom) || 0;
    page.style.height = Math.max(320, Math.round(avail - top - padB - mb)) + 'px';
  };

  /* 组合写法：hash 里带 frozen/many 就是 60 行数据，带 measure 就打印测量，
     带 measure2 就用大字只显示测量（数字能被看准）。 */
  const many = /many|frozen/.test(location.hash);
  const bigMeasure = /measure2/.test(location.hash);
  const doMeasure = /measure/.test(location.hash);

  Ledger.rows = /empty/.test(location.hash) ? [] : ROWS.slice();
  if (many) {              // 造 60 行，验证纵向滚动下的表头/合计条是否常驻
    Ledger.rows = [];
    for (let k = 0; k < 6; k++) {
      ROWS.forEach(r => Ledger.rows.push(Object.assign({}, r, {
        id: r.id + '_' + k, contract_no: r.contract_no + '-' + (k + 1)
      })));
    }
  }
  Ledger.filters.settled = '全部';

  /* #nodept：把前 3 行的部门指到不存在的部门 —— 等价于「导入时部门名没匹配上，落库为 NULL」。
     验证：① 这几行在「归属部门」列以警示色显示「未指定」② 部门下拉的「未指定」
     点下去真的能筛出这几行（旧实现点了不生效，会把全部行列出来）。 */
  /* 注意：本段位于生成器的模板字符串内，注释里不要出现反引号，否则会截断模板。 */
  if (/nodept/.test(location.hash)) {
    /* 两种成因都要覆盖：前 2 行落库为 NULL；第 3 行的部门 id 在字典里查不到。
       两者在界面上都显示「未指定」，也都应能被「未指定」筛出来。 */
    Ledger.rows.slice(0, 2).forEach(r => { r.department_id = null; });
    Ledger.rows[2].department_id = 'd-not-exist';
  }

  /* #deptzero：复现用户报的「部门筛选有问题 —— 点进去是空的」。
     默认「结清状态 = 未结」，而该部门名下的记录恰好都已结清 —— 部门这一维没错，
     是被默认维度挡在外面。期望：部门 chip 变警示色显示 0、下拉里该部门显示 0
     而「全部」显示 9、空状态给出「把『结清状态』放宽到『全部』可看到 1 条」且一点即出。 */
  if (/deptzero/.test(location.hash)) {
    Ledger.filters.settled = '未结';
    const row = Ledger.rows.find(x => x.department_id === 'd3');   // 测绘地理信息院（仅 1 条）
    row.received_amount = row.final_amount;                        // 令其已结清
    Ledger.filters.dept = '测绘地理信息院';
  }

  /* #frozen：把「项目名称 / 合同编号」冻结到左侧，并把「应收余额」提到最前 ——
     同时验证"自定义列顺序"与"自定义冻结列"（顺序被打乱后冻结区仍须是连续前缀）。 */
  if (/frozen/.test(location.hash)) {
    ColPrefs.frozen = ['project_name', 'contract_no'];
    ColPrefs.order = ['receivable_balance', 'project_name', 'contract_no'];
    ColPrefs.normalize();
  }

  if (/core/.test(location.hash)) {
    ColPrefs.hidden = new Set(
      [...FIELD_DEFS, ...COMPUTED_DEFS].map(f => f.key).filter(k => !ColPrefs.coreKeys().includes(k)));
  }

  /* 部门字典由 init() 从 ar_departments 载入（走上面的桩件）—— 这里刻意不再手动赋值，
     否则会掩盖"部门字典没取到"这类真实故障，预览就失真了 */
  await Ledger.init().catch(() => {});
  Ledger.render();

  const wrap = document.querySelector('.table-wrap');
  /* big=true 时清空页面、用大字只显示测量结果 —— 小字浮层的数字在缩略图里容易被看错，
     几何这类"差 1px 就要查"的数据必须能一眼读准。 */
  const overlay = (txt, big) => {
    if (big) {
      document.body.innerHTML = '';
      document.body.style.cssText = 'margin:0;padding:14px;background:#fff';
    }
    const d = document.createElement('pre');
    d.style.cssText = big
      ? 'margin:0;background:#fff;color:#111;font:19px/1.8 monospace;white-space:pre-wrap'
      : 'position:fixed;inset:0 0 auto 0;z-index:9999;margin:0;padding:8px 12px;' +
        'max-height:100%;overflow:hidden;background:#fff;color:#111;' +
        'border-bottom:2px solid #c00;font:11.5px/1.6 monospace;white-space:pre-wrap';
    d.textContent = 'MEASURE>>\\n' + txt;
    document.body.appendChild(d);
  };

  if (wrap) {
    if (/scrolled/.test(location.hash)) wrap.scrollLeft = 320;
    if (/far/.test(location.hash)) wrap.scrollLeft = wrap.scrollWidth;
    if (many) { wrap.scrollLeft = 300; wrap.scrollTop = 260; }
  }

  if (/nodept/.test(location.hash)) {
    const rows = () => document.querySelectorAll('.table-wrap tbody tr');
    const nAll = rows().length;
    const nNoneBefore = document.querySelectorAll('.td-dept.is-none').length;
    /* 部门选项现在在 chip 的下拉里 —— 先点开再点「未指定」 */
    const chip = document.querySelector('.fb-chip[data-dim="dept"]');
    if (chip) chip.click();
    const pop = document.getElementById('fb-pop');
    const capNone = pop && [...pop.querySelectorAll('.capsule')].find(c => c.dataset.val === '未指定');
    if (capNone) capNone.click();
    const nAfter = rows().length;
    const noneAfter = document.querySelectorAll('.td-dept.is-none').length;
    const allAfter = document.querySelectorAll('.td-dept:not(.is-none)').length;
    const sample = document.querySelector('.td-dept.is-none, .td-dept');
    overlay([
      '部门「未指定」选项是否存在: ' + (capNone ? '是 ✓' : '否 ✗（列上出现未指定却没给筛选项）'),
      '点击前 总行数=' + nAll + '  警示色单元格=' + nNoneBefore,
      '点击后 总行数=' + nAfter + '（应为 3，旧实现会等于 ' + nAll + ' = 全部行）',
      '点击后 未指定格=' + noneAfter + '  有部门格=' + allAfter + '（后者应为 0）',
      '筛选断言: ' + (nAfter === 3 && allAfter === 0 ? '通过 ✓' : '不通过 ✗'),
      '警示色: ' + (sample ? getComputedStyle(sample).color + ' italic=' + getComputedStyle(sample).fontStyle : '无样本'),
      '当前 filters.dept=' + JSON.stringify(Ledger.filters.dept),
    ].join('\\n'));
  }

  /* ==========================================================================
     #deptzero —— 用户报的「部门筛选有问题」回归用例
     现象：部门下拉里明明有这一项，点进去却一条都没有。
     根因：默认「结清状态 = 未结」把该部门下已结清的记录挡掉了，而旧胶囊上的
     数字是"这个部门一共几条"，界面完全没提"还有别的条件在叠加"。
     ========================================================================== */
  if (/deptzero/.test(location.hash)) {
    const out = [];
    const rows = () => document.querySelectorAll('.table-wrap tbody tr');
    const chip = () => document.querySelector('.fb-chip[data-dim="dept"]');
    out.push('筛选条高度=' + Math.round(document.querySelector('.filterbar').getBoundingClientRect().height) +
      'px（旧实现 5 行胶囊约 150px+）  toolbar+筛选条=' +
      Math.round(document.querySelector('.toolbar').getBoundingClientRect().height +
        document.querySelector('.filterbar').getBoundingClientRect().height) + 'px');
    out.push('部门 chip 文案=「' + chip().textContent.trim().replace(/\\s+/g, ' ') + '」 class=' + chip().className);
    out.push('① 选中项筛不出记录时 chip 是否变警示色: ' + (chip().classList.contains('is-zero') ? '是 ✓' : '否 ✗'));
    out.push('② 选中「已结清」的部门后表格行数=' + rows().length + '（旧实现到这里就"一片空白"）');

    chip().click();
    const pop = document.getElementById('fb-pop');
    const opts = [...pop.querySelectorAll('.capsule')].map(c =>
      c.textContent.trim().replace(/\\s+/g, '') + (c.classList.contains('active') ? '←当前' : ''));
    out.push('③ 部门下拉（数字=在当前「未结」下真能筛出几条）: ' + opts.join(' / '));
    Ledger.closeDimPop();

    const es = document.querySelector('.empty-state');
    const rel = es && es.querySelector('[data-act="relax"]');
    const allRel = es ? [...es.querySelectorAll('[data-act="relax"]')] : [];
    out.push('④ 空状态标题=「' + (es ? es.querySelector('.es-title').textContent : '无') + '」');
    out.push('   放行建议共 ' + allRel.length + ' 条：' +
      (allRel.length ? allRel.map(b => '「' + b.textContent.trim() + '」').join(' / ')
                     : '（没有 —— 用户只能自己猜是哪一项挡住的）'));
    out.push('   首选按钮=「' + (rel ? rel.textContent.trim() : '无') + '」');
    const before = rows().length;
    /* relaxno：只看空状态面板长什么样，不要点下去 —— 点完就只剩表格，看不到面板 */
    if (rel && !/relaxno/.test(location.hash)) rel.click();
    const after = rows().length;
    out.push('⑤ 点一下首选按钮: 行数 ' + before + ' → ' + after +
      '  结清状态=' + Ledger.filters.settled + '  部门=' + Ledger.filters.dept);
    /* 期望：首选建议必须是「放宽结清状态 → 1 条」而不是「放宽部门 → 8 条」。
       前者说明"你要的这条在，只是被默认条件挡住"；后者会让用户以为部门筛坏了。 */
    out.push('结果: ' + (before === 0 && after === 1 && Ledger.filters.settled === '全部'
      ? '通过 ✓（部门没错，松开的正是挡住它的那一维）'
      : '不通过 ✗'));
    /* 带 measure2 时用大字只显示这段 —— 0→? 这类关键数字在小字浮层里常被看错 */
    overlay(out.join('\\n'), bigMeasure);
  }

  /* deptzero 自己就会 overlay（大字模式下清空页面），此时不必再跑几何测量 */
  if (doMeasure && wrap && !/deptzero/.test(location.hash)) {
    const t = wrap.querySelector('table');
    /* 测量一律从自然位置（scrollLeft=0）开始，否则 dump 出来的 x 会带上滚动偏移，
       读的人（包括我自己）很容易把它误判成"冻结列偏移错了"。 */
    wrap.scrollLeft = 0; wrap.scrollTop = 0;
    const box = el => {
      const r = el.getBoundingClientRect();
      return 'x' + Math.round(r.left) + ' w' + Math.round(r.width);
    };
    const bg = el => (el ? getComputedStyle(el).backgroundColor.replace(/^rgba?\(|\)$/g, '') : 'null');
    const row1 = t.querySelectorAll('tbody tr')[0];
    const head = [...t.querySelectorAll('thead th')].slice(0, 4).map(e =>
      (e.textContent.trim() || '☑') + ' ' + box(e));
    const body = [...row1.children].slice(0, 4).map(box);
    const act = [...row1.children].slice(-1).map(e => '操作 ' + box(e));
    const foot = [...t.querySelectorAll('tfoot td')].slice(0, 3).map(box);
    /* 关键：区分「自然位置」与「吸附位置」。
       sticky 元素在 scrollLeft=0 时停在自然位置；只有滚动超过阈值才会被吸附。
       所以必须同时打印容器与表格自身的左边界，否则会把自然位置误读成穿帮。 */
    const cls = e => (String(e.className).trim() || '-');
    const dump = (list, n) => [...list].slice(0, n)
      .map((e, i) => i + ':' + cls(e) + ' ' + box(e)).join(' | ');
    const widths = sel => [...t.querySelectorAll(sel)].map(e => Math.round(e.getBoundingClientRect().width));
    const uniq = a => [...new Set(a)];
    const ck = widths('.col-check'), ix = widths('.col-idx');
    const txt = [
      /* 自然位置基准：wrap 左边界 / 表格自身左边界。
         scrollLeft=0 时冻结列就停在自然位置，x 不相等是正常的，不算穿帮。 */
      'base  wrap' + box(wrap) + '  table' + box(t) + '  scrollLeft=' + wrap.scrollLeft,
      'THn   ' + dump(t.querySelectorAll('thead th'), 6),
      'TDn   ' + dump(row1.children, 6),
      'TH    ' + head.join(' | '),
      'TD1   ' + body.join(' | '),
      'ACT   ' + act.join(' | '),
      'FOOT  ' + foot.join(' | '),
      'col-check 宽度集合 ' + JSON.stringify(uniq(ck)) + '（应恒为 [36]）',
      'col-idx   宽度集合 ' + JSON.stringify(uniq(ix)) + '（应恒为 [40]）',
      '冻结区右边界 x=' + Math.round(t.querySelector('tbody td.col-idx').getBoundingClientRect().right) +
        '  下一列左边界 x=' + Math.round(row1.children[2].getBoundingClientRect().left) +
        '  → 间隙 ' + (row1.children[2].getBoundingClientRect().left -
        t.querySelector('tbody td.col-idx').getBoundingClientRect().right).toFixed(1) + 'px（应为 0）',
      'table scrollW=' + t.scrollWidth + ' clientW=' + t.clientWidth +
        ' | wrap scrollW=' + wrap.scrollWidth + ' clientW=' + wrap.clientWidth +
        ' scrollH=' + wrap.scrollHeight + ' clientH=' + wrap.clientHeight,
      'wrap scrollLeft=' + wrap.scrollLeft + ' max=' + (wrap.scrollWidth - wrap.clientWidth) +
        ' | class="' + wrap.className + '"',
      /* 自检：滚动水位类名是否随位置正确切换（决定冻结列/操作列的投影）。
         注意 scroll 事件是异步派发的，这里必须显式调一次 syncOverflow，
         否则读到的是滚动前的旧类名。 */
      (function () {
        const snap = () => { Ledger.syncOverflow(); return wrap.className; };
        wrap.scrollLeft = 0;   const at0 = snap();
        wrap.scrollLeft = 320; const at320 = snap();
        wrap.scrollLeft = wrap.scrollWidth; const atEnd = snap();
        wrap.scrollLeft = 0; snap();
        return 'class 随滚动位置 —— 0:[' + at0 + '] 320:[' + at320 + '] 末端:[' + atEnd + ']';
      })(),
      /* 配色核对：直接读计算值，比截图取色可靠 */
      'backgroundColor —— 表头=' + bg(t.querySelector('thead th[data-sort]')) +
        ' 冻结表头=' + bg(t.querySelector('thead th.col-idx')) +
        ' 普通行=' + bg(t.querySelector('tbody tr:nth-child(3) td:nth-child(3)')) +
        ' 斑马行=' + bg(t.querySelector('tbody tr:nth-child(4) td:nth-child(3)')) +
        ' 合计行=' + bg(t.querySelector('tfoot td:nth-child(2)')),

      /* ---------- 本次三项诉求的硬指标 ---------- */
      '① 滚动区归属 —— 页面 documentElement scrollH=' + document.documentElement.scrollHeight +
        ' clientH=' + document.documentElement.clientHeight +
        ' → ' + (document.documentElement.scrollHeight <= document.documentElement.clientHeight + 1
          ? '页面没有第二条滚动条 ✓' : '页面出现了滚动条 ✗（超出 ' +
            (document.documentElement.scrollHeight - document.documentElement.clientHeight) + 'px）'),
      /* 溢出时把高度账目逐项摊开 —— 算术推导漏了哪一项，看这行就知道 */
      (function () {
        const sh = document.querySelector('.preview-shell');
        const nt = document.querySelector('.preview-note');
        const pg = document.getElementById('page-ledger');
        const sd = document.querySelector('.sidebar');
        const cs = getComputedStyle(sh);
        return '   高度账目 —— 视口=' + document.documentElement.clientWidth +
          '×' + document.documentElement.clientHeight +
          ' innerH=' + window.innerHeight + ' innerW=' + window.innerWidth +
          ' | 说明栏=' + (nt ? Math.round(nt.getBoundingClientRect().height) : 0) +
          ' 外壳 rect=' + Math.round(sh.getBoundingClientRect().height) +
          '(inline=' + (sh.style.height || '—') +
          ' computed=' + cs.height + ' minH=' + cs.minHeight + ' boxS=' + cs.boxSizing +
          ' padB=' + cs.paddingBottom + ' borB=' + cs.borderBottomWidth + ' overflow=' + cs.overflow + ')' +
          ' | 侧栏 rect=' + Math.round(sd.getBoundingClientRect().height) +
          ' | 页面顶边=' + Math.round(pg.getBoundingClientRect().top) +
          ' 页高=' + (pg.style.height || '—') +
          ' 内边距下=' + Math.round(parseFloat(getComputedStyle(pg.parentElement).paddingBottom) || 0) +
          ' 页面 margin-bottom=' + Math.round(parseFloat(getComputedStyle(pg).marginBottom) || 0) +
          ' | body scrollW=' + document.body.scrollWidth + ' rect=' +
          Math.round(document.body.getBoundingClientRect().height) +
          '\\n   实验 —— style属性=「' + (sh.getAttribute('style') || '') + '」' +
          ' | 侧栏 computed=' + getComputedStyle(sd).height +
          ' | 100vh=' + (function () {
            const d = document.createElement('div');
            d.style.cssText = 'position:absolute;top:0;left:0;width:0;height:100vh';
            document.body.appendChild(d);
            const h = Math.round(d.getBoundingClientRect().height);
            d.remove();
            return h;
          })();
      })(),
      '   表格卡片 scrollH=' + wrap.scrollHeight + ' clientH=' + wrap.clientHeight +
        ' → ' + (wrap.scrollHeight > wrap.clientHeight + 1 ? '卡片内滚动 ✓（表头常驻的前提）' : '（数据不足以产生滚动）'),
      (function () {
        const th = t.querySelector('thead th[data-sort]');
        const wTop = Math.round(wrap.getBoundingClientRect().top);
        wrap.scrollTop = 0;   const a = Math.round(th.getBoundingClientRect().top);
        wrap.scrollTop = 240; const b = Math.round(th.getBoundingClientRect().top);
        wrap.scrollTop = 0;
        return '② 表头常驻 —— wrap 顶缘 y=' + wTop + '；表头 th 顶缘 滚0=' + a + ' 滚240=' + b +
          ' → ' + (Math.abs(a - b) <= 1 ? '表头纹丝不动 ✓' : '表头跟着滚走了 ✗（Δ=' + (b - a) + '）');
      })(),
      '③ 筛选区高度 —— 筛选条=' + Math.round(document.querySelector('.filterbar').getBoundingClientRect().height) +
        'px（旧实现 5 行胶囊约 150px+） toolbar=' +
        Math.round(document.querySelector('.toolbar').getBoundingClientRect().height) + 'px' +
        ' | 台账页=' + Math.round(document.getElementById('page-ledger').getBoundingClientRect().height) +
        'px 表格卡片=' + Math.round(wrap.getBoundingClientRect().height) + 'px',
      (function () {
        const rd = v => Math.round(v * 100) / 100;
        const hdr = [...t.querySelectorAll('thead tr')[0].children];
        const isFz = e => e.classList.contains('col-check') || e.classList.contains('col-idx') ||
          e.classList.contains('is-frozen');
        const fzHdr = hdr.filter(isFz);
        /* 精确到 0.01px：冻结列必须首尾相接，缝 = 后一列 left − 前一列 right（应为 0） */
        const precise = fzHdr.map(e => {
          const r = e.getBoundingClientRect();
          const st = getComputedStyle(e);
          return (e.textContent.trim().slice(0, 6) || '☑') + ' [' + rd(r.left) + ',' + rd(r.right) + ']' +
            ' w=' + rd(r.width) + ' css(left=' + st.left + ' width=' + st.width +
            ' min=' + st.minWidth + ' max=' + st.maxWidth + ')';
        });
        const slit = [];
        for (let i = 1; i < fzHdr.length; i++) {
          slit.push(rd(fzHdr[i].getBoundingClientRect().left - fzHdr[i - 1].getBoundingClientRect().right));
        }
        const csT = getComputedStyle(t);
        /* 滚到中间：冻结列应贴住容器左缘、彼此无缝隙。
           基准取【内容区左缘】= wrap 左缘 + 左边框(1px)，否则会把那 1px 边框
           当成"冻结列偏移了 1px"。 */
        const refLeft = wrap.getBoundingClientRect().left + wrap.clientLeft;
        wrap.scrollLeft = 400;
        const row0 = [...t.querySelectorAll('tbody tr')[0].children].filter(isFz);
        const gaps = [];
        for (let i = 1; i < row0.length; i++) {
          gaps.push(rd(row0[i].getBoundingClientRect().left - row0[i - 1].getBoundingClientRect().right));
        }
        const firstΔ = rd(row0[0].getBoundingClientRect().left - refLeft);
        const bad = slit.concat(gaps).filter(g => Math.abs(g) > 0.6);
        wrap.scrollLeft = 0;
        return '④ 冻结列 —— ' + precise.join('  ') +
          '\\n   border-spacing=' + csT.borderSpacing + ' table-layout=' + csT.tableLayout +
          '  表头相邻缝=[' + slit.join(', ') + ']' +
          '\\n   滚到 400：首列相对内容区左缘 Δ=' + firstΔ + '（应为 0）' +
          '  行内相邻缝=[' + gaps.join(', ') + '] → ' +
          (Math.abs(firstΔ) < 0.6 && !bad.length ? '无穿帮 ✓' : '有缝/偏移 ✗');
      })(),
      '⑤ 列顺序 —— ' + [...t.querySelectorAll('thead th')].map(e => e.textContent.trim() || '☑').slice(0, 8).join(' | ')
    ].join('\\n');
    overlay(txt, bigMeasure);
  }

  document.title = '台账总览预览 · 已渲染';
  document.body.dataset.ready = '1';
})();
`;

const html = `<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>台账总览预览 · 企业应收账款台账系统</title>
<style>
${css}
/* —— 预览页专属，不属于产品样式 —— */
body { margin: 0; padding: 0; background: var(--surface-2); }
.preview-note {
  padding: 7px 18px; font-size: 12px; line-height: 1.7;
  background: oklch(96% 0.03 258); color: oklch(38% 0.09 258);
  border-bottom: 1px solid oklch(86% 0.065 258);
}
.preview-note b { font-weight: 600; }
.preview-note code { background: oklch(93% 0.02 258); padding: 1px 4px; border-radius: 3px; }
/* 与外层真实骨架一致：整页固定一屏（固定高度而非 100vh——无头截图下
   视口高度不稳定，会让"表格吃掉剩余高度"的版面每次都不同）。
   注意：这里**不能**再写 height（旧版写了 900px），否则会和下面按实测
   写进来的内联高度打架，"页面没有第二条滚动条"这条断言就测不准了。 */
.preview-shell { min-height: 0; overflow: hidden; }
.preview-shell .sidebar { height: 100%; }
.preview-shell .page-container { height: 100%; min-height: 0; }
</style>
</head>
<body>
<div class="preview-note">
  <b>台账总览页视觉预览</b> · 模拟台账数据，不连数据库 ·
  与真实系统同源：<code>css/style.css</code> + <code>js/ledger.js</code> ·
  <code>#scrolled</code> 横向滚到中间 · <code>#far</code> 滚到最右 · <code>#core</code> 仅常用列 ·
  <code>#empty</code> 空状态 · <code>#nodept</code> 无归属部门 · 
  <code>#deptzero</code> 部门筛出 0 条（默认「未结」挡住） · <code>#frozen</code> 自定义冻结列+列顺序 ·
  <code>#many</code> 60 行（纵向滚动） · <code>#measure</code> 打印几何测量
</div>
<div class="app-shell preview-shell">
  <aside class="sidebar">
    <div class="side-brand">企业应收账款<br>台账系统</div>
    <nav class="side-nav">
      <button class="nav-item"><span class="nav-icon" aria-hidden="true">▦</span><span>数据看板</span></button>
      <button class="nav-item active" aria-current="page"><span class="nav-icon" aria-hidden="true">▤</span><span>台账总览</span></button>
      <button class="nav-item"><span class="nav-icon" aria-hidden="true">⇪</span><span>Excel 导入</span></button>
      <button class="nav-item"><span class="nav-icon" aria-hidden="true">☰</span><span>导入批次管理</span></button>
      <button class="nav-item"><span class="nav-icon" aria-hidden="true">⚿</span><span>用户管理</span></button>
      <button class="nav-item"><span class="nav-icon" aria-hidden="true">◈</span><span>选项管理</span></button>
      <button class="nav-item"><span class="nav-icon" aria-hidden="true">⚙</span><span>系统设置</span></button>
    </nav>
  </aside>
  <div class="app-main">
    <header class="topbar">
      <div class="topbar-left"><div class="topbar-title">台账总览</div></div>
      <div class="topbar-user">
        <span class="user-dept">财务资产部</span><span class="user-name">韩志远</span>
        <button class="btn btn-xs">修改密码</button><button class="btn btn-xs">退出</button>
      </div>
    </header>
    <main class="page-container">
      <section id="page-ledger" class="page"></section>
    </main>
  </div>
</div>
<script>${read('js/fields.js')}</script>
<script>${read('js/dict.js')}</script>
<script>${read('js/colprefs.js')}</script>
<script>${read('js/utils.js')}</script>
<script>${read('js/attachments.js')}</script>
<script>${read('js/ledger.js')}</script>
<script>${mockJs}</script>
</body>
</html>
`;

const out = path.join(__dirname, 'ledger-preview.html');
fs.writeFileSync(out, html, 'utf8');
console.log(`已生成 ${path.relative(ROOT, out)}（${(html.length / 1024).toFixed(1)} KB）`);
