/**
 * colprefs.js - 台账列偏好：**显示 / 顺序 / 左侧冻结**，按登录账号独立保存
 *
 * 存储优先级：
 *   1. 数据库表 ar_user_prefs（每个账号一行，换电脑/换浏览器都跟随账号）
 *   2. localStorage（key 带用户 id，作为断网/未建表时的兜底，同样按账号隔离）
 *
 * 数据库表未建立时不会报错，自动降级为本地存储，功能照常可用。
 * ar_user_prefs.prefs 是 jsonb，三个维度都塞在这一个字段里，加维度不需要改表结构：
 *   { hidden_cols: [...], col_order: [...], frozen_cols: [...] }
 *
 * 三个概念的关系（面板里就是三件事）：
 *   order  —— 全部列（含隐藏列）的排列顺序，唯一真相
 *   hidden —— 哪些列不显示
 *   frozen —— 左侧冻结的列，**必须是 order 的一段前缀**（否则冻结列会盖住正在滚动的列，
 *             表现为「一列压着一列」），故面板用「冻结区 / 滚动区」两块来表达，
 *             拖过分界线即等于冻结或解冻，数据上等价于 order = [...冻结区, ...滚动区]。
 */

const ColPrefs = {

  hidden: new Set(),      // 被隐藏的字段 key
  order: [],              // 全部列的 key 顺序
  frozen: [],             // 左侧冻结的列 key（有序，且为 order 的前缀区）
  userId: null,
  dbOk: false,

  /** 左侧冻结列上限：再宽就没地方看数据了 */
  MAX_FROZEN: 8,

  /** 全部可显示列（台账字段 + 自动计算列） */
  allDefs() { return [...FIELD_DEFS, ...COMPUTED_DEFS]; },

  /** 全部列，按用户自定义顺序排列（未记录顺序的列按默认定义顺序补在末尾） */
  orderedDefs() {
    const all = this.allDefs();
    const byKey = new Map(all.map(f => [f.key, f]));
    const seen = new Set();
    const out = [];
    (Array.isArray(this.order) ? this.order : []).forEach(k => {
      const f = byKey.get(k);
      if (f && !seen.has(k)) { seen.add(k); out.push(f); }
    });
    all.forEach(f => { if (!seen.has(f.key)) { seen.add(f.key); out.push(f); } });
    return out;
  },

  /** 当前显示的列定义：**冻结区在前、滚动区在后**。
   *  冻结列必须是渲染顺序里连续的一段前缀 —— 否则粘住的列会盖在正在滚动的列上面，
   *  看起来像"一列压着一列"。这里强制成前缀，任何来源的偏好数据都破坏不了这条不变量。 */
  visibleDefs() {
    const vis = this.orderedDefs().filter(f => this.isVisible(f.key));
    const fzSet = new Set(this.frozen);
    return [...vis.filter(f => fzSet.has(f.key)), ...vis.filter(f => !fzSet.has(f.key))];
  },

  /** 常用列（一键精简，新指标体系核心 15 列）
   *  含「归属部门」：它是本系统的第一数据维度（RLS 按部门隔离、筛选首行也是部门），
   *  精简掉会让人以为"这一列丢了"。 */
  coreKeys() {
    return ['contract_no', 'project_name', 'department_id', 'owner_unit', 'project_status',
      'final_amount', 'invoiced_amount', 'received_amount', 'writeoff_amount',
      'receivable_internal', 'receivable_external', 'receivable_balance',
      'debt_status', 'collector', 'dunning_date'];
  },

  lsKey() { return 'ar_colprefs_' + (this.userId || 'anon'); },

  /* ================= 读写 ================= */

  /** 把任意来源的偏好对象规整成合法状态（丢弃已不存在的列、冻结列去重与封顶） */
  applyPrefs(p) {
    if (!p) return;
    if (Array.isArray(p)) {          // 兼容旧版：localStorage 里直接存了 hidden 数组
      this.hidden = new Set(p);
      return;
    }
    if (typeof p !== 'object') return;
    if (Array.isArray(p.hidden_cols)) this.hidden = new Set(p.hidden_cols);
    if (Array.isArray(p.col_order)) this.order = p.col_order.slice();
    if (Array.isArray(p.frozen_cols)) this.frozen = p.frozen_cols.slice();
  },

  /** 清理：只保留现存的列；order 补全；frozen 去重、截断 */
  normalize() {
    const keys = new Set(this.allDefs().map(f => f.key));
    this.hidden = new Set([...this.hidden].filter(k => keys.has(k)));
    const order = [];
    (Array.isArray(this.order) ? this.order : []).forEach(k => {
      if (keys.has(k) && !order.includes(k)) order.push(k);
    });
    this.allDefs().forEach(f => { if (!order.includes(f.key)) order.push(f.key); });
    this.order = order;
    const fz = [];
    (Array.isArray(this.frozen) ? this.frozen : []).forEach(k => {
      if (keys.has(k) && !fz.includes(k) && fz.length < this.MAX_FROZEN) fz.push(k);
    });
    this.frozen = fz;
  },

  /** 登录成功后调用 */
  async load(userId) {
    this.userId = userId;
    this.hidden = new Set(); this.order = []; this.frozen = []; this.dbOk = false;

    try {
      const raw = localStorage.getItem(this.lsKey());
      if (raw) this.applyPrefs(JSON.parse(raw));
    } catch (e) { /* 忽略本地读取失败 */ }

    try {
      const { data, error } = await sb
        .from('ar_user_prefs').select('prefs').eq('user_id', userId).maybeSingle();
      if (error) {
        this.dbOk = false;                     // 表未建立 → 仅用本地存储
      } else {
        this.dbOk = true;
        if (data && data.prefs) { this.applyPrefs(data.prefs); this.saveLocal(); }
      }
    } catch (e) {
      this.dbOk = false;
    }
    this.normalize();
  },

  prefs() {
    return { hidden_cols: [...this.hidden], col_order: [...this.order], frozen_cols: [...this.frozen] };
  },

  saveLocal() {
    try { localStorage.setItem(this.lsKey(), JSON.stringify(this.prefs())); } catch (e) { /* 忽略 */ }
  },

  /** 保存到服务器（失败则仅本地生效） */
  async save() {
    this.normalize();
    this.saveLocal();
    if (!this.userId) return;
    try {
      const { error } = await sb.from('ar_user_prefs').upsert(
        { user_id: this.userId, prefs: this.prefs(), updated_at: new Date().toISOString() },
        { onConflict: 'user_id' });
      if (error) this.dbOk = false;
    } catch (e) { this.dbOk = false; }
  },

  /* ================= 状态查询 ================= */

  isVisible(key) { return !this.hidden.has(key); },
  hiddenCount() { return this.hidden.size; },
  isFrozen(key) { return this.frozen.includes(key); },

  /** 实际生效的左侧冻结列（隐藏列不参与渲染，自然也不冻结） */
  frozenVisible() { return this.frozen.filter(k => this.isVisible(k)); },

  /** 分成「冻结区 / 滚动区」两块，两块合起来 = 全部列（顺序即渲染顺序） */
  zones() {
    const all = this.orderedDefs().map(f => f.key);
    const fz = [], sc = [];
    all.forEach(k => (this.frozen.includes(k) ? fz : sc).push(k));
    return { frozen: fz, scroll: sc };
  },

  /* ================= 变更 ================= */

  async commit(zones) {
    const fz = zones.frozen.slice(0, this.MAX_FROZEN);
    const rest = zones.scroll.slice();
    // 超出上限的被退回滚动区，避免"面板里冻结着、表里没冻结"
    zones.frozen.slice(this.MAX_FROZEN).forEach(k => { if (!rest.includes(k)) rest.unshift(k); });
    this.frozen = fz;
    this.order = [...fz, ...rest];
    await this.save();
  },

  async toggle(key) {
    if (this.hidden.has(key)) this.hidden.delete(key); else this.hidden.add(key);
    await this.save();
  },

  async showAll() { this.hidden = new Set(); await this.save(); },

  async onlyCore() {
    this.hidden = new Set(this.allDefs().map(f => f.key).filter(k => !this.coreKeys().includes(k)));
    await this.save();
  },

  async resetOrder() {
    this.order = []; this.frozen = [];
    await this.save();
  },

  /** 冻结：移到冻结区末尾（超上限则提示并放弃） */
  async freeze(key) {
    if (this.frozen.includes(key)) return;
    if (this.frozen.length >= this.MAX_FROZEN) {
      Utils.toast(`最多冻结 ${this.MAX_FROZEN} 列，请先解冻其它列`, 'error');
      return;
    }
    const z = this.zones();
    z.scroll = z.scroll.filter(k => k !== key);
    z.frozen.push(key);
    await this.commit(z);
  },

  /** 解冻：移到滚动区开头（贴着冻结区，视觉上位置变化最小） */
  async unfreeze(key) {
    const z = this.zones();
    z.frozen = z.frozen.filter(k => k !== key);
    z.scroll = [key, ...z.scroll.filter(k => k !== key)];
    await this.commit(z);
  },

  /** 拖动排序：把 dragKey 插到 targetKey 的前/后（目标所在区块决定它是否冻结） */
  async moveTo(dragKey, targetKey, after) {
    if (!dragKey || dragKey === targetKey) return;
    const z = this.zones();
    const targetZone = z.frozen.includes(targetKey) ? 'frozen' : 'scroll';
    const fromZone = z.frozen.includes(dragKey) ? 'frozen' : 'scroll';
    if (targetZone === 'frozen' && fromZone !== 'frozen' && z.frozen.length >= this.MAX_FROZEN) {
      Utils.toast(`最多冻结 ${this.MAX_FROZEN} 列，请先解冻其它列`, 'error');
      return;
    }
    z.frozen = z.frozen.filter(k => k !== dragKey);
    z.scroll = z.scroll.filter(k => k !== dragKey);
    const list = z[targetZone];
    const i = list.indexOf(targetKey);
    if (i < 0) list.push(dragKey);
    else list.splice(after ? i + 1 : i, 0, dragKey);
    await this.commit(z);
  },

  /* ================= 列设置面板 ================= */

  /**
   * 打开列设置面板
   * @param {HTMLElement} anchor 触发按钮
   * @param {Function} onChange 每次变更后回调（重绘表格；**不可整页重绘**，
   *                 否则本按钮会被替换掉，面板就丢了锚点）
   */
  openPanel(anchor, onChange) {
    this.closePanel();
    const el = document.createElement('div');
    el.id = 'col-panel';
    el.className = 'col-panel';
    document.body.appendChild(el);
    this._anchor = anchor;
    this._onChange = onChange;
    this._posDone = false;
    this.renderPanel();

    document.addEventListener('mousedown', this._outsideHandler = e => {
      if (el.contains(e.target) || (anchor && anchor.contains(e.target))) return;
      this.closePanel();
    });
    document.addEventListener('keydown', this._escHandler = e => {
      if (e.key === 'Escape') this.closePanel();
    });
  },

  /** 重绘面板（拖拽落地、勾选、冻结后调用；面板本身保持打开与滚动位置） */
  renderPanel() {
    const el = document.getElementById('col-panel');
    if (!el) return;
    const scrollTops = {};
    el.querySelectorAll('.cp-list').forEach(l => { scrollTops[l.dataset.list] = l.scrollTop; });

    const zones = this.zones();
    const defs = new Map(this.orderedDefs().map(f => [f.key, f]));
    const row = (key, zone) => {
      const f = defs.get(key);
      if (!f) return '';
      const vis = this.isVisible(key);
      const fz = zone === 'frozen';
      return `<div class="cp-row${vis ? '' : ' is-off'}" data-key="${f.key}" draggable="true">
        <span class="cp-grip" aria-hidden="true" title="拖动排序">⠿</span>
        <input type="checkbox" data-vis="${f.key}" ${vis ? 'checked' : ''}
               title="${vis ? '隐藏该列' : '显示该列'}">
        <span class="cp-name" title="${Utils.escapeHtml(f.label)}">${Utils.escapeHtml(f.label)}</span>
        <button class="cp-fz${fz ? ' is-on' : ''}" data-fz="${f.key}"
                title="${fz ? '取消冻结，移回滚动区' : '冻结到表格左侧'}">${fz ? '解冻' : '冻结'}</button>
      </div>`;
    };

    el.innerHTML = `
      <div class="cp-head">
        <span>显示列（${this.allDefs().length - this.hidden.size}/${this.allDefs().length}）</span>
        <span class="cp-tip">仅当前账号</span>
      </div>
      <div class="cp-body">
        <div class="cp-zone">
          <div class="cp-zone-title">左侧冻结区<span>${zones.frozen.length}/${this.MAX_FROZEN} · 拖动排序</span></div>
          <div class="cp-list" data-list="frozen">
            ${zones.frozen.map(k => row(k, 'frozen')).join('') || '<div class="cp-hint">还没有冻结列，点右侧「冻结」或把列拖到这里</div>'}
          </div>
        </div>
        <div class="cp-zone">
          <div class="cp-zone-title">横向滚动区<span>拖动排序 · 勾选显示</span></div>
          <div class="cp-list" data-list="scroll">${zones.scroll.map(k => row(k, 'scroll')).join('')}</div>
        </div>
      </div>
      <div class="cp-foot">
        <a data-act="all">全部显示</a>
        <a data-act="core">仅常用列</a>
        <a data-act="reset">恢复默认</a>
        <span class="cp-dbstate${this.dbOk ? '' : ' warn'}">${this.dbOk ? '已保存到账号' : '仅本台生效'}</span>
      </div>`;

    if (!this._posDone) { this.placePanel(); this._posDone = true; }
    Object.keys(scrollTops).forEach(k => {
      const l = el.querySelector(`.cp-list[data-list="${k}"]`);
      if (l) l.scrollTop = scrollTops[k];
    });
    this.bindPanel();
  },

  placePanel() {
    const el = document.getElementById('col-panel');
    const a = this._anchor;
    if (!el || !a || !a.getBoundingClientRect) return;
    const r = a.getBoundingClientRect();
    const w = el.offsetWidth || 330, h = el.offsetHeight || 420;
    const vw = document.documentElement.clientWidth, vh = document.documentElement.clientHeight;
    const x = Math.max(8, Math.min(r.left + window.scrollX, window.scrollX + vw - w - 12));
    let y = r.bottom + 6 + window.scrollY;
    if (r.bottom + 6 + h > vh) y = Math.max(window.scrollY + 8, window.scrollY + vh - h - 12);
    el.style.left = Math.round(x) + 'px';
    el.style.top = Math.round(y) + 'px';
  },

  bindPanel() {
    const el = document.getElementById('col-panel');
    if (!el) return;
    const after = async () => {
      this.renderPanel();
      if (this._onChange) this._onChange();
    };

    el.querySelectorAll('input[data-vis]').forEach(cb => cb.addEventListener('change', async () => {
      await this.toggle(cb.dataset.vis);
      await after();
    }));

    el.querySelectorAll('[data-fz]').forEach(b => b.addEventListener('click', async e => {
      e.preventDefault(); e.stopPropagation();
      const k = b.dataset.fz;
      if (this.isFrozen(k)) await this.unfreeze(k); else await this.freeze(k);
      await after();
    }));

    el.querySelector('[data-act="all"]').addEventListener('click', async () => { await this.showAll(); await after(); });
    el.querySelector('[data-act="core"]').addEventListener('click', async () => { await this.onlyCore(); await after(); });
    el.querySelector('[data-act="reset"]').addEventListener('click', async () => { await this.resetOrder(); await after(); });

    /* ---------- 拖拽 ---------- */
    let dragKey = null;
    const clearHints = () => el.querySelectorAll('.cp-drop').forEach(x => x.classList.remove('cp-drop'));
    const dropTarget = (row, e) => {
      const r = row.getBoundingClientRect();
      const before = Math.abs(e.clientY - r.top) < r.height / 2;
      clearHints();
      row.classList.add(before ? 'cp-drop-before' : 'cp-drop-after');
      return before ? 'before' : 'after';
    };

    el.querySelectorAll('.cp-row').forEach(row => {
      row.addEventListener('dragstart', e => {
        dragKey = row.dataset.key;
        row.classList.add('is-dragging');
        try { e.dataTransfer.effectAllowed = 'move'; e.dataTransfer.setData('text/plain', dragKey); } catch (err) { /* 忽略 */ }
      });
      row.addEventListener('dragend', () => { row.classList.remove('is-dragging'); clearHints(); dragKey = null; });
      row.addEventListener('dragover', e => { e.preventDefault(); dropTarget(row, e); });
      row.addEventListener('drop', async e => {
        e.preventDefault(); e.stopPropagation();
        const pos = dropTarget(row, e);
        const k = dragKey || e.dataTransfer.getData('text/plain');
        dragKey = null;
        if (k) { await this.moveTo(k, row.dataset.key, pos === 'after'); await after(); }
      });
    });

    // 拖到区块空白处 = 追加到该区块末尾
    el.querySelectorAll('.cp-list').forEach(list => {
      list.addEventListener('dragover', e => {
        e.preventDefault();
        if (!e.target.closest('.cp-row')) { clearHints(); list.classList.add('cp-drop'); }
      });
      list.addEventListener('drop', async e => {
        if (e.target.closest('.cp-row')) return;
        e.preventDefault();
        const zone = list.dataset.list;
        const k = dragKey || e.dataTransfer.getData('text/plain');
        dragKey = null; clearHints();
        if (!k) return;
        const z = this.zones();
        if (zone === 'frozen' && z.frozen.length >= this.MAX_FROZEN) {
          Utils.toast(`最多冻结 ${this.MAX_FROZEN} 列`, 'error');
          return;
        }
        z.frozen = z.frozen.filter(x => x !== k);
        z.scroll = z.scroll.filter(x => x !== k);
        z[zone].push(k);
        await this.commit(z);
        await after();
      });
    });
  },

  closePanel() {
    const el = document.getElementById('col-panel');
    if (el) el.remove();
    if (this._outsideHandler) { document.removeEventListener('mousedown', this._outsideHandler); this._outsideHandler = null; }
    if (this._escHandler) { document.removeEventListener('keydown', this._escHandler); this._escHandler = null; }
  },
};
