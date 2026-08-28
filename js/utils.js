/**
 * utils.js - 通用工具（格式化 / DOM / 提示 / 确认框 / 防抖）
 */

const Utils = {

  /** HTML 转义 */
  escapeHtml(str) {
    if (str === null || str === undefined) return '';
    return String(str)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
  },

  /** 金额格式化：千分位，最多 2 位小数（整数不带小数点） */
  fmtMoney(v) {
    if (v === null || v === undefined || v === '') return '';
    const n = Number(v);
    if (!isFinite(n)) return String(v);
    const fixed = Math.abs(n) >= 1000 ? n.toLocaleString('zh-CN', { maximumFractionDigits: 2 }) : String(Math.round(n * 100) / 100);
    return fixed;
  },

  /** 解析金额输入/Excel 单元格（支持千分位、字符串） */
  parseMoney(v) {
    if (v === null || v === undefined || v === '') return null;
    if (typeof v === 'number') return isFinite(v) ? v : null;
    const s = String(v).replace(/[,\s￥¥]/g, '').replace(/[（）()]/g, m => m === '（' || m === '(' ? '-' : '');
    const n = Number(s);
    return isFinite(n) && s !== '' ? n : null;
  },

  /** 日期格式化 YYYY-MM-DD */
  fmtDate(v) {
    if (!v) return '';
    if (typeof v === 'string') {
      const m = v.match(/^(\d{4})[-/年](\d{1,2})[-/月](\d{1,2})/);
      if (m) return `${m[1]}-${String(m[2]).padStart(2, '0')}-${String(m[3]).padStart(2, '0')}`;
      const d = new Date(v);
      return isNaN(d) ? v.slice(0, 10) : d.toISOString().slice(0, 10);
    }
    return '';
  },

  /**
   * Excel 日期值 -> YYYY-MM-DD
   * SheetJS cellDates 模式给 Date 对象；数字为 Excel 序列号
   */
  parseExcelDate(v) {
    if (v === null || v === undefined || v === '') return null;
    if (v instanceof Date && !isNaN(v)) {
      return `${v.getFullYear()}-${String(v.getMonth() + 1).padStart(2, '0')}-${String(v.getDate()).padStart(2, '0')}`;
    }
    if (typeof v === 'number' && v > 20000 && v < 80000) {
      // Excel 序列号（1900 日期系统）
      const d = new Date(Math.round((v - 25569) * 86400 * 1000));
      return d.toISOString().slice(0, 10);
    }
    const s = String(v).trim();
    if (!s) return null;
    const m = s.match(/^(\d{4})[-/年.](\d{1,2})[-/月.](\d{1,2})日?$/);
    if (m) return `${m[1]}-${String(m[2]).padStart(2, '0')}-${String(m[3]).padStart(2, '0')}`;
    const d = new Date(s);
    if (!isNaN(d) && d.getFullYear() > 1990) return d.toISOString().slice(0, 10);
    return null;
  },

  /**
   * 项目名称等长文本截断：≤3 行 × 每行 12 个汉字，超出以 … 结尾
   */
  clampName(str, maxLine = 12, maxLineCount = 3) {
    const s = String(str || '');
    if (!s) return '';
    const limit = maxLine * maxLineCount;
    if (s.length <= limit) return s;
    return s.slice(0, limit) + '…';
  },

  /** 防抖 */
  debounce(fn, wait = 300) {
    let t = null;
    return function (...args) {
      clearTimeout(t);
      t = setTimeout(() => fn.apply(this, args), wait);
    };
  },

  /** 轻提示 */
  toast(msg, type = 'info') {
    let box = document.getElementById('toast-box');
    if (!box) {
      box = document.createElement('div');
      box.id = 'toast-box';
      document.body.appendChild(box);
    }
    const el = document.createElement('div');
    el.className = `toast toast-${type}`;
    el.textContent = msg;
    box.appendChild(el);
    setTimeout(() => { el.classList.add('show'); }, 10);
    setTimeout(() => {
      el.classList.remove('show');
      setTimeout(() => el.remove(), 300);
    }, type === 'error' ? 4200 : 2600);
  },

  /**
   * 确认框（Promise<boolean>）
   * @param {string} message 支持 \n 换行
   * @param {object} opts { title, danger, confirmText }
   */
  confirm(message, opts = {}) {
    return new Promise(resolve => {
      const old = document.getElementById('modal-confirm');
      if (old) old.remove();
      const el = document.createElement('div');
      el.id = 'modal-confirm';
      el.className = 'modal-mask';
      el.innerHTML = `
        <div class="modal modal-sm">
          <div class="modal-header">${Utils.escapeHtml(opts.title || '请确认')}</div>
          <div class="modal-body confirm-msg">${Utils.escapeHtml(message).replace(/\n/g, '<br>')}</div>
          <div class="modal-footer">
            <button class="btn" data-act="cancel">取消</button>
            <button class="btn ${opts.danger ? 'btn-danger' : 'btn-primary'}" data-act="ok">${Utils.escapeHtml(opts.confirmText || '确定')}</button>
          </div>
        </div>`;
      document.body.appendChild(el);
      let sx = 0, sy = 0;
      el.addEventListener('mousedown', e => { sx = e.clientX; sy = e.clientY; });
      el.addEventListener('click', e => {
        if (Math.hypot(e.clientX - sx, e.clientY - sy) > 6) return;
        if (e.target === el || e.target.closest('[data-act="cancel"]')) { el.remove(); resolve(false); }
        else if (e.target.closest('[data-act="ok"]')) { el.remove(); resolve(true); }
      });
    });
  },

  /**
   * 弹窗遮罩点击关闭（带拖拽误触保护：按下滑动超 6px 不关闭）
   * @param {HTMLElement} mask 遮罩元素
   * @param {Function} onClose 点击遮罩关闭时回调
   */
  bindMaskClose(mask, onClose) {
    let sx = 0, sy = 0;
    mask.addEventListener('mousedown', e => { sx = e.clientX; sy = e.clientY; });
    mask.addEventListener('click', e => {
      if (e.target !== mask) return;
      if (Math.hypot(e.clientX - sx, e.clientY - sy) > 6) return;
      onClose();
    });
  },

  /** 密码强度评分（0-5）：长度≥8 / 大写 / 小写 / 数字 / 符号 各计 1 分 */
  pwdScore(v) {
    if (!v) return 0;
    let s = 0;
    if (v.length >= 8) s++;
    if (/[A-Z]/.test(v)) s++;
    if (/[a-z]/.test(v)) s++;
    if (/[0-9]/.test(v)) s++;
    if (/[^A-Za-z0-9]/.test(v)) s++;
    return s;
  },

  /** 密码是否符合强密码规则（≥8 位 + 四类字符） */
  pwdValid(v) { return this.pwdScore(v) >= 5; },

  /** 给密码输入框绑定实时强度进度条（bar 进度条元素，hint 提示元素） */
  bindPwdMeter(input, bar, hint) {
    const colors = ['#e5e7eb', '#dc2626', '#f97316', '#eab308', '#84cc16', '#16a34a'];
    const update = () => {
      const v = input.value;
      const s = this.pwdScore(v);
      const ok = this.pwdValid(v);
      bar.style.width = (v ? Math.max(s / 5 * 100, 8) : 0) + '%';
      bar.style.background = v ? colors[s] : colors[0];
      if (!v) {
        hint.textContent = '至少 8 位，须同时包含大写字母、小写字母、数字和符号';
        hint.classList.remove('ok');
        return;
      }
      const missing = [];
      if (v.length < 8) missing.push('至少 8 位');
      if (!/[A-Z]/.test(v)) missing.push('大写字母');
      if (!/[a-z]/.test(v)) missing.push('小写字母');
      if (!/[0-9]/.test(v)) missing.push('数字');
      if (!/[^A-Za-z0-9]/.test(v)) missing.push('符号');
      hint.textContent = ok ? '✓ 密码强度合格' : '还缺：' + missing.join('、');
      hint.classList.toggle('ok', ok);
    };
    input.addEventListener('input', update);
    update();
  },

  /** 计算两个日期相差天数（b - a） */
  daysBetween(a, b) {
    if (!a || !b) return null;
    const da = new Date(a + 'T00:00:00'), db = new Date(b + 'T00:00:00');
    if (isNaN(da) || isNaN(db)) return null;
    return Math.round((db - da) / 86400000);
  },

  /** 今天 YYYY-MM-DD */
  today() {
    const d = new Date();
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
  },

  /**
   * 超期预警状态计算
   * 规则：应收余额 = 应收合计 - 已到账金额
   *   应收余额 <= 0        -> settled  已结清（绿）
   *   无完工日期           -> none     —
   *   今天 > 完工 + warnDays -> overdue 超期N天（红）
   *   今天 > 完工日期       -> soon     临近超期（橙）
   *   其他                 -> ok       未超期（灰绿）
   */
  overdueStatus(row, warnDays = 90) {
    const total = Number(row.receivable_total || 0);
    const received = Number(row.received_amount || 0);
    const balance = total - received;
    if (total <= 0 && balance <= 0) return { level: 'settled', label: '已结清', days: 0, balance: 0 };
    if (balance <= 0) return { level: 'settled', label: '已结清', days: 0, balance: 0 };
    if (!row.end_date) return { level: 'none', label: '—', days: null, balance };
    const days = Utils.daysBetween(row.end_date, Utils.today());
    if (days === null) return { level: 'none', label: '—', days: null, balance };
    if (days > warnDays) return { level: 'overdue', label: `超期${days - warnDays}天`, days, balance };
    if (days > 0) return { level: 'soon', label: '临近超期', days, balance };
    return { level: 'ok', label: '未超期', days, balance };
  },
};
