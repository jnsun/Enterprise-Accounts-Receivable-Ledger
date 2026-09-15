/**
 * mock-data.js - 看板预览用的模拟数据与最小桩件（不连数据库、不发请求）
 *
 * 供 docs/preview/build-dashboard-preview.js 内联进自包含预览页，
 * 目的是让「数据看板」在没有真实账号 / 数据的情况下也能完整渲染出来做视觉验收。
 * 数据为确定性伪随机（同一种子每次一致），仅用于看版面与字号。
 */

/* —— 与真实字典同源的取值 —— */
const PREVIEW_DEPTS = ['地调所', '地勘分院', '岩土所', '地灾所', '实验室', '禹地公司', '资环所', '测绘院太原分院', '大地测绘中心', '工程测绘中心', '遥感中心', '大数据中心', '测绘咨询中心', '晋城分院', '能源所', '地震物探', '工程物探所', '综合研究所', '广州分院', '电磁所', '碳中和', '矿产咨询', '六勘院太原分院', '一测', '二测', '综勘三', '原物探/太原', '翟悟飞', '孙勇军', '其他'];
const PREVIEW_UNITS = ['物化院', '六勘院', '测绘院', '禹地公司'];
const PREVIEW_ATTRS = ['内部单位', '政府部门--省', '政府部门--市', '政府部门--县', '政府部门--县以下', '煤矿集团--晋能控股', '煤矿集团--山西焦煤', '煤矿集团--潞安化工', '煤矿集团--华阳新材', '煤矿集团--华新燃气', '煤矿集团--其他煤矿', '社会客户-省内', '社会客户-省外', '社会客户-海外', '其他'];
const PREVIEW_NATURES = ['二、三维地震', '宅基地', '农经权', '房地一体', '其他测绘', '工民建勘察', '报告编写、设计方案', '政府性灾害勘察', '地灾评估、勘察、设计', '市场地质', '价款项目', '综合物探', '基础施工', '灾害施工', '生态修复', '化验、基础检测', '土工试验', '其他'];
const PREVIEW_SECTORS = ['能源资源勘查开发', '生态保护修复', '地质灾害治理', '工程勘察与施工', '地质延伸产业', '实验测试', '测绘地理信息', '海外勘查贸易'];
const PREVIEW_CLIENTS = [
  '山西晋能控股集团某煤业有限公司', '山西焦煤集团某煤矿', '潞安化工集团某煤业', '华阳新材料科技集团',
  '某县自然资源局', '某市规划和自然资源局', '某省地质勘查院', '某县农业农村局', '某煤业有限责任公司',
  '山西华新燃气集团', '某市住房和城乡建设局', '某县水利局', '中煤某能源有限公司', '某县交通运输局',
  '某测绘地理信息有限公司', '某乡人民政府', '某海外矿业有限公司', '某县应急管理局',
];

/* 确定性伪随机（LCG） */
let _seed = 20260915;
const rnd = () => { _seed = (_seed * 1103515245 + 12345) % 2147483648; return _seed / 2147483648; };
const pick = arr => arr[Math.floor(rnd() * arr.length)];
const money = (min, max) => Math.round((min + rnd() * (max - min)) / 1000) * 1000;
const pad2 = n => String(n).padStart(2, '0');

const PREVIEW_DEPT_ROWS = PREVIEW_DEPTS.map((name, i) => ({ id: 'D' + String(i + 1).padStart(3, '0'), name }));

/* —— 台账模拟行（约 12% 决算未定，用于覆盖「—」口径与 KPI 附注） —— */
const LEDGER_ROWS = (() => {
  const rows = [];
  const statuses = ['完工', '施工中', '中止', '取消或作废'];
  const debts = ['正常', '正常', '正常', '逾期', '逾期', '诉讼', '和解', ''];
  for (let i = 0; i < 72; i++) {
    const dept = PREVIEW_DEPT_ROWS[Math.floor(rnd() * PREVIEW_DEPT_ROWS.length)];
    const hasFinal = rnd() > 0.12;
    const contract = money(300000, 9800000);
    const invoiced = Math.round((hasFinal ? contract : money(100000, 3000000)) * (0.25 + rnd() * 0.7));
    const received = Math.round(invoiced * rnd() * 0.95);
    rows.push({
      id: 'L' + String(i + 1).padStart(4, '0'),
      contract_no: `WT2026-${String(100 + i)}`,
      project_name: `某${pick(['县', '市', '矿区', '乡'])}${pick(PREVIEW_NATURES)}${pick(['技术服务', '勘察', '测绘', '施工'])}项目（含野外作业与内业报告）`,
      department_id: dept.id,
      creditor_unit: pick(PREVIEW_UNITS),
      owner_unit: pick(PREVIEW_CLIENTS),
      client_attr: pick(PREVIEW_ATTRS),
      work_nature: pick(PREVIEW_NATURES),
      sector: pick(PREVIEW_SECTORS),
      project_status: pick(statuses),
      final_amount: hasFinal ? contract : null,
      invoiced_amount: invoiced,
      received_amount: received,
      writeoff_amount: rnd() > 0.9 ? Math.round(received * 0.1) : 0,
      debt_status: pick(debts),
      dunning_date: rnd() > 0.3
        ? `2026-${pad2(1 + Math.floor(rnd() * 9))}-${pad2(1 + Math.floor(rnd() * 28))}` : null,
      collector: pick(['张三', '李四', '王五', '赵六', '孙勇军', '翟悟飞', '']),
    });
  }
  return rows;
})();

/* —— 明细模拟（近 12 个月开票 / 回款，供趋势卡） —— */
function mockDetail(kind) {
  const out = [];
  const now = new Date();
  for (let i = 11; i >= 0; i--) {
    const d = new Date(now.getFullYear(), now.getMonth() - i, 1);
    const key = `${d.getFullYear()}-${pad2(d.getMonth() + 1)}`;
    const cnt = 2 + ((i * 7) % 5);
    for (let j = 0; j < cnt; j++) {
      const amt = 200000 + ((i * 13 + j * 29) % 40) * 160000;
      const day = pad2(Math.min(3 + j * 4, 28));
      out.push(kind === 'invoice'
        ? { invoice_date: `${key}-${day}`, amount: amt }
        : { receipt_date: `${key}-${day}`, amount: Math.round(amt * 0.68) });
    }
  }
  return out;
}

/* —— 最小桩件：Ledger / sb / App —— */
const Ledger = {
  rows: LEDGER_ROWS,
  departments: PREVIEW_DEPT_ROWS,
  /** 与 js/ledger.js computeRow 口径一致（决算未定 → null） */
  computeRow(r) {
    const inv = Number(r.invoiced_amount || 0);
    const recv = Number(r.received_amount || 0);
    const wo = Number(r.writeoff_amount || 0);
    const has = r.final_amount !== null && r.final_amount !== undefined && r.final_amount !== '';
    const fin = has ? Number(r.final_amount) : null;
    return {
      receivable_internal: Math.round((inv - recv) * 10000) / 10000,
      receivable_external: fin === null ? null : Math.round((fin - inv) * 10000) / 10000,
      receivable_balance: fin === null ? null : Math.round((fin - recv - wo) * 10000) / 10000,
      attach_summary: '',
    };
  },
  deptNameOf(r) {
    const d = this.departments.find(x => x.id === r.department_id);
    return d ? d.name : '未指定';
  },
};

/** Supabase 客户端桩：loadTrend 的三段链式调用原样可用 */
const sb = {
  from(table) {
    return {
      select: () => ({
        gte: () => Promise.resolve({
          data: table === 'ar_invoices' ? mockDetail('invoice')
            : table === 'ar_receipts' ? mockDetail('receipt') : [],
          error: null,
        }),
      }),
    };
  },
};

const App = { currentView: 'dashboard' };

/* —— 渲染 —— */
document.getElementById('root').innerHTML = `
  <div class="app-shell">
    <aside class="sidebar">
      <div class="side-brand">企业应收账款<br>台账系统</div>
      <nav class="side-nav">
        ${[['◔', '数据看板', true], ['▤', '台账总览'], ['⇪', 'Excel 导入'], ['◱', '导入批次'],
           ['☰', '用户管理'], ['⚙', '选项管理'], ['⚙', '系统设置']]
          .map(([ic, label, on]) => `<button class="nav-item ${on ? 'active' : ''}">
            <span class="nav-icon" aria-hidden="true">${ic}</span><span>${label}</span></button>`).join('')}
      </nav>
      <div class="side-perms">
        <div class="sp-title">我的权限（7 · 全部）</div>
        <ul class="perm-list">
          ${['查看台账', '查看全部数据', '新增记录', '编辑记录', '删除记录', '导入 Excel', '导出 Excel']
            .map(l => `<li class="on"><span class="pm-icon">✓</span>${l}</li>`).join('')}
          <li class="on"><span class="pm-icon">✓</span>超级管理员（用户与设置）</li>
        </ul>
      </div>
    </aside>
    <div class="app-main">
      <header class="topbar">
        <div class="topbar-left"><div class="topbar-title">数据看板</div></div>
        <div class="topbar-user">
          <span class="user-dept">系统管理员</span><span class="user-name">sjn</span>
          <button class="btn btn-xs">修改密码</button><button class="btn btn-xs">退出</button>
        </div>
      </header>
      <main class="page-container"><section id="page-dashboard" class="page"></section></main>
    </div>
  </div>`;

Dashboard.render();
