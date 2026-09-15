/**
 * admin.js - 用户管理 + 部门管理（管理员）+ 系统设置（管理员）
 *
 * 角色体系（与月报系统独立）：
 *   超级管理员 ar_super_admin=true → 全部账号管理 + 部门管理 + 系统设置
 *   普通管理员 ar_role='admin'    → 台账全部权限 + 报账员管理 + 部门管理 + 系统设置
 *   报账员     ar_role='user'     → 权限由 ar_user_perms 逐人开放
 *
 * 部门存于台账独立的 ar_departments 表，与月报系统互不影响；
 * 删除账号只移出台账（不删登录账号），对月报系统零影响。
 */

const Admin = {

  users: [],   // [{id, email, full_name, phone, ar_role, ar_super_admin, department_id, ar_departments, perms}]
  depts: [],   // [{id, name, sort_order}]
  /** 权限表读取异常时的页面提示（空串 = 正常） */
  permsWarning: '',

  async load() {
    const { data: profiles, error } = await sb.from('ar_users')
      .select('user_id, email, full_name, phone, department_id, ar_role, ar_super_admin, ar_protected, ar_departments(name)')
      .order('ar_super_admin', { ascending: false }).limit(500);
    if (error) { Utils.toast('用户列表加载失败：' + error.message, 'error'); return; }
    // 报账员的「台账权限」列完全依赖这张表。读不到时必须**看得见**，
    // 否则会表现成"所有报账员都没有权限"（常见原因：管理员判定策略未更新）
    const { data: permsRows, error: permErr } = await sb.from('ar_user_perms').select('user_id, perms');
    const permMap = new Map((permsRows || []).map(p => [p.user_id, p.perms || {}]));
    this.users = (profiles || []).map(p => ({ ...p, id: p.user_id, perms: permMap.get(p.user_id) || {} }));
    this.permsWarning = '';
    if (permErr) {
      this.permsWarning = '权限数据读取失败：' + permErr.message +
        '　→ 下面的权限勾选不可信，请先执行 sql/upgrade-v3.2-admin-rls.sql 再刷新。';
    } else if (!(permsRows || []).length && this.users.some(u => u.ar_role === 'user')) {
      this.permsWarning = '系统里有报账员，但一条权限记录都没读到。若确认分配过权限，请执行 sql/upgrade-v3.2-admin-rls.sql（管理员判定策略修复）后刷新。';
    }
    await this.loadDepts();
    this.render();
  },

  /** 加载台账部门字典（同步给台账页/导入页的下拉使用） */
  async loadDepts() {
    const { data } = await sb.from('ar_departments').select('id, name, sort_order').order('sort_order');
    this.depts = data || [];
    Ledger.departments = this.depts.map(d => ({ id: d.id, name: d.name }));
  },

  roleTag(u) {
    if (u.ar_super_admin) return '<span class="tag tag-red">超级管理员</span>';
    if (u.ar_role === 'admin') return '<span class="tag tag-blue">管理员</span>';
    return '<span class="tag tag-teal">报账员</span>';
  },

  render() {
    const page = document.getElementById('page-admin');
    if (!page) return;
    if (!Auth.isAdmin) {
      page.innerHTML = '<div class="page-head"><h2>用户管理</h2></div><div class="guide-card"><p class="muted">只有管理员可以查看用户。</p></div>';
      return;
    }
    const canManage = Auth.isSuperAdmin;   // 超级管理员：管理全部账号；普通管理员：仅管理报账员

    const rows = this.users.map(u => {
      const isSelf = u.id === Auth.currentUser.id;
      const dept = (u.ar_departments && u.ar_departments.name) || '未分配';
      // 权限列：管理员可勾选报账员权限
      let permCell;
      if (u.ar_role !== 'user') {
        permCell = '<span class="muted">拥有全部台账权限</span>';
      } else if (Auth.isAdmin) {
        permCell = PERM_DEFS.map(p => `
            <label class="perm-toggle" title="${p.label}">
              <input type="checkbox" data-user="${u.id}" data-perm="${p.key}" ${u.perms[p.key] ? 'checked' : ''}>
              <span>${p.label}</span>
            </label>`).join('') + '<a data-act="save-perms" data-id="' + u.id + '">保存权限</a>';
      } else {
        const n = PERM_DEFS.filter(p => u.perms[p.key]).length;
        permCell = '<span class="muted">' + n + ' / ' + PERM_DEFS.length + ' 项权限</span>';
      }
      // 操作列
      const acts = [];
      const isBaoZhangYuan = u.ar_role === 'user';
      // 受保护的主管理员：只有本人能编辑（他人不可编辑/删除）
      const canEditThis = canManage ? (!u.ar_protected || isSelf) : isBaoZhangYuan;
      if (canEditThis) acts.push('<a data-act="edit" data-id="' + u.id + '">编辑</a>');
      // 删除：超级管理员可删除自己以外任何账号；普通管理员仅可删报账员；主管理员受保护不可删
      const canDelete = (Auth.isSuperAdmin && !isSelf && !u.ar_protected) || (!Auth.isSuperAdmin && isBaoZhangYuan);
      if (canDelete) acts.push('<a class="link-danger" data-act="del" data-id="' + u.id + '">删除</a>');
      return `<tr data-id="${u.id}" class="${u.ar_super_admin ? 'row-admin' : ''}">
        <td style="min-width:130px">${Utils.escapeHtml(u.full_name || '（未命名）')}${isSelf ? ' <span class="tag tag-blue">我</span>' : ''}${u.ar_protected ? ' <span class="tag tag-red" title="不可被删除或降级">主管理员</span>' : ''}</td>
        <td style="min-width:180px">${Utils.escapeHtml(u.email || '')}</td>
        <td style="min-width:100px">${Utils.escapeHtml(dept)}</td>
        <td style="min-width:110px">${Utils.escapeHtml(u.phone || '')}</td>
        <td style="min-width:90px">${this.roleTag(u)}</td>
        <td class="perm-cell">${permCell}</td>
        <td style="width:150px;white-space:nowrap">${acts.join('')}</td>
      </tr>`;
    }).join('');

    // 部门管理（卡片网格）：笔数 = 该部门的台账记录数，便于判断哪些部门在用
    const countOf = {};
    (Ledger.rows || []).forEach(r => { countOf[r.department_id] = (countOf[r.department_id] || 0) + 1; });
    const deptCards = this.depts.map((d, i) => `
      <div class="dept-card" data-id="${d.id}">
        <div class="dc-head">
          <span class="dc-name" title="${Utils.escapeHtml(d.name)}">${Utils.escapeHtml(d.name)}</span>
          <span class="dc-count ${countOf[d.id] ? '' : 'zero'}" title="该部门的台账记录数">${countOf[d.id] || 0}</span>
        </div>
        <div class="dc-acts">
          <button class="dc-btn" data-act="dept-up" data-id="${d.id}" ${i === 0 ? 'disabled' : ''} title="上移">↑</button>
          <button class="dc-btn" data-act="dept-down" data-id="${d.id}" ${i === this.depts.length - 1 ? 'disabled' : ''} title="下移">↓</button>
          <button class="dc-btn" data-act="dept-edit" data-id="${d.id}" title="重命名">重命名</button>
          <button class="dc-btn danger" data-act="dept-del" data-id="${d.id}" title="删除" ${countOf[d.id] ? 'disabled' : ''}>删除</button>
        </div>
      </div>`).join('') || '<div class="dept-empty">暂无部门，在右上角输入名称后点「＋ 新增部门」创建</div>';

    page.innerHTML = `
      <div class="page-head">
        <h2>用户管理</h2>
        <span class="muted">${canManage
          ? '超级管理员：新增/编辑/删除全部账号；台账账号、部门体系与月报系统互相独立'
          : '管理员：可管理报账员账号与部门；管理员账号由超级管理员管理'}</span>
      </div>
      <div class="toolbar">
        <div class="toolbar-left"><span class="muted">共 ${this.users.length} 个账号 · 「删除」仅将账号移出台账，绝不影响月报系统</span></div>
        <div class="toolbar-right">${Auth.isAdmin ? '<button class="btn btn-primary" data-act="create">＋ 新增账号</button>' : ''}</div>
      </div>
      ${this.permsWarning ? `<div class="admin-warn">⚠ ${Utils.escapeHtml(this.permsWarning)}</div>` : ''}
      <div class="table-wrap">
        <table class="admin-table">
          <thead><tr>
            <th>用户</th><th>邮箱</th><th>部门</th><th>手机号</th><th>角色</th><th>台账权限</th><th>操作</th>
          </tr></thead>
          <tbody>${rows}</tbody>
        </table>
      </div>
      <div class="dept-panel">
        <div class="dept-panel-head">
          <div>
            <div class="dph-title">部门管理</div>
            <div class="dph-sub">台账独立部门，与月报系统互不影响 · 卡片右上角数字为该部门的台账记录数<br>
              已被用户或台账数据使用的部门不能删除；顺序即台账筛选与下拉里的展示顺序</div>
          </div>
          <div class="dept-add">
            <input class="ipt" id="dept-new-name" placeholder="新部门名称，如：财务资产部">
            <button class="btn btn-primary" data-act="dept-add">＋ 新增部门</button>
          </div>
        </div>
        <div class="dept-grid" id="dept-list">${deptCards}</div>
      </div>`;

    if (Auth.isAdmin) {
      page.querySelector('[data-act="create"]').addEventListener('click', () => this.userDialog(null));
      page.querySelectorAll('[data-act="edit"]').forEach(a => a.addEventListener('click', () => {
        const u = this.users.find(x => x.id === a.dataset.id);
        if (u) this.userDialog(u);
      }));
      page.querySelectorAll('[data-act="save-perms"]').forEach(a => a.addEventListener('click', () => this.savePerms(a.dataset.id)));
      page.querySelector('[data-act="dept-add"]').addEventListener('click', () => this.deptAdd());
      page.querySelectorAll('[data-act="dept-up"]').forEach(b =>
        b.addEventListener('click', () => this.moveDept(b.dataset.id, 'up')));
      page.querySelectorAll('[data-act="dept-down"]').forEach(b =>
        b.addEventListener('click', () => this.moveDept(b.dataset.id, 'down')));
      page.querySelectorAll('[data-act="dept-edit"]').forEach(a => a.addEventListener('click', () => {
        const d = this.depts.find(x => x.id === a.dataset.id);
        if (d) this.deptDialog(d);
      }));
      page.querySelectorAll('[data-act="dept-del"]').forEach(a => a.addEventListener('click', () => this.deleteDept(a.dataset.id)));
    }
    page.querySelectorAll('[data-act="del"]').forEach(a => a.addEventListener('click', () => this.deleteUser(a.dataset.id)));
  },

  /** 删除账号（超级管理员：除自己外任意；普通管理员：仅报账员） */
  async deleteUser(userId) {
    const u = this.users.find(x => x.id === userId);
    if (!u) return;
    const ok = await Utils.confirm(
      `确定删除账号「${u.full_name || u.email}」？\n该账号将被移出台账系统（登录账号保留，月报系统不受任何影响）。`,
      { danger: true, title: '删除账号', confirmText: '删除' });
    if (!ok) return;
    const { error } = await sb.rpc('ar_delete_user', { p_user_id: userId });
    if (error) { Utils.toast('删除失败：' + error.message, 'error'); return; }
    Utils.toast('已移出台账（不影响月报系统）', 'success');
    await this.load();
  },

  /** 报账员权限保存 */
  async savePerms(userId) {
    const perms = {};
    document.querySelectorAll(`input[data-user="${userId}"]`).forEach(cb => {
      if (cb.checked) perms[cb.dataset.perm] = true;
    });
    const { error } = await sb.from('ar_user_perms').upsert(
      { user_id: userId, perms, updated_by: Auth.currentUser.id, updated_at: new Date().toISOString() },
      { onConflict: 'user_id' });
    if (error) { Utils.toast('保存失败：' + error.message, 'error'); return; }
    const u = this.users.find(x => x.id === userId);
    if (u) u.perms = perms;
    Utils.toast('权限已保存', 'success');
  },

  /** 新增 / 编辑账号弹窗（含密码强度条） */
  userDialog(user) {
    const isNew = !user;
    const old = document.getElementById('modal-user');
    if (old) old.remove();

    const deptOpts = ['<option value="">（请选择部门）</option>', ...this.depts.map(d =>
      `<option value="${d.id}" ${user && user.department_id === d.id ? 'selected' : ''}>${Utils.escapeHtml(d.name)}</option>`)].join('');
    const adminOpt = Auth.isSuperAdmin ? '<option value="admin">管理员（全部台账权限）</option>' : '';
    const roleOpts = isNew
      ? `<option value="user" selected>报账员（按权限开放）</option>${adminOpt}`
      : user.ar_super_admin
        ? '<option value="admin" selected>超级管理员（SQL 设置，界面不可改）</option>'
        : `<option value="user" ${user.ar_role === 'user' ? 'selected' : ''}>报账员（按权限开放）</option>${adminOpt}`;
    const permBoxes = PERM_DEFS.map(p => `
      <label class="perm-toggle"><input type="checkbox" data-perm="${p.key}" ${user && user.perms[p.key] ? 'checked' : ''}>
      <span>${p.label}</span></label>`).join('');

    const el = document.createElement('div');
    el.id = 'modal-user';
    el.className = 'modal-mask';
    el.innerHTML = `
      <div class="modal">
        <div class="modal-header">${isNew ? '新增账号' : '编辑账号'}<span class="modal-close" data-act="close">×</span></div>
        <div class="modal-body">
          <div class="form-grid">
            ${isNew ? `<label class="form-field"><span class="ff-label">邮箱（登录账号）</span><input class="ipt" id="u-email" placeholder="name@company.com"></label>
                       <label class="form-field"><span class="ff-label">初始密码</span><input class="ipt" id="u-pwd" type="text" placeholder="至少 8 位，含大小写/数字/符号" autocomplete="new-password"></label>`
                    : `<label class="form-field"><span class="ff-label">邮箱</span><input class="ipt" value="${Utils.escapeHtml(user.email || '')}" disabled></label>
                       <label class="form-field"><span class="ff-label">重置密码（留空不修改）</span><input class="ipt" id="u-pwd" type="text" placeholder="至少 8 位，含大小写/数字/符号" autocomplete="new-password"></label>`}
            <label class="form-field"><span class="ff-label">姓名</span><input class="ipt" id="u-name" value="${Utils.escapeHtml(user ? (user.full_name || '') : '')}"></label>
            <label class="form-field"><span class="ff-label">手机号（可用于登录）</span><input class="ipt" id="u-phone" value="${Utils.escapeHtml(user ? (user.phone || '') : '')}"></label>
            <label class="form-field"><span class="ff-label">角色</span><select class="ipt" id="u-role" ${isNew ? '' : (user.ar_super_admin ? 'disabled' : '')}>${roleOpts}</select></label>
            <label class="form-field"><span class="ff-label">部门（报账员必选）</span><select class="ipt" id="u-dept">${deptOpts}</select></label>
          </div>
          <div class="pwd-meter"><div class="pwd-meter-bar" id="u-pwd-bar"></div></div>
          <div class="pwd-hint" id="u-pwd-hint"></div>
          <div class="form-field form-full" style="margin-top:12px"><span class="ff-label">台账权限（报账员生效；管理员自动拥有全部）</span>
            <div class="perm-cell" id="u-perms">${permBoxes}</div>
          </div>
          <div class="form-hint">若邮箱已被月报系统使用，将直接把该账号加入台账（无需密码，原登录方式不变）。</div>
          <div id="user-error" class="editor-error hidden"></div>
        </div>
        <div class="modal-footer">
          <button class="btn" data-act="close">取消</button>
          <button class="btn btn-primary" data-act="ok">${isNew ? '创建账号' : '保存修改'}</button>
        </div>
      </div>`;
    document.body.appendChild(el);
    el.querySelector('[data-act="close"]').addEventListener('click', () => el.remove());
    Utils.bindMaskClose(el, () => el.remove());
    Utils.bindPwdMeter(el.querySelector('#u-pwd'), el.querySelector('#u-pwd-bar'), el.querySelector('#u-pwd-hint'));

    const roleSel = el.querySelector('#u-role');
    const syncPermDisabled = () => {
      const r = roleSel.value;
      el.querySelectorAll('#u-perms input').forEach(cb => { cb.disabled = r !== 'user'; });
      el.querySelector('#u-perms').style.opacity = r === 'user' ? '1' : '.45';
    };
    roleSel.addEventListener('change', syncPermDisabled);
    syncPermDisabled();

    el.querySelector('[data-act="ok"]').addEventListener('click', async () => {
      const errBox = el.querySelector('#user-error');
      errBox.classList.add('hidden');
      const fullName = el.querySelector('#u-name').value.trim();
      const phone = el.querySelector('#u-phone').value.trim();
      const dept = el.querySelector('#u-dept').value || null;
      const pwd = el.querySelector('#u-pwd').value;
      const role = roleSel.value;
      const perms = {};
      el.querySelectorAll('#u-perms input[data-perm]').forEach(cb => { if (cb.checked) perms[cb.dataset.perm] = true; });

      // 强密码前端校验（创建必填；编辑留空表示不改密码）
      if ((isNew || pwd) && !Utils.pwdValid(pwd)) {
        errBox.textContent = '密码须至少 8 位，且同时包含大写字母、小写字母、数字和符号';
        errBox.classList.remove('hidden');
        return;
      }

      let error;
      if (isNew) {
        const email = el.querySelector('#u-email').value.trim();
        if (!email || !pwd) {
          errBox.textContent = '邮箱和初始密码必填'; errBox.classList.remove('hidden'); return;
        }
        ({ error } = await sb.rpc('ar_create_user', {
          p_email: email, p_password: pwd, p_full_name: fullName || null,
          p_phone: phone || null, p_department_id: dept, p_ar_role: role, p_perms: perms }));
      } else {
        ({ error } = await sb.rpc('ar_update_user', {
          p_user_id: user.id, p_full_name: fullName || null, p_phone: phone || null,
          p_department_id: dept, p_ar_role: roleSel.disabled ? null : role,
          p_password: pwd || null, p_perms: role === 'user' ? perms : null }));
      }
      if (error) {
        errBox.textContent = '保存失败：' + error.message;
        errBox.classList.remove('hidden');
        return;
      }
      el.remove();
      Utils.toast(isNew ? '账号已创建' : '已保存', 'success');
      await this.load();
    });
  },

  /* ---------- 部门管理 ---------- */

  /** 新增部门：输入框有值直接创建，留空则开弹窗（走带校验的完整流程） */
  async deptAdd() {
    const inp = document.getElementById('dept-new-name');
    const name = (inp && inp.value || '').trim();
    if (!name) { this.deptDialog(null); return; }
    const { error } = await sb.from('ar_departments').insert({ name, sort_order: this.depts.length + 1 });
    if (error) {
      Utils.toast('创建失败：' + (/duplicate|unique/i.test(error.message) ? '该部门名称已存在' : error.message), 'error');
      return;
    }
    Utils.toast(`已创建部门「${name}」`, 'success');
    await this.load();
  },

  /** 部门排序：与相邻项交换，并把 sort_order 规范化为 1..n（下拉与筛选顺序即此顺序） */
  async moveDept(deptId, dir) {
    const i = this.depts.findIndex(d => d.id === deptId);
    if (i < 0) return;
    const j = dir === 'up' ? i - 1 : i + 1;
    if (j < 0 || j >= this.depts.length) return;
    const arr = [...this.depts];
    [arr[i], arr[j]] = [arr[j], arr[i]];
    // 只更新顺序真正变化的行，避免无谓写入
    const changed = arr
      .map((d, idx) => ({ id: d.id, sort_order: idx + 1, old: Number(d.sort_order || 0) }))
      .filter(r => r.old !== r.sort_order);
    for (const r of changed) {
      const { error } = await sb.from('ar_departments').update({ sort_order: r.sort_order }).eq('id', r.id);
      if (error) { Utils.toast('排序保存失败：' + error.message, 'error'); await this.load(); return; }
    }
    await this.load();
  },

  deptDialog(dept) {
    const isNew = !dept;
    const old = document.getElementById('modal-dept');
    if (old) old.remove();
    const el = document.createElement('div');
    el.id = 'modal-dept';
    el.className = 'modal-mask';
    el.innerHTML = `
      <div class="modal modal-sm">
        <div class="modal-header">${isNew ? '新增部门' : '重命名部门'}<span class="modal-close" data-act="close">×</span></div>
        <div class="modal-body">
          <label class="form-field"><span class="ff-label">部门名称</span>
            <input class="ipt" id="dept-name" value="${Utils.escapeHtml(dept ? dept.name : '')}" placeholder="如：财务资产部"></label>
          <div id="dept-error" class="editor-error hidden"></div>
        </div>
        <div class="modal-footer">
          <button class="btn" data-act="close">取消</button>
          <button class="btn btn-primary" data-act="ok">${isNew ? '创建' : '保存'}</button>
        </div>
      </div>`;
    document.body.appendChild(el);
    el.querySelector('[data-act="close"]').addEventListener('click', () => el.remove());
    Utils.bindMaskClose(el, () => el.remove());
    el.querySelector('#dept-name').focus();

    el.querySelector('[data-act="ok"]').addEventListener('click', async () => {
      const name = el.querySelector('#dept-name').value.trim();
      const errBox = el.querySelector('#dept-error');
      errBox.classList.add('hidden');
      if (!name) { errBox.textContent = '请输入部门名称'; errBox.classList.remove('hidden'); return; }
      let error;
      if (isNew) ({ error } = await sb.from('ar_departments').insert({ name }));
      else ({ error } = await sb.from('ar_departments').update({ name }).eq('id', dept.id));
      if (error) {
        errBox.textContent = '保存失败：' + (error.message.includes('duplicate') || error.message.includes('unique') ? '该部门名称已存在' : error.message);
        errBox.classList.remove('hidden');
        return;
      }
      el.remove();
      Utils.toast(isNew ? '部门已创建' : '已保存', 'success');
      await this.load();
    });
  },

  async deleteDept(deptId) {
    const d = this.depts.find(x => x.id === deptId);
    if (!d) return;
    const used = this.users.some(u => u.department_id === deptId);
    const ok = await Utils.confirm(
      `确定删除部门「${d.name}」？` + (used ? '\n该部门下仍有用户，需先在用户列表中调整其部门。' : ''),
      { danger: true, title: '删除部门', confirmText: '删除' });
    if (!ok) return;
    const { error } = await sb.from('ar_departments').delete().eq('id', deptId);
    if (error) {
      const msg = /foreign key|外键/i.test(error.message)
        ? '该部门仍被用户或台账数据引用，无法删除'
        : error.message;
      Utils.toast('删除失败：' + msg, 'error');
      return;
    }
    Utils.toast('部门已删除', 'success');
    await this.load();
  },

  /* ---------- 系统设置（管理员） ---------- */
  /*
   * 本页只放「运行信息 + 数据维护工具」，不放业务词典：
   *   客户属性 / 部门 / 单位 / 工作性质 … 等下拉选项统一在「选项管理」页维护（ar_dict）。
   *
   * 历史变更（2026-09-15）：删除「超期预警天数」设置。它来自 v1 的自动逾期设想，
   * 但按 CONTEXT.md / ADR-0002 的结论，本院业务"按合同期限几乎全部逾期"、自动判定
   * 无区分度，债权状态改为人工维护，该天数已无人使用（Utils.overdueStatus 亦无调用方）。
   */

  async loadSettings() {
    const page = document.getElementById('page-settings');
    if (!page) return;

    // 前端构建版本：直接读 index.html 里 config.js 的 ?v=（免去两处手工同步）
    const build = (document.querySelector('script[src*="config.js"]') || { src: '' }).src.match(/[?&]v=([\w.]+)/);
    const dbHost = String(SUPABASE_URL || '').replace(/^https?:\/\//, '').replace(/\/+$/, '') || '未配置';
    const u = Auth.arUser || {};
    const roleName = Auth.isSuperAdmin ? '超级管理员' : (Auth.isAdmin ? '管理员' : '报账员');

    // 明细表探测：表未建时给出明确指引，而不是让回款区块静默报错
    let detailState = '<span class="tag tag-green">已就绪</span>';
    const { error: probeErr } = await sb.from('ar_receipts').select('id').limit(1);
    if (probeErr) {
      detailState = '<span class="tag tag-orange">未创建</span> <span class="muted">需执行 sql/upgrade-v3.1-receipts.sql</span>';
    }

    page.innerHTML = `
      <div class="page-head">
        <h2>系统设置</h2>
        <span class="muted">本页为运行信息与数据维护；业务下拉选项（客户属性 / 部门 / 单位 / 工作性质等）在「选项管理」页维护</span>
      </div>
      <div class="settings-grid">
        <div class="settings-card">
          <div class="set-title">系统信息</div>
          <div class="set-list">
            <div class="set-row"><span class="set-k">前端构建版本</span><span class="set-v">${build ? 'v' + Utils.escapeHtml(build[1]) : '未识别'}</span></div>
            <div class="set-row"><span class="set-k">数据库实例</span><span class="set-v">${Utils.escapeHtml(dbHost)}</span></div>
            <div class="set-row"><span class="set-k">台账记录</span><span class="set-v">${(Ledger.rows || []).length} 条</span></div>
            <div class="set-row"><span class="set-k">开票/回款明细</span><span class="set-v">${detailState}</span></div>
          </div>
        </div>

        <div class="settings-card">
          <div class="set-title">当前账号</div>
          <div class="set-list">
            <div class="set-row"><span class="set-k">登录邮箱</span><span class="set-v">${Utils.escapeHtml((Auth.currentUser && Auth.currentUser.email) || '—')}</span></div>
            <div class="set-row"><span class="set-k">姓名</span><span class="set-v">${Utils.escapeHtml(u.full_name || '（未填写）')}</span></div>
            <div class="set-row"><span class="set-k">角色</span><span class="set-v">${roleName}</span></div>
            <div class="set-row"><span class="set-k">归属部门</span><span class="set-v">${Utils.escapeHtml((u.ar_departments && u.ar_departments.name) || '未分配')}</span></div>
            <div class="set-row"><span class="set-k">台账权限</span><span class="set-v">${Auth.permCount()} / ${PERM_DEFS.length} 项${Auth.isAdmin ? '（管理员默认全部）' : ''}</span></div>
          </div>
          <div class="set-hint">账号信息与权限由管理员在「用户管理」页调整；密码在右上角「个人设置」里修改。</div>
        </div>

        <div class="settings-card">
          <div class="set-title">数据维护</div>
          <p class="set-hint">
            「最新挂账时间」已改为按开票明细自动维护（= 该合同最近一笔开票日期）。
            历史手工填写或导入的值与明细不一致时，可在此一键校正；没有开票明细的记录保持不变。
          </p>
          <button class="btn btn-primary" id="set-recalc">重算全部台账的挂账时间</button>
          <div class="pwd-hint" id="set-recalc-msg"></div>
        </div>
      </div>`;

    page.querySelector('#set-recalc').addEventListener('click', async () => {
      const msg = page.querySelector('#set-recalc-msg');
      const ok = await Utils.confirm(
        '将把每条台账的「最新挂账时间」重算为该合同最近一笔开票日期。\n' +
        '没有开票明细的记录保持不变。该操作可重复执行。',
        { title: '重算挂账时间', confirmText: '开始重算' });
      if (!ok) return;
      msg.textContent = '正在重算…';
      const { data, error } = await sb.rpc('ar_recalc_charge_date');
      if (error) {
        msg.textContent = /does not exist|schema cache|Could not find/i.test(error.message)
          ? '数据库还没有这个维护函数，请先执行 sql/upgrade-v3.2-admin-rls.sql'
          : '重算失败：' + error.message;
        return;
      }
      const n = data && data.updated != null ? data.updated : 0;
      msg.textContent = `已更新 ${n} 条记录`;
      Utils.toast(`挂账时间重算完成：更新 ${n} 条`, 'success');
      // 目标页是隐藏的台账页，刷新失败不影响本页结果
      try { await Ledger.reload(); } catch (e) { /* 忽略 */ }
    });
  },
};
