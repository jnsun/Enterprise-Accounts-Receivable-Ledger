#!/usr/bin/env node
/**
 * build-import-preview.js - 生成自包含的「Excel 导入 · 预览确认」步预览
 *
 * 用途：把 css/style.css + js/fields.js + js/utils.js + js/importer.js 内联成单个 HTML，
 *       驱动第 3 步「预览确认」，无需登录、不连数据库。
 *
 * 用法：
 *   node docs/preview/build-import-preview.js            # 合成数据 → 入库产物
 *   node docs/preview/build-import-preview.js --real     # 本机真实数据 → 仅本地查看
 *
 * ⚠️ 本仓库是**公开**的：产物 HTML 会把数据内联进去。所以默认走合成数据；
 *    只有显式加 --real 时才读 .workbuddy/ 下的真实快照（该目录已被 .gitignore 排除），
 *    并把产物写到 docs/preview/ 之外，避免误提交。
 *
 * 产物：
 *   docs/preview/import-preview.html                       （合成数据，可入库）
 *   .workbuddy/import-preview-real.html                    （--real 时，不入库）
 *
 * hash 场景：
 *   （默认）    2 个部门名匹配不上、19 行无法自动归属 → 黄色告警 + 就地指定下拉
 *   #resolved   已就地指定归属 → 面板转绿，按钮不再提示「未指定部门」
 *   #nodeptcol  把「部门名称」列改成忽略 → 提示整批都不会有归属部门
 *   #unified    统一归属到某个部门 → 绿色说明，不再读部门名称列
 *   #measure    打印几何测量浮层
 *
 * 注：修改 style.css / importer.js 后需重新运行本脚本。
 */
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..', '..');
const read = f => fs.readFileSync(path.join(ROOT, f), 'utf8');
const readJson = f => { try { return JSON.parse(fs.readFileSync(path.join(ROOT, f), 'utf8')); } catch (e) { return null; } };

const USE_REAL = process.argv.includes('--real');
const css = read('css/style.css');

/* ---------------- 数据来源 ---------------- */

/* 合成数据：部门名与「部门名称」列刻意对不上，用来复现「导入成功但归属部门为空」那一幕。
   全为虚构名称，可安全入库（仓库是公开的）。 */
const SYNTH_DEPTS = [
  { id: 'd-01', name: '综合所' }, { id: 'd-02', name: '地质所' }, { id: 'd-03', name: '工程所' },
  { id: 'd-04', name: '测量所' }, { id: 'd-05', name: '测试所' }, { id: 'd-06', name: '环境所' },
];
const SYNTH_HEADER = ['合同编号', '项目名称', '合同金额', '决算金额', '已开发票金额', '已到账金额',
  '账内应收金额', '账外应收金额', '应收合计', '甲方单位', '债权单位',
  '开工日期', '完工日期', '付款节点', '部门名称', '工作性质', '八大板块', '成本费用', '催收/询证日期'];
const SYNTH_ROWS = [
  [SYNTH_HEADER],
  ...[1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16, 17, 18].map(n =>
    [`DEMO-${String(n).padStart(3, '0')}`, `示例项目名称 ${n} —— 二维地震勘探技术服务`,
      n * 10, n * 10, n * 10, n * 5, n * 5, 0, n * 5, '某某煤业有限公司', '某某勘查院有限公司',
      '', '', '', '某分公司', '', '', '', '']),
  ['DEMO-019', '示例项目名称 19 —— 三维地震勘探技术服务', 200, 200, 200, 100, 100, 0, 100,
    '某某能源有限公司', '某某勘查院有限公司', '', '', '', '另一分公司', '', '', '', ''],
].flat();

const realSheet = USE_REAL ? readJson('.workbuddy/tmp-sheet.json') : null;
const realDepts = USE_REAL ? readJson('.workbuddy/tmp-depts.json') : null;
const SHEET = realSheet || SYNTH_ROWS;
const DEPTS_DATA = realDepts || SYNTH_DEPTS;

const mockJs = `
/* ---------- 预览用数据与桩件（不连数据库） ---------- */
const SHEET_ROWS = ${JSON.stringify(SHEET)};
const DEPTS = ${JSON.stringify(DEPTS_DATA)};

/* 台账预览只调 Importer；Ledger 只需给出部门字典 */
const Ledger = { departments: DEPTS.slice(), reload() {} };
const Auth = { isAdmin: true, isSuperAdmin: true, currentUser: { id: 'u1' } };
const Attachments = { summaryText: () => '', count: () => 0 };
const XLSX = { utils: {}, read() {}, writeFile() {} };

/* PostgREST 替身：本预览只走到「预览确认」，不点导入，故只需可链式调用 */
function makeChain() {
  const o = { select: () => o, order: () => o, eq: () => o, limit: () => o,
    maybeSingle: () => Promise.resolve({ data: null, error: null }),
    single: () => Promise.resolve({ data: { id: 'batch-1' }, error: null }),
    insert: () => o, update: () => o,
    then: (res) => Promise.resolve({ data: [], error: null }).then(res) };
  return o;
}
const sb = { from: () => makeChain() };

(async () => {
  const h = location.hash;
  const modal = Importer.open();

  /* 直接把「已选文件」的结果塞进去：本预览要验的是第 3 步的版面，
     不必真的走一遍文件选择（无头环境里没有 FileReader 输入） */
  Importer.fileName = '应收账款导入模板.xlsx';
  Importer.sheetRows = SHEET_ROWS;
  Importer.detectHeaderAndMapping();

  if (h === '#nodeptcol') {
    /* 模拟用户把「部门名称」列的下拉改成「忽略该列」 */
    Importer.mapping = Importer.mapping.map(m => (m === 'department' ? '' : m));
  }
  if (h === '#unified') {
    Importer.targetDept = DEPTS[2].id;   // 任取一个部门演示「统一归属」
  }
  if (h === '#resolved') {
    const byName = new Map(DEPTS.map(d => [d.name, d.id]));
    const ci = Importer.mapping.indexOf('department');
    const names = [...new Set(Importer.dataRows.map(r => String(r[ci]).trim()))];
    names.forEach((n, i) => {
      if (!byName.has(n)) Importer.deptOverrides.set(n, DEPTS[(i + 2) % DEPTS.length].id);
    });
  }

  Importer.renderStepMapping();
  await Importer.renderStepPreview();

  document.title = '导入预览 · 已渲染';
  document.body.dataset.ready = '1';

  /* 探针延后一拍再跑：刚写完 innerHTML 时盒模型尚未稳定，同一个元素两次
     getBoundingClientRect 会给出互相矛盾的结果（实测「h55」与「底缘 y=528」并存）。 */
  if (h === '#measure') setTimeout(runProbe, 600);
})();

function runProbe() {
  const q = s => document.querySelector(s);
  const qa = s => [...document.querySelectorAll(s)];
  const box = e => { const r = e.getBoundingClientRect(); return 'L' + Math.round(r.left) + ' x' + Math.round(r.top) + ' w' + Math.round(r.width) + ' h' + Math.round(r.height); };
  /* overflow:hidden 元素的 scrollWidth 在内容不溢出时会退化成 clientWidth，
     量不出「文字到底需要多宽」。要真宽就用 Range 量文字本身。 */
  const textW = el => { const r = document.createRange(); r.selectNodeContents(el); return r.getBoundingClientRect().width; };
  const out = [];

  const panel = q('.dept-check');
  out.push('告警面板: ' + (panel ? box(panel) + '  底缘 y=' + Math.round(panel.getBoundingClientRect().bottom) + '  class=' + panel.className : '不存在'));
  out.push('面板溢出: ' + (panel && panel.scrollHeight > panel.clientHeight + 1
    ? '内容被截（' + panel.scrollHeight + '>' + panel.clientHeight + '）' : '无 ✓'));
  out.push('标题: ' + (q('.dchk-title') ? q('.dchk-title').textContent.trim() : '—'));

  const rows = qa('.dchk-row');
  out.push('未匹配部门行数=' + rows.length);
  rows.forEach(r => {
    const name = r.querySelector('.dchk-name');
    const sel = r.querySelector('.dchk-sel');
    const need = Math.round(textW(name));
    out.push('  「' + name.textContent + '」 文字实宽=' + need
      + ' 容器宽=' + Math.round(name.clientWidth)
      + (need > name.clientWidth + 1 ? ' ⚠截断' : ' ✓')
      + ' | 条数=' + r.querySelector('.dchk-cnt').textContent.trim()
      + ' | 下拉 ' + Math.round(sel.getBoundingClientRect().width) + '×' + Math.round(sel.getBoundingClientRect().height)
      + ' 选项=' + sel.options.length + ' 当前值=' + (sel.value || '（未选）'));
  });

  /* 行内元素是否互相压叠 / 间距是否过大 */
  if (rows.length) {
    const n = rows[0].querySelector('.dchk-name').getBoundingClientRect();
    const c = rows[0].querySelector('.dchk-cnt').getBoundingClientRect();
    const s = rows[0].querySelector('.dchk-sel').getBoundingClientRect();
    out.push('首行: 名右缘 ' + Math.round(n.right) + ' → 数左缘 ' + Math.round(c.left)
      + ' Δ=' + Math.round(c.left - n.right) + ' | 数右缘 ' + Math.round(c.right)
      + ' → 下拉左缘 ' + Math.round(s.left) + '（Δ 大 = 名字与下拉之间留白多）');
  }

  const btn = q('#btn-commit');
  out.push('主按钮: ' + (btn ? box(btn) + '  文案=「' + btn.textContent.trim() + '」' : '不存在'));
  out.push('面板底缘 → 按钮顶缘 Δ=' + Math.round(btn.getBoundingClientRect().top - panel.getBoundingClientRect().bottom) + 'px');

  /* 预览表：表头行高（旧版长表头会被挤成 5 行）+ 部门列是否真有值 */
  const ths = qa('.ledger-table thead th');
  const th = q('.ledger-table thead th');
  const first = q('.ledger-table tbody tr');
  out.push('预览表表头行数/高: ' + ths.length + ' 列, 行高=' + Math.round(th.getBoundingClientRect().height) + 'px（旧版长表头换行达 5 行）');
  const di = ths.findIndex(t => t.textContent.trim() === '部门名称（归属部门）');
  out.push('部门列索引=' + di + '  首行该格=「'
    + (di >= 0 && first ? first.children[di].textContent.trim() : '—') + '」（旧代码恒为空白）');
  out.push('预览表横向溢出: ' + (q('.table-wrap').scrollWidth > q('.table-wrap').clientWidth + 1
    ? '需横向滚动（' + q('.table-wrap').scrollWidth + '>' + q('.table-wrap').clientWidth + '）' : '无需滚动'));

  const d = document.createElement('pre');
  d.style.cssText = 'position:fixed;inset:0 0 auto 0;z-index:9999;margin:0;padding:8px 10px;' +
    'background:#fff;color:#111;border-bottom:2px solid #c00;font:15px/1.5 monospace;white-space:pre;overflow-x:auto';
  d.textContent = 'MEASURE>>\\n' + out.join('\\n');
  document.body.appendChild(d);
}
`;

const html = `<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Excel 导入预览 · 企业应收账款台账系统</title>
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
/* 模态框平时 position:fixed 覆盖整屏，这里让它落进文档流，
   并解除 90vh / 内部滚动，方便一张图看全整步内容 */
.modal-mask { position: static; background: none; padding: 0; display: block; animation: none; }
.modal { margin: 0 auto; max-height: none; animation: none; }
.modal-body { overflow: visible; }
</style>
</head>
<body>
<div class="preview-note">
  <b>Excel 导入 · 第 3 步「预览确认」预览</b> · ${realSheet && realDepts ? '<b>本机真实数据（勿提交）</b>' : '合成数据'} · 不连数据库 ·
  同源：<code>css/style.css</code> + <code>js/importer.js</code> ·
  <code>#resolved</code> 已就地指定归属 · <code>#nodeptcol</code> 无部门列 ·
  <code>#unified</code> 统一归属 · <code>#measure</code> 打印几何测量
</div>
<script>${read('js/fields.js')}</script>
<script>${read('js/utils.js')}</script>
<script>${read('js/importer.js')}</script>
<script>${mockJs}</script>
</body>
</html>
`;

/* --real 的产物写到 .workbuddy/（已 gitignore），避免真实业务数据被提交到公开仓库。
   数据快照缺失时自动降级回合成数据，不让生成器空跑。 */
const useReal = !!(realSheet && realDepts);
const out = useReal
  ? path.join(ROOT, '.workbuddy', 'import-preview-real.html')
  : path.join(__dirname, 'import-preview.html');
fs.writeFileSync(out, html, 'utf8');
console.log(`已生成 ${path.relative(ROOT, out)}（${(html.length / 1024).toFixed(1)} KB）`
  + (useReal ? ' · 真实数据（不入库）'
    : USE_REAL ? ' · ⚠ 未找到 .workbuddy 数据快照，已降级为合成数据'
    : ' · 合成数据'));
