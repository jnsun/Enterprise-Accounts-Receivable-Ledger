/**
 * ledger.js - 台账核心模块（列表 / 筛选 / 编辑 / 删除 / 开票明细）
 */

const Ledger = {
  rows: [],                 // 当前可见台账数据
  settings: { warn_days: 90 },
  departments: [],          // 部门字典（导入归属 / 编辑指定用）
  filters: { search: '', dept: '全部', progress: '全部', status: '全部', batch: null },
  selected: new Set(),      // 勾选的行 id
  sortKey: null,
  sortDir: 1,

  /** 初始化：加载设置、部门字典 */
  async init() {
    const { data: setting } = await sb.from('ar_settings').select('*').eq('id', 1).maybeSingle();
    if (setting) this.settings = setting;
    const { data: depts } = await sb.from('ar_departments').select('id, name').order('sort_order');
    this.departments = depts || [];
  },

  /** 加载台账数据（RLS 已按部门权限隔离） */
  async load() {
    let query = sb.from('ar_ledger').select('*').order('created_at', { ascending: false });
    if (this.filters.batch) {
      query = query.eq('batch_id', this.filters.batch);
    }
    const { data, error } = await query.limit(5000);
    if (error) { Utils.toast('台账加载失败：' + error.message, 'error'); return; }
    this.rows = data || [];
    this.selected.clear();
  },

  /** 筛选后的行 */
  filteredRows() {
    const kw = this.filters.search.trim().toLowerCase();
    return this.rows.filter(r => {
      if (this.filters.batch && r.batch_id !== this.filters.batch) return false;
      if (this.filters.dept !== '全部' && (r.dept_name || '未填写') !== this.filters.dept) return false;
      if (this.filters.progress !== '全部' && (r.progress || '未填写') !== this.filters.progress) return false;
      const st = Utils.overdueStatus(r, this.settings.warn_days);
      if (this.filters.status === '未结清' && st.level === 'settled') return false;
      if (this.filters.status === '已结清' && st.level !== 'settled') return false;
      if (this.filters.status === '超期' && st.level !== 'overdue') return false;
      if (kw) {
        const hay = [r.contract_no, r.project_name, r.owner_unit, r.creditor_unit, r.dept_name, r.payment_node, r.dunning_feedback]
          .map(x => String(x || '').toLowerCase()).join(' ');
        if (!hay.includes(kw)) return false;
      }
      return true;
    });
  },

  /** 施工部门胶囊选项（按出现次数排序） */
  deptCaps() {
    const counter = {};
    this.rows.forEach(r => {
      const k = r.dept_name || '未填写';
      counter[k] = (counter[k] || 0) + 1;
    });
    return Object.entries(counter).sort((a, b) => b[1] - a[1]).map(e => e[0]);
  },

  /* ================= 渲染 ================= */

  renderToolbar() {
    const canAdd = Auth.can('add'), canImport = Auth.can('import'),
          canExport = Auth.can('export'), canDelete = Auth.can('delete');
    return `
      <div class="toolbar">
        <div class="toolbar-left">
          ${this.filters.batch ? '<span class="batch-chip">批次内数据 <a data-act="exit-batch">退出</a></span>' : ''}
          <input id="kw-input" class="kw-input" placeholder="搜索 合同编号 / 项目 / 单位 / 反馈…" value="${Utils.escapeHtml(this.filters.search)}">
        </div>
        <div class="toolbar-right">
          ${canAdd ? '<button class="btn btn-primary" data-act="add">＋ 新增记录</button>' : ''}
          ${canImport ? '<button class="btn" data-act="import">⇪ 导入 Excel</button>' : ''}
          ${canExport ? '<button class="btn" data-act="export">⇩ 导出 Excel</button>' : ''}
          ${canDelete ? `<button class="btn btn-danger-plain" data-act="batch-del" ${this.selected.size ? '' : 'disabled'}>删除选中（${this.selected.size}）</button>` : ''}
          <button class="btn" data-act="refresh">刷新</button>
        </div>
      </div>`;
  },

  renderCapsules() {
    const depts = this.deptCaps();
    const progresses = ['全部', ...PROGRESS_OPTIONS];
    const statuses = ['全部', '未结清', '已结清', '超期'];
    const cap = (group, val, cur) =>
      `<button class="capsule ${val === cur ? 'active' : ''}" data-group="${group}" data-val="${Utils.escapeHtml(val)}">${Utils.escapeHtml(val)}</button>`;
    return `
      <div class="capsule-row"><span class="capsule-label">施工部门</span>${depts.length ? depts.map(d => cap('dept', d, this.filters.dept)).join('') : '<span class="muted">暂无数据</span>'}</div>
      <div class="capsule-row"><span class="capsule-label">工程进度</span>${progresses.map(p => cap('progress', p, this.filters.progress)).join('')}</div>
      <div class="capsule-row"><span class="capsule-label">收款状态</span>${statuses.map(s => cap('status', s, this.filters.status)).join('')}</div>`;
  },

  renderTable() {
    const rows = this.filteredRows();
    const canEdit = Auth.can('edit'), canDelete = Auth.can('delete');
    const allChecked = rows.length > 0 && rows.every(r => this.selected.has(r.id));

    const headCells = [
      `<th class="col-check"><input type="checkbox" id="check-all" ${allChecked ? 'checked' : ''}></th>`,
      `<th class="col-idx">序</th>`,
      ...FIELD_DEFS.map(f =>
        `<th style="min-width:${f.width}px;max-width:${f.width}px" class="${f.type === 'money' || f.type === 'date' ? 'ta-r' : ''} ${f.key === this.sortKey ? 'sorted' : ''}" data-sort="${f.key}">${f.label}</th>`),
      ...COMPUTED_DEFS.map(f => `<th style="min-width:${f.width}px;max-width:${f.width}px" class="ta-r ${f.key === 'overdue_status' ? '' : ''}">${f.label}</th>`),
      `<th class="col-actions">操作</th>`,
    ].join('');

    const bodyRows = rows.map((r, i) => {
      const st = Utils.overdueStatus(r, this.settings.warn_days);
      const checked = this.selected.has(r.id);
      const cells = FIELD_DEFS.map(f => {
        let v = r[f.key];
        if (f.type === 'money') return `<td class="ta-r td-money">${Utils.fmtMoney(v)}</td>`;
        if (f.type === 'date') return `<td class="ta-r td-date">${Utils.escapeHtml(v || '')}</td>`;
        if (f.key === 'project_name') return `<td class="td-name" title="${Utils.escapeHtml(v)}">${Utils.escapeHtml(Utils.clampName(v))}</td>`;
        if (f.key === 'progress' && v) {
          const cls = { '未开工': 'tag-gray', '施工中': 'tag-blue', '已完工': 'tag-green', '已决算': 'tag-teal' }[v] || 'tag-gray';
          return `<td><span class="tag ${cls}">${Utils.escapeHtml(v)}</span></td>`;
        }
        return `<td title="${Utils.escapeHtml(v)}">${Utils.escapeHtml(v || '')}</td>`;
      }).join('');
      const computed = `
        <td class="ta-r td-money ${st.balance > 0 ? 'owed' : ''}">${st.balance > 0 ? Utils.fmtMoney(st.balance) : '0'}</td>
        <td class="ta-r"><span class="tag ${'tag-' + st.level}">${st.label}</span></td>`;
      const actions = `
        <td class="col-actions">
          ${canEdit ? `<a data-act="edit" data-id="${r.id}">编辑</a>` : ''}
          ${canEdit ? `<a data-act="invoices" data-id="${r.id}">开票</a>` : ''}
          ${canDelete ? `<a class="link-danger" data-act="del" data-id="${r.id}">删除</a>` : ''}
        </td>`;
      return `<tr data-id="${r.id}" class="${checked ? 'row-checked' : ''}">
        <td class="col-check"><input type="checkbox" class="row-check" data-id="${r.id}" ${checked ? 'checked' : ''}></td>
        <td class="col-idx">${i + 1}</td>
        ${cells}${computed}${actions}
      </tr>`;
    }).join('');

    // 合计行（当前筛选范围）
    const sum = key => rows.reduce((s, r) => s + Number(r[key] || 0), 0);
    const footCells = [
      '<td colspan="2" class="ta-r">合计</td>',
      ...FIELD_DEFS.map(f => f.type === 'money'
        ? `<td class="ta-r td-money td-foot">${Utils.fmtMoney(sum(f.key))}</td>`
        : '<td></td>'),
      `<td class="ta-r td-money td-foot">${Utils.fmtMoney(rows.reduce((s, r) => s + (Utils.overdueStatus(r, this.settings.warn_days).balance || 0), 0))}</td>`,
      '<td></td><td></td>',
    ].join('');

    return `
      <div class="table-wrap">
        <table class="ledger-table">
          <thead><tr>${headCells}</tr></thead>
          <tbody>${bodyRows || '<tr><td colspan="30" class="empty-cell">暂无数据，点击「新增记录」或「导入 Excel」开始建立台账</td></tr>'}</tbody>
          ${rows.length ? `<tfoot><tr>${footCells}</tr></tfoot>` : ''}
        </table>
      </div>
      <div class="table-status">共 ${rows.length} 条记录 · 已选 ${this.selected.size} 条${this.filters.batch ? ' · 批次视图' : ''}</div>`;
  },

  render() {
    const main = document.getElementById('page-ledger');
    if (!main) return;
    main.innerHTML = this.renderToolbar() + this.renderCapsules() + '<div id="ledger-table-box">' + this.renderTable() + '</div>';
    this.bindEvents(main);
  },

  /** 只刷新表格区（筛选/勾选变化时避免整页重绘导致输入框失焦） */
  refreshTable() {
    const box = document.getElementById('ledger-table-box');
    if (box) box.innerHTML = this.renderTable();
    const btn = document.querySelector('[data-act="batch-del"]');
    if (btn) {
      btn.textContent = `删除选中（${this.selected.size}）`;
      btn.disabled = !this.selected.size;
    }
    this.bindTableEvents(box);
  },

  /* ================= 事件 ================= */

  bindEvents(root) {
    const kw = root.querySelector('#kw-input');
    if (kw) kw.addEventListener('input', Utils.debounce(e => {
      this.filters.search = e.target.value;
      this.refreshTable();
    }, 250));

    root.querySelectorAll('.capsule').forEach(c => c.addEventListener('click', () => {
      const g = c.dataset.group, v = c.dataset.val;
      this.filters[g] = v;
      root.querySelectorAll(`.capsule[data-group="${g}"]`).forEach(x => x.classList.toggle('active', x === c));
      this.refreshTable();
    }));

    root.querySelectorAll('[data-act]').forEach(el => {
      const act = el.dataset.act;
      if (act === 'refresh') el.addEventListener('click', () => this.reload());
      if (act === 'add' && Auth.can('add')) el.addEventListener('click', () => Editor.open(null));
      if (act === 'import') el.addEventListener('click', () => Importer.open());
      if (act === 'export') el.addEventListener('click', () => Exporter.open());
      if (act === 'exit-batch') el.addEventListener('click', () => {
        this.filters.batch = null; App.navigate('ledger'); Batches.load();
      });
      if (act === 'batch-del' && Auth.can('delete')) el.addEventListener('click', () => this.deleteSelected());
    });

    this.bindTableEvents(root);
  },

  bindTableEvents(root) {
    if (!root) return;
    const checkAll = root.querySelector('#check-all');
    if (checkAll) checkAll.addEventListener('change', e => {
      const rows = this.filteredRows();
      if (e.target.checked) rows.forEach(r => this.selected.add(r.id));
      else rows.forEach(r => this.selected.delete(r.id));
      this.refreshTable();
    });

    root.querySelectorAll('.row-check').forEach(cb => cb.addEventListener('change', e => {
      const id = e.target.dataset.id;
      e.target.checked ? this.selected.add(id) : this.selected.delete(id);
      e.target.closest('tr').classList.toggle('row-checked', e.target.checked);
      const btn = document.querySelector('[data-act="batch-del"]');
      if (btn) { btn.textContent = `删除选中（${this.selected.size}）`; btn.disabled = !this.selected.size; }
      const status = document.querySelector('.table-status');
      if (status) status.textContent = `共 ${this.filteredRows().length} 条记录 · 已选 ${this.selected.size} 条${this.filters.batch ? ' · 批次视图' : ''}`;
    }));

    root.querySelectorAll('th[data-sort]').forEach(th => th.addEventListener('click', () => {
      const key = th.dataset.sort;
      if (this.sortKey === key) this.sortDir *= -1;
      else { this.sortKey = key; this.sortDir = 1; }
      const f = FIELD_DEFS.find(x => x.key === key);
      this.rows.sort((a, b) => {
        const va = a[key], vb = b[key];
        if (f && f.type === 'money') return (Number(va || 0) - Number(vb || 0)) * this.sortDir;
        return String(va || '').localeCompare(String(vb || ''), 'zh') * this.sortDir;
      });
      this.refreshTable();
    }));

    root.querySelectorAll('td [data-act]').forEach(el => el.addEventListener('click', async e => {
      e.stopPropagation();
      const id = el.dataset.id, act = el.dataset.act;
      const row = this.rows.find(r => r.id === id);
      if (!row) return;
      if (act === 'edit') Editor.open(row);
      if (act === 'invoices') Editor.open(row, 'invoices');
      if (act === 'del' && Auth.can('delete')) {
        const ok = await Utils.confirm(`确定删除该条台账记录？\n合同编号：${row.contract_no || '（空）'}\n项目：${Utils.clampName(row.project_name)}`, { danger: true, confirmText: '删除' });
        if (!ok) return;
        const { error } = await sb.from('ar_ledger').delete().eq('id', id);
        if (error) { Utils.toast('删除失败：' + error.message, 'error'); return; }
        Utils.toast('已删除', 'success');
        await this.reload();
      }
    }));
  },

  /** 删除勾选行 */
  async deleteSelected() {
    const ids = [...this.selected];
    if (!ids.length) return;
    const ok = await Utils.confirm(`确定删除选中的 ${ids.length} 条台账记录？\n删除后不可恢复（开票明细将一并删除）。`, { danger: true, confirmText: '删除' });
    if (!ok) return;
    const { error } = await sb.from('ar_ledger').delete().in('id', ids);
    if (error) { Utils.toast('删除失败：' + error.message, 'error'); return; }
    Utils.toast(`已删除 ${ids.length} 条记录`, 'success');
    await this.reload();
  },

  async reload() {
    await this.load();
    this.render();
  },
};

/* ============================================================
 * Editor - 单条台账编辑（含开票明细 Tab）
 * ============================================================ */

const Editor = {
  row: null,
  isNew: false,
  activeTab: 'base',
  invoices: [],

  open(row, tab = 'base') {
    this.row = row;
    this.isNew = !row;
    this.activeTab = tab || 'base';
    this.invoices = [];
    this.renderModal();
    if (!this.isNew) this.loadInvoices();
    if (!this.isNew) this.loadOwnerUnits();
    else this.loadOwnerUnits();
  },

  async loadOwnerUnits() {
    // 甲方单位建议：内置预设 + 库内历史值
    const { data } = await sb.from('ar_ledger').select('owner_unit').not('owner_unit', 'is', null).limit(500);
    const set = new Set(OWNER_UNIT_PRESETS);
    (data || []).forEach(d => { if (d.owner_unit) set.add(d.owner_unit); });
    const dl = document.getElementById('dl-owner-units');
    if (dl) dl.innerHTML = [...set].map(u => `<option value="${Utils.escapeHtml(u)}">`).join('');
  },

  renderModal() {
    const old = document.getElementById('modal-editor');
    if (old) old.remove();
    const r = this.row || {};
    const isAdmin = Auth.isAdmin;
    const deptOpts = ['<option value="">（未指定）</option>', ...Ledger.departments.map(d =>
      `<option value="${d.id}" ${r.department_id === d.id ? 'selected' : ''}>${Utils.escapeHtml(d.name)}</option>`)].join('');

    const input = (key, extra = '') => {
      const f = FIELD_DEFS.find(x => x.key === key);
      const v = r[key] === null || r[key] === undefined ? '' : r[key];
      const val = f.type === 'date' ? (v ? Utils.fmtDate(v) : '') : v;
      if (f.type === 'money')
        return `<input type="number" step="0.0001" class="ipt ta-r" id="ed-${key}" value="${val}" ${extra} data-money-sync="${key}">`;
      if (f.type === 'date')
        return `<input type="date" class="ipt" id="ed-${key}" value="${val}" ${extra}>`;
      if (f.type === 'select')
        return `<select class="ipt" id="ed-${key}" ${extra}>${['', ...f.options].map(o =>
          `<option value="${Utils.escapeHtml(o)}" ${v === o || (!v && !o) ? 'selected' : ''}>${o || '（请选择）'}</option>`).join('')}</select>`;
      if (f.type === 'textarea')
        return `<textarea class="ipt" id="ed-${key}" rows="2" ${extra}>${Utils.escapeHtml(val)}</textarea>`;
      if (f.datalist)
        return `<input class="ipt" id="ed-${key}" list="dl-owner-units" value="${Utils.escapeHtml(val)}" ${extra}>`;
      return `<input class="ipt" id="ed-${key}" value="${Utils.escapeHtml(val)}" ${extra}>`;
    };

    const fieldCell = key => {
      const f = FIELD_DEFS.find(x => x.key === key);
      return `<label class="form-field"><span class="ff-label">${f.label}</span>${input(key)}</label>`;
    };

    // 金额组：账内+账外 -> 合计自动联动
    const moneyGroup = `
      <div class="form-grid">
        ${fieldCell('contract_amount')}${fieldCell('final_amount')}
        ${fieldCell('invoiced_amount')}${fieldCell('received_amount')}
        ${fieldCell('receivable_internal')}${fieldCell('receivable_external')}
        ${fieldCell('receivable_total')}${fieldCell('cost_expense')}
      </div>
      <div class="form-hint">应收合计默认自动 = 账内应收 + 账外应收；可手工修改覆盖。</div>`;

    const baseGroup = `
      <div class="form-grid">
        ${fieldCell('contract_no')}${fieldCell('project_name')}
        ${fieldCell('owner_unit')}${fieldCell('creditor_unit')}
        ${isAdmin ? `<label class="form-field"><span class="ff-label">数据归属部门</span><select class="ipt" id="ed-department_id">${deptOpts}</select></label>` : ''}
        ${fieldCell('work_nature')}${fieldCell('sector')}
      </div>`;

    const progressGroup = `
      <div class="form-grid">
        ${fieldCell('start_date')}${fieldCell('end_date')}
        ${fieldCell('progress')}${fieldCell('payment_node')}
        ${fieldCell('dept_name')}
      </div>`;

    const dunningGroup = `
      <div class="form-grid">
        ${fieldCell('dunning_date')}
      </div>
      <div class="form-field form-full"><span class="ff-label">催收反馈</span>${input('dunning_feedback')}</div>`;

    const tabs = [
      { key: 'base', label: '基本信息' },
      { key: 'money', label: '金额信息' },
      { key: 'progress', label: '进度与节点' },
      { key: 'dunning', label: '催收信息' },
      { key: 'invoices', label: '开票明细' + (this.invoices.length ? `（${this.invoices.length}）` : '') },
    ];

    const el = document.createElement('div');
    el.id = 'modal-editor';
    el.className = 'modal-mask';
    el.innerHTML = `
      <div class="modal modal-lg">
        <div class="modal-header">
          ${this.isNew ? '新增台账记录' : '编辑台账记录'}
          <span class="modal-close" data-act="close">×</span>
        </div>
        <div class="modal-tabs">${tabs.map(t =>
          `<button class="mtab ${this.activeTab === t.key ? 'active' : ''}" data-tab="${t.key}">${t.label}</button>`).join('')}</div>
        <div class="modal-body">
          <datalist id="dl-owner-units"></datalist>
          <div class="tab-pane ${this.activeTab === 'base' ? '' : 'hidden'}" data-pane="base">${baseGroup}</div>
          <div class="tab-pane ${this.activeTab === 'money' ? '' : 'hidden'}" data-pane="money">${moneyGroup}</div>
          <div class="tab-pane ${this.activeTab === 'progress' ? '' : 'hidden'}" data-pane="progress">${progressGroup}</div>
          <div class="tab-pane ${this.activeTab === 'dunning' ? '' : 'hidden'}" data-pane="dunning">${dunningGroup}</div>
          <div class="tab-pane ${this.activeTab === 'invoices' ? '' : 'hidden'}" data-pane="invoices" id="invoice-pane">
            <div class="loading-hint">开票明细加载中…</div>
          </div>
        </div>
        <div class="modal-footer">
          ${this.activeTab !== 'invoices'
            ? `<button class="btn btn-primary" data-act="save">${this.isNew ? '保存' : '保存修改'}</button>`
            : ''}
          <button class="btn" data-act="close">关闭</button>
        </div>
        <div id="editor-error" class="editor-error hidden"></div>
      </div>`;
    document.body.appendChild(el);
    this.bindModal(el);
    if (this.activeTab === 'invoices') this.renderInvoicePane();
  },

  bindModal(el) {
    el.querySelector('[data-act="close"]').addEventListener('click', () => el.remove());
    Utils.bindMaskClose(el, () => el.remove());
    el.querySelectorAll('.mtab').forEach(t => t.addEventListener('click', () => {
      this.activeTab = t.dataset.tab;
      el.querySelectorAll('.mtab').forEach(x => x.classList.toggle('active', x === t));
      el.querySelectorAll('.tab-pane').forEach(p => p.classList.toggle('hidden', p.dataset.pane !== this.activeTab));
      const footer = el.querySelector('.modal-footer');
      footer.querySelector('[data-act="save"]')?.remove();
      if (this.activeTab !== 'invoices') {
        const b = document.createElement('button');
        b.className = 'btn btn-primary'; b.dataset.act = 'save';
        b.textContent = this.isNew ? '保存' : '保存修改';
        footer.prepend(b);
      }
      if (this.activeTab === 'invoices') this.renderInvoicePane();
    }));

    // 应收合计自动联动
    const internal = el.querySelector('#ed-receivable_internal');
    const external = el.querySelector('#ed-receivable_external');
    const total = el.querySelector('#ed-receivable_total');
    const syncTotal = () => {
      const sum = (Number(internal.value) || 0) + (Number(external.value) || 0);
      total.value = sum || '';
      total.dataset.auto = '1';
    };
    internal.addEventListener('input', syncTotal);
    external.addEventListener('input', syncTotal);
    total.addEventListener('input', () => { total.dataset.auto = ''; });

    el.querySelector('[data-act="save"]').addEventListener('click', () => this.save(el));
  },

  /** 收集表单并保存 */
  async save(el) {
    const errBox = el.querySelector('#editor-error');
    errBox.classList.add('hidden');
    const payload = {};
    FIELD_DEFS.forEach(f => {
      const node = el.querySelector('#ed-' + f.key);
      if (!node) return;
      if (f.type === 'money') payload[f.key] = node.value === '' ? null : Number(node.value);
      else if (f.type === 'date') payload[f.key] = node.value || null;
      else payload[f.key] = node.value.trim() || null;
    });
    if (Auth.isAdmin) {
      const dept = el.querySelector('#ed-department_id');
      payload.department_id = dept && dept.value ? dept.value : null;
    } else if (this.isNew && Auth.arUser && Auth.arUser.department_id) {
      payload.department_id = Auth.arUser.department_id;
    }

    // 校验
    if (!payload.contract_no && !payload.project_name) {
      errBox.textContent = '合同编号与项目名称至少填写一项';
      errBox.classList.remove('hidden');
      return;
    }

    let error;
    if (this.isNew) {
      payload.created_by = Auth.currentUser.id;
      ({ error } = await sb.from('ar_ledger').insert(payload));
    } else {
      ({ error } = await sb.from('ar_ledger').update(payload).eq('id', this.row.id));
    }
    if (error) {
      errBox.textContent = '保存失败：' + error.message;
      errBox.classList.remove('hidden');
      return;
    }
    Utils.toast(this.isNew ? '新增成功' : '保存成功', 'success');
    el.remove();
    await Ledger.reload();
  },

  /* ---------- 开票明细 ---------- */

  async loadInvoices() {
    if (!this.row) return;
    const { data, error } = await sb.from('ar_invoices')
      .select('*').eq('ledger_id', this.row.id).order('invoice_date', { ascending: false });
    if (!error) this.invoices = data || [];
    this.renderInvoicePane();
  },

  renderInvoicePane() {
    const pane = document.getElementById('invoice-pane');
    if (!pane) return;
    const canEdit = Auth.can('edit');
    const sum = this.invoices.reduce((s, i) => s + Number(i.amount || 0), 0);
    pane.innerHTML = `
      <div class="invoice-summary">本合同累计开票：<b>${Utils.fmtMoney(sum)}</b>
        <button class="btn btn-xs" data-act="sync-invoiced">同步到「已开发票金额」</button></div>
      <table class="invoice-table">
        <thead><tr><th style="width:110px">开票日期</th><th style="width:130px">发票号码</th><th style="width:110px" class="ta-r">金额</th><th>备注</th>${canEdit ? '<th style="width:60px">操作</th>' : ''}</tr></thead>
        <tbody>
          ${this.invoices.map(i => `<tr data-inv-id="${i.id}">
            <td>${Utils.escapeHtml(i.invoice_date)}</td>
            <td>${Utils.escapeHtml(i.invoice_no || '')}</td>
            <td class="ta-r td-money">${Utils.fmtMoney(i.amount)}</td>
            <td>${Utils.escapeHtml(i.remark || '')}</td>
            ${canEdit ? `<td><a class="link-danger" data-act="inv-del">删除</a></td>` : ''}
          </tr>`).join('') || '<tr><td colspan="5" class="empty-cell">暂无开票记录，在下方新增</td></tr>'}
        </tbody>
      </table>
      ${canEdit ? `
      <div class="invoice-add">
        <input type="date" class="ipt" id="inv-date" value="${Utils.today()}">
        <input class="ipt" id="inv-no" placeholder="发票号码（选填）" style="width:140px">
        <input type="number" step="0.0001" class="ipt ta-r" id="inv-amount" placeholder="金额" style="width:120px">
        <input class="ipt" id="inv-remark" placeholder="备注（选填）">
        <button class="btn btn-primary" data-act="inv-add">＋ 添加开票记录</button>
      </div>` : ''}`;

    pane.querySelector('[data-act="inv-add"]')?.addEventListener('click', () => this.addInvoice());
    pane.querySelector('[data-act="sync-invoiced"]')?.addEventListener('click', () => this.syncInvoiced(sum));
    pane.querySelectorAll('[data-act="inv-del"]').forEach(a => a.addEventListener('click', async e => {
      const tr = e.target.closest('tr');
      const id = tr.dataset.invId;
      const { error } = await sb.from('ar_invoices').delete().eq('id', id);
      if (error) { Utils.toast('删除失败：' + error.message, 'error'); return; }
      this.invoices = this.invoices.filter(i => i.id !== id);
      this.renderInvoicePane();
      this.renderTabBadge();
    }));
  },

  renderTabBadge() {
    const tab = document.querySelector('.mtab[data-tab="invoices"]');
    if (tab) tab.textContent = '开票明细' + (this.invoices.length ? `（${this.invoices.length}）` : '');
  },

  async addInvoice() {
    const date = document.getElementById('inv-date').value;
    const amount = document.getElementById('inv-amount').value;
    if (!date) { Utils.toast('请选择开票日期', 'error'); return; }
    if (amount === '' || !(Number(amount) >= 0)) { Utils.toast('请填写开票金额', 'error'); return; }
    const payload = {
      ledger_id: this.row.id,
      invoice_date: date,
      amount: Number(amount),
      invoice_no: document.getElementById('inv-no').value.trim() || null,
      remark: document.getElementById('inv-remark').value.trim() || null,
      created_by: Auth.currentUser.id,
    };
    const { data, error } = await sb.from('ar_invoices').insert(payload).select().single();
    if (error) { Utils.toast('添加失败：' + error.message, 'error'); return; }
    this.invoices.unshift(data);
    this.renderInvoicePane();
    this.renderTabBadge();
    // 清空金额与备注，方便连续录入
    document.getElementById('inv-amount').value = '';
    document.getElementById('inv-remark').value = '';
    document.getElementById('inv-no').value = '';
    Utils.toast('已添加开票记录', 'success');
  },

  /** 把开票合计写回台账「已开发票金额」 */
  async syncInvoiced(sum) {
    const { error } = await sb.from('ar_ledger').update({ invoiced_amount: sum }).eq('id', this.row.id);
    if (error) { Utils.toast('同步失败：' + error.message, 'error'); return; }
    Utils.toast('已同步到「已开发票金额」', 'success');
    await Ledger.reload();
  },
};
