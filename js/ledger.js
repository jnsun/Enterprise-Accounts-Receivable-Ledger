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

/** 没有归属部门的记录在界面上的显示值 / 部门胶囊里的筛选项（两处必须同一个常量，
 *  否则胶囊会列出「未指定」但点下去筛不出东西）。 */
const DEPT_NONE = '未指定';

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

  /** 行的派生列值（表格渲染 / 排序比较 / Excel 导出共用同一口径）
   *  口径（CONTEXT.md）：决算金额为空时，账外应收 / 应收余额 = null（显示"—"，
   *  不参与看板与汇总合计）；账内应收照常计算（不依赖决算）。
   *  注意 department_id 在这里是**部门名**而非 UUID —— r.department_id 才是原始外键，
   *  列上要给人看名字，故本函数返回显示值（与 attach_summary 同理）。
   */
  computeRow(r) {
    const inv = Number(r.invoiced_amount || 0);
    const recv = Number(r.received_amount || 0);
    const bal = this.balanceOf(r);
    return {
      receivable_internal: Math.round((inv - recv) * 10000) / 10000,
      receivable_external: bal === null ? null : Math.round((Number(r.final_amount) - inv) * 10000) / 10000,
      receivable_balance: bal,
      attach_summary: Attachments.summaryText(r.id),
      department_id: this.deptNameOf(r),
    };
  },

  /** 应收余额（决算未定 → null，显示「—」且不参与合计）。
   *  单独提出来，是因为筛选与分面计数会逐行调它 —— computeRow 还要拼附件摘要，
   *  在几千行的表上按维度反复调用会明显变慢。 */
  balanceOf(r) {
    const hasFinal = r.final_amount !== null && r.final_amount !== undefined && r.final_amount !== '';
    if (!hasFinal) return null;
    return Math.round((Number(r.final_amount) - Number(r.received_amount || 0)
      - Number(r.writeoff_amount || 0)) * 10000) / 10000;
  },

  deptNameOf(r) {
    const d = this.departments.find(x => x.id === r.department_id);
    return d ? d.name : DEPT_NONE;
  },

  /* ================= 筛选维度 =================
     每个维度与 filters 同名；取什么值由 dimValue 决定；「全部」= 该维度不设条件。
     默认值 def 只影响 chip 的高亮（未结是结清状态的默认，不是"没筛过"）。 */

  DIMS: [
    { key: 'dept',           label: '部门' },
    { key: 'settled',        label: '结清状态', def: '未结' },
    { key: 'project_status', label: '项目状态' },
    { key: 'debt_status',    label: '债权状态' },
    { key: 'client_attr',    label: '客户属性' },
  ],

  dimDef(key) { return this.DIMS.find(d => d.key === key) || { key, label: key }; },
  dimDefault(key) { return this.dimDef(key).def || '全部'; },
  isDefaultDim(key) { return this.filters[key] === this.dimDefault(key); },

  /** 某维度上「这一行属于哪个选项」—— 显示什么就按什么筛，两端共用同一个口径 */
  dimValue(key, r) {
    if (key === 'dept') return this.deptNameOf(r);
    if (key === 'settled') return this.balanceOf(r) === 0 ? '已结清' : '未结';
    if (key === 'client_attr') return (r.client_attr && String(r.client_attr).trim()) || '未填写';
    return r[key] || '未填写';
  },

  /** 单行是否命中当前筛选；skip 指定本次忽略哪个维度（算分面计数用） */
  rowMatch(r, skip) {
    const f = this.filters;
    if (f.batch && r.batch_id !== f.batch) return false;

    /* 结清状态（CONTEXT.md「记录生命周期」）：
       未结 = 应收余额 ≠ 0 **或决算未定**（余额不可知，不能算已结清） */
    if (skip !== 'settled' && f.settled !== '全部') {
      const b = this.balanceOf(r);
      if (f.settled === '未结' ? b === 0 : b !== 0) return false;
    }

    if (skip !== 'dept' && f.dept !== '全部') {
      /* 「未指定」只能按"部门名解析不出来"判断，不能按 department_id 是否为空判断 ——
         两者不等价：部门 id 存在但字典里查不到（字典未加载全 / 跨标签页新增的部门）
         同样会显示成「未指定」。显示与筛选必须同一个口径。 */
      if (f.dept === DEPT_NONE) {
        if (this.deptNameOf(r) !== DEPT_NONE) return false;
      } else {
        const d = this.departments.find(x => x.name === f.dept);
        /* 选中的部门名在部门表里查不到（部门被删或改过名）→ 命中 0 条，
           而不是"当成没筛"。空状态会给出可点击的清除建议。 */
        if (!d || r.department_id !== d.id) return false;
      }
    }

    if (skip !== 'project_status' && f.project_status !== '全部'
        && this.dimValue('project_status', r) !== f.project_status) return false;
    if (skip !== 'debt_status' && f.debt_status !== '全部'
        && this.dimValue('debt_status', r) !== f.debt_status) return false;
    if (skip !== 'client_attr' && f.client_attr !== '全部'
        && this.dimValue('client_attr', r) !== f.client_attr) return false;

    const kw = f.search.trim().toLowerCase();
    if (kw) {
      const hay = [r.contract_no, r.project_name, r.owner_unit, r.creditor_unit,
        r.collector, r.feedback, r.latest_progress, r.next_plan, r.remark, this.deptNameOf(r)]
        .map(x => String(x || '').toLowerCase()).join(' ');
      if (!hay.includes(kw)) return false;
    }
    return true;
  },

  /** 筛选后的行 */
  filteredRows() { return this.rows.filter(r => this.rowMatch(r, null)); },

  /** 分面计数：在「其他维度已生效」的前提下，本维度各选项各能筛出多少条。
   *  ⚠️ 这是本次修复的关键。旧胶囊上写的是"这个部门一共有几条"，与默认「未结」
   *  叠加后实际可能一条都筛不出来，点进去一片空白 —— 用户以为筛选坏了。
   *  现在下拉里每个选项后面的数字都是"点下去真能看到几条"。 */
  facetCounts(key) {
    const c = new Map();
    this.rows.forEach(r => {
      if (!this.rowMatch(r, key)) return;
      const k = this.dimValue(key, r);
      c.set(k, (c.get(k) || 0) + 1);
    });
    return c;
  },

  /** 本维度选「全部」时的条数（= 其他维度筛完还剩多少） */
  facetTotal(key) {
    let n = 0;
    this.rows.forEach(r => { if (this.rowMatch(r, key)) n++; });
    return n;
  },

  /** 某维度的可选项（只列数据里真实出现的值 —— 字典里有、一条数据都没有的选项
   *  在筛选器里只会挤占地方） */
  dimOptions(key) {
    const counts = this.facetCounts(key);
    let vals = [...counts.keys()];
    if (key === 'dept') {
      const ord = new Map(this.departments.map((d, i) => [d.name, i]));
      vals.sort((a, b) => (ord.has(a) ? ord.get(a) : 9998) - (ord.has(b) ? ord.get(b) : 9998));
      vals = [...vals.filter(v => v !== DEPT_NONE), ...vals.filter(v => v === DEPT_NONE)];
    } else {
      vals.sort((a, b) => (counts.get(b) - counts.get(a)) || String(a).localeCompare(String(b), 'zh'));
    }
    const cur = this.filters[key];
    const opts = [{ val: '全部', count: this.facetTotal(key), active: cur === '全部' }];
    vals.forEach(v => opts.push({ val: v, count: counts.get(v) || 0, active: cur === v }));
    if (cur !== '全部' && !vals.includes(cur)) opts.push({ val: cur, count: 0, active: true });
    return opts;
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

  /** 筛选条（一行）：每个维度一个 chip，点开才是胶囊选项。
   *  原先 5 行胶囊平铺 —— 部门一变多就糊成一片（31 个部门会占掉 4~5 行），
   *  而且看不到"点下去能筛出几条"，正是本次两个诉求的来源。 */
  filterBarHTML() {
    const chips = this.DIMS.map(d => {
      const cur = this.filters[d.key];
      const set = !this.isDefaultDim(d.key);
      /* 计数只在本维度真的被筛过时才算：默认状态下不算，省掉一次全表扫描 */
      const zero = set && (this.facetCounts(d.key).get(cur) || 0) === 0;
      return `<button class="fb-chip${set ? ' is-set' : ''}${zero ? ' is-zero' : ''}"
        data-dim="${d.key}" aria-haspopup="true" aria-expanded="false"
        title="${d.label}：${Utils.escapeHtml(cur)}${zero ? '（当前条件下没有记录，点开可看原因）' : '（点击选择）'}"
        ><span class="fb-lab">${d.label}</span><b class="fb-val">${Utils.escapeHtml(cur)}</b>${
        zero ? '<span class="fb-zero" aria-hidden="true">0</span>' : ''
      }<span class="fb-caret" aria-hidden="true">▾</span></button>`;
    }).join('');

    const shown = this.filteredRows().length, total = this.rows.length;
    return `${chips}
      <span class="fb-sum" id="fb-sum">${shown === total
        ? `共 ${total} 条`
        : `共 ${total} 条 · 筛选后 <b>${shown}</b> 条`}</span>
      ${this.hasActiveFilter() ? '<a class="fb-clear" data-act="clear-filters">清除筛选</a>' : ''}`;
  },

  /** 只重画筛选条（筛选变化后调用；表格另算） */
  syncFilterBar() {
    const bar = document.getElementById('filter-bar');
    if (!bar) return;
    this.closeDimPop();
    bar.innerHTML = this.filterBarHTML();
    this.bindFilterBar(bar);
  },

  bindFilterBar(root) {
    if (!root) return;
    root.querySelectorAll('[data-dim]').forEach(btn => {
      btn.addEventListener('click', e => {
        e.stopPropagation();
        if (document.getElementById('fb-pop') && this._popDim === btn.dataset.dim) { this.closeDimPop(); return; }
        this.openDimPop(btn.dataset.dim, btn);
      });
    });
    const clear = root.querySelector('[data-act="clear-filters"]');
    if (clear) clear.addEventListener('click', () => {
      this.DIMS.forEach(d => { this.filters[d.key] = this.dimDefault(d.key); });
      this.filters.search = '';
      const kw = document.getElementById('kw-input');
      if (kw) kw.value = '';
      this.syncFilterBar();
      this.refreshTable();
    });
  },

  /** 维度选项面板：胶囊 + 计数（「未指定」等长列表再加个搜索框） */
  openDimPop(dimKey, anchor) {
    this.closeDimPop();
    const d = this.dimDef(dimKey);
    const opts = this.dimOptions(dimKey);
    const el = document.createElement('div');
    el.id = 'fb-pop';
    el.className = 'fb-pop';
    el.innerHTML = `
      <div class="fb-pop-head"><span>${d.label}</span>
        <span class="fb-pop-tip">数字 = 点下去能筛出几条</span></div>
      ${opts.length > 9 ? '<input class="fb-search" placeholder="输入关键词过滤选项…" aria-label="过滤选项">' : ''}
      <div class="fb-opts">
        ${opts.map(o => {
          const isDefault = o.val === this.dimDefault(dimKey);
          /*
            0 条的选项淡化但仍可点：它正是"部门没问题、是被默认「未结」挡住了"的证据，
            点下去空状态会直接告诉用户该放开哪一个维度。 */
          return `<button class="capsule${o.active ? ' active' : ''}${o.active && isDefault ? ' is-default' : ''}${!o.count ? ' is-zero' : ''}"
            data-val="${Utils.escapeHtml(o.val)}" aria-pressed="${o.active}"
            >${Utils.escapeHtml(o.val)}<span class="fb-cnt">${o.count}</span></button>`;
        }).join('')}
      </div>`;
    document.body.appendChild(el);
    this._popDim = dimKey;
    this._popAnchor = anchor;
    this.placePop(el, anchor);
    anchor.setAttribute('aria-expanded', 'true');

    el.querySelectorAll('.capsule').forEach(c => c.addEventListener('click', () => {
      this.filters[dimKey] = c.dataset.val;
      this.closeDimPop();
      this.syncFilterBar();
      this.refreshTable();
    }));

    const search = el.querySelector('.fb-search');
    if (search) search.addEventListener('input', () => {
      const kw = search.value.trim().toLowerCase();
      el.querySelectorAll('.capsule').forEach(c => {
        c.classList.toggle('hidden', !!kw && !c.textContent.toLowerCase().includes(kw));
      });
    });

    document.addEventListener('mousedown', this._popOutside = e => {
      if (el.contains(e.target) || (anchor && anchor.contains(e.target))) return;
      this.closeDimPop();
    });
    document.addEventListener('keydown', this._popEsc = e => { if (e.key === 'Escape') this.closeDimPop(); });
  },

  closeDimPop() {
    const el = document.getElementById('fb-pop');
    if (el) el.remove();
    if (this._popAnchor) { this._popAnchor.setAttribute('aria-expanded', 'false'); this._popAnchor = null; }
    this._popDim = null;
    if (this._popOutside) { document.removeEventListener('mousedown', this._popOutside); this._popOutside = null; }
    if (this._popEsc) { document.removeEventListener('keydown', this._popEsc); this._popEsc = null; }
  },

  placePop(el, anchor) {
    const r = anchor.getBoundingClientRect();
    const w = el.offsetWidth || 260, h = el.offsetHeight || 200;
    const vw = document.documentElement.clientWidth, vh = document.documentElement.clientHeight;
    const x = Math.max(8, Math.min(r.left + window.scrollX, window.scrollX + vw - w - 12));
    let y = r.bottom + 6 + window.scrollY;
    if (r.bottom + 6 + h > vh) y = Math.max(window.scrollY + 8, window.scrollY + vh - h - 12);
    el.style.left = Math.round(x) + 'px';
    el.style.top = Math.round(y) + 'px';
  },

  /** 筛出 0 条时，逐个维度松一松试试 —— 告诉用户"放开哪一个就能看到几条"。
   *  这就是用户报的「部门筛选有问题」：部门没筛错，是默认「未结」把它挡在外面了。
   *
   *  两个容易写错的地方：
   *  ① 不能跳过"还停在默认值"的维度。挡住用户的往往正是默认值（本项目的
   *     「结清状态 = 未结」），跳过它等于永远给不出正确解释，只会建议去放宽
   *     用户亲手选的那一维 —— 反而让他以为筛选坏了。
   *  ② 排序按条数**从少到多**。最少条数的那个才是最贴近用户意图的解释：
   *     「放宽结清状态可看到 1 条」说明"你要的这条在，只是被挡住了"；
   *     而「放宽部门可看到 80 条」会把人带偏成"部门筛错了"。 */
  diagnoseEmpty() {
    const f = this.filters;
    const tips = [];
    if (f.dept !== '全部' && f.dept !== DEPT_NONE && !this.departments.some(d => d.name === f.dept)) {
      tips.push({ n: 0, label: `所选部门「${f.dept}」已不在部门表中，点此清除`, patch: { dept: '全部' } });
    }
    this.DIMS.forEach(d => {
      const saved = f[d.key];
      if (saved === '全部') return;                    // 本来就没限制，松它没有意义
      f[d.key] = '全部';
      const n = this.filteredRows().length;
      f[d.key] = saved;
      if (n > 0) tips.push({ n, label: `把「${d.label}」放宽到「全部」可看到 ${n} 条`, patch: { [d.key]: '全部' } });
    });
    if (f.search.trim()) {
      const saved = f.search;
      f.search = '';
      const n = this.filteredRows().length;
      f.search = saved;
      if (n > 0) tips.push({ n, label: `清空搜索关键词可看到 ${n} 条`, patch: { search: '' } });
    }
    this._emptyTips = tips.slice()
      .sort((a, b) => a.n - b.n)                       // 最"贴身"的解释排第一
      .slice(0, 3);
    return this._emptyTips;
  },

  /** 当前显示的列定义（已按用户的列顺序排列） */
  visibleDefs() { return ColPrefs.visibleDefs(); },

  renderTable() {
    const rows = this.filteredRows();
    const canEdit = Auth.can('edit'), canDelete = Auth.can('delete');
    const allChecked = rows.length > 0 && rows.every(r => this.selected.has(r.id));
    const defs = this.visibleDefs();

    /* 左侧冻结列：勾选 + 序号是固定前置，其后是用户在「列设置」里指定的列。
       顺序与冻结区都由 ColPrefs 维护（冻结区永远是渲染顺序的前一段），
       这里只把 fz-i 序号挂到单元格上 —— 真正的 left 偏移由 syncFrozen() 用
       **实测宽度**算（声明宽度会被 table-layout:auto 回缩，详见 style.css）。 */
    const frozenKeys = ColPrefs.frozenVisible();
    const fzOf = new Map();
    defs.forEach(f => { if (frozenKeys.includes(f.key)) fzOf.set(f.key, fzOf.size); });
    const lastFz = [...fzOf.keys()].pop();
    const fzCls = key => fzOf.has(key)
      ? ` is-frozen fz-${fzOf.get(key)}${key === lastFz ? ' is-fz-last' : ''}` : '';
    const idxCls = fzOf.size ? '' : ' is-fz-last';   // 没有用户冻结列时，序号列就是冻结区最后一列

    const headCells = [
      `<th class="col-check"><input type="checkbox" id="check-all" ${allChecked ? 'checked' : ''}></th>`,
      `<th class="col-idx${idxCls}">序</th>`,
      ...defs.map(f =>
        `<th style="min-width:${f.width}px;max-width:${f.width}px" class="${f.type === 'money' || f.type === 'date' ? 'ta-r ' : ''}${f.key === this.sortKey ? 'sorted' : ''}${fzCls(f.key)}" data-sort="${f.key}">${f.label}</th>`),
      `<th class="col-actions">操作</th>`,
    ].join('');

    const bodyRows = rows.map((r, i) => {
      const checked = this.selected.has(r.id);
      const comp = this.computeRow(r);
      const cells = defs.map(f => {
        const ex = fzCls(f.key);
        if (f.key === 'attach_summary') {
          const n = Attachments.count(r.id);
          return `<td title="${Utils.escapeHtml(comp.attach_summary)}" class="${n ? 'att-has' : 'muted'}${ex}">${n ? `📎 ${Utils.escapeHtml(comp.attach_summary)}` : '—'}</td>`;
        }
        /* 派生列（归属部门）取值以 computeRow 为准 —— 与排序比较器、Exporter.valueOf
           同一口径。若直接读 r[f.key]，department_id 会渲染成 UUID 原文。 */
        let v = (f.key in comp) ? comp[f.key] : r[f.key];
        if (f.type === 'money') {
          const isCalc = f.key in comp;
          const val = isCalc ? comp[f.key] : v;
          if (isCalc && val === null) return `<td class="ta-r td-money muted${ex}" title="决算金额未定，暂不计算">—</td>`;
          const neg = Number(val) < 0;
          return `<td class="ta-r td-money${neg ? ' neg' : ''}${ex}">${Utils.fmtMoney(val)}</td>`;
        }
        if (f.type === 'date') return `<td class="ta-r td-date${ex}">${Utils.escapeHtml(v || '')}</td>`;
        if (f.key === 'project_name') return `<td class="td-name${ex}" title="${Utils.escapeHtml(v)}">${Utils.escapeHtml(Utils.clampName(v))}</td>`;
        /* 归属部门为空时（多为导入时部门名对不上）用警示色标出来 ——
           判据取 comp.department_id（= deptNameOf 的结果，即该格真实显示值），
           与部门胶囊「未指定」的筛选口径严格一致。 */
        if (f.key === 'department_id') {
          const none = v === DEPT_NONE;
          return `<td class="td-dept${none ? ' is-none' : ''}${ex}" title="${Utils.escapeHtml(none ? '这条记录没有归属部门' : v)}">${Utils.escapeHtml(v || '')}</td>`;
        }
        if ((f.key === 'project_status' || f.key === 'debt_status') && v) {
          const cls = TAG_COLORS[v] || 'tag-gray';
          return `<td class="${ex.trim()}"><span class="tag ${cls}">${Utils.escapeHtml(v)}</span></td>`;
        }
        return `<td class="${f.cls || ''}${ex}" title="${Utils.escapeHtml(v)}">${Utils.escapeHtml(v || '')}</td>`;
      }).join('');
      const actions = `
        <td class="col-actions">
          ${canEdit ? `<a data-act="edit" data-id="${r.id}">编辑</a>` : ''}
          ${canDelete ? `<a class="link-danger" data-act="del" data-id="${r.id}">删除</a>` : ''}
        </td>`;
      return `<tr data-id="${r.id}" class="${checked ? 'row-checked' : ''}">
        <td class="col-check"><input type="checkbox" class="row-check" data-id="${r.id}" ${checked ? 'checked' : ''}></td>
        <td class="col-idx${idxCls}">${i + 1}</td>
        ${cells}${actions}
      </tr>`;
    }).join('');

    // 合计行（当前筛选范围）：金额列 + 计算金额列
    const sums = new Map();
    defs.filter(f => f.type === 'money').forEach(f => {
      sums.set(f.key, rows.reduce((s, r) => {
        const comp = this.computeRow(r);
        const v = (f.key in comp) ? comp[f.key] : r[f.key];
        return s + Number(v || 0);
      }, 0));
    });
    const footCells = [
      '<td colspan="2" class="ta-r td-foot td-foot-label">合计</td>',
      ...defs.map(f => f.type === 'money'
        ? `<td class="ta-r td-money td-foot${fzCls(f.key)}">${Utils.fmtMoney(sums.get(f.key))}</td>`
        : `<td class="${fzCls(f.key).trim()}"></td>`),
      '<td></td>',
    ].join('');

    if (!rows.length) {
      return this.renderEmpty() + `<div class="table-status">${this.statusText(rows)}</div>`;
    }
    return `
      <div class="table-wrap">
        <table class="ledger-table">
          <thead><tr>${headCells}</tr></thead>
          <tbody>${bodyRows}</tbody>
          <tfoot><tr>${footCells}</tr></tfoot>
        </table>
      </div>
      <div class="table-status">${this.statusText(rows)}</div>`;
  },

  /** 空状态：不放进表格里。
      台账表宽可达 3000px+，而 <td colspan="N"> 里的居中内容会落在整表的中点
      （约 x=1700），落在可视区之外 —— 也就是"一片空白什么都没有"。
      改为独立面板，并把"该放开哪个维度"直接做成可点的按钮。 */
  renderEmpty() {
    if (!this.rows.length) {
      return `<div class="table-wrap is-empty"><div class="empty-state">
        <span class="es-badge" aria-hidden="true">▤</span>
        <p class="es-title">台账还没有记录</p>
        <p class="es-hint">点「＋ 新增记录」逐条录入，或用「⇪ 导入 Excel」批量导入</p>
      </div></div>`;
    }
    const tips = this.diagnoseEmpty();
    return `<div class="table-wrap is-empty"><div class="empty-state">
      <span class="es-badge" aria-hidden="true">▤</span>
      <p class="es-title">当前筛选条件下没有记录</p>
      <p class="es-hint">共 ${this.rows.length} 条记录，被下面的条件挡在外面了：</p>
      ${tips.length
        ? `<div class="es-actions">${tips.map((t, i) =>
            `<button class="btn btn-sm" data-act="relax" data-idx="${i}">${Utils.escapeHtml(t.label)}</button>`).join('')}</div>`
        : '<p class="es-hint">把搜索关键词清空试试</p>'}
    </div></div>`;
  },

  /** 表格下沿的状态条：总数 / 筛选后 / 已选 / 隐藏列（隐藏列提示用右侧淡字，避免用户以为列丢了） */
  statusText(rows) {
    const shown = (rows || this.filteredRows()).length;
    const total = this.rows.length;
    const left = [`共 ${total} 条`];
    if (shown !== total) left.push(`筛选后 <b>${shown}</b> 条`);
    if (this.selected.size) left.push(`已选 ${this.selected.size} 条`);
    if (this.filters.batch) left.push('批次视图');
    const hidden = ColPrefs.hiddenCount();
    return left.join(' · ') +
      (hidden ? `<span class="ts-right">已隐藏 ${hidden} 列 · 「▦ 列设置」可恢复</span>` : '');
  },

  /** 横向滚动提示：只在确实还有内容滚出去的一侧投影（配合 .table-wrap 的类名） */
  syncOverflow() {
    const wrap = document.querySelector('#ledger-table-box .table-wrap');
    if (!wrap) return;
    const max = wrap.scrollWidth - wrap.clientWidth;
    wrap.classList.toggle('is-scrolled', max > 1 && wrap.scrollLeft > 2);
    wrap.classList.toggle('has-more', max > 1 && wrap.scrollLeft < max - 2);
  },

  /** 冻结列的 left 偏移必须严格等于「它前面所有冻结列的实际渲染宽度」之和。
   *  ⚠️ 不能拿声明宽度直接算：本表是 table-layout:auto，浏览器会把列宽向内容
   *  最小宽度回缩（勾选列声明 36px 只画到 29px），偏移比列宽大或小都会露出
   *  一条正在横向滚动的单元格 —— 表现为「序号列右边有一片空白 / 穿帮」。
   *  所以这里量一次真实宽度，再把偏移写成 CSS 规则（.fz-i）。 */
  syncFrozen() {
    const wrap = document.querySelector('#ledger-table-box .table-wrap');
    const table = wrap && wrap.querySelector('.ledger-table');
    const headRow = table && table.querySelector('thead tr');
    if (!headRow) return;

    const cells = [...headRow.children];
    const w = el => (el ? Math.round(el.getBoundingClientRect().width * 100) / 100 : 0);
    const hasOverflow = wrap.scrollWidth > wrap.clientWidth + 1;

    const chk = cells.find(th => th.classList.contains('col-check'));
    const idx = cells.find(th => th.classList.contains('col-idx'));
    const userFrozen = cells.filter(th => th.classList.contains('is-frozen'));

    /* 勾选列与序号列的宽度写在同一个变量上（宽度与 left 共用），
       只在出现横向滚动时才回写：那时各列宽度之和必然大于容器，
       浏览器不会再去分配多余空间，回写不会引起二次回流；
       而表格窄到不需要横向滚动时，偏移本来就无所谓。 */
    if (hasOverflow) {
      if (chk) table.style.setProperty('--fc-check', w(chk) + 'px');
      if (idx) table.style.setProperty('--fc-idx', w(idx) + 'px');
      table.style.setProperty('--fc-w', (w(chk) + w(idx)) + 'px');
    }

    const offsets = [];
    let acc = w(chk) + w(idx);
    userFrozen.forEach((th, i) => { offsets[i] = acc; acc = Math.round((acc + w(th)) * 100) / 100; });
    let st = document.getElementById('cfz-style');
    if (!st) {
      st = document.createElement('style');
      st.id = 'cfz-style';
      document.head.appendChild(st);
    }
    st.textContent = offsets
      .map((left, i) => `.ledger-table .fz-${i} { left: ${left}px; }`)
      .join('\n');
  },

  /** 让台账页恰好填满「顶栏以下、页面内边距以内」的高度。
      这一步是「表头常驻」的前提：#page-ledger 原先写的是 height:100%，
      但它的上一层（.app-main）高度由内容决定，百分比解析不出具体值，
      于是 .table-wrap 的 max-height:100% 退化成 none —— 表格没有内部滚动区，
      整页往下滚、表头跟着滚走（用户看到的现象），横向滚动条则被推到
      数千像素高的表格最底部，很难够得着。
      这里把可用高度量成 px，弹性链有确定值，滚动区就落在表格卡片内部。

      高度用**实测**而不是"视口高 − 顶栏 − 上下内边距"的算术推导：算术法只要
      上方有任何一处没被算进去（提示条、外边距、弹性间距、以后新增的一条
      工具行），就会溢出几像素 —— 页面立刻多出一条滚动条，用户抱怨的
      「容器不要有滚动栏」就又回来了。改法是先把内联高度撤掉、量出页面的
      自然顶边，再用「可用高度 − 顶边 − 下内边距」得出高度；上方多出什么
      都自然被包含进去。 */
  fitHeight() {
    const page = document.getElementById('page-ledger');
    if (!page) return;
    page.style.height = '';                            // 撤掉旧值，量自然顶边
    const rect = page.getBoundingClientRect();
    const top = rect.top + (window.scrollY || 0);
    const holder = page.parentElement;                 // .page-container
    const cs = getComputedStyle(holder || page);
    const padB = parseFloat(cs.paddingBottom) || 0;
    const mb = parseFloat(getComputedStyle(page).marginBottom) || 0;
    /* 可用高度取 documentElement.clientHeight：若此刻已有滚动条，它会自动
       被扣掉，于是下一次算出的高度更小、滚动条消失、再量又变准 —— 收敛。
       不会来回抖，因为"高度恰好等于可用值"本身就满足 scrollHeight === clientHeight。 */
    const vh = document.documentElement.clientHeight || window.innerHeight;
    page.style.height = Math.max(320, Math.round(vh - top - padB - mb)) + 'px';
  },

  /** 表格重建后重新挂滚动监听（节点是新的，旧监听随之作废） */
  bindOverflow() {
    const wrap = document.querySelector('#ledger-table-box .table-wrap');
    if (wrap) {
      wrap.addEventListener('scroll', () => this.syncOverflow(), { passive: true });
      this.syncOverflow();
    }
    if (!this._resizeBound) {
      this._resizeBound = true;
      const onResize = Utils.debounce(() => {
        if (document.getElementById('page-ledger')?.classList.contains('hidden')) return;
        this.fitHeight();
        this.syncOverflow();
        this.syncFrozen();
      }, 150);
      window.addEventListener('resize', onResize);
      /* 顶栏高度会变（部门胶囊换行），它一变可用高度就变 */
      if (typeof ResizeObserver !== 'undefined') {
        const tb = document.querySelector('.topbar');
        if (tb) new ResizeObserver(Utils.debounce(() => {
          if (document.getElementById('page-ledger')?.classList.contains('hidden')) return;
          this.fitHeight(); this.syncFrozen();
        }, 150)).observe(tb);
      }
    }
  },

  /** 是否有生效的筛选条件（只要有一个维度离开了它的默认值） */
  hasActiveFilter() {
    const f = this.filters;
    return !!(f.search.trim() || f.batch || this.DIMS.some(d => f[d.key] !== this.dimDefault(d.key)));
  },

  render() {
    const main = document.getElementById('page-ledger');
    if (!main) return;
    this.fitHeight();
    main.innerHTML = this.renderToolbar()
      + `<div class="filterbar" id="filter-bar">${this.filterBarHTML()}</div>`
      + '<div id="ledger-table-box">' + this.renderTable() + '</div>';
    this.bindEvents(main);
    this.bindFilterBar(main);
    this.bindOverflow();
    this.syncFrozen();
  },

  /** 只刷新表格区（筛选/勾选变化时避免整页重绘导致搜索框失焦、
      也会让「列设置」面板丢掉锚点按钮） */
  refreshTable() {
    const box = document.getElementById('ledger-table-box');
    const keepLeft = box?.querySelector('.table-wrap')?.scrollLeft || 0;   // 重绘会丢横向位置
    if (box) box.innerHTML = this.renderTable();
    const nw = document.querySelector('#ledger-table-box .table-wrap');
    if (nw && keepLeft) nw.scrollLeft = keepLeft;
    const btn = document.querySelector('[data-act="batch-del"]');
    if (btn) {
      btn.textContent = `删除选中（${this.selected.size}）`;
      btn.disabled = !this.selected.size;
    }
    const cpb = document.getElementById('btn-colprefs');   // 隐藏列数会变
    if (cpb) cpb.textContent = '▦ 列设置' + (ColPrefs.hiddenCount() ? `（隐${ColPrefs.hiddenCount()}）` : '');
    this.bindTableEvents(box);
    this.bindOverflow();
    this.syncFrozen();
  },

  /* ================= 事件 ================= */

  bindEvents(root) {
    const kw = root.querySelector('#kw-input');
    if (kw) kw.addEventListener('input', Utils.debounce(e => {
      this.filters.search = e.target.value;
      this.syncFilterBar();      // 计数与「筛选后 N 条」跟着搜索变
      this.refreshTable();
    }, 250));

    root.querySelectorAll('[data-act]').forEach(el => {
      const act = el.dataset.act;
      if (act === 'refresh') el.addEventListener('click', () => this.reload());
      if (act === 'add' && Auth.can('add')) el.addEventListener('click', () => Editor.open(null));
      if (act === 'import') el.addEventListener('click', () => Importer.open());
      if (act === 'export') el.addEventListener('click', () => Exporter.open());
      /* 回调只重绘表格区：整页重绘会把本按钮一起换掉，列设置面板就丢了锚点 */
      if (act === 'colprefs') el.addEventListener('click', () => ColPrefs.openPanel(el, () => this.refreshTable()));
      if (act === 'exit-batch') el.addEventListener('click', () => {
        this.filters.batch = null; App.navigate('ledger'); Batches.load();
      });
      if (act === 'batch-del' && Auth.can('delete')) el.addEventListener('click', () => this.deleteSelected());
    });

    this.bindTableEvents(root);
  },

  bindTableEvents(root) {
    if (!root) return;

    /* 空状态里的「放宽某个维度」按钮：点一下就把挡路的那一项松开，
       用户不需要自己猜是哪个筛选条件把数据挡在外面了 */
    root.querySelectorAll('[data-act="relax"]').forEach(b => b.addEventListener('click', () => {
      const tip = (this._emptyTips || [])[Number(b.dataset.idx)];
      if (!tip) return;
      Object.assign(this.filters, tip.patch);
      if ('search' in tip.patch) {
        const kw = document.getElementById('kw-input');
        if (kw) kw.value = tip.patch.search;
      }
      this.syncFilterBar();
      this.refreshTable();
      Utils.toast('已放宽筛选条件', 'info');
    }));

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
      if (status) status.innerHTML = this.statusText(this.filteredRows());
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
