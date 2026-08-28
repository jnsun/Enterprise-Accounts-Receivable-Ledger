/**
 * admin.js - 用户管理（仅台账超级管理员）+ 系统设置（管理员）
 *
 * 角色体系（与月报系统独立）：
 *   超级管理员 ar_super_admin=true → 管理「用户管理」页：新增/编辑/停用账号
 *   普通管理员 ar_role='admin'    → 台账全部权限 + 系统设置
 *   报账员     ar_role='user'     → 权限由 ar_user_perms 逐人开放
 *   已停用     ar_role='disabled' → 无法访问台账（登录后无任何权限）
 */

const Admin = {

  users: [],   // [{id, email, full_name, phone, ar_role, ar_super_admin, department_id, departments, perms}]

  async load() {
    const { data: profiles, error } = await sb.from('ar_users')
      .select('user_id, email, full_name, phone, department_id, ar_role, ar_super_admin, departments(name)')
      .order('ar_super_admin', { ascending: false }).limit(500);
    if (error) { Utils.toast('用户列表加载失败：' + error.message, 'error'); return; }
    const { data: permsRows } = await sb.from('ar_user_perms').select('user_id, perms');
    const permMap = new Map((permsRows || []).map(p => [p.user_id, p.perms || {}]));
    this.users = (profiles || []).map(p => ({ ...p, id: p.user_id, perms: permMap.get(p.user_id) || {} }));
    this.render();
  },

  roleTag(u) {
    if (u.ar_super_admin) return '<span class="tag tag-red">超级管理员</span>';
    if (u.ar_role === 'admin') return '<span class="tag tag-blue">管理员</span>';
    if (u.ar_role === 'disabled') return '<span class="tag tag-gray">已停用</span>';
    return '<span class="tag tag-teal">报账员</span>';
  },

  render() {
    const page = document.getElementById('page-admin');
    if (!page) return;
    if (!Auth.isAdmin) {
      page.innerHTML = '<div class="page-head"><h2>用户管理</h2></div><div class="guide-card"><p class="muted">只有管理员可以查看用户。</p></div>';
      return;
    }
    const canManage = Auth.isSuperAdmin;   // 超级管理员：增改停；普通管理员：仅可删除报账员

    const rows = this.users.map(u => {
      const isSelf = u.id === Auth.currentUser.id;
      const dept = (u.departments && u.departments.name) || '未分配';
      // 权限列：管理员可勾选报账员权限；无权限查看者只读展示
      let permCell;
      if (u.ar_role !== 'user') {
        permCell = '<span class="muted">' + (u.ar_role === 'disabled' ? '停用中，无任何权限' : '拥有全部台账权限') + '</span>';
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
      const isBaoZhangYuan = u.ar_role === 'user' || (u.ar_role === 'disabled' && !u.ar_super_admin);
      if (Auth.isSuperAdmin || isBaoZhangYuan) acts.push('<a data-act="edit" data-id="' + u.id + '">编辑</a>');
      // 删除：超级管理员可删除自己以外任何账号；普通管理员仅可删报账员
      const canDelete = (Auth.isSuperAdmin && !isSelf) || (!Auth.isSuperAdmin && isBaoZhangYuan);
      if (canDelete) acts.push('<a class="link-danger" data-act="del" data-id="' + u.id + '">删除</a>');
      if (Auth.isSuperAdmin && !isSelf && !u.ar_super_admin) {
        acts.push(u.ar_role === 'disabled'
          ? '<a data-act="enable" data-id="' + u.id + '">恢复</a>'
          : '<a data-act="disable" data-id="' + u.id + '">停用</a>');
      } else if (!Auth.isSuperAdmin && isBaoZhangYuan && !isSelf) {
        acts.push(u.ar_role === 'disabled'
          ? '<a data-act="enable" data-id="' + u.id + '">恢复</a>'
          : '<a data-act="disable" data-id="' + u.id + '">停用</a>');
      }
      return `<tr data-id="${u.id}" class="${u.ar_super_admin ? 'row-admin' : ''}">
        <td style="min-width:130px">${Utils.escapeHtml(u.full_name || '（未命名）')}${isSelf ? ' <span class="tag tag-blue">我</span>' : ''}</td>
        <td style="min-width:180px">${Utils.escapeHtml(u.email || '')}</td>
        <td style="min-width:100px">${u.ar_role === 'disabled' ? '<span class="muted">—</span>' : Utils.escapeHtml(dept)}</td>
        <td style="min-width:110px">${Utils.escapeHtml(u.phone || '')}</td>
        <td style="min-width:90px">${this.roleTag(u)}</td>
        <td class="perm-cell">${permCell}</td>
        <td style="width:150px;white-space:nowrap">${acts.join('')}</td>
      </tr>`;
    }).join('');

    page.innerHTML = `
      <div class="page-head">
        <h2>用户管理</h2>
        <span class="muted">${canManage
          ? '超级管理员：新增/编辑/停用/删除全部账号；台账账号体系与月报系统互相独立'
          : '管理员：可新增/编辑/停用/删除报账员账号；管理员账号由超级管理员管理'}</span>
      </div>
      <div class="toolbar">
        <div class="toolbar-left"><span class="muted">共 ${this.users.length} 个账号 · 「停用」可随时恢复；「删除」将移出台账，若未在月报系统使用则连登录账号一并删除</span></div>
        <div class="toolbar-right">${Auth.isAdmin ? '<button class="btn btn-primary" data-act="create">＋ 新增账号</button>' : ''}</div>
      </div>
      <div class="table-wrap">
        <table class="admin-table">
          <thead><tr>
            <th>用户</th><th>邮箱</th><th>部门</th><th>手机号</th><th>角色</th><th>台账权限</th><th>操作</th>
          </tr></thead>
          <tbody>${rows}</tbody>
        </table>
      </div>`;

    if (Auth.isAdmin) {
      page.querySelector('[data-act="create"]').addEventListener('click', () => this.userDialog(null));
      page.querySelectorAll('[data-act="edit"]').forEach(a => a.addEventListener('click', () => {
        const u = this.users.find(x => x.id === a.dataset.id);
        if (u) this.userDialog(u);
      }));
      page.querySelectorAll('[data-act="disable"]').forEach(a => a.addEventListener('click', () => this.setActive(a.dataset.id, 'disabled')));
      page.querySelectorAll('[data-act="enable"]').forEach(a => a.addEventListener('click', () => this.setActive(a.dataset.id, 'user')));
      page.querySelectorAll('[data-act="save-perms"]').forEach(a => a.addEventListener('click', () => this.savePerms(a.dataset.id)));
    }
    page.querySelectorAll('[data-act="del"]').forEach(a => a.addEventListener('click', () => this.deleteUser(a.dataset.id)));
  },

  /** 删除账号（超级管理员：除自己外任意；普通管理员：仅报账员） */
  async deleteUser(userId) {
    const u = this.users.find(x => x.id === userId);
    if (!u) return;
    const ok = await Utils.confirm(
      `确定删除账号「${u.full_name || u.email}」？\n` +
      (u.ar_super_admin ? '该账号是超级管理员，删除后需通过 SQL 才能恢复！' :
       '该账号将被移出台账系统，且不可通过界面恢复。'),
      { danger: true, title: '删除账号', confirmText: '删除' });
    if (!ok) return;
    const { data, error } = await sb.rpc('ar_delete_user', { p_user_id: userId });
    if (error) { Utils.toast('删除失败：' + error.message, 'error'); return; }
    Utils.toast(data && data.auth_deleted ? '账号已彻底删除' : '已移出台账（登录账号保留供月报系统使用）', 'success');
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

  /** 停用 / 恢复 */
  async setActive(userId, role) {
    const u = this.users.find(x => x.id === userId);
    if (!u) return;
    const ok = await Utils.confirm(
      role === 'disabled'
        ? `确定停用「${u.full_name || u.email}」？\n停用后该账号立即失去台账全部权限，账号本身保留，可随时恢复。`
        : `确定恢复「${u.full_name || u.email}」的台账访问？（角色：报账员）`,
      { danger: role === 'disabled', title: role === 'disabled' ? '停用账号' : '恢复账号', confirmText: '确定' });
    if (!ok) return;
    const { error } = await sb.rpc('ar_update_user', { p_user_id: userId, p_ar_role: role });
    if (error) { Utils.toast('操作失败：' + error.message, 'error'); return; }
    Utils.toast(role === 'disabled' ? '已停用' : '已恢复', 'success');
    await this.load();
  },

  /** 新增 / 编辑账号弹窗 */
  userDialog(user) {
    const isNew = !user;
    const old = document.getElementById('modal-user');
    if (old) old.remove();

    const deptOpts = ['<option value="">（请选择部门）</option>', ...Ledger.departments.map(d =>
      `<option value="${d.id}" ${user && user.department_id === d.id ? 'selected' : ''}>${Utils.escapeHtml(d.name)}</option>`)].join('');
    const adminOpt = Auth.isSuperAdmin ? '<option value="admin">管理员（全部台账权限）</option>' : '';
    const roleOpts = isNew
      ? `<option value="user" selected>报账员（按权限开放）</option>${adminOpt}`
      : user.ar_super_admin
        ? '<option value="admin" selected>超级管理员（SQL 设置，界面不可改）</option>'
        : Auth.isSuperAdmin
          ? `<option value="user" ${user.ar_role === 'user' ? 'selected' : ''}>报账员（按权限开放）</option>${adminOpt}
             <option value="disabled" ${user.ar_role === 'disabled' ? 'selected' : ''}>已停用</option>`
          : `<option value="user" ${user.ar_role === 'user' ? 'selected' : ''}>报账员（按权限开放）</option>
             <option value="disabled" ${user.ar_role === 'disabled' ? 'selected' : ''}>已停用</option>`;
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
                       <label class="form-field"><span class="ff-label">初始密码（至少 6 位）</span><input class="ipt" id="u-pwd" type="text" placeholder="首次登录后可自行修改"></label>`
                    : `<label class="form-field"><span class="ff-label">邮箱</span><input class="ipt" value="${Utils.escapeHtml(user.email || '')}" disabled></label>
                       <label class="form-field"><span class="ff-label">重置密码（留空不修改）</span><input class="ipt" id="u-pwd" type="text" placeholder="至少 6 位"></label>`}
            <label class="form-field"><span class="ff-label">姓名</span><input class="ipt" id="u-name" value="${Utils.escapeHtml(user ? (user.full_name || '') : '')}"></label>
            <label class="form-field"><span class="ff-label">手机号（可用于登录）</span><input class="ipt" id="u-phone" value="${Utils.escapeHtml(user ? (user.phone || '') : '')}"></label>
            <label class="form-field"><span class="ff-label">角色</span><select class="ipt" id="u-role" ${isNew ? '' : (user.ar_super_admin ? 'disabled' : '')}>${roleOpts}</select></label>
            <label class="form-field"><span class="ff-label">部门（报账员必选）</span><select class="ipt" id="u-dept">${deptOpts}</select></label>
          </div>
          <div class="form-field form-full"><span class="ff-label">台账权限（报账员生效；管理员自动拥有全部）</span>
            <div class="perm-cell" id="u-perms">${permBoxes}</div>
          </div>
          <div class="form-hint">账号与月报系统共用登录，但角色、部门、权限在两个系统各自独立。</div>
          <div id="user-error" class="editor-error hidden"></div>
        </div>
        <div class="modal-footer">
          <button class="btn" data-act="close">取消</button>
          <button class="btn btn-primary" data-act="ok">${isNew ? '创建账号' : '保存修改'}</button>
        </div>
      </div>`;
    document.body.appendChild(el);
    el.querySelector('[data-act="close"]').addEventListener('click', () => el.remove());
    el.addEventListener('click', e => { if (e.target === el) el.remove(); });

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
      const role = roleSel.value === 'disabled' ? 'disabled' : roleSel.value;
      const perms = {};
      el.querySelectorAll('#u-perms input[data-perm]').forEach(cb => { if (cb.checked) perms[cb.dataset.perm] = true; });

      let error;
      if (isNew) {
        const email = el.querySelector('#u-email').value.trim();
        if (!email || !pwd) {
          errBox.textContent = '邮箱和初始密码必填'; errBox.classList.remove('hidden'); return;
        }
        ({ error } = await sb.rpc('ar_create_user', {
          p_email: email, p_password: pwd, p_full_name: fullName || null,
          p_phone: phone || null, p_department_id: dept,
          p_ar_role: role === 'disabled' ? 'user' : role, p_perms: perms }));
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

  /* ---------- 系统设置（管理员） ---------- */

  async loadSettings() {
    const page = document.getElementById('page-settings');
    if (!page) return;
    page.innerHTML = `
      <div class="page-head"><h2>系统设置</h2></div>
      <div class="settings-card">
        <label class="form-field">
          <span class="ff-label">超期预警天数（完工日期后多少天未收清视为超期）</span>
          <input type="number" class="ipt" id="set-warn-days" min="1" max="3650" value="${Ledger.settings.warn_days}" style="width:140px">
        </label>
        <button class="btn btn-primary" id="set-save">保存设置</button>
      </div>`;
    page.querySelector('#set-save').addEventListener('click', async () => {
      const days = Number(page.querySelector('#set-warn-days').value);
      if (!(days >= 1 && days <= 3650)) { Utils.toast('预警天数须在 1 - 3650 之间', 'error'); return; }
      const { error } = await sb.from('ar_settings').update({ warn_days: days, updated_at: new Date().toISOString() }).eq('id', 1);
      if (error) { Utils.toast('保存失败：' + error.message, 'error'); return; }
      Ledger.settings.warn_days = days;
      Utils.toast('设置已保存', 'success');
      if (App.currentView === 'ledger') Ledger.render();
    });
  },
};
