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
 *   #core       启用「仅常用列」（隐藏非核心列），检查窄表下的表现
 *   #empty      清空数据，检查空状态
 *   #nodept     造 3 行"无归属部门"，检查警示色 + 部门胶囊「未指定」筛选是否真的生效
 *   #measure    在页面顶部浮层打印冻结列几何测量结果
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

  Ledger.rows = location.hash === '#empty' ? [] : ROWS.slice();
  if (location.hash === '#many') {              // 造 60 行，验证纵向滚动下的表头/合计条冻结
    Ledger.rows = [];
    for (let k = 0; k < 6; k++) {
      ROWS.forEach((r, i) => Ledger.rows.push(Object.assign({}, r, {
        id: r.id + '_' + k, contract_no: r.contract_no + '-' + (k + 1)
      })));
    }
  }
  Ledger.filters.settled = '全部';

  /* #nodept：把前 3 行的 department_id 指到一个不存在的部门 id —— 等价于
     「导入时部门名没匹配上，落库为 NULL」。验证两件事：
       ① 这几行在「归属部门」列以警示色显示「未指定」（.td-dept.is-none）
       ② 部门胶囊里的「未指定」点下去真的能筛出这几行
     后者原先点了不生效：'未指定' 在部门字典里查不到 → deptId 为 undefined →
     旧判据（deptId && 声明）当成了"不做筛选"，于是列出全部行。 */
  /* 注意：本段位于生成器的模板字符串内，注释里不要出现反引号，否则会截断模板。 */
  if (location.hash === '#nodept') {
    /* 两种成因都要覆盖：前 2 行落库为 NULL；第 3 行的部门 id 在字典里查不到。
       两者在界面上都显示「未指定」，也都应能被「未指定」胶囊筛出来。 */
    Ledger.rows.slice(0, 2).forEach(r => { r.department_id = null; });
    Ledger.rows[2].department_id = 'd-not-exist';
  }

  if (location.hash === '#core') {
    ColPrefs.hidden = new Set(
      [...FIELD_DEFS, ...COMPUTED_DEFS].map(f => f.key).filter(k => !ColPrefs.coreKeys().includes(k)));
  }

  /* 部门字典由 init() 从 ar_departments 载入（走上面的桩件）—— 这里刻意不再手动赋值，
     否则会掩盖"部门字典没取到"这类真实故障，预览就失真了 */
  await Ledger.init().catch(() => {});
  Ledger.render();

  const wrap = document.querySelector('.table-wrap');

  if (wrap) {
    if (location.hash === '#scrolled') wrap.scrollLeft = 320;
    if (location.hash === '#far') wrap.scrollLeft = wrap.scrollWidth;
    if (location.hash === '#many') { wrap.scrollLeft = 300; wrap.scrollTop = 260; }
  }

  if (location.hash === '#nodept') {
    const rows = () => document.querySelectorAll('.table-wrap tbody tr');
    const nAll = rows().length;
    const capNone = document.querySelector('.capsule[data-group="dept"][data-val="未指定"]');
    const nNoneBefore = document.querySelectorAll('.td-dept.is-none').length;
    if (capNone) capNone.click();
    const nAfter = rows().length;
    const noneAfter = document.querySelectorAll('.td-dept.is-none').length;
    const allAfter = document.querySelectorAll('.td-dept:not(.is-none)').length;
    const sample = document.querySelector('.td-dept.is-none, .td-dept');
    const txt = [
      '部门胶囊「未指定」是否存在: ' + (capNone ? '是 ✓' : '否 ✗（列上出现未指定却没给筛选项）'),
      '点击前 总行数=' + nAll + '  警示色单元格=' + nNoneBefore,
      '点击后 总行数=' + nAfter + '（应为 3，原先会等于 ' + nAll + ' = 全部行）',
      '点击后 未指定格=' + noneAfter + '  有部门格=' + allAfter + '（后者应为 0）',
      '筛选断言: ' + (nAfter === 3 && allAfter === 0 ? '通过 ✓' : '不通过 ✗'),
      '警示色: ' + (sample ? getComputedStyle(sample).color + ' italic=' + getComputedStyle(sample).fontStyle : '无样本'),
      '当前 filters.dept=' + JSON.stringify(Ledger.filters.dept),
    ];
    const d = document.createElement('pre');
    d.style.cssText = 'position:fixed;inset:0 0 auto 0;z-index:9999;margin:0;padding:8px 10px;' +
      'background:#fff;color:#111;border-bottom:2px solid #c00;font:15px/1.5 monospace;white-space:pre;overflow-x:auto';
    d.textContent = 'MEASURE>>\\n' + txt.join('\\n');
    document.body.appendChild(d);
  }

  if (location.hash === '#measure' && wrap) {
    const t = wrap.querySelector('table');
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
      'base  wrap' + box(wrap) + '  table' + box(t),
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
      'body 高度=' + document.body.scrollHeight + '（应≈视口高度，页面不该出现第二条滚动条）'
    ].join('\\n');
    const d = document.createElement('pre');
    d.style.cssText = 'position:fixed;inset:0 0 auto 0;z-index:9999;margin:0;padding:8px 12px;' +
      'max-height:100%;overflow:hidden;' +
      'background:#fff;color:#111;border-bottom:2px solid #c00;font:11px/1.65 monospace;white-space:pre-wrap';
    d.textContent = 'MEASURE>>\\n' + txt;
    document.body.appendChild(d);
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
   视口高度不稳定，会让"表格吃掉剩余高度"的版面每次都不同） */
.preview-shell { height: 900px; min-height: 0; overflow: hidden; }
.preview-shell .sidebar { height: 100%; }
.preview-shell .page-container { height: 100%; min-height: 0; }
</style>
</head>
<body>
<div class="preview-note">
  <b>台账总览页视觉预览</b> · 模拟台账数据，不连数据库 ·
  与真实系统同源：<code>css/style.css</code> + <code>js/ledger.js</code> ·
  <code>#scrolled</code> 横向滚到中间 · <code>#far</code> 滚到最右 · <code>#core</code> 仅常用列 ·
  <code>#empty</code> 空状态 · <code>#nodept</code> 无归属部门 + 「未指定」筛选 · <code>#measure</code> 打印几何测量
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
        <span class="user-dept">财务资产部</span><span class="user-name">孙晋宁</span>
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
