/**
 * config.js - Supabase 连接配置（腾讯云自托管实例，与月报/证照系统共用）
 *
 * 2026-09-13：服务器 80 端口已全局 301 到 https://www.safety.sx.cn（培训平台上线），
 * 原 http://140.143.247.55 会被跳转导致 fetch 跨域断裂（登录 Failed to fetch）。
 * 改为域名同源地址。⚠️ 前提：服务器 nginx 需恢复 /auth/v1、/rest/v1 → Kong:8000
 * 的代理（见 .workbuddy/fix-auth-routing.sh，跑一次即可）。
 */
const SUPABASE_URL = 'https://www.safety.sx.cn';
const SUPABASE_ANON_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJyb2xlIjoiYW5vbiIsImlzcyI6InN1cGFiYXNlIiwiaWF0IjoxNzg3OTIzMTgyLCJleHAiOjIxMDMyODMxODJ9.KnS6ejpGHGxOyET6KQdjwhFzWBcGNpHfoLKOfh-dTXU';

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
          '填入腾讯云自托管 Supabase 的 ANON_KEY（SUPABASE_ANON_KEY）。</div>';
      }
    });
    return;
  }
  sb = supabase.createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
    auth: { persistSession: true, autoRefreshToken: true },
  });
})();
