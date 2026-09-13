/**
 * dashboard.js - 数据看板（首屏）
 * 数据来源：Ledger.rows（RLS 已按部门权限隔离，与台账总览口径一致）
 * 图表：纯 SVG 手绘，无外部依赖
 * 规则复用：Utils.overdueStatus（应收余额 = 应收合计 - 已到账；超期 = 完工日期 + warn_days）
 */

const Dashboard = {

  render() {
    const page = document.getElementById('page-dashboard');
    if (!page) return;
    const rows = Ledger.rows || [];
    const warnDays = Ledger.settings.warn_days || 90;

    if (!rows.length) {
      page.innerHTML = `
        <div class="dash-empty">
          <p>暂无可统计的台账数据</p>
          <p class="muted">可能原因：账号未开放台账查看权限，或本部门尚无台账记录。</p>
        </div>`;
      return;
    }

    /* ---------- 汇总 ---------- */
    const st = r => Utils.overdueStatus(r, warnDays);
    const sum = (fn) => rows.reduce((s, r) => s + fn(r), 0);
    const totalContract = sum(r => Number(r.contract_amount || 0));
    const totalReceivable = sum(r => Number(r.receivable_total || 0));
    const totalReceived = sum(r => Number(r.received_amount || 0));
    const totalBalance = sum(r => st(r).balance || 0);
    const totalInvoiced = sum(r => Number(r.invoiced_amount || 0));
    const overdueRows = rows.map(r => ({ r, s: st(r) })).filter(x => x.s.level === 'overdue');
    const overdueBalance = overdueRows.reduce((s, x) => s + x.s.balance, 0);
    const settledCount = rows.filter(r => st(r).level === 'settled').length;

    /* ---------- 图表数据 ---------- */
    const byDept = {};
    rows.forEach(r => {
      const k = r.dept_name || '未填写';
      byDept[k] = (byDept[k] || 0) + (st(r).balance || 0);
    });
    const deptBars = Object.entries(byDept)
      .filter(([, v]) => v > 0)
      .sort((a, b) => b[1] - a[1]).slice(0, 8);

    const statusCounts = { overdue: 0, soon: 0, ok: 0, none: 0, settled: 0 };
    rows.forEach(r => statusCounts[st(r).level]++);

    page.innerHTML = `
      <div class="dash-kpis">
        <div class="kpi-card">
          <div class="kpi-label">合同总额</div>
          <div class="kpi-value">${this.wan(totalContract)}</div>
          <div class="kpi-sub">共 ${rows.length} 笔合同</div>
        </div>
        <div class="kpi-card">
          <div class="kpi-label">应收合计 / 已到账</div>
          <div class="kpi-value">${this.wan(totalReceivable)}<span class="kpi-sep">/</span>${this.wan(totalReceived)}</div>
          <div class="kpi-sub">开票 ${this.wan(totalInvoiced)} · 回款率 ${totalReceivable > 0 ? Math.round(totalReceived / totalReceivable * 100) : 0}%</div>
        </div>
        <div class="kpi-card">
          <div class="kpi-label">应收余额（未回款）</div>
          <div class="kpi-value kpi-blue">${this.wan(totalBalance)}</div>
          <div class="kpi-sub">已结清 ${settledCount} 笔</div>
        </div>
        <div class="kpi-card kpi-danger">
          <div class="kpi-label">超期预警</div>
          <div class="kpi-value">${overdueRows.length}<span class="kpi-unit">笔</span></div>
          <div class="kpi-sub">超期余额 ${this.wan(overdueBalance)} · 预警线 ${warnDays} 天</div>
        </div>
      </div>

      <div class="dash-grid">
        <div class="dash-card">
          <div class="dash-card-head"><h3>各施工部门应收余额 TOP8</h3></div>
          <div class="dash-card-body">${this.deptChart(deptBars)}</div>
        </div>
        <div class="dash-card">
          <div class="dash-card-head"><h3>收款状态构成</h3></div>
          <div class="dash-card-body">${this.statusChart(statusCounts, rows.length)}</div>
        </div>
      </div>

      <div class="dash-card">
        <div class="dash-card-head">
          <h3>超期预警 TOP10</h3>
          <span class="muted">按应收余额排序</span>
        </div>
        <div class="table-wrap">
          <table class="ledger-table dash-table">
            <thead><tr>
              <th style="min-width:100px;max-width:100px">合同编号</th>
              <th style="min-width:200px;max-width:200px">项目名称</th>
              <th style="min-width:90px;max-width:90px">施工部门</th>
              <th style="min-width:100px;max-width:100px" class="ta-r">应收余额</th>
              <th style="min-width:84px;max-width:84px" class="ta-r">超期天数</th>
              <th style="min-width:96px;max-width:96px" class="ta-r">催收/询证日期</th>
            </tr></thead>
            <tbody>
              ${overdueRows.length
                ? overdueRows.sort((a, b) => b.s.balance - a.s.balance).slice(0, 10).map(x => `
                  <tr>
                    <td title="${Utils.escapeHtml(x.r.contract_no || '')}">${Utils.escapeHtml(x.r.contract_no || '—')}</td>
                    <td class="td-name" title="${Utils.escapeHtml(x.r.project_name || '')}">${Utils.escapeHtml(Utils.clampName(x.r.project_name || '（未填项目）'))}</td>
                    <td>${Utils.escapeHtml(x.r.dept_name || '未填写')}</td>
                    <td class="ta-r td-money owed">${Utils.fmtMoney(x.s.balance)}</td>
                    <td class="ta-r"><span class="tag tag-overdue">${x.s.days - warnDays} 天</span></td>
                    <td class="ta-r">${Utils.escapeHtml(x.r.dunning_date || '—')}</td>
                  </tr>`).join('')
                : '<tr><td colspan="6" class="empty-cell">暂无超期合同 ✓</td></tr>'}
            </tbody>
          </table>
        </div>
      </div>`;
  },

  /* ---------- 施工部门条形图 ---------- */
  deptChart(bars) {
    if (!bars.length) return '<div class="dash-empty-sm">暂有余额为 0，无需展示</div>';
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

  /* ---------- 收款状态构成（水平堆叠条 + 图例） ---------- */
  statusChart(counts, total) {
    const defs = [
      ['settled', '已结清', '#16a34a'],
      ['overdue', '超期', '#dc2626'],
      ['soon', '临近超期', '#d97706'],
      ['ok', '未超期', '#2563eb'],
      ['none', '未定（无完工日期）', '#94a3b8'],
    ].filter(([k]) => counts[k] > 0);
    if (!defs.length) return '<div class="dash-empty-sm">暂无数据</div>';
    const W = 520, H = 96, barY = 18, barH = 28;
    let x = 0;
    const segs = defs.map(([key, label, color]) => {
      const w = W * counts[key] / total;
      const seg = `<rect x="${x}" y="${barY}" width="${Math.max(w - 1, 1)}" height="${barH}" fill="${color}"/>`;
      x += w;
      return seg;
    }).join('');
    const legend = defs.map(([key, label, color]) => `
      <div class="dash-legend-item">
        <i style="background:${color}"></i>${label}
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
