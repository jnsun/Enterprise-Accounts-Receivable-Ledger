/**
 * config.js - Supabase 连接配置（独立实例，数据与安全生产管理系统完全分开）
 *
 * 本系统使用腾讯云服务器上独立部署的 Supabase 实例。
 * 请将下面两项替换为你的自部署 Supabase 信息：
 *   SUPABASE_URL      例：http://服务器IP:8000 或 https://你的域名
 *   SUPABASE_ANON_KEY 在服务器 Supabase 的 docker/.env 文件中找 ANON_KEY，
 *                     或 Studio → Settings → API 中复制 anon public key。
 * 注意：公网访问建议为 Studio/API 配置 HTTPS 反向代理。
 */
const SUPABASE_URL = 'http://YOUR_TENCENT_CLOUD_SUPABASE_HOST';
const SUPABASE_ANON_KEY = 'YOUR_SUPABASE_ANON_KEY';

/** 全局 Supabase 客户端实例（由本文件底部初始化） */
let sb = null;

(function initSupabase() {
  if (typeof supabase === 'undefined' || !supabase.createClient) return;
  if (SUPABASE_URL.includes('YOUR_TENCENT_CLOUD_SUPABASE_HOST')) {
    // 未配置前的友好提示
    window.addEventListener('DOMContentLoaded', () => {
      const root = document.getElementById('root');
      if (root && !root.childElementCount) {
        root.innerHTML =
          '<div class="boot-error">尚未配置 Supabase 连接：<br>请编辑 <b>js/config.js</b>，' +
          '填入腾讯云自部署 Supabase 的地址（SUPABASE_URL）与 anon key（SUPABASE_ANON_KEY）。</div>';
      }
    });
    return;
  }
  sb = supabase.createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
    auth: { persistSession: true, autoRefreshToken: true },
  });
})();
