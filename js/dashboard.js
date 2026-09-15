/**
 * dashboard.js - 数据看板 v3（新指标体系口径）
 * 数据来源：Ledger.rows（RLS 已按部门权限隔离，与台账总览口径一致）
 * 口径：账内应收 = 开票 − 到账；账外应收 = 决算 − 开票；
 *      应收余额 = 决算 − 到账 − 核销；债权状态为手工维护（正常/逾期/诉讼/和解）
 *      决算金额未定的行：账外应收 / 应收余额不计入合计（KPI 附提示笔数）
 * 视角：部门（责任口径）与 单位（债权主体法人口径）正交聚合（CONTEXT.md「组织」）
 * 趋势：月度开票/回款（数据源 ar_invoices / ar_receipts 明细表，表未建时该卡静默隐藏）
 *
 * 图表：纯 SVG 手绘，无外部依赖。
 *   ⚠ 关键：SVG 用 viewBox + width:100% 时，容器比 viewBox 宽多少，图内文字就放
 *   大多少倍（520 宽的 viewBox 放进 1400px 卡片 → 12px 文字渲染成 32px）。
 *   因此这里**先量容器宽度再生成 viewBox**（见 paintCharts），缩放比恒为 1，
 *   文字尺寸即设计尺寸；同时用 max-width 封顶，避免超宽屏上条形长得失去可比性。
 * 配色：颜色只承载语义，不承载装饰——「欠款量级」类图统一主色，
 *   仅「客户属性大类」与「债权状态」使用分类/语义色。
 */

/* —— 图表色板（对应 css/style.css :root 令牌的 sRGB 等价色）—— */
const C_PRIMARY   = '#21539c';   // --primary
const C_INK_950   = '#101926';   // --ink-950
const C_INK_600   = '#5f6771';   // --ink-600
const C_INK_500   = '#7a818b';   // --ink-500
const C_INK_400   = '#a0a5ad';   // --ink-400
const C_LINE      = '#e0e3e8';   // --line
const C_SURFACE_3 = '#ecf0f5';   // --surface-3
const C_DANGER    = '#b51f1c';   // --danger
const C_OK        = '#267543';   // --ok
const C_TEAL      = '#006a6a';   // --teal
const C_VIOLET    = '#623e96';   // --violet

/** 图表宽度上限：超过这个宽度条形过长、标签与数值距离过远，反而不好读 */
const DASH_MAX_W = 1120;

/** 客户属性大类着色（分类用色，刻意避开红/琥珀以免与风险语义混淆） */
function groupColorOf(name) {
  if (/^内部单位/.test(name)) return C_INK_600;
  if (/^政府部门/.test(name)) return C_PRIMARY;
  if (/^煤矿集团/.test(name)) return C_TEAL;
  if (/^社会客户/.test(name)) return C_VIOLET;
  return C_INK_400;
}

const Dashboard = {

  /* 图表数据缓存（供窗口尺寸变化后重绘，避免重新拉数据） */
  _ch: null,
  _resizeBound: false,

  render() {
    const page = document.getElementById('page-dashboard');
    if (!page) return;
    const rows = Ledger.rows || [];

    if (!rows.length) {
      this._ch = null;
      page.innerHTML = `
        <div class="dash-empty">
          <p>暂无可统计的台账数据</p>
          <p class="muted">可能原因：账号未开放台账查看权限，或本部门尚无台账记录。</p>
        </div>`;
      return;
    }

    /* ---------- 汇总（决算未定的行不参与账外/余额合计，CONTEXT.md 口径） ---------- */
    const comp = r => Ledger.computeRow(r);
    const sum = (fn) => rows.reduce((s, r) => s + fn(r), 0);
    const hasFinal = r => r.final_amount !== null && r.final_amount !== undefined && r.final_amount !== '';
    const unfinalCount = rows.filter(r => !hasFinal(r)).length;
    const finalCount = rows.length - unfinalCount;
    const totalFinal = sum(r => Number(r.final_amount || 0));
    const totalInvoiced = sum(r => Number(r.invoiced_amount || 0));
    const totalReceived = sum(r => Number(r.received_amount || 0));
    const totalWriteoff = sum(r => Number(r.writeoff_amount || 0));
    const totalInternal = sum(r => comp(r).receivable_internal);
    const totalExternal = sum(r => Number(comp(r).receivable_external) || 0);
    const totalBalance = sum(r => Number(comp(r).receivable_balance) || 0);

    /* 债权状态构成 */
    const debtCounts = {};
    rows.forEach(r => {
      const k = r.debt_status || '未填写';
      debtCounts[k] = (debtCounts[k] || 0) + 1;
    });

    /* 部门应收余额 TOP8 */
    const byDept = {};
    rows.forEach(r => {
      const k = Ledger.deptNameOf(r);
      byDept[k] = (byDept[k] || 0) + Number(comp(r).receivable_balance || 0);
    });
    const deptBars = Object.entries(byDept)
      .filter(([, v]) => v > 0)
      .sort((a, b) => b[1] - a[1]).slice(0, 8);

    /* 各单位（债权主体，法人口径）应收余额——部门与单位正交，按行上「单位」字段聚合 */
    const byUnit = {};
    rows.forEach(r => {
      const k = r.creditor_unit || '未填写';
      byUnit[k] = (byUnit[k] || 0) + Number(comp(r).receivable_balance || 0);
    });
    const unitBars = Object.entries(byUnit)
      .filter(([, v]) => v > 0)
      .sort((a, b) => b[1] - a[1]);

    /* 客户应收余额 TOP10（按客户名称聚合） */
    const byCust = {};
    rows.forEach(r => {
      const k = r.owner_unit && String(r.owner_unit).trim() || '未填写';
      byCust[k] = (byCust[k] || 0) + Number(comp(r).receivable_balance || 0);
    });
    const custBars = Object.entries(byCust)
      .filter(([, v]) => v > 0)
      .sort((a, b) => b[1] - a[1]).slice(0, 10);

    /* 客户属性欠款构成（按大类着色：内部单位/政府部门/煤矿集团/社会客户） */
    const ATTR_GROUPS = [
      ['内部单位', /^内部单位/], ['政府部门', /^政府部门/],
      ['煤矿集团', /^煤矿集团/], ['社会客户', /^社会客户/], ['其他', /.*/],
    ];
    const groupOf = name => ATTR_GROUPS.find(([, re]) => re.test(name))[0];
    const byAttr = {};
    rows.forEach(r => {
      const k = r.client_attr && String(r.client_attr).trim() || '未填写';
      byAttr[k] = (byAttr[k] || 0) + Number(comp(r).receivable_balance || 0);
    });
    const attrBars = Object.entries(byAttr)
      .filter(([, v]) => v > 0)
      .sort((a, b) => b[1] - a[1]);
    const attrGroupTotals = {};
    attrBars.forEach(([k, v]) => {
      const g = groupOf(k);
      attrGroupTotals[g] = (attrGroupTotals[g] || 0) + v;
    });

    /* 催收跟踪 TOP10：欠款 > 0，优先逾期，再按最新催收时间最早
       欠款口径：决算已定 = 应收余额；决算未定 = 账内应收（开票−到账，照样要催） */
    const owedOf = r => {
      const b = comp(r).receivable_balance;
      return b === null ? comp(r).receivable_internal : b;
    };
    const tracking = rows
      .filter(r => owedOf(r) > 0)
      .sort((a, b) => {
        const ra = a.debt_status === '逾期' ? 0 : 1, rb = b.debt_status === '逾期' ? 0 : 1;
        if (ra !== rb) return ra - rb;
        return String(a.dunning_date || '9999').localeCompare(String(b.dunning_date || '9999'));
      }).slice(0, 10);

    page.innerHTML = `
      <div class="dash-kpis">
        <div class="kpi-card">
          <div class="kpi-label">决算总额（应收总量）</div>
          <div class="kpi-value">${this.wan(totalFinal)}</div>
          <div class="kpi-sub">共 ${rows.length} 笔 · 已定案 ${finalCount} 笔 · 开票 ${this.wan(totalInvoiced)}</div>
        </div>
        <div class="kpi-card">
          <div class="kpi-label">账内应收（开票 − 到账）</div>
          <div class="kpi-value kpi-blue">${this.wan(totalInternal)}</div>
          <div class="kpi-sub">已开票未回款 · 已到账 ${this.wan(totalReceived)}</div>
        </div>
        <div class="kpi-card">
          <div class="kpi-label">账外应收（决算 − 开票）</div>
          <div class="kpi-value">${this.wan(totalExternal)}</div>
          <div class="kpi-sub">已决算未开票${unfinalCount ? ` · ${unfinalCount} 笔决算未定未计入` : ''}</div>
        </div>
        <div class="kpi-card kpi-danger">
          <div class="kpi-label">应收余额（决算 − 到账 − 核销）</div>
          <div class="kpi-value">${this.wan(totalBalance)}</div>
          <div class="kpi-sub">已核销 ${this.wan(totalWriteoff)} · 逾期 ${debtCounts['逾期'] || 0} 笔 · 诉讼 ${debtCounts['诉讼'] || 0} 笔</div>
        </div>
      </div>

      <div class="dash-card" id="dash-trend" style="display:none">
        <div class="dash-card-head">
          <h3>月度开票 / 回款趋势</h3>
          <span class="muted">近 12 个月 · 按明细发生额 · <span id="dash-trend-note"></span></span>
        </div>
        <div class="dash-card-body"><div data-chart="trend"></div></div>
      </div>

      <div class="dash-grid">
        <div class="dash-card">
          <div class="dash-card-head">
            <h3>各单位应收余额（债权主体）</h3>
            <span class="muted">法人口径 · 按台账「单位」列聚合</span>
          </div>
          <div class="dash-card-body"><div data-chart="unit"></div></div>
        </div>
        <div class="dash-card">
          <div class="dash-card-head"><h3>债权状态构成</h3><span class="muted">人工维护的处置阶段</span></div>
          <div class="dash-card-body"><div data-chart="debt"></div></div>
        </div>
      </div>

      <div class="dash-grid even">
        <div class="dash-card">
          <div class="dash-card-head"><h3>各部门应收余额 TOP8</h3><span class="muted">责任口径 · 按部门归属</span></div>
          <div class="dash-card-body"><div data-chart="dept"></div></div>
        </div>
        <div class="dash-card">
          <div class="dash-card-head"><h3>客户应收余额 TOP10</h3><span class="muted">催收对象排序 · 按客户名称聚合</span></div>
          <div class="dash-card-body"><div data-chart="cust"></div></div>
        </div>
      </div>

      <div class="dash-card">
        <div class="dash-card-head">
          <h3>客户属性欠款构成</h3>
          <span class="muted">按 15 类客户属性聚合 · 四大类着色（政府部门 / 煤矿集团 / 社会客户 / 内部单位）</span>
        </div>
        <div class="dash-card-body"><div data-chart="attr"></div></div>
      </div>

      <div class="dash-card">
        <div class="dash-card-head">
          <h3>催收跟踪 TOP10</h3>
          <span class="muted">逾期优先 · 再按最新催收时间从早到晚 · 决算未定按账内应收计</span>
        </div>
        <div class="table-wrap">
          <table class="ledger-table dash-table">
            <thead><tr>
              <th style="min-width:100px;max-width:100px">合同编号</th>
              <th style="min-width:200px;max-width:200px">项目名称</th>
              <th style="min-width:90px;max-width:90px">部门</th>
              <th style="min-width:100px;max-width:100px" class="ta-r">应收余额</th>
              <th style="min-width:84px;max-width:84px" class="ta-r">债权状态</th>
              <th style="min-width:104px;max-width:104px" class="ta-r">最新催收时间</th>
              <th style="min-width:90px;max-width:90px">清收责任人</th>
            </tr></thead>
            <tbody>
              ${tracking.length
                ? tracking.map(r => `
                  <tr>
                    <td title="${Utils.escapeHtml(r.contract_no || '')}">${Utils.escapeHtml(r.contract_no || '—')}</td>
                    <td class="td-name" title="${Utils.escapeHtml(r.project_name || '')}">${Utils.escapeHtml(Utils.clampName(r.project_name || '（未填项目）'))}</td>
                    <td>${Utils.escapeHtml(Ledger.deptNameOf(r))}</td>
                    <td class="ta-r td-money owed" ${comp(r).receivable_balance === null ? 'title="决算未定，此处为账内应收（开票−到账）"' : ''}>${Utils.fmtMoney(owedOf(r))}${comp(r).receivable_balance === null ? '<span class="muted">*</span>' : ''}</td>
                    <td class="ta-r">${r.debt_status ? `<span class="tag ${TAG_COLORS[r.debt_status] || 'tag-gray'}">${Utils.escapeHtml(r.debt_status)}</span>` : '—'}</td>
                    <td class="ta-r">${Utils.escapeHtml(r.dunning_date || '—')}</td>
                    <td>${Utils.escapeHtml(r.collector || '—')}</td>
                  </tr>`).join('')
                : '<tr><td colspan="7" class="empty-cell">暂无未清收合同 ✓</td></tr>'}
            </tbody>
          </table>
        </div>
      </div>`;

    /* 图表数据入缓存 → 量宽绘制（render 时页面已可见，clientWidth 有效） */
    this._ch = {
      unit: unitBars, dept: deptBars, cust: custBars,
      attr: attrBars, attrTotals: attrGroupTotals,
      debt: { counts: debtCounts, total: rows.length },
      trend: null,
    };
    this.bindResize();
    this.paintCharts();
    this.loadTrend();
  },

  /* ---------- 按容器实测宽度绘制全部图表（缩放比恒为 1） ---------- */
  paintCharts() {
    const page = document.getElementById('page-dashboard');
    const ch = this._ch;
    if (!page || !ch) return;

    const paint = (name, build) => {
      const el = page.querySelector(`[data-chart="${name}"]`);
      if (!el) return;
      const w = Math.round(el.clientWidth);
      if (!w || w < 80) return;   // 容器不可见（如趋势卡尚未展开）→ 稍后重绘
      el.innerHTML = build(Math.min(w, DASH_MAX_W));
    };

    paint('unit', w => this.unitChart(ch.unit, w));
    paint('debt', w => this.debtChart(ch.debt.counts, ch.debt.total, w));
    paint('dept', w => this.deptChart(ch.dept, w));
    paint('cust', w => this.custChart(ch.cust, w));
    paint('attr', w => this.attrChart(ch.attr, w) + this.attrLegend(ch.attrTotals));
    if (ch.trend) paint('trend', w => this.trendChart(ch.trend.months, ch.trend.invMap, ch.trend.recvMap, w));
  },

  /* 窗口尺寸变化 → 防抖重绘（不重新请求数据） */
  bindResize() {
    if (this._resizeBound) return;
    this._resizeBound = true;
    let timer = null;
    window.addEventListener('resize', () => {
      clearTimeout(timer);
      timer = setTimeout(() => {
        if (typeof App !== 'undefined' && App.currentView === 'dashboard') this.paintCharts();
      }, 160);
    });
  },

  /* ---------- 月度开票/回款趋势（ar_invoices / ar_receipts 明细聚合） ---------- */
  async loadTrend() {
    const card = document.getElementById('dash-trend');
    if (!card) return;

    /* 近 12 个月起始日（含当月） */
    const since = new Date();
    since.setMonth(since.getMonth() - 11, 1);
    const sinceStr = since.toISOString().slice(0, 10);

    let inv, recv;
    try {
      [inv, recv] = await Promise.all([
        sb.from('ar_invoices').select('invoice_date,amount').gte('invoice_date', sinceStr),
        sb.from('ar_receipts').select('receipt_date,amount').gte('receipt_date', sinceStr),
      ]);
    } catch (e) { card.remove(); return; }
    /* 明细表未建（upgrade-v3.1-receipts.sql 未执行）或查询失败 → 静默隐藏整卡 */
    if ((inv && inv.error) || (recv && recv.error)) { card.remove(); return; }

    /* 页面可能已切走，缓存已重置 */
    if (!this._ch) return;

    const months = [];
    const now = new Date();
    for (let i = 11; i >= 0; i--) {
      const d = new Date(now.getFullYear(), now.getMonth() - i, 1);
      months.push(`${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`);
    }
    const bucket = (arr, dateKey) => {
      const m = {};
      (arr || []).forEach(x => {
        const k = String(x[dateKey] || '').slice(0, 7);
        if (k) m[k] = (m[k] || 0) + Number(x.amount || 0);
      });
      return m;
    };
    const invMap = bucket(inv.data, 'invoice_date');
    const recvMap = bucket(recv.data, 'receipt_date');

    /* 本自然月摘要 */
    const curMonth = months[months.length - 1];
    const note = document.getElementById('dash-trend-note');
    if (note) note.textContent = `本月已开票 ${this.wan(invMap[curMonth] || 0)} · 已回款 ${this.wan(recvMap[curMonth] || 0)}`;

    this._ch.trend = { months, invMap, recvMap };
    card.style.display = '';
    this.paintCharts();
  },

  /* 月度双序列分组柱状图：开票（蓝）/ 回款（绿） */
  trendChart(months, invMap, recvMap, W = 560) {
    const vals = months.map(m => [Number(invMap[m] || 0), Number(recvMap[m] || 0)]);
    if (!vals.some(v => v[0] > 0 || v[1] > 0)) {
      return '<div class="dash-empty-sm">近 12 个月无开票 / 回款明细记录<br><span class="muted">在编辑弹窗的「开票明细 / 回款明细」区块登记后，此处自动汇总</span></div>';
    }
    const max = Math.max(...vals.flat());
    const H = 196, top = 28, bottom = 42;
    const plotH = H - top - bottom;
    const groupW = W / months.length;
    /* 柱宽随容器伸缩，但设上限，避免超宽屏上柱子变成细线、柱间出现大空洞 */
    const barW = Math.max(5, Math.min(20, groupW * 0.30));
    const y = v => top + plotH * (1 - v / max);

    const bars = months.map((m, i) => {
      const cx = i * groupW + groupW / 2;
      const [iv, rv] = vals[i];
      const x1 = cx - barW - 1, x2 = cx + 1;
      const label = Number(m.slice(5)) + '月';
      const lab = i === 0 || Number(m.slice(5)) === 1 ? String(m.slice(2, 4)) + '年' : label;
      const t1 = iv > 0 ? `<text x="${x1 + barW / 2}" y="${y(iv) - 5}" text-anchor="middle" font-size="9" fill="${C_PRIMARY}">${this.wanShort(iv)}</text>` : '';
      const t2 = rv > 0 ? `<text x="${x2 + barW / 2}" y="${y(rv) - 5}" text-anchor="middle" font-size="9" fill="${C_OK}">${this.wanShort(rv)}</text>` : '';
      /* 悬停显示精确金额（柱顶标注为短格式，避免相邻柱标签重叠） */
      const tip = `${m.slice(0, 4)}年${Number(m.slice(5))}月 · 开票 ${Utils.fmtMoney(iv)} · 回款 ${Utils.fmtMoney(rv)}`;
      return `<g><title>${Utils.escapeHtml(tip)}</title>
        ${t1}<rect x="${x1}" y="${y(iv)}" width="${barW}" height="${Math.max(top + plotH - y(iv), iv > 0 ? 2 : 0)}" rx="2" fill="${C_PRIMARY}"/>
        ${t2}<rect x="${x2}" y="${y(rv)}" width="${barW}" height="${Math.max(top + plotH - y(rv), rv > 0 ? 2 : 0)}" rx="2" fill="${C_OK}"/>
        <text x="${cx}" y="${H - 18}" text-anchor="middle" font-size="11" fill="${C_INK_500}">${lab}</text></g>`;
    }).join('');
    const axis = `<line x1="0" y1="${top + plotH}" x2="${W}" y2="${top + plotH}" stroke="${C_LINE}"/>`;
    return `
      <svg viewBox="0 0 ${W} ${H}" role="img"
           aria-label="近 12 个月开票与回款趋势柱状图" style="width:100%;max-width:${W}px;height:auto">${axis}${bars}</svg>
      <div class="dash-legend">
        <div class="dash-legend-item"><i style="background:${C_PRIMARY}"></i>开票</div>
        <div class="dash-legend-item"><i style="background:${C_OK}"></i>回款</div>
        <div class="dash-legend-item muted">柱顶为万元短标注 · 悬停看精确金额</div>
      </div>`;
  },

  /** 金额短格式（趋势图柱顶标注用，无货币符） */
  wanShort(n) {
    const v = Number(n) || 0;
    const abs = Math.abs(v);
    if (abs >= 100000000) return (v / 100000000).toFixed(1).replace(/\.0$/, '') + '亿';
    if (abs >= 10000) return (v / 10000).toFixed(abs >= 1000000 ? 0 : 1).replace(/\.0$/, '') + '万';
    return String(Math.round(v));
  },

  /* ---------- 部门条形图（责任口径） ---------- */
  deptChart(bars, W) {
    return this.barChart(bars, { color: C_PRIMARY, labelW: 96, title: '各部门应收余额' }, W);
  },

  /* ---------- 单位（债权主体）条形图 ---------- */
  unitChart(bars, W) {
    return this.barChart(bars, { color: C_PRIMARY, labelW: 84, title: '各单位应收余额' }, W);
  },

  /* ---------- 客户条形图（长名称，标签加宽） ---------- */
  custChart(bars, W) {
    return this.barChart(bars, { color: C_PRIMARY, labelW: 132, labelMax: 12, title: '客户应收余额' }, W);
  },

  /* ---------- 客户属性条形图（按大类着色） ---------- */
  attrChart(bars, W) {
    return this.barChart(bars, { labelW: 120, labelMax: 10, colorBy: name => groupColorOf(name), title: '客户属性欠款构成' }, W);
  },

  /* 客户属性大类图例（含各类合计） */
  attrLegend(groupTotals) {
    const entries = Object.entries(groupTotals).sort((a, b) => b[1] - a[1]);
    if (!entries.length) return '';
    return `<div class="dash-legend">${entries.map(([g, v]) => `
      <div class="dash-legend-item"><i style="background:${groupColorOf(g)}"></i>${g}
        <b>${this.wan(v)}</b><span>欠款</span>
      </div>`).join('')}</div>`;
  },

  /* ---------- 通用水平条形图（W = 容器实测宽度） ---------- */
  barChart(bars, opts = {}, W = 520) {
    if (!bars.length) return '<div class="dash-empty-sm">暂无未清应收余额</div>';
    const color = opts.color || C_PRIMARY, labelW = opts.labelW || 96;
    const labelMax = opts.labelMax || 7;
    const max = Math.max(...bars.map(b => b[1]));
    const rowH = 34, barH = 16, valueW = 80;
    const H = bars.length * rowH + 8;
    const innerW = Math.max(80, W - labelW - valueW);
    const svg = bars.map(([name, val], i) => {
      const y = 8 + i * rowH;
      const w = Math.max(3, innerW * val / max);
      const barColor = opts.colorBy ? opts.colorBy(name) : color;
      const label = name.length > labelMax ? name.slice(0, labelMax) + '…' : name;
      return `<g><title>${Utils.escapeHtml(name)} ${this.wan(val)}</title>
        <text x="${labelW - 10}" y="${y + barH / 2 + 4}" text-anchor="end" font-size="12" fill="${C_INK_600}">${Utils.escapeHtml(label)}</text>
        <rect x="${labelW}" y="${y}" width="${w}" height="${barH}" rx="2" fill="${barColor}"/>
        <text x="${labelW + w + 8}" y="${y + barH / 2 + 4}" font-size="12" fill="${C_INK_950}" font-weight="600">${this.wan(val)}</text></g>`;
    }).join('');
    const aria = `${opts.title || '条形图'}：` + bars.map(([n, v]) => `${n} ${this.wan(v)}`).join('，');
    return `<svg viewBox="0 0 ${W} ${H}" role="img" aria-label="${Utils.escapeHtml(aria)}"
                 style="width:100%;max-width:${W}px;height:auto">${svg}</svg>`;
  },

  /* ---------- 债权状态构成（水平堆叠条 + 图例） ---------- */
  debtChart(counts, total, W = 520) {
    const defs = [
      ['正常', C_OK], ['逾期', C_DANGER], ['诉讼', C_VIOLET],
      ['和解', C_TEAL], ['未填写', C_INK_400],
    ].filter(([k]) => counts[k] > 0);
    if (!defs.length) return '<div class="dash-empty-sm">暂无数据</div>';
    const H = 96, barY = 18, barH = 28;
    let x = 0;
    const segs = defs.map(([key, color]) => {
      const w = W * counts[key] / total;
      const seg = `<rect x="${x}" y="${barY}" width="${Math.max(w - 1, 1)}" height="${barH}" fill="${color}"><title>${key} ${counts[key]} 笔</title></rect>`;
      x += w;
      return seg;
    }).join('');
    const legend = defs.map(([key, color]) => `
      <div class="dash-legend-item">
        <i style="background:${color}"></i>${key}
        <b>${counts[key]}</b><span>笔 · ${Math.round(counts[key] / total * 100)}%</span>
      </div>`).join('');
    const aria = `债权状态构成：` + defs.map(([k]) => `${k} ${counts[k]} 笔`).join('，');
    return `
      <svg viewBox="0 0 ${W} ${H}" role="img" aria-label="${Utils.escapeHtml(aria)}"
           style="width:100%;max-width:${W}px;height:auto">
        <rect x="0" y="${barY}" width="${W}" height="${barH}" rx="4" fill="${C_SURFACE_3}"/>
        ${segs}
        <text x="${W / 2}" y="${barY + barH + 22}" text-anchor="middle" font-size="12" fill="${C_INK_500}">共 ${total} 笔</text>
      </svg>
      <div class="dash-legend">${legend}</div>`;
  },

  /** 金额 → 万元可读格式 */
  wan(n) {
    const v = Number(n) || 0;
    const abs = Math.abs(v);
    if (abs >= 100000000) return '¥' + (v / 100000000).toFixed(abs >= 1000000000 ? 0 : 1) + '亿';
    if (abs >= 10000) return '¥' + (v / 10000).toFixed(abs >= 1000000 ? 0 : 1) + '万';
    return '¥' + v.toLocaleString('zh-CN');
  },
};
