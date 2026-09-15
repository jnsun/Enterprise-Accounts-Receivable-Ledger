/**
 * dictadmin.js - 选项管理页（要求三：蓝色内置可选项，财务可自行编辑）
 *
 * 管理表单下拉选项（ar_dict）：增删改、上下排序。
 * 保存方式：整类重写（先删后插），保证顺序即 sort_order。
 * 类别为空时以内置默认选项作为初始内容，保存后即入库生效。
 *
 * 版面：双栏面板 —— 左栏类别索引（类别名 + 项数 + 是否已自定义），
 *       右栏当前类别的选项编辑区。样式见 css/style.css「选项管理」段。
 */

const DictAdmin = {

  current: null,   // 当前类别 key
  items: [],       // 当前类别的选项值（有序）
  dirty: false,

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
    if (!this.items.length) this.items = [...Dicts.get(this.current)];
    this.dirty = false;
    this.render();
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

  rows() {
    if (!this.items.length) {
      return `<tr><td colspan="3" class="dict-empty">
          <b>这一类还没有选项</b>
          <span>表单下拉会回退为内置默认值，用下方输入框添加第一条</span>
        </td></tr>`;
    }
    return this.items.map((v, i) => `
      <tr data-idx="${i}">
        <td class="dt-idx">${i + 1}</td>
        <td class="dt-val">
          <input class="dict-item" data-idx="${i}" value="${Utils.escapeHtml(v)}"
                 aria-label="第 ${i + 1} 项选项内容">
        </td>
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
                <th class="dt-act">操作</th>
              </tr></thead>
              <tbody>${this.rows()}</tbody>
            </table>
          </div>
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

    // 就地编辑：不整体重渲染（会丢焦点），只同步头部与保存按钮
    page.querySelectorAll('.dict-item').forEach(inp => inp.addEventListener('input', () => {
      this.items[Number(inp.dataset.idx)] = inp.value;
      this.dirty = true;
      this.syncHead();
    }));

    // 新增：回车即添加，省一次鼠标移动
    const newInput = page.querySelector('#dict-new');
    newInput.addEventListener('keydown', e => {
      if (e.key === 'Enter') { e.preventDefault(); this.addItem(); }
    });
    page.querySelector('[data-act="add"]').addEventListener('click', () => this.addItem());

    page.querySelector('[data-act="save"]').addEventListener('click', () => this.save());
    this.bindRowActs();
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
       就真的从数据库删掉了 —— 这条路必须有个刹车。 */
    page.querySelectorAll('[data-act="del"]').forEach(a => a.addEventListener('click', async () => {
      const i = Number(a.dataset.idx);
      const v = this.items[i];
      const ok = await Utils.confirm(`确定删除选项「${v}」？\n保存后将从数据库中移除。`,
        { title: '删除选项', danger: true, confirmText: '删除' });
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
    await Dicts.load();     // 刷新全局字典缓存
    Utils.toast('选项已保存，全系统即时生效', 'success');
    this.render();
  },
};
