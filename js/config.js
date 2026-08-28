/**
 * config.js - Supabase 连接配置（腾讯云自托管实例，与月报/证照系统共用）
 *
 * 实例：http://140.143.247.55（Nginx 80 同源反代 Kong:8000）
 * ANON_KEY：自托管部署时签发的新 key（服务器 supabase/docker/.env 的
 *           ANON_KEY，或部署脚本打印的密钥卡）。切勿填 SERVICE_ROLE_KEY！
 */
const SUPABASE_URL = 'http://140.143.247.55';
const SUPABASE_ANON_KEY = 'YOUR_SELFHOSTED_ANON_KEY';

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
