#!/usr/bin/env node
/**
 * build-dashboard-preview.js - 生成自包含的数据看板预览页
 *
 * 用途：把 css/style.css + js/utils.js + js/dashboard.js + mock-data.js 内联成
 *       单个 HTML 文件，无需登录、无需数据库即可查看看板真实渲染效果
 *       （用于视觉验收：版面、字号、图表比例）。
 *
 * 用法：node docs/preview/build-dashboard-preview.js
 * 产物：docs/preview/dashboard-preview.html
 *
 * 注：修改 style.css / dashboard.js 后需重新运行本脚本，预览页才会同步。
 */
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..', '..');
const read = f => fs.readFileSync(path.join(ROOT, f), 'utf8');

const css = read('css/style.css');
const utilsJs = read('js/utils.js');
const dashJs = read('js/dashboard.js');
const mockJs = read('docs/preview/mock-data.js');

const html = `<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>数据看板预览 · 企业应收账款台账系统</title>
<style>
${css}
/* —— 预览页专属：仅用于说明，不属于产品样式 —— */
.preview-note {
  position: sticky; top: 0; z-index: 99;
  padding: 7px 16px; font-size: 12px; line-height: 1.6;
  background: oklch(96% 0.03 258); color: oklch(38% 0.09 258);
  border-bottom: 1px solid oklch(86% 0.065 258);
}
.preview-note b { font-weight: 600; }
</style>
</head>
<body>
<div class="preview-note">
  <b>看板视觉预览</b> · 数据为模拟数据（不连数据库、不发请求）· 内容与真实系统同源：
  <code>css/style.css</code> + <code>js/dashboard.js</code> ·
  <b>拖动浏览器窗口改变宽度，图表内文字应保持同一大小</b>（本次修复的正是这一点）
</div>
<div id="root"></div>
<script>${utilsJs}</script>
<script>${dashJs}</script>
<script>${mockJs}</script>
</body>
</html>
`;

const out = path.join(__dirname, 'dashboard-preview.html');
fs.writeFileSync(out, html, 'utf8');
console.log(`已生成 ${path.relative(ROOT, out)}（${(html.length / 1024).toFixed(1)} KB）`);
