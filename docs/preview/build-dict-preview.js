#!/usr/bin/env node
/**
 * build-dict-preview.js - 生成自包含的「选项管理」页预览
 *
 * 用途：把 css/style.css + js/fields.js + js/dict.js + js/utils.js + js/dictadmin.js
 *       内联成单个 HTML，用模拟字典数据渲染真实页面，无需登录、不连数据库。
 *
 * 用法：node docs/preview/build-dict-preview.js
 * 产物：docs/preview/dict-preview.html
 *
 * hash 场景：
 *   （默认）    项目状态 —— 内置默认、未入库、4 项
 *   #managed    客户属性 —— 已入库、15 项
 *   #many       工作性质 —— 内置默认、18 项（长列表）
 *   #dirty      在输入框里改一个字，触发「有未保存的修改」
 *   #confirm    点第一行的删除按钮，弹出二次确认（验证误删刹车）
 *   #measure    打印几何测量浮层
 *
 * 注：修改 style.css / dictadmin.js 后需重新运行本脚本。
 */
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..', '..');
const read = f => fs.readFileSync(path.join(ROOT, f), 'utf8');

const css = read('css/style.css');

/* 与真实种子一致的内置默认值（取自 sql/upgrade-v3-indicators.sql） */
const mockJs = `
/* ---------- 模拟数据 & 假 Supabase（仅预览用） ---------- */
/* DB_DICT 里的类别 = 已在 ar_dict 入库；不在的 = 内置默认（未入库）。
   刻意让 project_status（默认打开的第一个类别）不在库里 —— 那是最需要看清的
   一种状态：灰色标签「内置默认（未落库）」+ 主色「保存并启用」按钮。 */
const DB_DICT = {
  debt_status: ['正常', '逾期', '诉讼', '和解'],
  client_attr: ['内部单位', '政府部门--省', '政府部门--市', '政府部门--县',
    '政府部门--县以下', '煤矿集团--晋能控股', '煤矿集团--山西焦煤', '煤矿集团--潞安化工',
    '煤矿集团--华阳新材', '煤矿集团--华新燃气', '煤矿集团--其他煤矿', '社会客户-省内',
    '社会客户-省外', '社会客户-海外', '其他'],
  unit: ['物化院', '六勘院', '测绘院', '禹地公司'],
  comm_method: ['电话', '上门拜访', '邮件', '微信', '函件+电话', '函件+微信'],
};

/* 最小可用的 PostgREST 链式替身：支持 select/eq/order/limit 与 delete/insert */
function makeChain(table) {
  let cat = null, op = 'select', payload = null;
  const o = {
    select: () => o, order: () => o, limit: () => o,
    delete: () => { op = 'delete'; return o; },
    insert: rows => { op = 'insert'; payload = rows; return o; },
    eq: (k, v) => { if (k === 'category') cat = v; return o; },
    then: (res, rej) => {
      if (op === 'select') {
        if (cat === null) {   /* Dicts.load()：不带 eq，取全部类别 */
          const all = [];
          Object.keys(DB_DICT).forEach(c => DB_DICT[c].forEach((v, i) => all.push({ category: c, value: v, sort_order: i + 1 })));
          return Promise.resolve({ data: all, error: null }).then(res, rej);
        }
        const vals = DB_DICT[cat] || [];
        return Promise.resolve({ data: vals.map((v, i) => ({ value: v, sort_order: i + 1 })), error: null }).then(res, rej);
      }
      if (op === 'delete') { delete DB_DICT[cat]; return Promise.resolve({ error: null }).then(res, rej); }
      DB_DICT[cat] = (payload || []).map(r => r.value);
      return Promise.resolve({ error: null }).then(res, rej);
    }
  };
  return o;
}
const sb = { from: t => makeChain(t) };

const Auth = { isAdmin: true, isSuperAdmin: true, currentUser: { id: 'u1', name: '孙晋宁' } };

(async () => {
  await Dicts.load();
  const h = location.hash;
  /* #dirty 特意选一个「已入库」的类别 —— 那是真实里最常改的场景，
     要验的是「已自定义 + 有未保存修改 → 按钮变『保存修改』」这条路径 */
  const catFor = { '#managed': 'client_attr', '#many': 'work_nature', '#dirty': 'debt_status' };
  await DictAdmin.load(catFor[h] || 'project_status');

  if (h === '#dirty') {
    const inp = document.querySelector('.dict-item');
    inp.value = inp.value + '·改';
    inp.dispatchEvent(new Event('input'));
  }

  if (h === '#confirm') {
    document.querySelector('.dict-table tbody [data-act="del"]').click();
  }

  if (h === '#measure') {
    const box = e => { const r = e.getBoundingClientRect(); return 'L' + Math.round(r.left) + ' x' + Math.round(r.top) + ' w' + Math.round(r.width) + ' h' + Math.round(r.height); };
    const out = [];
    const q = s => document.querySelector(s);
    const qa = s => [...document.querySelectorAll(s)];

    out.push('面板: ' + box(q('.dict-panel')) + '  左栏: ' + box(q('.dict-cats')) + '  右栏: ' + box(q('.dict-main')));
    out.push('视口高=' + window.innerHeight + '  面板底缘 y=' + Math.round(q('.dict-panel').getBoundingClientRect().bottom)
      + '（应≈视口高−容器底部内边距，即不再留半屏空白）');
    out.push('body 高=' + Math.round(document.body.getBoundingClientRect().height) + '（应≈外壳高度，不该出现第二条滚动条）');

    const rows = qa('.dict-table tbody tr');
    out.push('行数=' + rows.length + '  行高集合=' + [...new Set(rows.map(r => Math.round(r.getBoundingClientRect().height)))]);
    if (rows[0]) {
      const ths = qa('.dict-table thead th');
      out.push('表头各格: ' + ths.map((c, i) => i + ':' + box(c)).join(' | '));
      out.push('首行各格: ' + [...rows[0].children].map((c, i) => i + ':' + box(c)).join(' | '));
      out.push('表头/表体逐列宽度相等: ' + ths.every((th, i) => Math.round(th.getBoundingClientRect().width) === Math.round(rows[0].children[i].getBoundingClientRect().width)));
    }
    /* 可点击目标：WCAG 2.5.8 下限 24×24 */
    const acts = qa('.dict-table tbody tr:first-child [data-act]');
    out.push('操作按钮 ' + acts.length + ' 个: ' + acts.map(a => a.dataset.act + '[' + Math.round(a.getBoundingClientRect().width) + '×' + Math.round(a.getBoundingClientRect().height) + (a.disabled ? ' 禁用' : '') + ']').join(' '));
    out.push('最小点击目标边长=' + Math.min(...acts.map(a => Math.min(a.getBoundingClientRect().width, a.getBoundingClientRect().height))).toFixed(1) + 'px（须 ≥24）');
    /* 相邻按钮中心距：越小越容易误点 */
    const cs = acts.map(a => { const r = a.getBoundingClientRect(); return r.left + r.width / 2; });
    out.push('相邻按钮中心距=' + cs.slice(1).map((c, i) => (c - cs[i]).toFixed(0)).join('/') + 'px');
    /* 输入框默认是否"隐形" */
    const inp = q('.dict-item');
    out.push('输入框默认边框色=' + getComputedStyle(inp).borderTopColor + '（应为 transparent）');

    /* 左栏类别索引（注意限定 .dc-list —— 底部图例里也有 .dc-dot，不限定会数错）。
       同时逐行核对名称有没有被省略号截掉：左栏固定 212px，类别名最长的
       「单位（债权单位）」需要 ~152px，余量很紧。 */
    const caps = qa('.dc-list .dc-item');
    /* 注意别用 scrollWidth 当"文字宽度"：overflow:hidden 的元素在内容不溢出时
       scrollWidth 会退化成 clientWidth，读出来等于盒子宽度，会误导判断。
       要真宽就用 Range 量文字本身。 */
    const textW = el => { const r = document.createRange(); r.selectNodeContents(el); return r.getBoundingClientRect().width; };
    const nameW = Math.max(...caps.map(c => Math.round(textW(c.querySelector('.dc-name')))));
    const cw = caps.map(c => Math.round(c.querySelector('.dc-name').clientWidth));
    const uniform = cw.every(v => Math.abs(v - cw[0]) < 1);
    out.push('左栏类别 ' + caps.length + ' 行，行高集合=' + [...new Set(caps.map(c => Math.round(c.getBoundingClientRect().height)))]
      + '，最宽名称实宽=' + nameW + 'px');
    out.push('名称列宽: ' + (uniform
      ? cw[0] + 'px（固定列，余量 ' + (cw[0] - nameW) + 'px）'
      : '按胶囊内容自适应（窄屏横向滚动形态）'));
    const cut = caps.filter(c => { const n = c.querySelector('.dc-name'); return n.scrollWidth > n.clientWidth + 1; });
    out.push('名称被截断的类别: ' + (cut.length ? cut.map(c => c.querySelector('.dc-name').textContent).join(' , ') : '无 ✓'));
    out.push('左栏溢出: ' + (q('.dc-list').scrollHeight > q('.dc-list').clientHeight + 1 ? '需滚动（' + q('.dc-list').scrollHeight + '>' + q('.dc-list').clientHeight + '）' : '无需滚动 ✓'));
    out.push('已自定义标记=' + qa('.dc-list .dc-dot.is-db').length + ' 个 / 内置默认=' + qa('.dc-list .dc-dot:not(.is-db)').length + ' 个（合计应为 ' + caps.length + '）');
    out.push('当前类别 isManaged=' + Dicts.isManaged(DictAdmin.current) + '  Dicts.cache 键=' + Object.keys(Dicts.cache).join(','));

    out.push('新增输入框宽=' + Math.round(q('#dict-new').getBoundingClientRect().width) + 'px（旧版 904px 占满整行）');
    const sb = q('[data-act="save"]');
    out.push('保存按钮: ' + box(sb) + '  disabled=' + sb.disabled + '  文案=' + sb.textContent.trim());
    out.push('左右栏分界 x=' + Math.round(q('.dict-cats').getBoundingClientRect().right) + ' = 右栏左缘 x=' + Math.round(q('.dict-main').getBoundingClientRect().left)
      + '  Δ=' + Math.round(q('.dict-main').getBoundingClientRect().left - q('.dict-cats').getBoundingClientRect().right));

    const d = document.createElement('pre');
    /* white-space:pre 而不是 pre-wrap —— 换行会让读数穿插在后面板内容里看不清。
       字号 16px 是必须的：截图工具会把 1440 宽的图缩到 1080 再给模型看，
       10px 的读数缩放后只剩 7.5px，等于没读。 */
    d.style.cssText = 'position:fixed;inset:0 0 auto 0;z-index:9999;margin:0;padding:8px 10px;' +
      'background:#fff;color:#111;border-bottom:2px solid #c00;font:16px/1.5 monospace;white-space:pre;overflow-x:auto';
    d.textContent = 'MEASURE>>\\n' + out.join('\\n');
    document.body.appendChild(d);
  }

  document.title = '选项管理预览 · 已渲染';
  document.body.dataset.ready = '1';
})();
`;

const html = `<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>选项管理预览 · 企业应收账款台账系统</title>
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
/* 与外层真实骨架一致：固定高度而非 100vh（无头截图下视口高不稳定） */
.preview-shell { height: 900px; min-height: 0; overflow: hidden; }
.preview-shell .sidebar { height: 100%; }
.preview-shell .page-container { height: 100%; min-height: 0; }
</style>
</head>
<body>
<div class="preview-note">
  <b>选项管理页视觉预览</b> · 模拟字典数据，不连数据库 ·
  与真实系统同源：<code>css/style.css</code> + <code>js/dictadmin.js</code> ·
  <code>#managed</code> 已入库类别 · <code>#many</code> 18 项长列表 ·
  <code>#dirty</code> 未保存状态 · <code>#confirm</code> 删除确认 · <code>#measure</code> 打印几何测量
</div>
<div class="app-shell preview-shell">
  <aside class="sidebar">
    <div class="side-brand">企业应收账款<br>台账系统</div>
    <nav class="side-nav">
      <button class="nav-item"><span class="nav-icon" aria-hidden="true">▦</span><span>数据看板</span></button>
      <button class="nav-item"><span class="nav-icon" aria-hidden="true">▤</span><span>台账总览</span></button>
      <button class="nav-item"><span class="nav-icon" aria-hidden="true">⇪</span><span>Excel 导入</span></button>
      <button class="nav-item"><span class="nav-icon" aria-hidden="true">☰</span><span>导入批次管理</span></button>
      <button class="nav-item"><span class="nav-icon" aria-hidden="true">⚿</span><span>用户管理</span></button>
      <button class="nav-item active" aria-current="page"><span class="nav-icon" aria-hidden="true">◈</span><span>选项管理</span></button>
      <button class="nav-item"><span class="nav-icon" aria-hidden="true">⚙</span><span>系统设置</span></button>
    </nav>
  </aside>
  <div class="app-main">
    <header class="topbar">
      <div class="topbar-left"><div class="topbar-title">选项管理</div></div>
      <div class="topbar-user">
        <span class="user-dept">财务资产部</span><span class="user-name">孙晋宁</span>
        <button class="btn btn-xs">修改密码</button><button class="btn btn-xs">退出</button>
      </div>
    </header>
    <main class="page-container">
      <section id="page-dict" class="page"></section>
    </main>
  </div>
</div>
<script>${read('js/fields.js')}</script>
<script>${read('js/dict.js')}</script>
<script>${read('js/utils.js')}</script>
<script>${read('js/dictadmin.js')}</script>
<script>${mockJs}</script>
</body>
</html>
`;

const out = path.join(__dirname, 'dict-preview.html');
fs.writeFileSync(out, html, 'utf8');
console.log(`已生成 ${path.relative(ROOT, out)}（${(html.length / 1024).toFixed(1)} KB）`);
