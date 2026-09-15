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
 *   （默认）    项目状态 —— 内置默认、未入库、4 项；台账里的值都在选项表中（无孤儿值）
 *   #managed    客户属性 —— 已入库、15 项，且台账里有一个值不在选项表里（有孤儿值）
 *   #orphan     同 #managed（语义别名，专看孤儿值）
 *   #renamed    把「内部单位」改名 —— 一致性卡片应立刻出现警示（原值变成孤儿值）
 *   #saveimpact 改名后点保存 —— 应先弹「将移除 1 个在用选项、共影响 3 条台账」的确认
 *   #attach     附件类别 —— 数据来源是 ar_attachments 而不是台账
 *   #many       工作性质 —— 内置默认、18 项（长列表，验内部滚动）
 *   #dirty      在输入框里改一个字，触发「有未保存的修改」
 *   #confirm    点第一行的删除按钮，弹出二次确认（含在用条数的影响面）
 *   #measure    打印几何测量浮层（含右栏空白、在用列、一致性卡片）
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

/* 台账 / 附件侧的值分布 —— 「在用」列与孤儿值的 mock 数据源。
   刻意让 client_attr 里出现一个不在 DB_DICT 里的值（煤矿集团--晋城）：
   那就是「数据里有、选项表里没有」的孤儿值，本页要能把它摆出来。
   每列按 count 展开后从第 0 行开始顺序填，各列覆盖行数不同（高行会留空）——
   这样每个值的条数就等于 count 本身，断言可以逐一对账。 */
const DICT_COUNTS = {
  project_status: { '完工': 4, '施工中': 6, '中止': 2, '取消或作废': 1 },
  final_method:   { '合同金额': 8, '工作量': 5 },
  debt_status:    { '正常': 5, '逾期': 6, '诉讼': 2, '和解': 2 },
  client_attr:    { '内部单位': 3, '政府部门--县': 2, '煤矿集团--晋能控股': 4,
                    '煤矿集团--潞安化工': 2, '社会客户-省内': 3, '其他': 1,
                    '煤矿集团--晋城': 2 },              /* ← 不在 DB_DICT 里：孤儿值 */
  comm_method:    { '电话': 4, '上门拜访': 3, '邮件': 2, '微信': 3, '函件+电话': 1 },
  feedback:       { '承认欠款，但资金紧张': 3, '拒接电话': 2, '对质量提出异议': 2, '承认欠款，要求分期': 2 },
  progress_note:  { '已发送第二次催款函': 3, '停工': 2, '需协商': 2, '已安排对账': 2 },
  next_plan:      { '升级催收手段': 3, '需实地调查': 2, '跟踪付款进度': 2, '提供分期计划': 2 },
  unit:           { '物化院': 5, '六勘院': 3, '测绘院': 2, '禹地公司': 1 },
  work_nature:    { '二、三维地震': 3, '宅基地': 2, '农经权': 2, '房地一体': 2, '其他测绘': 1,
                    '工民建勘察': 2, '报告编写、设计方案': 1, '地灾评估、勘察、设计': 2, '市场地质': 1,
                    '价款项目': 1, '综合物探': 2, '基础施工': 1, '灾害施工': 1, '生态修复': 1,
                    '化验、基础检测': 1, '土工试验': 1, '其他': 1 },
  sector:         { '能源资源勘查开发': 3, '生态保护修复': 2, '地质灾害治理': 2, '工程勘察与施工': 2,
                    '地质延伸产业': 2, '实验测试': 2, '测绘地理信息': 2, '海外勘查贸易': 1 },
};
const ATTACH_COUNTS = { '决算': 5, '中止证明': 2, '其他': 1 };

const expand = counts => {
  const out = [];
  Object.keys(counts).forEach(v => { for (let i = 0; i < counts[v]; i++) out.push(v); });
  return out;
};
/* 类别 → 台账列名，与产品同源（FIELD_DEFS 的 dict 反查），不在这里另抄一份映射 */
const MOCK_ROWS = [];
Object.keys(DICT_COUNTS).forEach(c => {
  const f = FIELD_DEFS.find(x => x.dict === c);
  if (!f) return;
  expand(DICT_COUNTS[c]).forEach((v, i) => {
    MOCK_ROWS[i] = MOCK_ROWS[i] || {};
    MOCK_ROWS[i][f.key] = v;
  });
});
const MOCK_ATTACH = expand(ATTACH_COUNTS).map((v, i) => ({ id: i + 1, category: v }));

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
        /* 台账 / 附件：只用来算「在用」条数与找孤儿值，判据在调用方，这里原样返回整行 */
        if (table === 'ar_ledger') return Promise.resolve({ data: MOCK_ROWS, error: null }).then(res, rej);
        if (table === 'ar_attachments') return Promise.resolve({ data: MOCK_ATTACH, error: null }).then(res, rej);
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

const Auth = { isAdmin: true, isSuperAdmin: true, currentUser: { id: 'u1', name: '韩志远' } };

(async () => {
  await Dicts.load();
  const h = location.hash;
  const has = t => h.indexOf(t) >= 0;
  /* 场景与类别解耦：类别由 hash 里的关键词挑，测量用哪个类别就写哪个关键词。
     #measure 跑在 client_attr（有孤儿值）上；#measure-clean 跑在默认的 project_status
     （4 项）上 —— 后者才是「右栏留白」最初被投诉的那个场景。 */
  const pick = () => {
    if (['#managed', '#orphan', '#renamed', '#saveimpact', '#confirm'].indexOf(h) >= 0) return 'client_attr';
    if (has('many')) return 'work_nature';
    if (has('attach')) return 'attach_category';
    if (has('dirty')) return 'debt_status';
    if (has('measure-clean')) return 'project_status';
    if (has('measure')) return 'client_attr';
    return 'project_status';
  };
  await DictAdmin.load(pick());
  const doMeasure = has('measure');

  if (has('dirty')) {
    const inp = document.querySelector('.dict-item');
    inp.value = inp.value + '·改';
    inp.dispatchEvent(new Event('input'));
  }

  /* 改名首项「内部单位」（3 条在用）—— 原值当场变成孤儿值，
     一致性卡片应立刻出现警示并在列表里列出这个值 */
  if (has('renamed') || has('saveimpact')) {
    const inp = document.querySelector('.dict-item');
    inp.value = '内部单位·改';
    inp.dispatchEvent(new Event('input'));
  }

  if (has('confirm')) {
    document.querySelector('.dict-table tbody [data-act="del"]').click();
  }

  /* 保存前的影响面确认：只把「内部单位」改名后点保存，
     应当先弹出「将移除 1 个仍在使用的选项，共影响 3 条台账」的确认框 */
  if (has('saveimpact')) {
    document.querySelector('#page-dict [data-act="save"]').click();
  }

  if (doMeasure) {
    const box = e => { const r = e.getBoundingClientRect(); return 'L' + Math.round(r.left) + ' x' + Math.round(r.top) + ' w' + Math.round(r.width) + ' h' + Math.round(r.height); };
    const out = [];
    const q = s => document.querySelector(s);
    const qa = s => [...document.querySelectorAll(s)];

    out.push('面板: ' + box(q('.dict-panel')) + '  左栏: ' + box(q('.dict-cats')) + '  右栏: ' + box(q('.dict-main')));
    out.push('视口高=' + window.innerHeight + '  面板高=' + Math.round(q('.dict-panel').getBoundingClientRect().height)
      + '  面板底缘 y=' + Math.round(q('.dict-panel').getBoundingClientRect().bottom)
      + '  选项行数=' + qa('.dict-table tbody tr').length);
    /* 右栏空白：表格底缘到一致性卡片顶缘的距离 —— 这就是「选项管理右栏留白」的量化口径。
       不量「.dm-body 底缘 − 末块底缘」：卡片用 margin-top:auto 贴底，那个差值恒为 0，
       会把中间的空白完全掩盖掉。 */
    const consist0 = q('.dm-consist');
    const gapOf = () => {
      const tb = q('.dict-table');
      if (!tb) return 0;
      const bottom = tb.getBoundingClientRect().bottom;
      const next = consist0 ? consist0.getBoundingClientRect().top : q('.dm-body').getBoundingClientRect().bottom;
      return Math.round(next - bottom);
    };
    out.push('右栏空白=' + gapOf() + 'px（表格底缘 → 卡片顶缘；越大越像没做完）');
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

    /* —— 「在用」列与一致性卡片（本轮新增的两块） —— */
    const useCells = qa('.dict-table tbody .dt-use');
    out.push('当前类别=' + DictAdmin.current + '  选项来源=' + DictAdmin.usageSrc.table + '.' + DictAdmin.usageSrc.col);
    out.push('在用列表头=' + qa('.dict-table thead .dt-use').length + ' 个，单元格=' + useCells.length
      + ' 个（应与选项行数相同），首格=' + (useCells[0] ? useCells[0].textContent.trim() : '（无）'));
    const consist = q('.dm-consist');
    out.push('一致性卡片: ' + (consist ? box(consist) : '（没渲染 —— 应该有）'));
    const alertEl = q('.du-alert');
    out.push('  警示: ' + (alertEl ? alertEl.textContent.trim() : '（无；在 #renamed/#saveimpact 场景应出现）'));
    const orRows = qa('.du-row');
    out.push('  选项外的值 ' + orRows.length + ' 个 —— '
      + (orRows.length ? orRows.map(r => r.querySelector('.du-val').textContent + '／'
          + r.querySelector('.du-src').textContent + '／'
          + r.querySelector('.du-cnt').textContent).join('  |  ') : '（本类别数据里的值都在选项表中）'));
    out.push('  与台账对账: ' + DictAdmin.current + ' 覆盖 ' + [...DictAdmin.usage.values()].reduce((a, b) => a + b, 0)
      + ' ' + DictAdmin.usageSrc.unit + '，去重后 ' + DictAdmin.usage.size + ' 个值；选项表 ' + DictAdmin.items.length + ' 项');
    /* 一键收编：选项表 +1、选项外的值 −1（没有孤儿值时无事可做，不算失败） */
    const adoptBtn = q('[data-act="adopt"]');
    if (adoptBtn) {
      const beforeN = DictAdmin.items.length, beforeOr = orRows.length;
      adoptBtn.click();
      const okAdopt = DictAdmin.items.length === beforeN + 1 && qa('.du-row').length === beforeOr - 1;
      out.push('  点「加入选项」: 选项数 ' + beforeN + ' → ' + DictAdmin.items.length
        + '，选项外的值 ' + beforeOr + ' → ' + qa('.du-row').length + (okAdopt ? ' ✓' : ' ✗'));
    } else {
      out.push('  没有需要收编的值，无需此动作 ✓');
    }

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
/* 与外层真实骨架逐字一致：一句覆写都不加。
   早期这里写死 .preview-shell{height:900px} + .page-container{height:100%}，
   实测证明那不是「预览独有的失真」—— 真实骨架的 .app-shell{min-height:100vh}
   同样让百分比链解析出了确定值，面板一样被撑到 792px。
   写死高度只会掩盖真实问题，骨架类预览页一律不覆写外壳高度。 */
.preview-shell { overflow-x: hidden; }
</style>
</head>
<body>
<div class="preview-note">
  <b>选项管理页视觉预览</b> · 模拟字典数据，不连数据库 ·
  与真实系统同源：<code>css/style.css</code> + <code>js/dictadmin.js</code> ·
  <code>#managed</code> 已入库+有孤儿值 · <code>#renamed</code> 改名后的警示 ·
  <code>#saveimpact</code> 保存前影响面确认 · <code>#many</code> 18 项长列表 ·
  <code>#attach</code> 附件类别 · <code>#confirm</code> 删除确认 ·
  <code>#measure</code> 打印几何测量
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
        <span class="user-dept">财务资产部</span><span class="user-name">韩志远</span>
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
