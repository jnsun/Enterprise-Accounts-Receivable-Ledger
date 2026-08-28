/**
 * admin.js - 管理员模块（用户权限开放 / 系统设置）
 */

const Admin = {

  users: [],   // [{id, full_name, email?, phone?, role, department_id, departments, perms}]

  async load() {
    const { data: profiles, error } = await sb.from('profiles')
      .select('id, full_name, phone, role, department_id, departments(name)')
      .order('role').limit(500);
    if (error) { Utils.toast('用户列表加载失败：' + error.message, 'error'); return; }
    const { data: permsRows } = await sb.from('ar_user_perms').select('user_id, perms');
    const permMap = new Map((permsRows || []).map(p => [p.user_id, p.perms || {}]));
    this.users = (profiles || []).map(p => ({ ...p, perms: permMap.get(p.id) || {} }));
    this.render();
  },

  render() {
    const page = document.getElementById('page-admin');
    if (!page) return;

    const rows = this.users.map(u => {
      const isSelf = u.id === Auth.currentUser.id;
      const toggles = PERM_DEFS.map(p => `
        <label class="perm-toggle" title="${p.label}">
          <input type="checkbox" data-user="${u.id}" data-perm="${p.key}"
            ${u.perms[p.key] ? 'checked' : ''} ${u.role === 'admin' ? 'disabled' : ''}>
          <span>${p.label}</span>
        </label>`).join('');
      return `<tr data-id="${u.id}" class="${u.role === 'admin' ? 'row-admin' : ''}">
        <td style="min-width:120px">${Utils.escapeHtml(u.full_name || '（未命名）')}${isSelf ? ' <span class="tag tag-blue">我</span>' : ''}</td>
        <td style="min-width:120px">${u.role === 'admin' ? '<span class="tag tag-red">管理员</span>' : Utils.escapeHtml((u.departments && u.departments.name) || '未分配部门')}</td>
        <td style="min-width:110px">${Utils.escapeHtml(u.phone || '')}</td>
        <td class="perm-cell">${u.role === 'admin' ? '<span class="muted">拥有全部权限</span>' : toggles}</td>
        <td style="width:70px">${u.role === 'admin' ? '' : '<a data-act="save">保存</a>'}</td>
      </tr>`;
    }).join('');

    page.innerHTML = `
      <div class="page-head">
        <h2>用户权限管理</h2>
        <span class="muted">各部门权限由管理员逐人开放勾选后保存；账号本身请在月报系统后台创建</span>
      </div>
      <div class="table-wrap">
        <table class="admin-table">
          <thead><tr>
            <th>用户</th><th>部门 / 角色</th><th>手机号</th><th>台账权限（点击勾选）</th><th>操作</th>
          </tr></thead>
          <tbody>${rows}</tbody>
        </table>
      </div>`;

    page.querySelectorAll('[data-act="save"]').forEach(a => a.addEventListener('click', () => this.saveUser(a.closest('tr').dataset.id)));
  },

  async saveUser(userId) {
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
    Utils.toast(`已保存「${(u && u.full_name) || '用户'}」的权限`, 'success');
  },

  /* ---------- 系统设置 ---------- */

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
