/**
 * dashboard.js - 数据看板 v3（新指标体系口径）
 * 数据来源：Ledger.rows（RLS 已按部门权限隔离，与台账总览口径一致）
 * 口径：账内应收 = 开票 − 到账；账外应收 = 决算 − 开票；
 *      应收余额 = 决算 − 到账 − 核销；债权状态为手工维护（正常/逾期/诉讼/和解）
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

    /* ---------- 汇总 ---------- */
    const comp = r => Ledger.computeRow(r);
    const sum = (fn) => rows.reduce((s, r) => s + fn(r), 0);
    const totalFinal = sum(r => Number(r.final_amount || 0));
    const totalInvoiced = sum(r => Number(r.invoiced_amount || 0));
    const totalReceived = sum(r => Number(r.received_amount || 0));
    const totalWriteoff = sum(r => Number(r.writeoff_amount || 0));
    const totalInternal = sum(r => comp(r).receivable_internal);
    const totalExternal = sum(r => comp(r).receivable_external);
    const totalBalance = sum(r => comp(r).receivable_balance);

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
      byDept[k] = (byDept[k] || 0) + comp(r).receivable_balance;
    });
    const deptBars = Object.entries(byDept)
      .filter(([, v]) => v > 0)
      .sort((a, b) => b[1] - a[1]).slice(0, 8);

    /* 催收跟踪 TOP10：应收余额 > 0，优先逾期，再按最新催收时间最早 */
    const tracking = rows
      .filter(r => comp(r).receivable_balance > 0)
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
          <div class="kpi-sub">已决算未开票部分</div>
        </div>
        <div class="kpi-card kpi-danger">
          <div class="kpi-label">应收余额（决算 − 到账 − 核销）</div>
          <div class="kpi-value">${this.wan(totalBalance)}</div>
          <div class="kpi-sub">逾期 ${debtCounts['逾期'] || 0} 笔 · 诉讼 ${debtCounts['诉讼'] || 0} 笔</div>
        </div>
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
          <span class="muted">逾期优先 · 再按最新催收时间从早到晚</span>
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
                    <td class="ta-r td-money owed">${Utils.fmtMoney(comp(r).receivable_balance)}</td>
                    <td class="ta-r">${r.debt_status ? `<span class="tag ${TAG_COLORS[r.debt_status] || 'tag-gray'}">${Utils.escapeHtml(r.debt_status)}</span>` : '—'}</td>
                    <td class="ta-r">${Utils.escapeHtml(r.dunning_date || '—')}</td>
                    <td>${Utils.escapeHtml(r.collector || '—')}</td>
                  </tr>`).join('')
                : '<tr><td colspan="7" class="empty-cell">暂无未清收合同 ✓</td></tr>'}
            </tbody>
          </table>
        </div>
      </div>`;
  },

  /* ---------- 部门条形图 ---------- */
  deptChart(bars) {
    if (!bars.length) return '<div class="dash-empty-sm">各部门应收余额均为 0</div>';
    const max = Math.max(...bars.map(b => b[1]));
    const W = 520, rowH = 34, barH = 16, labelW = 92, valueW = 72;
    const H = bars.length * rowH + 8;
    const innerW = W - labelW - valueW;
    const svg = bars.map(([name, val], i) => {
      const y = 8 + i * rowH;
      const w = Math.max(3, innerW * val / max);
      const label = name.length > 6 ? name.slice(0, 6) + '…' : name;
      return `
        <text x="${labelW - 8}" y="${y + barH / 2 + 4}" text-anchor="end" font-size="12" fill="#64748b">${Utils.escapeHtml(label)}</text>
        <rect x="${labelW}" y="${y}" width="${w}" height="${barH}" rx="3" fill="#2563eb" opacity="0.85"/>
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
