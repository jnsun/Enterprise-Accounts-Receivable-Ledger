/**
 * verify-import-dept.js —— 导入「归属部门」链路回归验证（Node 直接跑真实源码）
 *
 * 背景：用户反馈「上传文件后台账总览里的归属部门没显示」。根因是 Excel「部门名称」列
 * 的值在 ar_departments 里查不到时，importer.js 直接写 null 且不报错 —— 导入结果
 * 显示「成功写入 N 条」，台账「归属部门」列却是清一色「未指定」。
 *
 * 本脚本把真实源码（js/fields.js + js/importer.js）在 `vm` 里跑起来，喂入本机的
 * 数据快照，断言 mapping / deptPlan / commit 落库载荷三处都对。
 * 不需要浏览器、不需要登录、不连数据库。
 *
 * 用法：
 *   node docs/preview/verify-import-dept.js
 * 依赖（不入库，仓库是公开的）：
 *   .workbuddy/tmp-sheet.json  待测 Excel 的二维数组（首行表头）
 *   .workbuddy/tmp-depts.json  ar_departments 的 [{id,name}] 快照
 *
 * ⚠️ 期望值一律**从数据推导**，不写死具体条数/名称 —— 写死过一版，后来给线上库
 *    新建了一个部门，断言立刻全红（脚本"腐烂"）。现在只会因真实缺陷而失败。
 */

const fs = require('fs');
const path = require('path');
const vm = require('vm');

const ROOT = path.join(__dirname, '..', '..');
const read = p => fs.readFileSync(path.join(ROOT, p), 'utf8');

/* 数据快照刻意不入库；读不到时给一条可执行的提示，别只丢 ENOENT 堆栈 */
function needJson(rel, howto) {
  const p = path.join(ROOT, rel);
  if (!fs.existsSync(p)) {
    console.error(`\n缺少本机数据快照：${rel}\n${howto}\n`);
    process.exit(2);
  }
  return JSON.parse(fs.readFileSync(p, 'utf8'));
}

const sheetRows = needJson('.workbuddy/tmp-sheet.json',
  '  请把待测 Excel 解析成二维数组后写成该文件（首行表头、后续数据行）。');
const LIVE_DEPTS = needJson('.workbuddy/tmp-depts.json',
  '  请从 ar_departments 取 [{id,name}] 写成该文件。');

/* ---------------- 从数据推导期望值 ---------------- */

const header = (sheetRows[0] || []).map(h => String(h === null || h === undefined ? '' : h).trim());
const deptCol = header.indexOf('部门名称');
if (deptCol < 0) {
  console.error('\n快照表头里没有「部门名称」列，本脚本的验证对象不成立。\n');
  process.exit(2);
}
const dataRowNames = sheetRows.slice(1)
  .filter(r => r && r.some(c => c !== null && c !== undefined && String(c).trim() !== ''))
  .map(r => String(r[deptCol] === null || r[deptCol] === undefined ? '' : r[deptCol]).trim());

const norm = s => String(s === null || s === undefined ? '' : s).replace(/[\s\u3000]/g, '').toLowerCase();
const liveNames = new Set(LIVE_DEPTS.map(d => d.name));
const liveNorms = new Set(LIVE_DEPTS.map(d => norm(d.name)));

/* 刻意把「表里出现过、且线上字典里也确实存在」的第一个部门名从测试字典里剔除 ——
   这样"哪一个匹配不上"永远是确定的，不会因为线上部门表被增删而让断言失效。 */
const appearInSheet = [...new Set(dataRowNames.filter(Boolean))];
const MISS_NAME = appearInSheet.find(n => liveNames.has(n) || liveNorms.has(norm(n))) || appearInSheet[0];
const DEPTS = LIVE_DEPTS.filter(d => d.name !== MISS_NAME);

const deptNameSet = new Set(DEPTS.map(d => d.name));
const deptNormSet = new Set(DEPTS.map(d => norm(d.name)));
const isMissingName = n => !!n && !deptNameSet.has(n) && !deptNormSet.has(norm(n));

const EXPECT_MISSING_NAMES = [...new Set(dataRowNames.filter(isMissingName))];
const EXPECT_MISSING_ROWS = dataRowNames.filter(isMissingName).length;
const MISS_ROWS = dataRowNames.filter(n => n === MISS_NAME).length;
const HIT_ROWS = dataRowNames.length - EXPECT_MISSING_ROWS;

console.log(`\n数据快照：${dataRowNames.length} 行 · ${appearInSheet.length} 个部门名 · 线上字典 ${LIVE_DEPTS.length} 个部门`);
console.log(`测试字典刻意剔除「${MISS_NAME}」 → 预期未匹配 ${EXPECT_MISSING_NAMES.length} 个名 / ${EXPECT_MISSING_ROWS} 行，已匹配 ${HIT_ROWS} 行`);

/* ---------------- 最小桩件 ---------------- */
const inserted = [];       // 捕获真正提交给 ar_ledger 的载荷
const batches = [];

function fakeFrom(table) {
  const api = {
    _t: table,
    select() { return api; }, order() { return api; }, eq() { return api; }, limit() { return api; },
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
    update() { return { eq: () => Promise.resolve({ error: null }) }; },
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
  [read('js/fields.js'), read('js/importer.js'),
    'globalThis.Importer = Importer; globalThis.IMPORT_TARGETS = IMPORT_TARGETS;'].join('\n'),
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
/* ---------------- 0. 装载 Excel ---------------- */
Importer.reset();
Importer.sheetRows = sheetRows;
Importer.fileName = '应收账款导入模板.xlsx';
Importer.detectHeaderAndMapping();
const rows = Importer.dataRows;

console.log('\n【0】文件解析');
ok(rows.length === dataRowNames.length,
  `识别出 ${dataRowNames.length} 条数据行（实得 ${rows.length}）`);
ok(Importer.fileName === '应收账款导入模板.xlsx', `文件名已记录：${Importer.fileName}`);

console.log('\n【1】字段映射 —— 「部门名称」必须落到虚拟目标 department');
const ci = Importer.mapping.indexOf('department');
ok(ci >= 0, `「部门名称」列已映射为 department（列索引 ${ci}）`);
ok(Importer.headers[ci] === '部门名称', `该列表头确为「部门名称」（实得「${Importer.headers[ci]}」）`);

console.log('\n【2】部门归属预检 —— 修好前这里是静默的');
const plan = Importer.deptPlan();
ok(plan.missing.size === EXPECT_MISSING_NAMES.length,
  `检出 ${EXPECT_MISSING_NAMES.length} 个系统里不存在的部门名（实得 ${plan.missing.size}）`,
  JSON.stringify([...plan.missing.entries()]));
ok(plan.missing.get(MISS_NAME) === MISS_ROWS,
  `「${MISS_NAME}」命中 ${MISS_ROWS} 行（实得 ${plan.missing.get(MISS_NAME)}）`);

console.log('\n【3】旧行为复现 —— 证明「静默写 null」确实是根因');
const wouldBeNull = plan.rows.filter(r => !r.deptId).length;
ok(wouldBeNull === EXPECT_MISSING_ROWS,
  `${EXPECT_MISSING_ROWS} 行会落 null → 台账「归属部门」显示「未指定」（实得 ${wouldBeNull}）`);
ok(plan.rows.filter(r => r.deptId).length === HIT_ROWS, `${HIT_ROWS} 行正常匹配到部门`);

console.log('\n【4】就地指定归属 —— 修好后的新能力');
Importer.deptOverrides.set(MISS_NAME, DEPTS[0].id);
const plan2 = Importer.deptPlan();
ok(!plan2.missing.has(MISS_NAME), '人工指定后该名字不再出现在未匹配清单里');
ok(plan2.rows.filter(r => r.deptId === DEPTS[0].id).length === MISS_ROWS,
  `${MISS_ROWS} 行归到「${DEPTS[0].name}」`);

console.log('\n【5】归一化匹配 —— 大小写 / 空格差异不该误判为「找不到」');
Importer.deptOverrides.clear();
Importer.dataRows = [{ 部门名称: ' ' + DEPTS[0].name + ' ' }, { 部门名称: DEPTS[0].name }];
ok(Importer.deptPlan().missing.size === 0, '带空格的部门名仍能匹配上');

console.log('\n【6】commit 落库载荷 —— 归属部门必须真的写进去');
Importer.dataRows = rows;
Importer.deptOverrides.clear();
/* 每个未匹配的名字都指定一个归属（用不同的部门，顺便验证逐名映射不会串） */
EXPECT_MISSING_NAMES.forEach((n, i) => Importer.deptOverrides.set(n, DEPTS[i % DEPTS.length].id));
Importer.targetDept = 'auto';
Importer.dupMode = 'insert';
inserted.length = 0;
await Importer.commit();

ok(batches[0] && batches[0].file_name === '应收账款导入模板.xlsx',
  `批次记录写入真实文件名（实得「${batches[0] && batches[0].file_name}」，旧代码这里是「手工批次」）`);
ok(inserted.length === rows.length, `提交 ${rows.length} 条（实得 ${inserted.length}）`);
const withDept = inserted.filter(o => o.department_id).length;
ok(withDept === rows.length, `${rows.length} 条全部带上 department_id（实得 ${withDept}）`);
const ids = new Set(DEPTS.map(d => d.id));
ok(inserted.every(o => ids.has(o.department_id)), '写进数据库的是部门 UUID，不是部门名原文');
ok(inserted.every(o => !('__dept_name' in o)), '__dept_name 临时字段没有泄漏进数据库载荷');

console.log('\n【7】统一指定部门（第 1 步那个原先失效的选项）');
Importer.deptOverrides.clear();
Importer.targetDept = DEPTS[0].id;
inserted.length = 0;
await Importer.commit();
ok(inserted.length === rows.length && inserted.every(o => o.department_id === DEPTS[0].id),
  '选定「统一归属」后全部写该部门（旧代码读不到 DOM，此项恒失效）');

console.log('\n【8】「暂不归属」也是一种明确选择，不该再报未匹配');
Importer.deptOverrides.clear();
Importer.targetDept = 'auto';
Importer.deptOverrides.set(MISS_NAME, null);
ok(Importer.deptPlan().missing.size === EXPECT_MISSING_NAMES.length - 1,
  '选出「暂不归属」后该名字从告警里消失，且不再被反复提醒');

console.log(`\n${'='.repeat(56)}\n通过 ${pass} 项，失败 ${fail} 项\n`);
process.exit(fail ? 1 : 0);
}

main().catch(e => { console.error('验证脚本自身出错：', e); process.exit(2); });
