#!/usr/bin/env node
/**
 * build-admin-preview.js - 生成自包含的「用户管理」页预览
 *
 * 用途：把 css/style.css + js/fields.js + js/utils.js + js/admin.js 内联成单个
 *       HTML，用模拟账号数据渲染真实页面，无需登录、不连数据库。
 *       用于验收表格列对齐、权限勾选网格、操作列留白等视觉问题。
 *
 * 用法：node docs/preview/build-admin-preview.js
 * 产物：docs/preview/admin-preview.html
 *
 * 注：修改 style.css / admin.js 后需重新运行本脚本。
 */
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..', '..');
const read = f => fs.readFileSync(path.join(ROOT, f), 'utf8');

const css = read('css/style.css');
const fieldsJs = read('js/fields.js');
const utilsJs = read('js/utils.js');
const adminJs = read('js/admin.js');

const mockJs = `
/* ---------- 模拟数据 & 假 Supabase（仅预览用） ---------- */
const DEPTS = [
  { id: 'd1', name: '财务资产部', sort_order: 0 },
  { id: 'd2', name: '工程物探所', sort_order: 1 },
  { id: 'd3', name: '测绘地理信息院', sort_order: 2 }
];

const USERS = [
  { user_id: 'u1', email: 'jnsun@qq.com', full_name: '孙晋宁', phone: '17535938268',
    department_id: null, ar_role: 'admin', ar_super_admin: true, ar_protected: true, ar_departments: null },
  { user_id: 'u2', email: 'zhaobing@cw.com', full_name: '赵兵', phone: '13935937279',
    department_id: null, ar_role: 'admin', ar_super_admin: false, ar_protected: false, ar_departments: null },
  { user_id: 'u3', email: 'maliya@cw.com', full_name: '马丽亚', phone: '13663590428',
    department_id: null, ar_role: 'admin', ar_super_admin: false, ar_protected: false, ar_departments: null },
  { user_id: 'u4', email: 'pengyanju@cw.com', full_name: '彭艳菊', phone: '13466932621',
    department_id: 'd2', ar_role: 'user', ar_super_admin: false, ar_protected: false,
    ar_departments: { name: '工程物探所' } },
  { user_id: 'u5', email: 'wangjianjun@cw.com', full_name: '王建军', phone: '13834567890',
    department_id: 'd1', ar_role: 'user', ar_super_admin: false, ar_protected: false,
    ar_departments: { name: '财务资产部' } },
  { user_id: 'u6', email: 'verylongemailaddress@geo-survey-cw.com', full_name: '欧阳明月',
    phone: '13612345678', department_id: 'd3', ar_role: 'user', ar_super_admin: false,
    ar_protected: false, ar_departments: { name: '测绘地理信息院' } }
];

const PERMS = {
  u1: {}, u2: {}, u3: {},
  u4: { view: true, add: true, edit: true, delete: true, import: true, export: true },
  u5: { view: true, export: true },
  u6: {}
};

/* 最小可用的 PostgREST 链式替身 */
function chain(result) {
  const o = {
    select: () => o, order: () => o, limit: () => o,
    then: (res, rej) => Promise.resolve(result).then(res, rej)
  };
  return o;
}
const sb = {
  from(t) {
    if (t === 'ar_users') return chain({ data: USERS.slice(), error: null });
    if (t === 'ar_user_perms') {
      return chain({ data: Object.keys(PERMS).map(k => ({ user_id: k, perms: PERMS[k] })), error: null });
    }
    if (t === 'ar_departments') return chain({ data: DEPTS.slice(), error: null });
    return chain({ data: [], error: null });
  }
};

const Ledger = { rows: [
  { department_id: 'd2' }, { department_id: 'd2' }, { department_id: 'd2' },
  { department_id: 'd1' }, { department_id: 'd3' }, { department_id: 'd3' }
], departments: [] };

const Auth = {
  isAdmin: true, isSuperAdmin: false,
  currentUser: { id: 'u2' },
  permCount: () => 0
};

(async () => {
  const stage = document.getElementById('page-admin');

  // ① 超级管理员视角（看自己 = 赵兵 换成 孙晋宁）
  Auth.isSuperAdmin = true;
  Auth.currentUser = { id: 'u1' };
  await Admin.load();
  document.getElementById('view-super').innerHTML = stage.innerHTML;

  // ② 普通管理员视角（本人 = 赵兵，正是截图里的情况）
  Auth.isSuperAdmin = false;
  Auth.currentUser = { id: 'u2' };
  await Admin.load();
  document.getElementById('view-admin').innerHTML = stage.innerHTML;

  stage.remove();

  // 预览用：把「勾选→点亮保存按钮」的交互重新绑上（innerHTML 复制不会带走监听）
  document.querySelectorAll('[data-perm-cell]').forEach(cell => {
    cell.addEventListener('change', () => {
      cell.classList.add('is-dirty');
      const st = cell.querySelector('.perm-state');
      const btn = cell.querySelector('[data-act="save-perms"]');
      if (st) st.textContent = '有未保存的修改';
      if (btn) btn.disabled = false;
    });
  });
  document.title = '用户管理预览 · 已渲染';
  document.body.dataset.ready = '1';

  // 附加：#perm-modal 时直接打开编辑弹窗（校验弹窗里的权限网格，与表格共用组件）
  // 注意用 Admin.users（load 时已把 perms 合并进去），mock 的 USERS 本身没有 perms 字段
  if (location.hash === '#perm-modal') {
    Auth.isSuperAdmin = true;
    Auth.currentUser = { id: 'u1' };
    Admin.userDialog(Admin.users.find(u => u.ar_role === 'user'));
  }
})();
`;

const html = `<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>用户管理预览 · 企业应收账款台账系统</title>
<style>
${css}
/* —— 预览页专属，不属于产品样式 —— */
body { margin: 0; padding: 18px 20px 60px; background: var(--surface-2); }
.preview-note {
  margin-bottom: 16px; padding: 8px 14px; font-size: 12px; line-height: 1.7;
  background: oklch(96% 0.03 258); color: oklch(38% 0.09 258);
  border: 1px solid oklch(86% 0.065 258); border-radius: 6px;
}
.preview-note b { font-weight: 600; }
.preview-h { margin: 26px 0 10px; font-size: 13px; font-weight: 600; color: var(--ink-600); }
.preview-h:first-of-type { margin-top: 0; }
#page-admin { display: none; }
</style>
</head>
<body>
<div class="preview-note">
  <b>用户管理页视觉预览</b> · 模拟账号数据，不连数据库 ·
  内容与真实系统同源：<code>css/style.css</code> + <code>js/admin.js</code> ·
  本页渲染两个视角：超级管理员看到的（首列带 <b>🔒 受保护</b> 标记）与普通管理员看到的。
  <br>勾选任一权限复选框，该行底部的「保存权限」按钮应点亮并提示「有未保存的修改」。
</div>
<div id="page-admin"></div>
<div class="preview-h">视角 A · 超级管理员（孙晋宁）</div>
<div id="view-super"></div>
<div class="preview-h">视角 B · 普通管理员（赵兵）</div>
<div id="view-admin"></div>
<script>${fieldsJs}</script>
<script>${utilsJs}</script>
<script>${adminJs}</script>
<script>${mockJs}</script>
</body>
</html>
`;

const out = path.join(__dirname, 'admin-preview.html');
fs.writeFileSync(out, html, 'utf8');
console.log(`已生成 ${path.relative(ROOT, out)}（${(html.length / 1024).toFixed(1)} KB）`);
