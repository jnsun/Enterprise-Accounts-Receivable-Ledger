/**
 * colprefs.js - 台账列显示偏好（**按登录账号独立保存**，互不影响）
 *
 * 存储优先级：
 *   1. 数据库表 ar_user_prefs（每个账号一行，换电脑/换浏览器都跟随账号）
 *   2. localStorage（key 带用户 id，作为断网/未建表时的兜底，同样按账号隔离）
 *
 * 数据库表未建立时不会报错，自动降级为本地存储，功能照常可用。
 */

const ColPrefs = {

  hidden: new Set(),      // 被隐藏的字段 key 集合
  userId: null,
  dbOk: false,

  /** 全部可显示列（台账字段 + 自动计算列） */
  allDefs() { return [...FIELD_DEFS, ...COMPUTED_DEFS]; },

  /** 常用列（一键精简，新指标体系核心 14 列） */
  coreKeys() {
    return ['contract_no', 'project_name', 'owner_unit', 'project_status',
      'final_amount', 'invoiced_amount', 'received_amount', 'writeoff_amount',
      'receivable_internal', 'receivable_external', 'receivable_balance',
      'debt_status', 'collector', 'dunning_date'];
  },

  lsKey() { return 'ar_colprefs_' + (this.userId || 'anon'); },

  /** 登录成功后调用 */
  async load(userId) {
    this.userId = userId;
    this.hidden = new Set();
    try {
      const raw = localStorage.getItem(this.lsKey());
      if (raw) this.hidden = new Set(JSON.parse(raw));
    } catch (e) { /* 忽略本地读取失败 */ }

    try {
      const { data, error } = await sb
        .from('ar_user_prefs').select('prefs').eq('user_id', userId).maybeSingle();
      if (error) {
        this.dbOk = false;                     // 表未建立 → 仅用本地存储
      } else {
        this.dbOk = true;
        if (data && data.prefs && Array.isArray(data.prefs.hidden_cols)) {
          this.hidden = new Set(data.prefs.hidden_cols);
          this.saveLocal();
        }
      }
    } catch (e) {
      this.dbOk = false;
    }
  },

  isVisible(key) { return !this.hidden.has(key); },
  hiddenCount() { return this.hidden.size; },

  saveLocal() {
    try { localStorage.setItem(this.lsKey(), JSON.stringify([...this.hidden])); } catch (e) { /* 忽略 */ }
  },

  /** 保存到服务器（失败则仅本地生效） */
  async save() {
    this.saveLocal();
    if (!this.userId) return;
    try {
      const { error } = await sb.from('ar_user_prefs').upsert(
        { user_id: this.userId, prefs: { hidden_cols: [...this.hidden] }, updated_at: new Date().toISOString() },
        { onConflict: 'user_id' });
      if (error) this.dbOk = false;
    } catch (e) { this.dbOk = false; }
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

  /* ================= 列设置面板 ================= */

  /**
   * 打开列设置下拉面板
   * @param {HTMLElement} anchor 触发按钮
   * @param {Function} onChange 每次勾选变化后回调（重绘表格）
   */
  openPanel(anchor, onChange) {
    this.closePanel();
    const defs = this.allDefs();
    const el = document.createElement('div');
    el.id = 'col-panel';
    el.className = 'col-panel';
    el.innerHTML = `
      <div class="cp-head">
        <span>显示列（${defs.length - this.hidden.size}/${defs.length}）</span>
        <span class="cp-tip">设置仅对当前账号生效</span>
      </div>
      <div class="cp-list">
        ${defs.map(f => `
          <label class="cp-item">
            <input type="checkbox" data-key="${f.key}" ${this.isVisible(f.key) ? 'checked' : ''}>
            <span>${f.label}</span>
          </label>`).join('')}
      </div>
      <div class="cp-foot">
        <a data-act="all">全部显示</a>
        <a data-act="core">仅常用列</a>
        <span class="cp-dbstate ${this.dbOk ? '' : 'warn'}">${this.dbOk ? '已保存到账号' : '仅本台生效'}</span>
      </div>`;
    document.body.appendChild(el);

    // 定位：贴着按钮下方，避免溢出右边界
    const r = anchor.getBoundingClientRect();
    const w = el.offsetWidth || 260;
    el.style.top = (r.bottom + 6 + window.scrollY) + 'px';
    el.style.left = Math.max(8, Math.min(r.left + window.scrollX, window.scrollX + document.documentElement.clientWidth - w - 12)) + 'px';

    el.querySelectorAll('input[data-key]').forEach(cb => cb.addEventListener('change', async () => {
      await this.toggle(cb.dataset.key);
      el.querySelector('.cp-head span').textContent =
        `显示列（${defs.length - this.hidden.size}/${defs.length}）`;
      onChange && onChange();
    }));

    el.querySelector('[data-act="all"]').addEventListener('click', async () => {
      await this.showAll(); this.closePanel(); onChange && onChange();
      anchor.click && anchor.click();
    });
    el.querySelector('[data-act="core"]').addEventListener('click', async () => {
      await this.onlyCore(); this.closePanel(); onChange && onChange();
      anchor.click && anchor.click();
    });

    setTimeout(() => {
      document.addEventListener('mousedown', this._outsideHandler = e => {
        if (!el.contains(e.target) && e.target !== anchor) this.closePanel();
      });
      document.addEventListener('keydown', this._escHandler = e => {
        if (e.key === 'Escape') this.closePanel();
      });
    }, 0);
  },

  closePanel() {
    const el = document.getElementById('col-panel');
    if (el) el.remove();
    if (this._outsideHandler) { document.removeEventListener('mousedown', this._outsideHandler); this._outsideHandler = null; }
    if (this._escHandler) { document.removeEventListener('keydown', this._escHandler); this._escHandler = null; }
  },
};
