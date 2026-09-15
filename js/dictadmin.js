/**
 * dictadmin.js - 选项管理页（要求三：蓝色内置可选项，财务可自行编辑）
 *
 * 管理表单下拉选项（ar_dict）：增删改、上下排序。
 * 保存方式：整类重写（先删后插），保证顺序即 sort_order。
 * 类别为空时以内置默认选项作为初始内容，保存后即入库生效。
 *
 * 版面：双栏面板 —— 左栏类别索引（类别名 + 项数 + 是否已自定义），
 *       右栏当前类别的选项编辑区。样式见 css/style.css「选项管理」段。
 *
 * ── 与台账数据的一致性（「在用」列与孤儿值）──────────────────────────────
 * 选项表不是孤岛：删掉一个还在被台账引用的选项，那些记录里的值不会跟着变，
 * 只会变成「数据里有、选项表里没有」的孤儿值 —— 从此筛不出来、编辑时也选不回。
 * 所以这里反查台账，把三件事摆到台面上：
 *   ① 「在用」列：每个选项当前被多少条记录引用（0 = 从未使用）
 *   ② 底部一致性卡片：数据里在用、选项表里没有的值，可一键「加入选项」
 *   ③ 删除 / 保存**之前**确认影响面，而不是保存完才发现筛不出来了
 * 读不到台账（无权限、断网、表不存在）时一律降级为「不显示使用情况」，不影响编辑与保存。
 * 条数是全量口径：本页只对管理员开放（Auth.isAdmin），而 ar_ledger 的 RLS 里
 * ar_is_admin() 成立即 ar_can_see_row() 恒真，所以管理员看到的就是全部部门的记录。
 */

const DictAdmin = {

  current: null,   // 当前类别 key
  items: [],       // 当前类别的选项值（有序）
  dirty: false,

  usage: null,     // Map<值, 引用条数>；null = 读不到台账（降级：不显示使用情况）
  usageMax: 0,     // 上者中的最大条数（细条的归一基准；缓存起来避免每次渲染都遍历 Map）
  loadedVals: [],  // 本次打开时数据库里的值（用于分辨「原本是选项」vs「数据里冒出来的新值」）
  usageSrc: null,  // 当前类别的数据来源 {table, col, unit}

  async load(catKey) {
    const page = document.getElementById('page-dict');
    if (!page) return;
    if (!Auth.isAdmin) {
      page.innerHTML = `
        <div class="page-head"><h2>选项管理</h2></div>
        <div class="guide-card"><p class="muted">只有财务管理员可以维护选项。</p></div>`;
      return;
    }
    if (!this.current) this.current = catKey || DICT_CATEGORIES[0].key;

    // 读取数据库实际值；类别未维护时用内置默认值作为起点
    const { data, error } = await sb.from('ar_dict')
      .select('value').eq('category', this.current).order('sort_order');
    if (error) { Utils.toast('选项加载失败：' + error.message, 'error'); return; }
    this.items = (data || []).map(d => d.value);
    this.loadedVals = [...this.items];     // 快照：用于分辨「原本是选项」与「数据里冒出来的值」
    if (!this.items.length) this.items = [...Dicts.get(this.current)];
    this.dirty = false;
    await this.loadUsage();                // 反查台账引用情况（读不到则为 null，界面自动降级）
    this.render();
  },

  /* ================= 与台账数据的一致性 ================= */

  /** 类别 → 它在业务数据里的落点。多数类别是 ar_ledger 上的一列，字段名由 FIELD_DEFS 的
   *  dict 反查（不在这里再抄一份映射，否则加字段时两处要同时改）；
   *  附件类别落在 ar_attachments.category，不是台账字段，单独列出。 */
  sourceOf(cat) {
    if (cat === 'attach_category') {
      return { table: 'ar_attachments', col: 'category', unit: '份附件', where: '附件的「类别」' };
    }
    const f = FIELD_DEFS.find(x => x.dict === cat);
    if (!f) return null;
    return { table: 'ar_ledger', col: f.key, unit: '条台账', where: `台账的「${f.label}」列` };
  },

  /** 统计每个选项被多少条记录引用。
   *  读不到（无权限 / 断网 / 表不存在）就置 null —— 界面据此整体隐藏使用情况，
   *  而不是显示一片「0 条」把财务吓一跳。 */
  async loadUsage() {
    this.usage = null;
    this.usageMax = 0;
    this.usageSrc = this.sourceOf(this.current);
    if (!this.usageSrc) return;
    try {
      const { data, error } = await sb.from(this.usageSrc.table)
        .select(this.usageSrc.col).limit(20000);
      if (error) throw error;
      const m = new Map();
      (data || []).forEach(r => {
        const raw = r[this.usageSrc.col];
        const v = (raw === null || raw === undefined) ? '' : String(raw).trim();
        if (v) m.set(v, (m.get(v) || 0) + 1);
      });
      this.usage = m;
      let max = 0;
      m.forEach(n => { if (n > max) max = n; });
      this.usageMax = max;
    } catch (e) { /* 静默降级：没有使用情况也不影响编辑与保存 */ }
  },

  usageOf(v) {
    if (!this.usage) return null;
    return this.usage.get(String(v).trim()) || 0;
  },

  /** 数据里在用、选项表里没有的值。
   *  wasOption=true 表示它本来是选项、被删掉或改名了 —— 保存后会变成孤儿值，优先提醒；
   *  false 表示它是从台账里直接写进去的（combo 字段 / 「其他」自由填写），可一键收编。 */
  outsideValues() {
    if (!this.usage) return [];
    const now = new Set(this.items.map(v => String(v).trim()).filter(Boolean));
    const wasOption = new Set(this.loadedVals);
    return [...this.usage.entries()]
      .filter(([v]) => !now.has(v))
      .map(([v, n]) => ({ value: v, n, wasOption: wasOption.has(v) }))
      .sort((a, b) => (b.wasOption - a.wasOption) || (b.n - a.n) || a.value.localeCompare(b.value, 'zh'));
  },

  /* ================= 渲染 ================= */

  /** 左栏：一个类别条目（项数与表单下拉同源 —— 都走 Dicts.get） */
  catItem(c) {
    const managed = Dicts.isManaged(c.key);
    const active = c.key === this.current;
    return `
      <button type="button" class="dc-item ${active ? 'is-active' : ''}" data-cat="${c.key}"
        ${active ? 'aria-current="true"' : ''} title="${managed ? '已自定义' : '内置默认（尚未落库）'}">
        <span class="dc-dot ${managed ? 'is-db' : ''}" aria-hidden="true"></span>
        <span class="dc-name">${Utils.escapeHtml(c.label)}</span>
        <span class="dc-num">${Dicts.get(c.key).length}</span>
      </button>`;
  },

  /** 「在用」单元格：数字 + 一条按最高用量归一的细条（读数量级用，不是精确图表）。
   *  0 用一条空槽表示 —— 空槽本身就是「从未使用」的视觉信号，不必再写字。 */
  usageCell(v) {
    if (!this.usage) return '';
    const n = this.usageOf(v);
    const pct = n ? Math.max(4, Math.round(n / Math.max(1, this.usageMax) * 100)) : 0;
    const tip = n ? `当前有 ${n} ${this.usageSrc.unit}使用这个值`
                  : '当前没有记录使用这个值（可以安全删除）';
    return `<span class="du-cell" title="${tip}">
        <span class="du-meter${n ? '' : ' is-zero'}" aria-hidden="true"><i style="width:${pct}%"></i></span>
        <span class="du-n${n ? '' : ' is-zero'}">${n || '—'}</span>
      </span>`;
  },

  rows() {
    if (!this.items.length) {
      return `<tr><td colspan="${this.usage ? 4 : 3}" class="dict-empty">
          <b>这一类还没有选项</b>
          <span>表单下拉会回退为内置默认值，用下方输入框添加第一条</span>
        </td></tr>`;
    }
    return this.items.map((v, i) => `
      <tr data-idx="${i}" data-orig="${Utils.escapeHtml(v)}">
        <td class="dt-idx">${i + 1}</td>
        <td class="dt-val">
          <input class="dict-item" data-idx="${i}" value="${Utils.escapeHtml(v)}"
                 aria-label="第 ${i + 1} 项选项内容">
        </td>
        ${this.usage ? `<td class="dt-use">${this.usageCell(v)}</td>` : ''}
        <td class="dt-act">
          <div class="dt-acts">
            <button type="button" class="iconbtn" data-act="up" data-idx="${i}"
              title="上移" aria-label="上移" ${i === 0 ? 'disabled' : ''}>↑</button>
            <button type="button" class="iconbtn" data-act="down" data-idx="${i}"
              title="下移" aria-label="下移" ${i === this.items.length - 1 ? 'disabled' : ''}>↓</button>
            <button type="button" class="iconbtn is-del" data-act="del" data-idx="${i}"
              title="删除" aria-label="删除">✕</button>
          </div>
        </td>
      </tr>`).join('');
  },

  /** 底部一致性卡片：数据里在用、选项表里没有的值。
   *  没有任何问题时也要占位（给一句确认），否则右栏下方会空出一大块。 */
  consistHTML() {
    const last = this.items.length ? this.items[this.items.length - 1] : '';
    void last;
    if (!this.usageSrc) return '';
    if (this.usage === null) {
      return `
        <div class="dm-consist">
          <div class="du-head"><b>与台账数据的一致性</b></div>
          <p class="du-note">暂时读不到台账数据（权限或网络原因），无法核对「选项」与「实际数据」。
            这不影响编辑与保存。</p>
        </div>`;
    }
    const rows = this.outsideValues();
    const total = [...this.usage.values()].reduce((a, b) => a + b, 0);
    const used = this.items.filter(v => this.usageOf(v) > 0).length;
    const lost = rows.filter(o => o.wasOption);
    const lostN = lost.reduce((s, o) => s + o.n, 0);

    const list = rows.map((o, i) => `
      <li class="du-row ${o.wasOption ? 'is-opt' : ''}">
        <span class="du-val" title="${Utils.escapeHtml(o.value)}">${Utils.escapeHtml(o.value)}</span>
        <span class="du-src">${o.wasOption ? '原是选项' : '来自台账'}</span>
        <span class="du-cnt">${o.n} ${this.usageSrc.unit}</span>
        <button type="button" class="btn btn-xs" data-act="adopt" data-or="${i}">加入选项</button>
      </li>`).join('');

    return `
      <div class="dm-consist">
        <div class="du-head">
          <b>与台账数据的一致性</b>
          <span class="du-scope">作用于 ${this.usageSrc.where}</span>
          <span class="du-sum">本类别 ${this.items.length} 项 · ${used} 项在用 ·
            ${total} ${this.usageSrc.unit}${rows.length ? ' · 选项外 ' + rows.length + ' 个值' : ''}</span>
        </div>
        ${lost.length ? `<div class="du-alert">保存后这 ${lost.length} 个选项将从选项表移除，
          而它们仍被 ${lostN} ${this.usageSrc.unit}引用 —— 那些记录会变成孤儿值（值还在，
          但下拉里选不到、筛不出来）。</div>` : ''}
        ${rows.length
          ? `<ul class="du-list">${list}</ul>`
          : `<p class="du-ok">数据里的值都在上面的选项表中 ✓</p>`}
        ${used ? `<p class="du-tip">删除一个正在被使用的选项不会改动台账里的值，
          但那条记录会变成孤儿值：筛选里查不到、编辑时也选不回来。
          所以删除前与保存前都会先报出影响多少条。</p>` : ''}
      </div>`;
  },

  render() {
    const page = document.getElementById('page-dict');
    if (!page) return;
    const cats = DICT_CATEGORIES;
    const cur = cats.find(c => c.key === this.current) || cats[0];
    const managed = Dicts.isManaged(this.current);
    /* 保存按钮何时可用：
       - 有未保存修改 → 可保存
       - 该类别还只是内置默认（未落库）→ 也可保存，否则财务没有入口把它固化进数据库 */
    const canSave = this.dirty || !managed;

    page.innerHTML = `
      <div class="page-head">
        <h2>选项管理</h2>
        <span class="muted">表单下拉的取值与顺序在此维护，保存后全系统即时生效</span>
      </div>
      <div class="dict-panel">
        <aside class="dict-cats">
          <div class="dc-head"><span>类别</span><span class="dc-total">${cats.length}</span></div>
          <div class="dc-list">${cats.map(c => this.catItem(c)).join('')}</div>
          <div class="dc-legend">
            <span><i class="dc-dot is-db"></i>已自定义</span>
            <span><i class="dc-dot"></i>内置默认</span>
          </div>
        </aside>
        <section class="dict-main" id="dict-main">
          <header class="dm-head">
            <h3>${Utils.escapeHtml(cur.label)}</h3>
            <span class="tag ${managed ? 'tag-blue' : 'tag-gray'}">${managed ? '已自定义' : '内置默认（未落库）'}</span>
            <span class="dm-warn ${this.dirty ? '' : 'hidden'}">有未保存的修改</span>
            <span class="dm-count">共 ${this.items.length} 项</span>
          </header>
          <div class="dm-body">
            <table class="dict-table">
              <thead><tr>
                <th class="dt-idx">#</th>
                <th class="dt-val">选项内容</th>
                ${this.usage ? '<th class="dt-use">在用</th>' : ''}
                <th class="dt-act">操作</th>
              </tr></thead>
              <tbody>${this.rows()}</tbody>
            </table>
          </div>
          ${this.consistHTML()}
          <footer class="dm-foot">
            <div class="dm-add">
              <input class="ipt" id="dict-new" placeholder="新增选项内容…" aria-label="新增选项内容">
              <button type="button" class="btn" data-act="add">添加</button>
            </div>
            <button type="button" class="btn ${canSave ? 'btn-primary' : ''}" data-act="save"
              ${canSave ? '' : 'disabled'}>${managed ? '保存修改' : '保存并启用'}</button>
            <div id="dict-error" class="editor-error hidden"></div>
          </footer>
        </section>
      </div>`;

    this.bind();
  },

  /* ================= 事件 ================= */

  bind() {
    const page = document.getElementById('page-dict');

    // 切换类别（有未保存修改时先确认）
    page.querySelectorAll('.dc-item').forEach(b => b.addEventListener('click', async () => {
      const key = b.dataset.cat;
      if (key === this.current) return;
      if (this.dirty) {
        const ok = await Utils.confirm('当前类别有未保存的修改，切换后将丢失。确定切换？',
          { title: '切换类别', confirmText: '放弃修改' });
        if (!ok) return;
      }
      this.current = key;
      await this.load(key);
    }));

    // 就地编辑：不整体重渲染（会丢焦点），只同步头部、保存按钮与使用情况
    page.querySelectorAll('.dict-item').forEach(inp => inp.addEventListener('input', () => {
      this.items[Number(inp.dataset.idx)] = inp.value;
      this.dirty = true;
      this.syncHead();
      this.syncUsage();
    }));

    // 新增：回车即添加，省一次鼠标移动
    const newInput = page.querySelector('#dict-new');
    newInput.addEventListener('keydown', e => {
      if (e.key === 'Enter') { e.preventDefault(); this.addItem(); }
    });
    page.querySelector('[data-act="add"]').addEventListener('click', () => this.addItem());

    page.querySelector('[data-act="save"]').addEventListener('click', () => this.save());
    this.bindRowActs();
    this.bindAdopt();
  },

  /** 一致性卡片里的「加入选项」（卡片会被 syncUsage 替换，故每次都要重新挂） */
  bindAdopt() {
    const page = document.getElementById('page-dict');
    if (!page) return;
    page.querySelectorAll('[data-act="adopt"]').forEach(b =>
      b.addEventListener('click', () => this.adopt(Number(b.dataset.or))));
  },

  adopt(i) {
    const o = this.outsideValues()[i];
    if (!o || this.items.includes(o.value)) return;
    this.items.push(o.value);
    this.dirty = true;
    this.render();
    Utils.toast(`已把「${o.value}」加入选项表，点「保存修改」后正式生效`, 'info');
  },

  bindRowActs() {
    const page = document.getElementById('page-dict');

    page.querySelectorAll('[data-act="up"]').forEach(a => a.addEventListener('click', () => {
      const i = Number(a.dataset.idx);
      if (i <= 0) return;
      [this.items[i - 1], this.items[i]] = [this.items[i], this.items[i - 1]];
      this.dirty = true;
      this.render();
      this.focusRow(i - 1, 'up');
    }));

    page.querySelectorAll('[data-act="down"]').forEach(a => a.addEventListener('click', () => {
      const i = Number(a.dataset.idx);
      if (i >= this.items.length - 1) return;
      [this.items[i + 1], this.items[i]] = [this.items[i], this.items[i + 1]];
      this.dirty = true;
      this.render();
      this.focusRow(i + 1, 'down');
    }));

    /* 删除要二次确认：文字按钮只有 11×15px 且紧贴上移/下移，误点后若再点保存
       就真的从数据库删掉了 —— 这条路必须有个刹车。
       确认框还要报出**影响面**：这个值当前被多少条记录引用。0 条时明说「可以安全删除」，
       否则财务每次都要停下来自己猜「删了会不会把台账搞乱」。 */
    page.querySelectorAll('[data-act="del"]').forEach(a => a.addEventListener('click', async () => {
      const i = Number(a.dataset.idx);
      const v = this.items[i];
      const n = this.usageOf(v);
      const unit = this.usageSrc ? this.usageSrc.unit : '';
      const msg = n === null
        ? `确定删除选项「${v}」？\n保存后将从数据库中移除。`
        : n > 0
          ? `确定删除选项「${v}」？\n\n当前有 ${n} ${unit}在使用这个值。`
            + `删除后这些记录里的值不会被改动，但会变成「数据里有、选项表里没有」的孤儿值`
            + ` —— 下拉里选不回来，筛选也筛不到。\n\n保存后将从数据库中移除。`
          : `确定删除选项「${v}」？\n\n当前没有记录在使用这个值，可以安全删除。\n保存后将从数据库中移除。`;
      const ok = await Utils.confirm(msg, { title: '删除选项', danger: true, confirmText: '删除' });
      if (!ok) return;
      this.items.splice(i, 1);
      this.dirty = true;
      this.render();
      // 焦点落到同一位置的那一行，连删多条时不用重新找
      if (!this.items.length) document.getElementById('dict-new')?.focus();
      else this.focusRow(Math.min(i, this.items.length - 1), 'del');
    }));
  },

  /** 重渲染后把焦点放回原位置（否则键盘/连点操作每次都要重新定位） */
  focusRow(i, prefer) {
    const btn = document.querySelector(`#page-dict [data-act="${prefer}"][data-idx="${i}"]`);
    if (btn && !btn.disabled) { btn.focus(); return; }
    document.querySelector(`#page-dict .dict-item[data-idx="${i}"]`)?.focus();
  },

  /** 局部同步头部状态（输入时用，避免重渲染丢焦点） */
  syncHead() {
    const main = document.getElementById('dict-main');
    if (!main) return;
    const managed = Dicts.isManaged(this.current);
    const warn = main.querySelector('.dm-warn');
    if (warn) warn.classList.toggle('hidden', !this.dirty);
    const cnt = main.querySelector('.dm-count');
    if (cnt) cnt.textContent = `共 ${this.items.length} 项`;
    const btn = main.querySelector('[data-act="save"]');
    if (btn) {
      const can = this.dirty || !managed;
      btn.disabled = !can;
      btn.classList.toggle('btn-primary', can);
      btn.textContent = managed ? '保存修改' : '保存并启用';
    }
  },

  /** 就地改名后同步「在用」列与一致性卡片 —— 改名会让原值当场变成孤儿值，
   *  数字必须跟着变，否则财务看不到自己刚刚制造的问题。 */
  syncUsage() {
    if (!this.usage) return;
    const main = document.getElementById('dict-main');
    if (!main) return;
    main.querySelectorAll('.dict-table tbody tr').forEach(tr => {
      const cell = tr.querySelector('.dt-use');
      const inp = tr.querySelector('.dict-item');
      if (cell && inp) cell.innerHTML = this.usageCell(inp.value);
    });
    const box = main.querySelector('.dm-consist');
    if (box) {
      box.outerHTML = this.consistHTML();   // 替换会带走卡片内的事件，故紧跟着重新挂
      this.bindAdopt();
    }
  },

  addItem() {
    const inp = document.getElementById('dict-new');
    if (!inp) return;
    const v = inp.value.trim();
    if (!v) { inp.focus(); return; }
    if (this.items.includes(v)) { Utils.toast('该选项已存在', 'error'); inp.select(); return; }
    this.items.push(v);
    this.dirty = true;
    this.render();
    const again = document.getElementById('dict-new');
    again?.focus();
    const body = document.querySelector('#page-dict .dm-body');
    if (body) body.scrollTop = body.scrollHeight;   // 连加多条时新行要在视野内
  },

  /* ================= 保存 ================= */

  /**
   * 整类重写：先删后插，保证 sort_order 就是列表顺序。
   *
   * ⚠ PostgREST 的单次请求没有事务，delete 与 insert 是两个请求 ——
   *   一旦 delete 成功而 insert 失败，该类选项就被清空且无法恢复。
   *   故这里先取一份回滚快照，插入失败时按原样写回（补偿事务）。
   *   快照必须取自「删除前的数据库内容」而不是内存里的 items：
   *   未落库的类别删 0 行，快照若用了内置默认值，回滚反而会把它误写成"已自定义"。
   */
  async save() {
    const cur = this.current;
    const errBox = document.getElementById('dict-error');
    const btn = document.querySelector('#page-dict [data-act="save"]');
    const managed = Dicts.isManaged(cur);
    const restoreBtn = () => {
      if (!btn) return;
      btn.disabled = !(this.dirty || !managed);
      btn.classList.toggle('btn-primary', !btn.disabled);
      btn.textContent = managed ? '保存修改' : '保存并启用';
    };
    const fail = (msg) => {
      if (errBox) { errBox.textContent = msg; errBox.classList.remove('hidden'); }
      Utils.toast('保存失败', 'error');
      restoreBtn();
    };

    if (errBox) errBox.classList.add('hidden');

    // 清洗：去空、去重
    const clean = [...new Set(this.items.map(v => v.trim()).filter(Boolean))];
    if (clean.length !== this.items.length) {
      this.items = clean;
      this.dirty = true;
      this.render();
      Utils.toast('已自动去除空项/重复项，请再次点击保存', 'info');
      return;
    }

    /* 影响面确认：这一步比「删除时逐个确认」重要得多 —— 删除只影响一项，
       而保存会一次性把整类重写，改名/删除攒在同一批里发生时，财务很难自己算清
       到底会甩下多少条孤儿记录。所以保存前把总数摆出来。 */
    if (this.usage) {
      const lost = this.outsideValues().filter(o => o.wasOption && o.n > 0);
      if (lost.length) {
        const total = lost.reduce((s, o) => s + o.n, 0);
        const names = lost.slice(0, 5).map(o => `「${o.value}」${o.n}`).join('、');
        const ok = await Utils.confirm(
          `本次保存将移除 ${lost.length} 个仍在使用中的选项，共影响 ${total} ${this.usageSrc.unit}：\n\n`
          + names + (lost.length > 5 ? ` 等 ${lost.length} 个` : '')
          + `\n\n这些记录里的值不会被改动，但会变成「数据里有、选项表里没有」的孤儿值，`
          + `之后下拉里选不回来。建议先在上方把它们改掉，或点「加入选项」保留。`,
          { title: '移除在用选项', danger: true, confirmText: '仍然保存' });
        if (!ok) { restoreBtn(); return; }
      }
    }

    if (btn) { btn.disabled = true; btn.textContent = '保存中…'; }

    // ① 回滚快照
    const { data: before, error: readErr } = await sb.from('ar_dict')
      .select('value, sort_order').eq('category', cur).order('sort_order');
    if (readErr) { fail('保存失败：' + readErr.message); return; }

    // ② 删旧
    const { error: delErr } = await sb.from('ar_dict').delete().eq('category', cur);
    if (delErr) { fail('保存失败：' + delErr.message); return; }

    // ③ 插新
    if (clean.length) {
      const { error: insErr } = await sb.from('ar_dict')
        .insert(clean.map((v, i) => ({ category: cur, value: v, sort_order: i + 1 })));
      if (insErr) {
        let note = '（已自动回滚，数据未丢失）';
        if ((before || []).length) {
          const { error: rbErr } = await sb.from('ar_dict').insert(
            before.map(r => ({ category: cur, value: r.value, sort_order: r.sort_order })));
          if (rbErr) note = `（自动回滚失败：${rbErr.message}，请联系管理员）`;
        }
        fail('保存失败：' + insErr.message + note);
        return;
      }
    }

    this.dirty = false;
    this.loadedVals = [...clean];   // 保存成功后，这批才算「原本就是选项」
    await Dicts.load();     // 刷新全局字典缓存
    Utils.toast('选项已保存，全系统即时生效', 'success');
    this.render();
  },
};
