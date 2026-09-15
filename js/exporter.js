/**
 * exporter.js - Excel 导出模块 v3（要求二：按要素筛选生成汇总表）
 *
 * - 自选导出字段（新指标体系全部字段 + 自动计算列 + 附件汇总）
 * - 按当前筛选范围或全部数据导出
 * - 末尾追加「合计」行（金额列自动求和），即财务所需汇总表
 * - 可选附带「开票明细 / 回款明细」两个附加工作表（仅含导出范围内合同，
 *   按日期排序并合计；明细表未创建时提示并跳过，台账主表照常导出）
 */

const Exporter = {

  open() {
    const old = document.getElementById('modal-export');
    if (old) old.remove();
    const count = Ledger.filteredRows().length;
    const total = Ledger.rows.length;

    const fieldItems = [...FIELD_DEFS, ...COMPUTED_DEFS].map(f => `
      <label class="exp-field"><input type="checkbox" checked data-key="${f.key}">
        <span>${f.label}</span></label>`).join('');

    const el = document.createElement('div');
    el.id = 'modal-export';
    el.className = 'modal-mask';
    el.innerHTML = `
      <div class="modal">
        <div class="modal-header">导出 Excel（汇总表） <span class="modal-close" data-act="close">×</span></div>
        <div class="modal-body">
          <div class="exp-scope">
            导出范围：
            <label><input type="radio" name="exp-scope" value="filtered" checked> 当前筛选结果（${count} 条）</label>
            <label><input type="radio" name="exp-scope" value="all"> 全部数据（${total} 条）</label>
          </div>
          <label class="exp-total-row"><input type="checkbox" id="exp-total" checked> 末尾追加「合计」行（金额列自动求和）</label>
          <label class="exp-total-row"><input type="checkbox" id="exp-details"> 附带「开票明细 / 回款明细」工作表（仅含导出范围内合同，按日期排序并合计）</label>
          <div class="exp-fields-head">
            选择导出字段
            <span class="exp-fields-ops"><a data-act="all">全选</a> / <a data-act="none">全不选</a> / <a data-act="core">常用字段</a></span>
          </div>
          <div class="exp-fields">${fieldItems}</div>
        </div>
        <div class="modal-footer">
          <button class="btn" data-act="close">取消</button>
          <button class="btn btn-primary" data-act="do">导出 Excel</button>
        </div>
      </div>`;
    document.body.appendChild(el);
    el.querySelector('[data-act="close"]').addEventListener('click', () => el.remove());
    Utils.bindMaskClose(el, () => el.remove());

    const boxes = [...el.querySelectorAll('.exp-field input')];
    const setAll = v => boxes.forEach(b => { b.checked = v; });
    el.querySelector('[data-act="all"]').addEventListener('click', () => setAll(true));
    el.querySelector('[data-act="none"]').addEventListener('click', () => setAll(false));
    el.querySelector('[data-act="core"]').addEventListener('click', () => {
      const core = ColPrefs.coreKeys();
      boxes.forEach(b => { b.checked = core.includes(b.dataset.key); });
    });
    el.querySelector('[data-act="do"]').addEventListener('click', () => {
      const scope = el.querySelector('input[name="exp-scope"]:checked').value;
      const withTotal = el.querySelector('#exp-total').checked;
      const withDetails = el.querySelector('#exp-details').checked;
      const keys = boxes.filter(b => b.checked).map(b => b.dataset.key);
      if (!keys.length) { Utils.toast('请至少选择一个导出字段', 'error'); return; }
      this.doExport(scope === 'all' ? Ledger.rows : Ledger.filteredRows(), keys, withTotal, withDetails);
      el.remove();
    });
  },

  /** 计算某行某 key 的值（含虚拟计算列） */
  valueOf(r, key) {
    const comp = Ledger.computeRow(r);
    if (key in comp) return comp[key];
    return r[key];
  },

  async doExport(rows, keys, withTotal, withDetails) {
    if (!rows.length) { Utils.toast('没有可导出的数据', 'error'); return; }
    const defs = [...FIELD_DEFS, ...COMPUTED_DEFS];
    const headers = keys.map(k => (defs.find(f => f.key === k) || {}).label || k);
    const aoa = [headers];
    rows.forEach(r => {
      aoa.push(keys.map(k => {
        const f = defs.find(x => x.key === k);
        const v = this.valueOf(r, k);
        if (f && f.type === 'money') return v === null || v === undefined || v === '' ? null : Number(v);
        if (f && f.type === 'date') return v || null;
        return v === null || v === undefined ? null : String(v);
      }));
    });
    // 合计行（金额列求和）
    if (withTotal) {
      const sumRow = keys.map((k, i) => {
        const f = defs.find(x => x.key === k);
        if (!f || f.type !== 'money') return i === 0 ? '合计' : null;
        const s = rows.reduce((acc, r) => acc + Number(this.valueOf(r, k) || 0), 0);
        return Math.round(s * 10000) / 10000;
      });
      aoa.push(sumRow);
    }
    const ws = XLSX.utils.aoa_to_sheet(aoa);
    ws['!cols'] = keys.map(k => {
      const f = defs.find(x => x.key === k);
      return { wch: k === 'project_name' ? 40 : (f && f.type === 'money' ? 14 : (f && f.type === 'date' ? 12 : 16)) };
    });
    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, ws, '应收账款台账');

    /* 附加明细工作表 */
    let detailInfo = null;
    if (withDetails) detailInfo = await this.appendDetailSheets(wb, rows);

    const d = new Date();
    const stamp = `${d.getFullYear()}${String(d.getMonth() + 1).padStart(2, '0')}${String(d.getDate()).padStart(2, '0')}`;
    XLSX.writeFile(wb, `应收账款台账_${stamp}.xlsx`);
    const extra = detailInfo ? `（含开票明细 ${detailInfo.invCount} 笔 / 回款明细 ${detailInfo.recvCount} 笔）` : '';
    Utils.toast(`已导出 ${rows.length} 条记录${withTotal ? '（含合计行）' : ''}${extra}`, 'success');
  },

  /**
   * 追加「开票明细 / 回款明细」两个工作表。
   * 数据源 ar_invoices / ar_receipts（RLS 随台账行权限）；
   * 明细表未创建时提示并跳过，主表导出不受影响。
   * 返回 { invCount, recvCount }；跳过时返回 null。
   */
  async appendDetailSheets(wb, rows) {
    const ids = rows.map(r => r.id);
    if (!ids.length) return null;
    const rowOf = {};
    rows.forEach(r => { rowOf[r.id] = r; });

    /* in 查询按 200 个分块，防超长 URL */
    const fetchAll = async (table) => {
      const out = [];
      for (let i = 0; i < ids.length; i += 200) {
        const { data, error } = await sb.from(table).select('*').in('ledger_id', ids.slice(i, i + 200));
        if (error) throw new Error(error.message);
        out.push(...(data || []));
      }
      return out;
    };

    let invs, recs;
    try {
      [invs, recs] = await Promise.all([fetchAll('ar_invoices'), fetchAll('ar_receipts')]);
    } catch (e) {
      Utils.toast('明细获取失败（明细表可能尚未创建），本次仅导出台账主表', 'error');
      return null;
    }

    const makeSheet = (list, dateKey, sheetName) => {
      if (!list.length) return 0;
      const isInv = sheetName === '开票明细';
      const header = ['合同编号', '项目名称', '部门', isInv ? '开票日期' : '到账日期'];
      if (isInv) header.push('发票号');
      header.push('金额', '备注');
      const sorted = [...list].sort((a, b) =>
        String(a[dateKey] || '').localeCompare(String(b[dateKey] || '')));
      const aoa = [header];
      sorted.forEach(x => {
        const r = rowOf[x.ledger_id] || {};
        const row = [r.contract_no || null, r.project_name || null, Ledger.deptNameOf(r), x[dateKey] || null];
        if (isInv) row.push(x.invoice_no || null);
        row.push(Number(x.amount || 0), x.remark || null);
        aoa.push(row);
      });
      const s = sorted.reduce((acc, x) => acc + Number(x.amount || 0), 0);
      const total = ['合计', null, null, null];
      if (isInv) total.push(null);
      total.push(Math.round(s * 10000) / 10000, null);
      aoa.push(total);
      const ws = XLSX.utils.aoa_to_sheet(aoa);
      ws['!cols'] = [{ wch: 16 }, { wch: 40 }, { wch: 14 }, { wch: 12 }, { wch: 16 }, { wch: 14 }, { wch: 24 }];
      XLSX.utils.book_append_sheet(wb, ws, sheetName);
      return sorted.length;
    };

    const invCount = makeSheet(invs, 'invoice_date', '开票明细');
    const recvCount = makeSheet(recs, 'receipt_date', '回款明细');
    return { invCount, recvCount };
  },
};
