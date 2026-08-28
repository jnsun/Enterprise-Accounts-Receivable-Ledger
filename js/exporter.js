/**
 * exporter.js - Excel 导出模块（可自选要素字段，按当前筛选范围导出）
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
        <div class="modal-header">导出 Excel <span class="modal-close" data-act="close">×</span></div>
        <div class="modal-body">
          <div class="exp-scope">
            导出范围：
            <label><input type="radio" name="exp-scope" value="filtered" checked> 当前筛选结果（${count} 条）</label>
            <label><input type="radio" name="exp-scope" value="all"> 全部数据（${total} 条）</label>
          </div>
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
      const core = ['contract_no', 'project_name', 'contract_amount', 'final_amount', 'invoiced_amount',
        'received_amount', 'receivable_total', 'receivable_balance', 'owner_unit', 'end_date',
        'dunning_date', 'overdue_status'];
      boxes.forEach(b => { b.checked = core.includes(b.dataset.key); });
    });
    el.querySelector('[data-act="do"]').addEventListener('click', () => {
      const scope = el.querySelector('input[name="exp-scope"]:checked').value;
      const keys = boxes.filter(b => b.checked).map(b => b.dataset.key);
      if (!keys.length) { Utils.toast('请至少选择一个导出字段', 'error'); return; }
      this.doExport(scope === 'all' ? Ledger.rows : Ledger.filteredRows(), keys);
      el.remove();
    });
  },

  doExport(rows, keys) {
    if (!rows.length) { Utils.toast('没有可导出的数据', 'error'); return; }
    const defs = [...FIELD_DEFS, ...COMPUTED_DEFS];
    const headers = keys.map(k => (defs.find(f => f.key === k) || {}).label || k);
    const aoa = [headers];
    rows.forEach(r => {
      aoa.push(keys.map(k => {
        if (k === 'receivable_balance') {
          const b = Utils.overdueStatus(r, Ledger.settings.warn_days).balance;
          return b > 0 ? Math.round(b * 10000) / 10000 : 0;
        }
        if (k === 'overdue_status') return Utils.overdueStatus(r, Ledger.settings.warn_days).label;
        const f = defs.find(x => x.key === k);
        if (f && f.type === 'money') return r[k] === null || r[k] === undefined ? null : Number(r[k]);
        if (f && f.type === 'date') return r[k] || null;
        return r[k] === null || r[k] === undefined ? null : String(r[k]);
      }));
    });
    const ws = XLSX.utils.aoa_to_sheet(aoa);
    ws['!cols'] = keys.map(k => {
      const f = defs.find(x => x.key === k);
      return { wch: k === 'project_name' ? 40 : (f && f.type === 'money' ? 14 : (k === 'overdue_status' ? 12 : 16)) };
    });
    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, ws, '应收账款台账');
    const d = new Date();
    const stamp = `${d.getFullYear()}${String(d.getMonth() + 1).padStart(2, '0')}${String(d.getDate()).padStart(2, '0')}`;
    XLSX.writeFile(wb, `应收账款台账_${stamp}.xlsx`);
    Utils.toast(`已导出 ${rows.length} 条记录`, 'success');
  },
};
