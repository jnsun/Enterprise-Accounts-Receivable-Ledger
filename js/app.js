/**
 * app.js - 应用入口（视图切换 / 侧边栏权限展示 / 登录界面）
 */

const App = {
  currentView: 'ledger',

  /** 启动 */
  async boot() {
    if (typeof sb === 'undefined' || !sb) {
      document.getElementById('root').innerHTML =
        '<div class="boot-error">Supabase SDK 加载失败，请检查 vendor/supabase.min.js 是否存在。</div>';
      return;
    }
    const session = await Auth.init();
    if (session) this.renderApp();
    else this.renderLogin();
  },

  /* ================= 登录页 ================= */

  renderLogin() {
    const root = document.getElementById('root');
    root.innerHTML = `
      <div class="login-wrap">
        <div class="login-card">
          <div class="login-logo">₊</div>
          <h1 class="login-title">企业应收账款台账系统</h1>
          <p class="login-sub">多部门应用中心 · 请使用系统分配的账号登录</p>
          <div class="login-form">
            <input class="ipt" id="login-id" placeholder="邮箱 / 手机号 / 部门名称 / 部门编码" autocomplete="username">
            <input class="ipt" id="login-pwd" type="password" placeholder="密码" autocomplete="current-password">
            <button class="btn btn-primary btn-block" id="login-btn">登 录</button>
            <div id="login-error" class="editor-error hidden"></div>
          </div>
        </div>
      </div>`;
    const doLogin = async () => {
      const id = document.getElementById('login-id').value.trim();
      const pwd = document.getElementById('login-pwd').value;
      const errBox = document.getElementById('login-error');
      errBox.classList.add('hidden');
      if (!id || !pwd) { errBox.textContent = '请输入账号和密码'; errBox.classList.remove('hidden'); return; }
      const btn = document.getElementById('login-btn');
      btn.disabled = true; btn.textContent = '登录中…';
      const res = await Auth.login(id, pwd);
      btn.disabled = false; btn.textContent = '登 录';
      if (!res.success) {
        errBox.textContent = res.error || '登录失败';
        errBox.classList.remove('hidden');
        return;
      }
      this.renderApp();
    };
    document.getElementById('login-btn').addEventListener('click', doLogin);
    root.querySelectorAll('#login-id, #login-pwd').forEach(i =>
      i.addEventListener('keydown', e => { if (e.key === 'Enter') doLogin(); }));
    document.getElementById('login-id').focus();
  },

  /* ================= 主界面 ================= */

  renderApp() {
    const root = document.getElementById('root');
    const p = Auth.currentProfile;
    const au = Auth.arUser || {};
    const deptName = (au.departments && au.departments.name) || (Auth.isAdmin ? '系统管理员' : '未分配部门');

    root.innerHTML = `
      <div class="app-shell">
        <aside class="sidebar">
          <div class="side-brand">企业应收账款<br>台账系统</div>
          <nav class="side-nav" id="side-nav"></nav>
          <div class="side-perms">
            <div class="sp-title">我的权限（${Auth.permCount()}${Auth.isAdmin ? ' · 全部' : ''}）</div>
            <ul class="perm-list" id="perm-list"></ul>
          </div>
        </aside>
        <div class="app-main">
          <header class="topbar">
            <div class="topbar-title" id="topbar-title">台账总览</div>
            <div class="topbar-user">
              <span class="user-dept">${Utils.escapeHtml(deptName)}</span>
              <span class="user-name">${Utils.escapeHtml(au.full_name || p.full_name || '用户')}</span>
              <button class="btn btn-xs" data-act="pwd">修改密码</button>
              <button class="btn btn-xs" data-act="logout">退出</button>
            </div>
          </header>
          <main class="page-container">
            <section id="page-ledger" class="page"></section>
            <section id="page-import-guide" class="page hidden"></section>
            <section id="page-batches" class="page hidden"></section>
            <section id="page-admin" class="page hidden"></section>
            <section id="page-settings" class="page hidden"></section>
          </main>
        </div>
      </div>`;

    this.renderSidebar();
    this.bindTopbar();

    // 首屏数据
    (async () => {
      await Ledger.init();
      await Ledger.load();
      Ledger.render();
      if (Auth.isSuperAdmin) Admin.load();
      if (Auth.isAdmin) Admin.loadSettings();
      if (Auth.can('delete') || Auth.can('import')) Batches.load();
    })();
  },

  renderSidebar() {
    const nav = document.getElementById('side-nav');
    const items = [{ key: 'ledger', label: '台账总览', icon: '▤', show: Auth.can('view') || Auth.can('view_all') || Auth.isAdmin }];
    if (Auth.can('import')) items.push({ key: 'import-guide', label: 'Excel 导入', icon: '⇪', show: true });
    if (Auth.can('delete') || Auth.can('import')) items.push({ key: 'batches', label: '导入批次管理', icon: '☰', show: true });
    if (Auth.isAdmin) items.push({ key: 'admin', label: '用户管理', icon: '⚿', show: true });
    if (Auth.isAdmin) items.push({ key: 'settings', label: '系统设置', icon: '⚙', show: true });
    // 无任何可见权限的部门用户也允许看总览（受 RLS 限制可能为空）
    nav.innerHTML = items.filter(i => i.show).map(i => `
      <button class="nav-item ${i.key === this.currentView ? 'active' : ''}" data-view="${i.key}">
        <span class="nav-icon">${i.icon}</span>${i.label}</button>`).join('');
    nav.querySelectorAll('.nav-item').forEach(b => b.addEventListener('click', () => this.navigate(b.dataset.view)));

    // 权限清单（一目了然）
    const list = document.getElementById('perm-list');
    list.innerHTML = PERM_DEFS.map(p => {
      const ok = Auth.can(p.key);
      return `<li class="${ok ? 'on' : 'off'}"><span class="pm-icon">${ok ? '✓' : '✗'}</span>${p.label}</li>`;
    }).join('') + (Auth.isSuperAdmin
      ? '<li class="on"><span class="pm-icon">✓</span>超级管理员（用户与设置）</li>'
      : `<li class="${Auth.isAdmin ? 'on' : 'off'}"><span class="pm-icon">${Auth.isAdmin ? '✓' : '✗'}</span>管理员（全部台账权限）</li>`);
  },

  navigate(view) {
    this.currentView = view;
    document.querySelectorAll('.page').forEach(pg => pg.classList.add('hidden'));
    const titles = {
      'ledger': '台账总览',
      'import-guide': 'Excel 导入',
      'batches': '导入批次管理',
      'admin': '用户管理',
      'settings': '系统设置',
    };
    document.getElementById('topbar-title').textContent = titles[view] || '';
    document.querySelectorAll('.nav-item').forEach(b => b.classList.toggle('active', b.dataset.view === view));

    const page = document.getElementById('page-' + view);
    if (page) page.classList.remove('hidden');

    if (view === 'ledger') {
      if (!Ledger.rows.length) Ledger.reload(); else Ledger.render();
    }
    if (view === 'import-guide') this.renderImportGuide();
    if (view === 'batches') Batches.load();
    if (view === 'admin') Admin.load();
    if (view === 'settings') Admin.loadSettings();
  },

  /** 导入引导页（真正的导入入口在台账工具栏，也可从这里打开） */
  renderImportGuide() {
    const page = document.getElementById('page-import-guide');
    const canImport = Auth.can('import');
    page.innerHTML = `
      <div class="page-head"><h2>Excel 导入</h2></div>
      <div class="guide-card">
        <ol class="guide-steps">
          <li>点击下方「下载模板」，参照模板整理 Excel 数据（也可直接使用自有表格，字段可在导入时映射）；</li>
          <li>点击下方按钮选择 Excel 文件，系统将<b>自动匹配字段位置</b>；</li>
          <li>点击下方按钮选择 Excel 文件，系统将<b>自动匹配字段位置</b>；</li>
          <li>在映射页核对每列的对应关系，<b>可人工选择修改</b>；</li>
          <li>预览确认后导入，导入按批次记录，可在「导入批次管理」中整批或部分删除。</li>
        </ol>
        ${canImport
          ? `<div style="display:flex;gap:10px;flex-wrap:wrap">
               <button class="btn btn-primary btn-lg" data-act="open-import">⇪ 选择 Excel 文件开始导入</button>
               <button class="btn btn-lg" data-act="dl-template">⇩ 下载导入模板</button>
             </div>`
          : '<p class="muted">您当前没有导入权限，请联系管理员开放。</p>'}
      </div>`;
    page.querySelector('[data-act="open-import"]')?.addEventListener('click', () => Importer.open());
    page.querySelector('[data-act="dl-template"]')?.addEventListener('click', () => Importer.downloadTemplate());
  },

  bindTopbar() {
    document.querySelectorAll('.topbar-user [data-act]').forEach(b => b.addEventListener('click', async () => {
      if (b.dataset.act === 'logout') {
        await Auth.logout();
        this.renderLogin();
      }
      if (b.dataset.act === 'pwd') this.changePwdDialog();
    }));
  },

  changePwdDialog() {
    const old = document.getElementById('modal-pwd');
    if (old) old.remove();
    const el = document.createElement('div');
    el.id = 'modal-pwd';
    el.className = 'modal-mask';
    el.innerHTML = `
      <div class="modal modal-sm">
        <div class="modal-header">修改密码 <span class="modal-close" data-act="close">×</span></div>
        <div class="modal-body">
          <input class="ipt" id="pwd-new" type="password" placeholder="新密码（至少 6 位）">
          <input class="ipt" id="pwd-new2" type="password" placeholder="确认新密码" style="margin-top:8px">
          <div id="pwd-error" class="editor-error hidden"></div>
        </div>
        <div class="modal-footer">
          <button class="btn" data-act="close">取消</button>
          <button class="btn btn-primary" data-act="ok">确认修改</button>
        </div>
      </div>`;
    document.body.appendChild(el);
    el.querySelector('[data-act="close"]').addEventListener('click', () => el.remove());
    el.addEventListener('click', e => { if (e.target === el) el.remove(); });
    el.querySelector('[data-act="ok"]').addEventListener('click', async () => {
      const p1 = el.querySelector('#pwd-new').value, p2 = el.querySelector('#pwd-new2').value;
      const errBox = el.querySelector('#pwd-error');
      errBox.classList.add('hidden');
      if (p1 !== p2) { errBox.textContent = '两次输入的密码不一致'; errBox.classList.remove('hidden'); return; }
      const res = await Auth.changePassword(p1);
      if (!res.success) { errBox.textContent = res.error; errBox.classList.remove('hidden'); return; }
      el.remove();
      Utils.toast('密码修改成功', 'success');
    });
  },
};

document.addEventListener('DOMContentLoaded', () => App.boot());
