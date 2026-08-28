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
      el.addEventListener('click', e => {
        if (e.target === el || e.target.closest('[data-act="cancel"]')) { el.remove(); resolve(false); }
        else if (e.target.closest('[data-act="ok"]')) { el.remove(); resolve(true); }
      });
    });
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
