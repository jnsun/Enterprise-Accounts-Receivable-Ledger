/**
 * config.js - Supabase 连接配置
 *
 * 2026-09-14：切换到独立的 Supabase 云端项目（与安全生产/月报/证照系统
 * 完全隔离的全新实例）。此前指向腾讯云自托管实例（https://www.safety.sx.cn），
 * 如需回退，将下面两行改回旧值即可：
 *   旧 URL: https://www.safety.sx.cn
 *   旧 KEY: eyJhbGciOiJIUzI1NiIs...（JWT 格式 anon key，见 git 历史此文件上一版）
 *
 * 说明：新项目使用 Supabase 新版密钥（sb_publishable_ 开头，即"发布密钥"，
 * 等价于旧版 anon key，可安全地放进前端代码）。
 */
const SUPABASE_URL = 'https://bttnxyexkbsskmqttbzi.supabase.co';
const SUPABASE_ANON_KEY = 'sb_publishable_IHE3a0i6REFt9NOY5d7QhQ_mbgcfTQO';

/** 全局 Supabase 客户端实例（由本文件底部初始化） */
let sb = null;

(function initSupabase() {
  if (typeof supabase === 'undefined' || !supabase.createClient) return;
  if (SUPABASE_ANON_KEY.includes('YOUR_SELFHOSTED_ANON_KEY')) {
    // 未配置前的友好提示
    window.addEventListener('DOMContentLoaded', () => {
      const root = document.getElementById('root');
      if (root && !root.childElementCount) {
        root.innerHTML =
          '<div class="boot-error">尚未配置 Supabase 密钥：<br>请编辑 <b>js/config.js</b>，' +
          '填入 Supabase 项目的发布密钥（SUPABASE_ANON_KEY）。</div>';
      }
    });
    return;
  }
  sb = supabase.createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
    auth: { persistSession: true, autoRefreshToken: true },
  });
})();
