/**
 * batches.js - 导入批次管理（对导错批次整批删除 / 查看后部分删除）
 */

const Batches = {

  list: [],

  async load() {
    const { data, error } = await sb.from('ar_import_batches')
      .select('*').order('created_at', { ascending: false }).limit(200);
    if (error) { Utils.toast('批次加载失败：' + error.message, 'error'); return; }
    this.list = data || [];
    // 统计各批次现存行数
    const { data: counts } = await sb.from('ar_ledger').select('batch_id');
    const counter = {};
    (counts || []).forEach(r => { if (r.batch_id) counter[r.batch_id] = (counter[r.batch_id] || 0) + 1; });
    this.list.forEach(b => { b.current_rows = counter[b.id] || 0; });
    this.render();
  },

  render() {
    const page = document.getElementById('page-batches');
    if (!page) return;
    const canDelete = Auth.can('delete');
    page.innerHTML = `
      <div class="page-head">
        <h2>导入批次管理</h2>
        <span class="muted">对导错的数据可整批删除，或「查看本批」后勾选部分删除</span>
      </div>
      <div class="table-wrap">
        <table class="batch-table">
          <thead><tr>
            <th style="min-width:220px">导入文件</th>
            <th style="width:110px" class="ta-r">导入行数</th>
            <th style="width:110px" class="ta-r">现存行数</th>
            <th style="width:160px">导入时间</th>
            <th style="width:220px">操作</th>
          </tr></thead>
          <tbody>
            ${this.list.map(b => `<tr data-id="${b.id}">
              <td title="${Utils.escapeHtml(b.file_name)}">${Utils.escapeHtml(Utils.clampName(b.file_name, 24, 2))}</td>
              <td class="ta-r">${b.row_count}</td>
              <td class="ta-r ${b.current_rows < b.row_count ? 'muted' : ''}">${b.current_rows}</td>
              <td>${new Date(b.created_at).toLocaleString('zh-CN', { hour12: false })}</td>
              <td class="col-actions">
                <a data-act="view">查看本批</a>
                ${canDelete && b.current_rows > 0 ? '<a class="link-danger" data-act="del-all">删除整批</a>' : ''}
              </td>
            </tr>`).join('') || '<tr><td colspan="5" class="empty-cell">暂无导入批次</td></tr>'}
          </tbody>
        </table>
      </div>`;

    page.querySelectorAll('td [data-act]').forEach(a => a.addEventListener('click', async () => {
      const id = a.closest('tr').dataset.id;
      const b = this.list.find(x => x.id === id);
      if (!b) return;
      if (a.dataset.act === 'view') {
        Ledger.filters.batch = id;
        App.navigate('ledger');
      }
      if (a.dataset.act === 'del-all') {
        const ok = await Utils.confirm(
          `确定删除批次「${b.file_name}」的全部 ${b.current_rows} 条数据？\n该批次的开票明细将一并删除，且不可恢复！`,
          { danger: true, title: '整批删除', confirmText: '整批删除' });
        if (!ok) return;
        const { error } = await sb.from('ar_ledger').delete().eq('batch_id', id);
        if (error) { Utils.toast('删除失败：' + error.message, 'error'); return; }
        await sb.from('ar_import_batches').delete().eq('id', id);
        Utils.toast(`已删除批次「${b.file_name}」`, 'success');
        await Promise.all([this.load(), Ledger.reload()]);
      }
    }));
  },
};
