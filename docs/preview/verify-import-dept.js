/**
 * verify-import-dept.js —— 导入「归属部门」链路回归验证（Node 直接跑真实源码）
 *
 * 背景：用户反馈「上传文件后台账总览里的归属部门没显示」。根因是 Excel「部门名称」列
 * 的值在 ar_departments 里查不到时，importer.js 直接写 null 且不报错 —— 导入结果
 * 显示「成功写入 19 条」，台账「归属部门」列却是清一色「未指定」。
 *
 * 本脚本用真实源码（js/fields.js + js/importer.js）+ 真实数据
 * （用户那份 Excel 的解析结果 + 线上 ar_departments 快照）驱动导入逻辑，
 * 断言 mapping / deptPlan / commit 落库载荷三处都对。
 *
 * 用法：
 *   node docs/preview/verify-import-dept.js
 * 依赖 .workbuddy/tmp-sheet.json 与 .workbuddy/tmp-depts.json（敏感数据，不入库）。
 */

const fs = require('fs');
const path = require('path');
const vm = require('vm');

const ROOT = path.join(__dirname, '..', '..');
const read = p => fs.readFileSync(path.join(ROOT, p), 'utf8');

const sheetRows = JSON.parse(fs.readFileSync(path.join(ROOT, '.workbuddy', 'tmp-sheet.json'), 'utf8'));
const DEPTS = JSON.parse(fs.readFileSync(path.join(ROOT, '.workbuddy', 'tmp-depts.json'), 'utf8'));

/* ---------------- 最小桩件 ---------------- */
const inserted = [];       // 捕获真正提交给 ar_ledger 的载荷
const batches = [];

function fakeFrom(table) {
  const api = {
    _t: table,
    select() { return api; },
    order() { return api; },
    eq() { return api; },
    limit() { return api; },
    maybeSingle() { return Promise.resolve({ data: null, error: null }); },
    single() {
      if (api._t === 'ar_import_batches') return Promise.resolve({ data: { id: 'batch-test-1' }, error: null });
      return Promise.resolve({ data: null, error: null });
    },
    insert(payload) {
      if (api._t === 'ar_ledger') inserted.push(...payload);
      if (api._t === 'ar_import_batches') batches.push(payload);
      const chain = { select: () => chain, single: () => api.single(), then: r => Promise.resolve({ error: null }).then(r) };
      return chain;
    },
    update() { const chain = { eq: () => Promise.resolve({ error: null }) }; return chain; },
    then(res) { return Promise.resolve({ data: [], error: null }).then(res); },
  };
  return api;
}

/* 极简 DOM 桩：importer.js 在 commit() 里只碰 #import-error / #btn-commit / #import-body */
function fakeEl() {
  return {
    innerHTML: '', textContent: '', disabled: false, value: '', dataset: {},
    classList: { add() {}, remove() {}, toggle() {} },
    addEventListener() {}, querySelector: () => null, querySelectorAll: () => [],
    closest: () => null,
  };
}

const sandbox = {
  console, JSON, Date, Math, Number, String, Object, Array, Map, Set, RegExp, Promise, Error,
  sb: { from: fakeFrom },
  Auth: { isAdmin: true, currentUser: { id: 'user-test-1' } },
  Ledger: { departments: DEPTS, reload() {} },
  Attachments: { summaryText: () => '', count: () => 0 },
  XLSX: {},
  document: { getElementById: () => fakeEl(), querySelector: () => null, querySelectorAll: () => [] },
  Utils: {
    escapeHtml: s => String(s === null || s === undefined ? '' : s)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;'),
    parseMoney: v => (v === null || v === undefined || v === '' ? null : Number(v)),
    parseExcelDate: v => (v === null || v === undefined || v === '' ? null : String(v)),
    fmtMoney: v => String(v === null ? '' : v),
    clampName: s => String(s || ''),
    fmtDate: s => String(s),
  },
};
sandbox.window = sandbox;

/* 真实源码拼成同一个脚本，共享顶层 const 作用域 */
vm.runInNewContext(
  [read('js/fields.js'), read('js/importer.js'), 'globalThis.Importer = Importer; globalThis.IMPORT_TARGETS = IMPORT_TARGETS;'].join('\n'),
  sandbox
);
const Importer = sandbox.Importer;

/* ---------------- 断言助手 ---------------- */
let pass = 0, fail = 0;
const ok = (cond, msg, extra) => {
  if (cond) { pass++; console.log('  ✓ ' + msg); }
  else { fail++; console.log('  ✗ ' + msg + (extra ? '\n      → ' + extra : '')); }
};

async function main() {
/* ---------------- 0. 装载用户那份 Excel ---------------- */
Importer.reset();
Importer.sheetRows = sheetRows;
Importer.fileName = '应收账款导入模板.xlsx';
Importer.detectHeaderAndMapping();
const rows = Importer.dataRows;

console.log('\n【0】文件解析');
ok(rows.length === 19, `识别出 19 条数据行（实得 ${rows.length}）`);
ok(Importer.fileName === '应收账款导入模板.xlsx', `文件名已记录：${Importer.fileName}`);

console.log('\n【1】字段映射 —— 「部门名称」必须落到虚拟目标 department');
const ci = Importer.mapping.indexOf('department');
ok(ci >= 0, `「部门名称」列已映射为 department（列索引 ${ci}）`);
ok(Importer.headers[ci] === '部门名称', `该列表头确为「部门名称」（实得「${Importer.headers[ci]}」）`);

console.log('\n【2】部门归属预检 —— 修好前这里是静默的');
const plan = Importer.deptPlan();
const missList = [...plan.missing.entries()];
ok(plan.missing.size === 2, `检出 2 个系统里不存在的部门名（实得 ${plan.missing.size}）`,
  JSON.stringify(missList));
/* 期望值从数据本身推导，不写死名称 —— 仓库是公开的，真实单位名不该出现在源码里 */
const [nm1, nm2] = missList.map(e => e[0]);
ok(plan.missing.get(nm1) === 18, `「${nm1}」命中 18 行（实得 ${plan.missing.get(nm1)}）`);
ok(plan.missing.get(nm2) === 1, `「${nm2}」命中 1 行（实得 ${plan.missing.get(nm2)}）`);
ok(plan.rows.every(r => r.deptId === null), '未人工指定时，这些行的归属部门为空（这正是用户看到的现象）');

console.log('\n【3】旧行为复现 —— 证明「静默写 null」确实是根因');
const wouldBeNull = plan.rows.filter(r => !r.deptId).length;
ok(wouldBeNull === 19, `19 行全部会落 null → 台账「归属部门」整列显示「未指定」（实得 ${wouldBeNull}）`);

console.log('\n【4】就地指定归属 —— 修好后的新能力');
const d1 = DEPTS[2], d2 = DEPTS[3];
Importer.deptOverrides.set(nm1, d1.id);
Importer.deptOverrides.set(nm2, d2.id);
const plan2 = Importer.deptPlan();
ok(plan2.missing.size === 0, '人工指定后不再有未匹配项');
ok(plan2.rows.filter(r => r.deptId === d1.id).length === 18, `18 行归到「${d1.name}」`);
ok(plan2.rows.filter(r => r.deptId === d2.id).length === 1, `1 行归到「${d2.name}」`);

console.log('\n【5】归一化匹配 —— 大小写 / 空格差异不该误判为「找不到」');
Importer.deptOverrides.clear();
Importer.dataRows = [{ 部门名称: ' ' + d1.name + ' ' }, { 部门名称: d1.name }];
const plan3 = Importer.deptPlan();
ok(plan3.missing.size === 0, '带空格的部门名仍能匹配上');

console.log('\n【6】commit 落库载荷 —— 归属部门必须真的写进去');
Importer.dataRows = rows;
Importer.deptOverrides.clear();
Importer.deptOverrides.set(nm1, d1.id);
Importer.deptOverrides.set(nm2, d2.id);
Importer.targetDept = 'auto';
Importer.dupMode = 'insert';
inserted.length = 0;
await Importer.commit();

ok(batches[0] && batches[0].file_name === '应收账款导入模板.xlsx',
  `批次记录写入真实文件名（实得「${batches[0] && batches[0].file_name}」，旧代码这里是「手工批次」）`);
ok(inserted.length === 19, `提交 19 条（实得 ${inserted.length}）`);
const withDept = inserted.filter(o => o.department_id).length;
ok(withDept === 19, `19 条全部带上 department_id（实得 ${withDept}）`);
const ids = new Set(DEPTS.map(d => d.id));
ok(inserted.every(o => ids.has(o.department_id)), '写进数据库的是部门 UUID，不是部门名原文');
ok(inserted.every(o => !('__dept_name' in o)), '__dept_name 临时字段没有泄漏进数据库载荷');

console.log('\n【7】统一指定部门（第 1 步那个原先失效的选项）');
Importer.deptOverrides.clear();
Importer.targetDept = d1.id;
inserted.length = 0;
await Importer.commit();
ok(inserted.length === 19 && inserted.every(o => o.department_id === d1.id),
  '选定「统一归属」后 19 条全部写该部门（旧代码读不到 DOM，此项恒失效）');

console.log(`\n${'='.repeat(56)}\n通过 ${pass} 项，失败 ${fail} 项\n`);
process.exit(fail ? 1 : 0);
}

main().catch(e => { console.error('验证脚本自身出错：', e); process.exit(2); });
