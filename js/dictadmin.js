/**
 * dictadmin.js - 选项管理页（要求三：蓝色内置可选项，财务可自行编辑）
 *
 * 管理表单下拉选项（ar_dict）：增删改、上下排序。
 * 保存方式：整类重写（先删后插），保证顺序即 sort_order。
 * 类别为空时以内置默认选项作为初始内容，保存后即入库生效。
 */

const DictAdmin = {

  current: null,   // 当前类别 key
  items: [],       // 当前类别的选项值（有序）
  dirty: false,

  async load(catKey) {
    const page = document.getElementById('page-dict');
    if (!page) return;
    if (!Auth.isAdmin) {
      page.innerHTML = '<div class="page-head"><h2>选项管理</h2></div><div class="guide-card"><p class="muted">只有财务管理员可以维护选项。</p></div>';
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

  render() {
    const page = document.getElementById('page-dict');
    if (!page) return;
    const cats = DICT_CATEGORIES;
    const cur = cats.find(c => c.key === this.current) || cats[0];
    const isBuiltinOnly = !Dicts.isManaged(this.current);

    const rows = this.items.map((v, i) => `
      <tr data-idx="${i}">
        <td style="width:36px" class="muted ta-r">${i + 1}</td>
        <td><input class="ipt dict-item" data-idx="${i}" value="${Utils.escapeHtml(v)}" style="width:100%"></td>
        <td style="width:110px" class="ta-r">
          <a data-act="up" data-idx="${i}" title="上移" ${i === 0 ? 'class="muted" style="pointer-events:none"' : ''}>↑</a>
          <a data-act="down" data-idx="${i}" title="下移" ${i === this.items.length - 1 ? 'class="muted" style="pointer-events:none"' : ''}>↓</a>
          <a class="link-danger" data-act="del" data-idx="${i}" title="删除">✕</a>
        </td>
      </tr>`).join('') || '<tr><td colspan="3" class="empty-cell">暂无选项，在下方添加</td></tr>';

    page.innerHTML = `
      <div class="page-head">
        <h2>选项管理</h2>
        <span class="muted">表单中的下拉选项在此维护，保存后全系统即时生效；选项为空时表单自动回退为内置默认值</span>
      </div>
      <div class="capsule-row">
        <span class="capsule-label">类别</span>
        ${cats.map(c => `<button class="capsule ${c.key === this.current ? 'active' : ''}" data-cat="${c.key}">${c.label}</button>`).join('')}
      </div>
      <div class="guide-card">
        <div class="page-head" style="margin-bottom:10px">
          <h3 style="font-size:14px">${cur.label}${isBuiltinOnly ? ' <span class="tag tag-gray">内置默认（未入库）</span>' : ''}</h3>
          ${this.dirty ? '<span class="tag tag-orange">有未保存的修改</span>' : '<span class="muted">共 ' + this.items.length + ' 项</span>'}
        </div>
        <div class="table-wrap">
          <table class="map-table">
            <thead><tr><th style="width:36px">#</th><th>选项内容</th><th style="width:110px" class="ta-r">操作</th></tr></thead>
            <tbody>${rows}</tbody>
          </table>
        </div>
        <div class="dict-add-row">
          <input class="ipt" id="dict-new" placeholder="新增选项内容（如：函件+邮件）" style="flex:1">
          <button class="btn" data-act="add">＋ 添加</button>
          <button class="btn btn-primary" data-act="save">保存本类选项</button>
        </div>
        <div id="dict-error" class="editor-error hidden"></div>
      </div>`;

    page.querySelectorAll('.capsule[data-cat]').forEach(c => c.addEventListener('click', () => {
      if (this.dirty && !confirm('当前类别有未保存的修改，切换将丢失，确定？')) return;
      this.current = c.dataset.cat;
      this.load(this.current);
    }));
    page.querySelectorAll('.dict-item').forEach(inp => inp.addEventListener('input', () => {
      this.items[Number(inp.dataset.idx)] = inp.value;
      this.dirty = true;
      this.renderBadge();
    }));
    page.querySelectorAll('[data-act="up"]').forEach(a => a.addEventListener('click', () => {
      const i = Number(a.dataset.idx);
      [this.items[i - 1], this.items[i]] = [this.items[i], this.items[i - 1]];
      this.dirty = true; this.render();
    }));
    page.querySelectorAll('[data-act="down"]').forEach(a => a.addEventListener('click', () => {
      const i = Number(a.dataset.idx);
      [this.items[i + 1], this.items[i]] = [this.items[i], this.items[i + 1]];
      this.dirty = true; this.render();
    }));
    page.querySelectorAll('[data-act="del"]').forEach(a => a.addEventListener('click', () => {
      this.items.splice(Number(a.dataset.idx), 1);
      this.dirty = true; this.render();
    }));
    page.querySelector('[data-act="add"]').addEventListener('click', () => {
      const inp = page.querySelector('#dict-new');
      const v = inp.value.trim();
      if (!v) return;
      if (this.items.includes(v)) { Utils.toast('该选项已存在', 'error'); return; }
      this.items.push(v);
      this.dirty = true;
      this.render();
    });
    page.querySelector('[data-act="save"]').addEventListener('click', () => this.save());
  },

  renderBadge() {
    const page = document.getElementById('page-dict');
    const badge = page && page.querySelector('.page-head .tag-orange');
    if (badge) return;
    // 轻量标记：只改提示文本
    const hint = page && page.querySelector('.guide-card .page-head .muted');
    if (hint) hint.innerHTML = '有未保存的修改';
  },

  async save() {
    const errBox = document.getElementById('dict-error');
    errBox.classList.add('hidden');
    // 清洗：去空、去重
    const clean = [...new Set(this.items.map(v => v.trim()).filter(Boolean))];
    if (clean.length !== this.items.length) {
      this.items = clean;
      this.dirty = true;
      this.render();
      Utils.toast('已自动去除空项/重复项，请再次点击保存', 'info');
      return;
    }
    // 整类重写
    const { error: delErr } = await sb.from('ar_dict').delete().eq('category', this.current);
    if (delErr) { errBox.textContent = '保存失败：' + delErr.message; errBox.classList.remove('hidden'); return; }
    if (clean.length) {
      const { error: insErr } = await sb.from('ar_dict')
        .insert(clean.map((v, i) => ({ category: this.current, value: v, sort_order: i + 1 })));
      if (insErr) { errBox.textContent = '保存失败：' + insErr.message; errBox.classList.remove('hidden'); return; }
    }
    this.dirty = false;
    await Dicts.load();     // 刷新全局字典缓存
    Utils.toast('选项已保存，全系统即时生效', 'success');
    this.render();
  },
};
