/**
 * dashboard.js - 数据看板 v3（新指标体系口径）
 * 数据来源：Ledger.rows（RLS 已按部门权限隔离，与台账总览口径一致）
 * 口径：账内应收 = 开票 − 到账；账外应收 = 决算 − 开票；
 *      应收余额 = 决算 − 到账 − 核销；债权状态为手工维护（正常/逾期/诉讼/和解）
 *      决算金额未定的行：账外应收 / 应收余额不计入合计（KPI 附提示笔数）
 * 视角：部门（责任口径 TOP8）与 单位（债权主体法人口径）正交聚合（CONTEXT.md「组织」）
 * 趋势：月度开票/回款（数据源 ar_invoices / ar_receipts 明细表，表未建时该卡静默隐藏）
 * 图表：纯 SVG 手绘，无外部依赖
 */

const Dashboard = {

  render() {
    const page = document.getElementById('page-dashboard');
    if (!page) return;
    const rows = Ledger.rows || [];

    if (!rows.length) {
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
          <div class="kpi-label">台账笔数 / 决算总额</div>
          <div class="kpi-value">${rows.length}<span class="kpi-unit">笔</span><span class="kpi-sep">/</span>${this.wan(totalFinal)}</div>
          <div class="kpi-sub">开票 ${this.wan(totalInvoiced)} · 到账 ${this.wan(totalReceived)} · 核销 ${this.wan(totalWriteoff)}</div>
        </div>
        <div class="kpi-card">
          <div class="kpi-label">账内应收（开票 − 到账）</div>
          <div class="kpi-value kpi-blue">${this.wan(totalInternal)}</div>
          <div class="kpi-sub">已开票未回款部分</div>
        </div>
        <div class="kpi-card">
          <div class="kpi-label">账外应收（决算 − 开票）</div>
          <div class="kpi-value">${this.wan(totalExternal)}</div>
          <div class="kpi-sub">已决算未开票部分${unfinalCount ? ` · ${unfinalCount} 笔决算未定未计入` : ''}</div>
        </div>
        <div class="kpi-card kpi-danger">
          <div class="kpi-label">应收余额（决算 − 到账 − 核销）</div>
          <div class="kpi-value">${this.wan(totalBalance)}</div>
          <div class="kpi-sub">逾期 ${debtCounts['逾期'] || 0} 笔 · 诉讼 ${debtCounts['诉讼'] || 0} 笔${unfinalCount ? ` · 决算未定 ${unfinalCount} 笔` : ''}</div>
        </div>
      </div>

      <div class="dash-card" id="dash-trend" style="display:none">
        <div class="dash-card-head">
          <h3>月度开票 / 回款趋势</h3>
          <span class="muted">近 12 个月 · 按明细发生额 · <span id="dash-trend-note"></span></span>
        </div>
        <div class="dash-card-body" id="dash-trend-body"></div>
      </div>

      <div class="dash-card">
        <div class="dash-card-head">
          <h3>各单位应收余额（债权主体）</h3>
          <span class="muted">法人口径 · 按台账「单位」列聚合</span>
        </div>
        <div class="dash-card-body">${this.unitChart(unitBars)}</div>
      </div>

      <div class="dash-grid">
        <div class="dash-card">
          <div class="dash-card-head"><h3>各部门应收余额 TOP8</h3></div>
          <div class="dash-card-body">${this.deptChart(deptBars)}</div>
        </div>
        <div class="dash-card">
          <div class="dash-card-head"><h3>债权状态构成</h3></div>
          <div class="dash-card-body">${this.debtChart(debtCounts, rows.length)}</div>
        </div>
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

    this.loadTrend();
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

    document.getElementById('dash-trend-body').innerHTML =
      this.trendChart(months, invMap, recvMap);
    card.style.display = '';
  },

  /* 月度双序列分组柱状图：开票（蓝）/ 回款（绿） */
  trendChart(months, invMap, recvMap) {
    const vals = months.map(m => [Number(invMap[m] || 0), Number(recvMap[m] || 0)]);
    if (!vals.some(v => v[0] > 0 || v[1] > 0)) {
      return '<div class="dash-empty-sm">近 12 个月无开票 / 回款明细记录<br><span class="muted">在编辑弹窗的「开票明细 / 回款明细」区块登记后，此处自动汇总</span></div>';
    }
    const max = Math.max(...vals.flat());
    const W = 560, H = 176, top = 26, bottom = 40;
    const plotH = H - top - bottom;
    const groupW = W / months.length;
    const barW = Math.min(14, groupW / 3.2);
    const y = v => top + plotH * (1 - v / max);

    const bars = months.map((m, i) => {
      const cx = i * groupW + groupW / 2;
      const [iv, rv] = vals[i];
      const x1 = cx - barW - 1, x2 = cx + 1;
      const label = Number(m.slice(5)) + '月';
      const lab = i === 0 || Number(m.slice(5)) === 1 ? String(m.slice(2, 4)) + '年' : label;
      const t1 = iv > 0 ? `<text x="${x1 + barW / 2}" y="${y(iv) - 4}" text-anchor="middle" font-size="9" fill="#2563eb">${this.wanShort(iv)}</text>` : '';
      const t2 = rv > 0 ? `<text x="${x2 + barW / 2}" y="${y(rv) - 4}" text-anchor="middle" font-size="9" fill="#16a34a">${this.wanShort(rv)}</text>` : '';
      return `
        ${t1}<rect x="${x1}" y="${y(iv)}" width="${barW}" height="${Math.max(top + plotH - y(iv), iv > 0 ? 2 : 0)}" rx="2" fill="#2563eb" opacity="0.88"/>
        ${t2}<rect x="${x2}" y="${y(rv)}" width="${barW}" height="${Math.max(top + plotH - y(rv), rv > 0 ? 2 : 0)}" rx="2" fill="#16a34a" opacity="0.88"/>
        <text x="${cx}" y="${H - 18}" text-anchor="middle" font-size="10" fill="#64748b">${lab}</text>`;
    }).join('');
    const axis = `<line x1="0" y1="${top + plotH}" x2="${W}" y2="${top + plotH}" stroke="#e2e8f0"/>`;
    return `
      <svg viewBox="0 0 ${W} ${H}" style="width:100%;height:auto">${axis}${bars}</svg>
      <div class="dash-legend">
        <div class="dash-legend-item"><i style="background:#2563eb"></i>开票</div>
        <div class="dash-legend-item"><i style="background:#16a34a"></i>回款</div>
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

  /* ---------- 部门条形图 ---------- */
  deptChart(bars) {
    return this.barChart(bars, { color: '#2563eb', labelW: 92 });
  },

  /* ---------- 单位（债权主体）条形图 ---------- */
  unitChart(bars) {
    return this.barChart(bars, { color: '#0d9488', labelW: 76 });
  },

  /* ---------- 通用水平条形图 ---------- */
  barChart(bars, opts = {}) {
    if (!bars.length) return '<div class="dash-empty-sm">无未清应收余额</div>';
    const color = opts.color || '#2563eb', labelW = opts.labelW || 92;
    const max = Math.max(...bars.map(b => b[1]));
    const W = 520, rowH = 34, barH = 16, valueW = 72;
    const H = bars.length * rowH + 8;
    const innerW = W - labelW - valueW;
    const svg = bars.map(([name, val], i) => {
      const y = 8 + i * rowH;
      const w = Math.max(3, innerW * val / max);
      const label = name.length > 7 ? name.slice(0, 7) + '…' : name;
      return `
        <text x="${labelW - 8}" y="${y + barH / 2 + 4}" text-anchor="end" font-size="12" fill="#64748b">${Utils.escapeHtml(label)}</text>
        <rect x="${labelW}" y="${y}" width="${w}" height="${barH}" rx="3" fill="${color}" opacity="0.85"/>
        <text x="${labelW + w + 8}" y="${y + barH / 2 + 4}" font-size="12" fill="#1f2937" font-weight="600">${this.wan(val)}</text>`;
    }).join('');
    return `<svg viewBox="0 0 ${W} ${H}" style="width:100%;height:auto">${svg}</svg>`;
  },

  /* ---------- 债权状态构成（水平堆叠条 + 图例） ---------- */
  debtChart(counts, total) {
    const defs = [
      ['正常', '#16a34a'], ['逾期', '#dc2626'], ['诉讼', '#7c3aed'],
      ['和解', '#0d9488'], ['未填写', '#94a3b8'],
    ].filter(([k]) => counts[k] > 0);
    if (!defs.length) return '<div class="dash-empty-sm">暂无数据</div>';
    const W = 520, H = 96, barY = 18, barH = 28;
    let x = 0;
    const segs = defs.map(([key, color]) => {
      const w = W * counts[key] / total;
      const seg = `<rect x="${x}" y="${barY}" width="${Math.max(w - 1, 1)}" height="${barH}" fill="${color}"/>`;
      x += w;
      return seg;
    }).join('');
    const legend = defs.map(([key, color]) => `
      <div class="dash-legend-item">
        <i style="background:${color}"></i>${key}
        <b>${counts[key]}</b><span>笔 · ${Math.round(counts[key] / total * 100)}%</span>
      </div>`).join('');
    return `
      <svg viewBox="0 0 ${W} ${H}" style="width:100%;height:auto">
        <rect x="0" y="${barY}" width="${W}" height="${barH}" rx="6" fill="#eef2f7"/>
        ${segs}
        <text x="${W / 2}" y="${barY + barH + 22}" text-anchor="middle" font-size="12" fill="#64748b">共 ${total} 笔</text>
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
