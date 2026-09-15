/**
 * ledger.js - 台账核心模块 v3（新指标体系）
 *
 * 列表 / 筛选（默认「未结」）/ 一项目一屏编辑 / 附件区 / 开票明细 / 回款明细 / 删除
 * 计算口径：账内应收 = 开票 − 到账；账外应收 = 决算 − 开票；
 *          应收余额 = 决算 − 到账 − 核销（均为前端虚拟计算列）
 *          决算金额为空时账外应收 / 应收余额显示「—」且不参与合计（CONTEXT.md）
 * 字段权限：非管理员（实体部门）仅可编辑催收跟踪类字段（deptEditable），
 *          新增记录时可额外填写基本信息；金额字段一律财务专属。
 */

const Ledger = {
  rows: [],                 // 当前可见台账数据
  settings: { warn_days: 90 },
  departments: [],          // 部门字典（ar_departments）
  filters: { search: '', dept: '全部', project_status: '全部', debt_status: '全部', client_attr: '全部', settled: '未结', batch: null },
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

  /** 加载台账数据（RLS 已按部门权限隔离）+ 附件计数 */
  async load() {
    let query = sb.from('ar_ledger').select('*').order('created_at', { ascending: false });
    if (this.filters.batch) {
      query = query.eq('batch_id', this.filters.batch);
    }
    const { data, error } = await query.limit(5000);
    if (error) { Utils.toast('台账加载失败：' + error.message, 'error'); return; }
    this.rows = data || [];
    this.selected.clear();
    await Attachments.loadCounts();
  },

  /** 行的虚拟计算列
   *  口径（CONTEXT.md）：决算金额为空时，账外应收 / 应收余额 = null（显示"—"，
   *  不参与看板与汇总合计）；账内应收照常计算（不依赖决算）。
   */
  computeRow(r) {
    const inv = Number(r.invoiced_amount || 0);
    const recv = Number(r.received_amount || 0);
    const wo = Number(r.writeoff_amount || 0);
    const hasFinal = r.final_amount !== null && r.final_amount !== undefined && r.final_amount !== '';
    const fin = hasFinal ? Number(r.final_amount) : null;
    return {
      receivable_internal: Math.round((inv - recv) * 10000) / 10000,
      receivable_external: fin === null ? null : Math.round((fin - inv) * 10000) / 10000,
      receivable_balance: fin === null ? null : Math.round((fin - recv - wo) * 10000) / 10000,
      attach_summary: Attachments.summaryText(r.id),
    };
  },

  deptNameOf(r) {
    const d = this.departments.find(x => x.id === r.department_id);
    return d ? d.name : '未指定';
  },

  /** 筛选后的行 */
  filteredRows() {
    const kw = this.filters.search.trim().toLowerCase();
    const deptId = this.filters.dept === '全部' ? null
      : (this.departments.find(d => d.name === this.filters.dept) || {}).id;
    return this.rows.filter(r => {
      if (this.filters.batch && r.batch_id !== this.filters.batch) return false;
      // 结清状态（CONTEXT.md「记录生命周期」）：未结 = 应收余额 ≠ 0 或决算未定（余额不可知）
      if (this.filters.settled === '未结') {
        const bal = this.computeRow(r).receivable_balance;
        if (bal === 0) return false;
      } else if (this.filters.settled === '已结清') {
        const bal = this.computeRow(r).receivable_balance;
        if (bal !== 0) return false;
      }
      if (deptId && r.department_id !== deptId) return false;
      if (this.filters.project_status !== '全部' && (r.project_status || '未填写') !== this.filters.project_status) return false;
      if (this.filters.debt_status !== '全部' && (r.debt_status || '未填写') !== this.filters.debt_status) return false;
      if (this.filters.client_attr !== '全部' && (r.client_attr && String(r.client_attr).trim() || '未填写') !== this.filters.client_attr) return false;
      if (kw) {
        const hay = [r.contract_no, r.project_name, r.owner_unit, r.creditor_unit,
          r.collector, r.feedback, r.latest_progress, r.next_plan, r.remark, this.deptNameOf(r)]
          .map(x => String(x || '').toLowerCase()).join(' ');
        if (!hay.includes(kw)) return false;
      }
      return true;
    });
  },

  /** 部门胶囊选项（按记录数排序） */
  deptCaps() {
    const counter = {};
    this.rows.forEach(r => {
      const k = this.deptNameOf(r);
      counter[k] = (counter[k] || 0) + 1;
    });
    return Object.entries(counter).sort((a, b) => b[1] - a[1]).map(e => e[0]);
  },

  /** 客户属性胶囊选项（取自实际数据，按记录数排序） */
  attrCaps() {
    const counter = {};
    this.rows.forEach(r => {
      const k = r.client_attr && String(r.client_attr).trim() || '未填写';
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
          <input id="kw-input" class="kw-input" placeholder="搜索 合同编号 / 项目 / 客户 / 责任人 / 反馈…" value="${Utils.escapeHtml(this.filters.search)}">
        </div>
        <div class="toolbar-right">
          ${canAdd ? '<button class="btn btn-primary" data-act="add">＋ 新增记录</button>' : ''}
          ${canImport ? '<button class="btn" data-act="import">⇪ 导入 Excel</button>' : ''}
          ${canExport ? '<button class="btn" data-act="export">⇩ 导出 Excel</button>' : ''}
          ${canDelete ? `<button class="btn btn-danger-plain" data-act="batch-del" ${this.selected.size ? '' : 'disabled'}>删除选中（${this.selected.size}）</button>` : ''}
          <button class="btn" data-act="colprefs" id="btn-colprefs">▦ 列设置${ColPrefs.hiddenCount() ? `（隐${ColPrefs.hiddenCount()}）` : ''}</button>
          <button class="btn" data-act="refresh">刷新</button>
        </div>
      </div>`;
  },

  renderCapsules() {
    const depts = this.deptCaps();
    const attrs = this.attrCaps();
    const statuses = ['全部', ...Dicts.get('project_status')];
    const debts = ['全部', ...Dicts.get('debt_status')];
    const cap = (group, val, cur) =>
      `<button class="capsule ${val === cur ? 'active' : ''}" data-group="${group}" data-val="${Utils.escapeHtml(val)}" aria-pressed="${val === cur}" aria-label="${group === 'dept' ? '部门' : group === 'settled' ? '结清状态' : group === 'project_status' ? '项目状态' : group === 'debt_status' ? '债权状态' : '客户属性'}：${Utils.escapeHtml(val)}">${Utils.escapeHtml(val)}</button>`;
    return `
      <div class="capsule-row"><span class="capsule-label">部门</span>${depts.length ? [cap('dept', '全部', this.filters.dept), ...depts.map(d => cap('dept', d, this.filters.dept))].join('') : '<span class="muted">暂无数据</span>'}</div>
      <div class="capsule-row"><span class="capsule-label">结清状态</span>${['未结', '已结清', '全部'].map(s => cap('settled', s, this.filters.settled)).join('')}</div>
      <div class="capsule-row"><span class="capsule-label">项目状态</span>${statuses.map(p => cap('project_status', p, this.filters.project_status)).join('')}</div>
      <div class="capsule-row"><span class="capsule-label">债权状态</span>${debts.map(s => cap('debt_status', s, this.filters.debt_status)).join('')}</div>
      <div class="capsule-row"><span class="capsule-label">客户属性</span>${attrs.length ? [cap('client_attr', '全部', this.filters.client_attr), ...attrs.map(a => cap('client_attr', a, this.filters.client_attr))].join('') : '<span class="muted">暂无数据</span>'}</div>`;
  },

  /** 当前显示的列定义（列设置过滤后） */
  visibleDefs() {
    return [...FIELD_DEFS, ...COMPUTED_DEFS].filter(f => ColPrefs.isVisible(f.key));
  },

  renderTable() {
    const rows = this.filteredRows();
    const canEdit = Auth.can('edit'), canDelete = Auth.can('delete');
    const allChecked = rows.length > 0 && rows.every(r => this.selected.has(r.id));
    const defs = this.visibleDefs();

    const headCells = [
      `<th class="col-check"><input type="checkbox" id="check-all" ${allChecked ? 'checked' : ''}></th>`,
      `<th class="col-idx">序</th>`,
      ...defs.map(f =>
        `<th style="min-width:${f.width}px;max-width:${f.width}px" class="${f.type === 'money' || f.type === 'date' ? 'ta-r' : ''} ${f.key === this.sortKey ? 'sorted' : ''}" data-sort="${f.key}">${f.label}</th>`),
      `<th class="col-actions">操作</th>`,
    ].join('');

    const bodyRows = rows.map((r, i) => {
      const checked = this.selected.has(r.id);
      const comp = this.computeRow(r);
      const cells = defs.map(f => {
        if (f.key === 'attach_summary') {
          const n = Attachments.count(r.id);
          return `<td title="${Utils.escapeHtml(comp.attach_summary)}" class="${n ? 'att-has' : 'muted'}">${n ? `📎 ${Utils.escapeHtml(comp.attach_summary)}` : '—'}</td>`;
        }
        let v = r[f.key];
        if (f.type === 'money') {
          const isCalc = f.key in comp;
          const val = isCalc ? comp[f.key] : v;
          if (isCalc && val === null) return `<td class="ta-r td-money muted" title="决算金额未定，暂不计算">—</td>`;
          const neg = Number(val) < 0;
          return `<td class="ta-r td-money ${neg ? 'neg' : ''}">${Utils.fmtMoney(val)}</td>`;
        }
        if (f.type === 'date') return `<td class="ta-r td-date">${Utils.escapeHtml(v || '')}</td>`;
        if (f.key === 'project_name') return `<td class="td-name" title="${Utils.escapeHtml(v)}">${Utils.escapeHtml(Utils.clampName(v))}</td>`;
        if ((f.key === 'project_status' || f.key === 'debt_status') && v) {
          const cls = TAG_COLORS[v] || 'tag-gray';
          return `<td><span class="tag ${cls}">${Utils.escapeHtml(v)}</span></td>`;
        }
        return `<td title="${Utils.escapeHtml(v)}">${Utils.escapeHtml(v || '')}</td>`;
      }).join('');
      const actions = `
        <td class="col-actions">
          ${canEdit ? `<a data-act="edit" data-id="${r.id}">编辑</a>` : ''}
          ${canDelete ? `<a class="link-danger" data-act="del" data-id="${r.id}">删除</a>` : ''}
        </td>`;
      return `<tr data-id="${r.id}" class="${checked ? 'row-checked' : ''}">
        <td class="col-check"><input type="checkbox" class="row-check" data-id="${r.id}" ${checked ? 'checked' : ''}></td>
        <td class="col-idx">${i + 1}</td>
        ${cells}${actions}
      </tr>`;
    }).join('');

    // 合计行（当前筛选范围）：金额列 + 计算金额列
    const sum = key => rows.reduce((s, r) => {
      const f = defs.find(x => x.key === key);
      const v = (f && key in this.computeRow(r)) ? this.computeRow(r)[key] : r[key];
      return s + Number(v || 0);
    }, 0);
    const footCells = [
      '<td colspan="2" class="ta-r td-foot td-foot-label">合计</td>',
      ...defs.map(f => f.type === 'money'
        ? `<td class="ta-r td-money td-foot">${Utils.fmtMoney(sum(f.key))}</td>`
        : '<td></td>'),
      '<td></td>',
    ].join('');

    const totalCols = 2 + defs.length + 1;
    const emptyMsg = this.hasActiveFilter()
      ? '当前筛选条件下没有记录<br>把「结清状态」切到「全部」，或清空搜索关键词即可看到更多'
      : '台账还没有记录<br>点「＋ 新增记录」逐条录入，或用「⇪ 导入 Excel」批量导入';
    return `
      <div class="table-wrap">
        <table class="ledger-table">
          <thead><tr>${headCells}</tr></thead>
          <tbody>${bodyRows || `<tr><td colspan="${totalCols}" class="empty-cell">${emptyMsg}</td></tr>`}</tbody>
          ${rows.length ? `<tfoot><tr>${footCells}</tr></tfoot>` : ''}
        </table>
      </div>
      <div class="table-status">共 ${rows.length} 条记录 · 已选 ${this.selected.size} 条${this.filters.batch ? ' · 批次视图' : ''}</div>`;
  },

  /** 是否有生效的筛选条件（用于区分「筛选无结果」与「真的没有数据」） */
  hasActiveFilter() {
    const f = this.filters;
    return !!(f.search.trim() || f.dept !== '全部' || f.project_status !== '全部'
      || f.debt_status !== '全部' || f.client_attr !== '全部' || f.settled !== '全部' || f.batch);
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
      root.querySelectorAll(`.capsule[data-group="${g}"]`).forEach(x => {
        const on = x === c;
        x.classList.toggle('active', on);
        x.setAttribute('aria-pressed', String(on));
      });
      this.refreshTable();
    }));

    root.querySelectorAll('[data-act]').forEach(el => {
      const act = el.dataset.act;
      if (act === 'refresh') el.addEventListener('click', () => this.reload());
      if (act === 'add' && Auth.can('add')) el.addEventListener('click', () => Editor.open(null));
      if (act === 'import') el.addEventListener('click', () => Importer.open());
      if (act === 'export') el.addEventListener('click', () => Exporter.open());
      if (act === 'colprefs') el.addEventListener('click', () => ColPrefs.openPanel(el, () => this.render()));
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
      const f = [...FIELD_DEFS, ...COMPUTED_DEFS].find(x => x.key === key);
      this.rows.sort((a, b) => {
        const va = (f && f.key in this.computeRow(a)) ? this.computeRow(a)[key] : a[key];
        const vb = (f && f.key in this.computeRow(b)) ? this.computeRow(b)[key] : b[key];
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
      if (act === 'del' && Auth.can('delete')) {
        const ok = await Utils.confirm(`确定删除该条台账记录？\n合同编号：${row.contract_no || '（空）'}\n项目：${Utils.clampName(row.project_name)}\n该记录的附件与开票/回款明细将一并删除。`, { danger: true, confirmText: '删除' });
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
    const ok = await Utils.confirm(`确定删除选中的 ${ids.length} 条台账记录？\n删除后不可恢复（附件与开票/回款明细将一并删除）。`, { danger: true, confirmText: '删除' });
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
 * Editor - 单条台账编辑（要求一：一个项目一个界面）
 * 全部要素分区单屏展示：基本信息 / 状态与金额（实时计算） /
 * 债权与催收 / 附件上传区 / 开票明细
 * ============================================================ */

const Editor = {
  row: null,
  isNew: false,

  /** 非管理员可编辑的字段 key 集合（新增时可填基本信息，编辑时仅催收跟踪类） */
  editableKeys() {
    if (Auth.isAdmin) return null;   // null = 全部可编辑
    const keys = FIELD_DEFS.filter(f => f.deptEditable).map(f => f.key);
    if (this.isNew) {
      FORM_GROUPS[0].fields.forEach(k => { if (!keys.includes(k)) keys.push(k); });
    }
    return new Set(keys);
  },

  canEditField(key) {
    const set = this.editableKeys();
    if (!set) return true;
    return set.has(key);
  },

  open(row) {
    this.row = row;
    this.isNew = !row;
    Attachments.rows = [];
    this.receipts = [];
    this.renderModal();
    if (!this.isNew) {
      Attachments.loadFor(row.id).then(() => this.renderAttachments());
      this.loadInvoices();
      this.loadReceipts();
    }
    this.loadOwnerUnits();
  },

  async loadOwnerUnits() {
    // 客户名称建议：内置预设 + 库内历史值
    const { data } = await sb.from('ar_ledger').select('owner_unit').not('owner_unit', 'is', null).limit(500);
    const set = new Set(OWNER_UNIT_PRESETS);
    (data || []).forEach(d => { if (d.owner_unit) set.add(d.owner_unit); });
    const dl = document.getElementById('dl-owner-units');
    if (dl) dl.innerHTML = [...set].map(u => `<option value="${Utils.escapeHtml(u)}">`).join('');
  },

  /* ---------- 表单控件 ---------- */

  inputWidget(f, v, disabled) {
    const id = `ed-${f.key}`;
    const dis = disabled ? 'disabled' : '';
    const val = v === null || v === undefined ? '' : v;

    if (f.type === 'money')
      return `<input type="number" step="0.0001" class="ipt ta-r" id="${id}" value="${val}" ${dis}>`;
    if (f.type === 'date')
      return `<input type="date" class="ipt" id="${id}" value="${val ? Utils.fmtDate(val) : ''}" ${dis}>`;
    if (f.type === 'textarea')
      return `<textarea class="ipt" id="${id}" rows="2" ${dis}>${Utils.escapeHtml(val)}</textarea>`;
    if (f.type === 'select') {
      const opts = Dicts.get(f.dict);
      const isCustom = val && !opts.includes(val);
      if (f.freeOther) {
        const otherId = `${id}__free`;
        return `<div class="sel-free" data-sf="${f.key}">
          <select class="ipt" id="${id}" ${dis}>
            <option value="">（请选择）</option>
            ${opts.map(o => `<option value="${Utils.escapeHtml(o)}" ${val === o ? 'selected' : ''}>${Utils.escapeHtml(o)}</option>`).join('')}
            ${isCustom ? `<option value="__custom__" selected>${Utils.escapeHtml(val)}（自定义）</option>` : ''}
            <option value="__other__">其他（自由填写）…</option>
          </select>
          <input class="ipt hidden" id="${otherId}" placeholder="请填写具体内容" ${dis}>
        </div>`;
      }
      return `<select class="ipt" id="${id}" ${dis}>
        <option value="">（请选择）</option>
        ${opts.map(o => `<option value="${Utils.escapeHtml(o)}" ${val === o ? 'selected' : ''}>${Utils.escapeHtml(o)}</option>`).join('')}
      </select>`;
    }
    if (f.type === 'combo') {
      const dlId = `dlc-${f.key}`;
      const opts = Dicts.get(f.dict);
      return `<input class="ipt" id="${id}" list="${dlId}" value="${Utils.escapeHtml(val)}" ${dis}>
        <datalist id="${dlId}">${opts.map(o => `<option value="${Utils.escapeHtml(o)}">`).join('')}</datalist>`;
    }
    if (f.datalist)
      return `<input class="ipt" id="${id}" list="dl-owner-units" value="${Utils.escapeHtml(val)}" ${dis}>`;
    return `<input class="ipt" id="${id}" value="${Utils.escapeHtml(val)}" ${dis}>`;
  },

  fieldCell(key) {
    const f = FIELD_DEFS.find(x => x.key === key);
    const r = this.row || {};
    const locked = !this.canEditField(key);
    const hint = key === 'charge_date'
      ? '<i style="font-style:normal;color:var(--text-3)">（自动=最近开票日期）</i>' : '';
    return `<label class="form-field ${locked ? 'ff-locked' : ''}" title="${locked ? '财务字段，仅财务管理员可修改' : ''}">
      <span class="ff-label">${f.label}${hint}${locked ? ' 🔒' : ''}</span>${this.inputWidget(f, r[key], locked)}</label>`;
  },

  /* ---------- 弹窗 ---------- */

  renderModal() {
    const old = document.getElementById('modal-editor');
    if (old) old.remove();
    const r = this.row || {};
    const isAdmin = Auth.isAdmin;
    const deptOpts = ['<option value="">（未指定）</option>', ...Ledger.departments.map(d =>
      `<option value="${d.id}" ${r.department_id === d.id ? 'selected' : ''}>${Utils.escapeHtml(d.name)}</option>`)].join('');

    const sec = (groupKey, extra = '') => {
      const g = FORM_GROUPS.find(x => x.key === groupKey);
      return `<div class="form-sec">
        <div class="form-sec-title">${g.label}${!isAdmin && groupKey === 'dunning' ? '<span class="form-sec-tag">本部门可编辑区</span>' : ''}</div>
        <div class="form-grid">${g.fields.map(k => this.fieldCell(k)).join('')}</div>
        ${extra}
      </div>`;
    };

    // 状态与金额：合同金额（自动带入决算）+ 实时计算条
    const r0 = this.row || {};
    const contractAmtField = `
      <label class="form-field" title="决算方式非「工作量」时，保存后合同金额自动带入决算金额（可手动修改）">
        <span class="ff-label">合同金额<i style="font-style:normal;color:var(--text-3)">（自动带入决算）</i></span>
        <input type="number" step="0.0001" class="ipt ta-r" id="ed-contract_amount" value="${r0.contract_amount === null || r0.contract_amount === undefined ? '' : r0.contract_amount}">
      </label>`;
    const calcBar = `
      <div class="calc-bar" id="calc-bar">
        <span>账内应收 <b id="calc-internal">—</b><i>= 开票 − 到账</i></span>
        <span>账外应收 <b id="calc-external">—</b><i>= 决算 − 开票</i></span>
        <span>应收余额 <b id="calc-balance">—</b><i>= 决算 − 到账 − 核销</i></span>
      </div>`;
    const financeSec = `
      <div class="form-sec">
        <div class="form-sec-title">状态与金额${!isAdmin ? '<span class="form-sec-tag warn">金额字段仅财务可修改</span>' : ''}</div>
        ${isAdmin ? `<label class="form-field ff-dept"><span class="ff-label">部门名称（数据归属）</span>
          <select class="ipt" id="ed-department_id">${deptOpts}</select></label>` : ''}
        <div class="form-grid">
          ${FORM_GROUPS[1].fields.map(k => this.fieldCell(k)).join('')}
          ${isAdmin ? contractAmtField : ''}
        </div>
        ${calcBar}
      </div>`;

    const attachSec = `
      <div class="form-sec" id="sec-attachments">
        <div class="form-sec-title">附件上传区<span class="form-sec-tag">决算 / 中止证明 / 其他</span></div>
        <div id="att-box"><div class="loading-hint">附件加载中…</div></div>
      </div>`;

    const invoiceSec = `
      <div class="form-sec" id="sec-invoices">
        <div class="form-sec-title">开票明细<span class="muted" style="font-weight:400">（逐笔登记，「开票金额」可一键同步合计）</span></div>
        <div id="invoice-pane"><div class="loading-hint">开票明细加载中…</div></div>
      </div>`;

    const receiptSec = `
      <div class="form-sec" id="sec-receipts">
        <div class="form-sec-title">回款明细<span class="muted" style="font-weight:400">（逐笔登记到账，「到账金额」可一键同步合计，仅财务）</span></div>
        <div id="receipt-pane"><div class="loading-hint">回款明细加载中…</div></div>
      </div>`;

    const el = document.createElement('div');
    el.id = 'modal-editor';
    el.className = 'modal-mask';
    el.innerHTML = `
      <div class="modal modal-xl">
        <div class="modal-header">
          ${this.isNew ? '新增台账记录' : `编辑台账记录${r.contract_no ? ' · ' + Utils.escapeHtml(r.contract_no) : ''}`}
          <span class="modal-close" data-act="close">×</span>
        </div>
        <div class="modal-body">
          <datalist id="dl-owner-units"></datalist>
          ${!isAdmin ? '<div class="lock-banner">您是部门账号：可更新<b>催收跟踪信息与附件</b>；财务金额类字段由财务管理员维护。</div>' : ''}
          ${sec('base')}
          ${financeSec}
          ${sec('dunning')}
          ${attachSec}
          ${invoiceSec}
          ${receiptSec}
          <div id="editor-error" class="editor-error hidden"></div>
        </div>
        <div class="modal-footer">
          <button class="btn" data-act="close">关闭</button>
          <button class="btn btn-primary" data-act="save">${this.isNew ? '保存' : '保存修改'}</button>
        </div>
      </div>`;
    document.body.appendChild(el);
    this.bindModal(el);
    this.syncCalc(el);
    this.renderAttachments();
  },

  bindModal(el) {
    el.querySelector('[data-act="close"]').addEventListener('click', () => el.remove());
    Utils.bindMaskClose(el, () => el.remove());
    el.querySelector('[data-act="save"]').addEventListener('click', () => this.save(el));

    // 实时计算
    ['final_amount', 'invoiced_amount', 'received_amount', 'writeoff_amount'].forEach(k => {
      el.querySelector('#ed-' + k)?.addEventListener('input', () => this.syncCalc(el));
    });

    // 合同额自动带入决算（ADR-0003）：决算方式非「工作量」且决算金额为空时带入
    const finalMethodSel = el.querySelector('#ed-final_method');
    const contractAmt = el.querySelector('#ed-contract_amount');
    const finalAmt = el.querySelector('#ed-final_amount');
    const currentMethod = () => {
      if (!finalMethodSel) return '';
      if (finalMethodSel.value === '__other__') {
        const free = el.querySelector('#ed-final_method__free');
        return free ? free.value.trim() : '';
      }
      return finalMethodSel.value || '';
    };
    const autoFillFinal = () => {
      if (!contractAmt || !finalAmt || finalAmt.disabled) return;
      const m = currentMethod();
      if (m && m !== '工作量' && finalAmt.value === '' && contractAmt.value !== '') {
        finalAmt.value = contractAmt.value;
        this.syncCalc(el);
        Utils.toast('已按合同金额带入「决算金额」（决算方式非工作量），可手动修改', 'info');
      }
    };
    finalMethodSel?.addEventListener('change', autoFillFinal);
    contractAmt?.addEventListener('input', autoFillFinal);

    // 「其他（自由填写）」联动
    el.querySelectorAll('.sel-free').forEach(box => {
      const key = box.dataset.sf;
      const sel = box.querySelector(`#ed-${key}`);
      const free = box.querySelector(`#ed-${key}__free`);
      sel.addEventListener('change', () => {
        if (sel.value === '__other__') {
          free.classList.remove('hidden');
          free.focus();
        } else {
          free.classList.add('hidden');
        }
      });
      // 当前值为自定义：直接进入自由填写态
      if (sel.value === '__other__') {
        free.classList.remove('hidden');
      }
    });
  },

  /** 读取 select+free 组合的最终值 */
  readField(el, f) {
    if (f.type === 'select' && f.freeOther) {
      const sel = el.querySelector('#ed-' + f.key);
      if (!sel) return null;
      if (sel.value === '__other__') {
        const free = el.querySelector(`#ed-${f.key}__free`);
        return (free && free.value.trim()) || null;
      }
      if (sel.value === '__custom__') {
        // 自定义保留原值
        return (this.row && this.row[f.key]) || null;
      }
      return sel.value || null;
    }
    const node = el.querySelector('#ed-' + f.key);
    if (!node) return null;
    if (f.type === 'money') return node.value === '' ? null : Number(node.value);
    if (f.type === 'date') return node.value || null;
    return node.value.trim() || null;
  },

  syncCalc(el) {
    const num = id => { const n = el.querySelector('#ed-' + id); return n && !n.disabled ? Number(n.value || 0) : Number((this.row || {})[id] || 0); };
    const raw = id => { const n = el.querySelector('#ed-' + id); return n && !n.disabled ? n.value : (this.row || {})[id]; };
    const inv = num('invoiced_amount'), recv = num('received_amount'), wo = num('writeoff_amount');
    // 决算未定（输入为空）→ 账外应收 / 应收余额显示「—」（CONTEXT.md 金额口径）
    const hasFin = raw('final_amount') !== '' && raw('final_amount') !== null && raw('final_amount') !== undefined;
    const fin = hasFin ? Number(raw('final_amount')) : null;
    const set = (id, v) => { const n = el.querySelector('#' + id); if (n) n.textContent = v === null ? '—' : (Utils.fmtMoney(Math.round(v * 100) / 100) || '0'); };
    set('calc-internal', inv - recv);
    set('calc-external', fin === null ? null : fin - inv);
    set('calc-balance', fin === null ? null : fin - recv - wo);
  },

  /** 收集表单并保存 */
  async save(el) {
    const errBox = el.querySelector('#editor-error');
    errBox.classList.add('hidden');
    const editable = this.editableKeys();

    const payload = {};
    FIELD_DEFS.forEach(f => {
      if (editable && !editable.has(f.key)) return;   // 非管理员只提交自己可编辑的字段
      payload[f.key] = this.readField(el, f);
    });
    if (Auth.isAdmin) {
      const dept = el.querySelector('#ed-department_id');
      payload.department_id = dept && dept.value ? dept.value : null;
      const cAmt = el.querySelector('#ed-contract_amount');
      payload.contract_amount = cAmt && cAmt.value !== '' ? Number(cAmt.value) : null;
    } else if (this.isNew && Auth.arUser && Auth.arUser.department_id) {
      payload.department_id = Auth.arUser.department_id;
    }

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
      const msg = /AR_FIELD_LOCKED/.test(error.message)
        ? '保存被拒绝：金额等财务字段仅财务管理员可修改，请只更新催收跟踪信息。'
        : '保存失败：' + error.message;
      errBox.textContent = msg;
      errBox.classList.remove('hidden');
      return;
    }
    Utils.toast(this.isNew ? '新增成功' : '保存成功', 'success');
    el.remove();
    await Ledger.reload();
  },

  /* ---------- 附件区 ---------- */

  renderAttachments() {
    const box = document.getElementById('att-box');
    if (!box) return;
    if (this.isNew) {
      box.innerHTML = '<div class="muted" style="padding:4px 0">保存记录后即可上传附件（决算 / 中止证明 / 其他）。</div>';
      return;
    }
    const canEdit = Auth.can('edit');   // 要求五：实体部门对附件有编辑权限
    box.innerHTML = Attachments.render(canEdit);
    Attachments.bind(box, () => this.renderAttachments());
  },

  /* ---------- 开票明细 ---------- */

  invoices: [],

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
    const isAdmin = Auth.isAdmin;   // 开票金额属财务字段，非管理员只读
    const sum = this.invoices.reduce((s, i) => s + Number(i.amount || 0), 0);
    if (this.isNew) {
      pane.innerHTML = '<div class="muted" style="padding:6px 0">保存记录后即可逐笔登记开票明细。</div>';
      return;
    }
    pane.innerHTML = `
      <div class="invoice-summary">本合同累计开票：<b>${Utils.fmtMoney(sum)}</b>
        ${isAdmin ? '<button class="btn btn-xs" data-act="sync-invoiced">同步到「开票金额」</button>' : '<span class="muted">（仅财务可登记开票）</span>'}</div>
      <table class="invoice-table">
        <thead><tr><th style="width:110px">开票日期</th><th style="width:130px">发票号码</th><th style="width:110px" class="ta-r">金额</th><th>备注</th>${isAdmin ? '<th style="width:60px">操作</th>' : ''}</tr></thead>
        <tbody>
          ${this.invoices.map(i => `<tr data-inv-id="${i.id}">
            <td>${Utils.escapeHtml(i.invoice_date)}</td>
            <td>${Utils.escapeHtml(i.invoice_no || '')}</td>
            <td class="ta-r td-money">${Utils.fmtMoney(i.amount)}</td>
            <td>${Utils.escapeHtml(i.remark || '')}</td>
            ${isAdmin ? `<td><a class="link-danger" data-act="inv-del">删除</a></td>` : ''}
          </tr>`).join('') || '<tr><td colspan="5" class="empty-cell">暂无开票记录，在下方新增</td></tr>'}
        </tbody>
      </table>
      ${isAdmin ? `
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
      this.recalcChargeDate();
    }));
  },

  /** 「最新挂账时间」自动维护（2026-09-15 决策）：= 开票明细中最近一笔开票日期。
   *  开票明细增删后重算；明细为空则不动（保留手填/导入的历史值）。
   */
  async recalcChargeDate() {
    if (!this.row || !this.invoices.length) return;
    const latest = this.invoices
      .map(i => i.invoice_date)
      .filter(Boolean)
      .sort()
      .pop();
    if (!latest || latest === this.row.charge_date) return;
    const { error } = await sb.from('ar_ledger').update({ charge_date: latest }).eq('id', this.row.id);
    if (error) { Utils.toast('挂账时间更新失败：' + error.message, 'error'); return; }
    this.row.charge_date = latest;
    const input = document.querySelector('#modal-editor #ed-charge_date');
    if (input && !input.disabled) input.value = latest;
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
    this.recalcChargeDate();
    document.getElementById('inv-amount').value = '';
    document.getElementById('inv-remark').value = '';
    document.getElementById('inv-no').value = '';
    Utils.toast('已添加开票记录', 'success');
  },

  /** 把开票合计写回台账「开票金额」（仅财务） */
  async syncInvoiced(sum) {
    const { error } = await sb.from('ar_ledger').update({ invoiced_amount: sum }).eq('id', this.row.id);
    if (error) { Utils.toast('同步失败：' + error.message, 'error'); return; }
    Utils.toast('已同步到「开票金额」', 'success');
    this.row.invoiced_amount = sum;
    this.syncCalc(document.getElementById('modal-editor'));
  },

  /* ---------- 回款明细（v3.1：与开票明细对称，仅财务可维护） ---------- */

  receipts: [],

  async loadReceipts() {
    if (!this.row) return;
    const { data, error } = await sb.from('ar_receipts')
      .select('*').eq('ledger_id', this.row.id).order('receipt_date', { ascending: false });
    if (!error) this.receipts = data || [];
    this.renderReceiptPane();
  },

  renderReceiptPane() {
    const pane = document.getElementById('receipt-pane');
    if (!pane) return;
    const isAdmin = Auth.isAdmin;   // 到账金额属财务字段，非管理员只读
    const sum = this.receipts.reduce((s, i) => s + Number(i.amount || 0), 0);
    if (this.isNew) {
      pane.innerHTML = '<div class="muted" style="padding:6px 0">保存记录后即可逐笔登记回款明细。</div>';
      return;
    }
    pane.innerHTML = `
      <div class="invoice-summary">本合同累计到账：<b>${Utils.fmtMoney(sum)}</b>
        ${isAdmin ? '<button class="btn btn-xs" data-act="sync-received">同步到「到账金额」</button>' : '<span class="muted">（仅财务可登记回款）</span>'}</div>
      <table class="invoice-table">
        <thead><tr><th style="width:110px">到账日期</th><th style="width:110px" class="ta-r">金额</th><th>备注</th>${isAdmin ? '<th style="width:60px">操作</th>' : ''}</tr></thead>
        <tbody>
          ${this.receipts.map(i => `<tr data-rec-id="${i.id}">
            <td>${Utils.escapeHtml(i.receipt_date)}</td>
            <td class="ta-r td-money">${Utils.fmtMoney(i.amount)}</td>
            <td>${Utils.escapeHtml(i.remark || '')}</td>
            ${isAdmin ? `<td><a class="link-danger" data-act="rec-del">删除</a></td>` : ''}
          </tr>`).join('') || '<tr><td colspan="4" class="empty-cell">暂无回款记录，在下方新增</td></tr>'}
        </tbody>
      </table>
      ${isAdmin ? `
      <div class="invoice-add">
        <input type="date" class="ipt" id="rec-date" value="${Utils.today()}">
        <input type="number" step="0.0001" class="ipt ta-r" id="rec-amount" placeholder="到账金额" style="width:120px">
        <input class="ipt" id="rec-remark" placeholder="备注（选填）">
        <button class="btn btn-primary" data-act="rec-add">＋ 添加回款记录</button>
      </div>` : ''}`;

    pane.querySelector('[data-act="rec-add"]')?.addEventListener('click', () => this.addReceipt());
    pane.querySelector('[data-act="sync-received"]')?.addEventListener('click', () => this.syncReceived(sum));
    pane.querySelectorAll('[data-act="rec-del"]').forEach(a => a.addEventListener('click', async e => {
      const tr = e.target.closest('tr');
      const id = tr.dataset.recId;
      const { error } = await sb.from('ar_receipts').delete().eq('id', id);
      if (error) { Utils.toast('删除失败：' + error.message, 'error'); return; }
      this.receipts = this.receipts.filter(i => i.id !== id);
      this.renderReceiptPane();
    }));
  },

  async addReceipt() {
    const date = document.getElementById('rec-date').value;
    const amount = document.getElementById('rec-amount').value;
    if (!date) { Utils.toast('请选择到账日期', 'error'); return; }
    if (amount === '' || !(Number(amount) >= 0)) { Utils.toast('请填写到账金额', 'error'); return; }
    const payload = {
      ledger_id: this.row.id,
      receipt_date: date,
      amount: Number(amount),
      remark: document.getElementById('rec-remark').value.trim() || null,
      created_by: Auth.currentUser.id,
    };
    const { data, error } = await sb.from('ar_receipts').insert(payload).select().single();
    if (error) { Utils.toast('添加失败：' + error.message, 'error'); return; }
    this.receipts.unshift(data);
    this.renderReceiptPane();
    document.getElementById('rec-amount').value = '';
    document.getElementById('rec-remark').value = '';
    Utils.toast('已添加回款记录', 'success');
  },

  /** 把回款合计写回台账「到账金额」（仅财务） */
  async syncReceived(sum) {
    const { error } = await sb.from('ar_ledger').update({ received_amount: sum }).eq('id', this.row.id);
    if (error) { Utils.toast('同步失败：' + error.message, 'error'); return; }
    Utils.toast('已同步到「到账金额」', 'success');
    this.row.received_amount = sum;
    this.syncCalc(document.getElementById('modal-editor'));
  },
};
