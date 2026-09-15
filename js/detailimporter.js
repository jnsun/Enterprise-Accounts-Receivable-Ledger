/**
 * detailimporter.js - 开票/回款明细批量导入（v3.1，仅财务管理员）
 *
 * 场景：财务有历史开票/回款 Excel，逐笔手敲不现实。
 * 流程：选文件 -> 按「合同编号」列匹配台账行（自动识别列）-> 预览
 *      （匹配/未匹配/数据无效分类）-> 批量写入明细表 -> 自动同步：
 *        开票：台账「开票金额」= 明细合计 + 「最新挂账时间」= 最近开票日期
 *        回款：台账「到账金额」= 明细合计
 * 注意：重复执行同一文件会重复登记，导入前请自行确认。
 */

const DetailImporter = {

  type: 'invoice',            // invoice | receipt
  sheetRows: null,
  headers: [],
  dataRows: [],
  colMap: {},                 // 字段 -> 列下标
  ledgerByNo: new Map(),      // 合同编号 -> { id, project_name }
  matched: [],                // { ledger, date, amount, invoice_no, remark }
  unmatched: [],              // { contract_no, reason }
  invalid: [],                // 数据无效（缺日期/金额）

  label() { return this.type === 'invoice' ? '开票明细' : '回款明细'; },
  table() { return this.type === 'invoice' ? 'ar_invoices' : 'ar_receipts'; },
  dateKey() { return this.type === 'invoice' ? 'invoice_date' : 'receipt_date'; },

  open(type) {
    if (!Auth.isAdmin) { Utils.toast('仅财务管理员可导入明细', 'error'); return; }
    this.type = type;
    this.reset();
    const old = document.getElementById('modal-detail-import');
    if (old) old.remove();
    const el = document.createElement('div');
    el.id = 'modal-detail-import';
    el.className = 'modal-mask';
    el.innerHTML = `
      <div class="modal modal-lg">
        <div class="modal-header">批量导入${this.label()} <span class="modal-close" data-act="close">×</span></div>
        <div class="modal-body" id="detail-import-body"></div>
      </div>`;
    document.body.appendChild(el);
    el.querySelector('[data-act="close"]').addEventListener('click', () => el.remove());
    Utils.bindMaskClose(el, () => el.remove());
    this.renderStepFile();
  },

  reset() {
    this.sheetRows = null; this.headers = []; this.dataRows = [];
    this.colMap = {}; this.ledgerByNo = new Map();
    this.matched = []; this.unmatched = []; this.invalid = [];
  },

  /* ---------- 第 1 步：选文件 ---------- */

  renderStepFile() {
    const dateCol = this.type === 'invoice' ? '开票日期' : '到账日期';
    document.getElementById('detail-import-body').innerHTML = `
      <div class="import-step">
        <div class="file-pick" id="di-file-pick">
          <div class="fp-icon">⇪</div>
          <div>点击选择或拖拽 Excel 文件到此处</div>
          <div class="muted">要求列：合同编号 · ${dateCol} · 金额${this.type === 'invoice' ? ' · 发票号（选填）' : ''} · 备注（选填）· 按合同编号匹配台账行</div>
        </div>
        <input type="file" id="di-file" accept=".xlsx,.xls" class="hidden">
        <div id="di-error" class="editor-error hidden"></div>
      </div>`;
    const pick = document.getElementById('di-file-pick');
    const input = document.getElementById('di-file');
    pick.addEventListener('click', () => input.click());
    pick.addEventListener('dragover', e => { e.preventDefault(); pick.classList.add('drag'); });
    pick.addEventListener('dragleave', () => pick.classList.remove('drag'));
    pick.addEventListener('drop', e => {
      e.preventDefault(); pick.classList.remove('drag');
      if (e.dataTransfer.files.length) this.readFile(e.dataTransfer.files[0]);
    });
    input.addEventListener('change', () => { if (input.files.length) this.readFile(input.files[0]); });
  },

  readFile(file) {
    const errBox = document.getElementById('di-error');
    errBox.classList.add('hidden');
    const reader = new FileReader();
    reader.onload = async e => {
      try {
        const wb = XLSX.read(e.target.result, { type: 'array', cellDates: true });
        const ws = wb.Sheets[wb.SheetNames[0]];
        this.sheetRows = XLSX.utils.sheet_to_json(ws, { header: 1, defval: null, raw: true });
        if (!this.sheetRows.length) throw new Error('表格内容为空');
        this.detectColumns();
        if (this.colMap.contract_no === undefined) throw new Error('未找到「合同编号」列');
        if (this.colMap.date === undefined) throw new Error('未找到日期列');
        if (this.colMap.amount === undefined) throw new Error('未找到金额列');
        await this.matchLedger();
        this.renderStepPreview();
      } catch (err) {
        errBox.textContent = err.message || String(err);
        errBox.classList.remove('hidden');
      }
    };
    reader.readAsArrayBuffer(file);
  },

  /** 在前 10 行找表头并识别列（合同编号必须，其余按别名） */
  detectColumns() {
    const norm = s => String(s || '').replace(/[\s()（）]/g, '').toLowerCase();
    const defs = [
      ['contract_no', ['合同编号', '合同号', '编号']],
      ['date', this.type === 'invoice'
        ? ['开票日期', '开票时间', '日期', '时间']
        : ['到账日期', '回款日期', '到账时间', '日期', '时间']],
      ['amount', this.type === 'invoice'
        ? ['开票金额', '金额']
        : ['到账金额', '回款金额', '金额']],
      ['invoice_no', ['发票号', '发票号码', '发票编号']],
      ['remark', ['备注', '说明']],
    ];
    // 表头行：前 10 行里含「合同编号」类单元格的第一行
    let headIdx = -1;
    for (let i = 0; i < Math.min(10, this.sheetRows.length); i++) {
      const row = this.sheetRows[i] || [];
      if (row.some(c => ['合同编号', '合同号'].includes(norm(c)))) { headIdx = i; break; }
    }
    if (headIdx < 0) headIdx = 0;
    this.headers = (this.sheetRows[headIdx] || []).map(h => h === null || h === undefined ? '' : String(h).trim());
    this.dataRows = this.sheetRows.slice(headIdx + 1)
      .filter(r => r && r.some(c => c !== null && c !== undefined && String(c).trim() !== ''));

    this.colMap = {};
    defs.forEach(([key, aliases]) => {
      const idx = this.headers.findIndex(h => aliases.includes(norm(h)));
      if (idx >= 0) this.colMap[key] = idx;
    });
  },

  /** 加载台账（按合同编号建索引）并逐行匹配 */
  async matchLedger() {
    const { data, error } = await sb.from('ar_ledger')
      .select('id, contract_no, project_name').not('contract_no', 'is', null).limit(5000);
    if (error) throw new Error('台账加载失败：' + error.message);
    this.ledgerByNo = new Map((data || []).map(r => [String(r.contract_no).trim(), r]));

    this.matched = []; this.unmatched = []; this.invalid = [];
    this.dataRows.forEach(raw => {
      const cell = k => this.colMap[k] !== undefined ? raw[this.colMap[k]] : null;
      const no = cell('contract_no') === null || cell('contract_no') === undefined
        ? '' : String(cell('contract_no')).trim();
      if (!no) return;   // 整行空/无编号，静默跳过
      const ledger = this.ledgerByNo.get(no);
      if (!ledger) { this.unmatched.push({ contract_no: no }); return; }
      const date = Utils.parseExcelDate(cell('date'));
      const amount = Utils.parseMoney(cell('amount'));
      if (!date || amount === null || !(amount >= 0)) {
        this.invalid.push({ contract_no: no, date: cell('date'), amount: cell('amount') });
        return;
      }
      const remark = cell('remark') === null || cell('remark') === undefined ? null : String(cell('remark')).trim() || null;
      const invoice_no = cell('invoice_no') === null || cell('invoice_no') === undefined ? null : String(cell('invoice_no')).trim() || null;
      this.matched.push({ ledger, date, amount, invoice_no, remark });
    });
  },

  /* ---------- 第 2 步：预览 + 写入 ---------- */

  renderStepPreview() {
    const m = this.matched;
    const previewRows = m.slice(0, 8);
    document.getElementById('detail-import-body').innerHTML = `
      <div class="import-step">
        <div class="import-meta">
          匹配成功 <b class="text-ok">${m.length}</b> 条
          ${this.unmatched.length ? ` · <span class="text-danger">未匹配台账 ${this.unmatched.length} 条（合同编号不存在，跳过）</span>` : ''}
          ${this.invalid.length ? ` · <span class="text-danger">日期/金额无效 ${this.invalid.length} 条（跳过）</span>` : ''}
          <span class="muted">· 写入后自动同步「${this.type === 'invoice' ? '开票金额与最新挂账时间' : '到账金额'}」</span>
        </div>
        ${this.unmatched.length ? `<div class="di-unmatched"><b>未匹配的合同编号：</b>${this.unmatched.slice(0, 12).map(u => Utils.escapeHtml(u.contract_no)).join('、')}${this.unmatched.length > 12 ? ' …' : ''}</div>` : ''}
        <div class="table-wrap" style="max-height:240px">
          <table class="ledger-table">
            <thead><tr>
              <th style="min-width:110px">合同编号</th><th>项目名称</th>
              <th style="min-width:100px">${this.type === 'invoice' ? '开票日期' : '到账日期'}</th>
              ${this.type === 'invoice' ? '<th style="min-width:110px">发票号</th>' : ''}
              <th style="min-width:90px" class="ta-r">金额</th><th>备注</th>
            </tr></thead>
            <tbody>
              ${previewRows.map(x => `<tr>
                <td>${Utils.escapeHtml(x.ledger.contract_no)}</td>
                <td class="td-name" title="${Utils.escapeHtml(x.ledger.project_name || '')}">${Utils.escapeHtml(Utils.clampName(x.ledger.project_name || '—'))}</td>
                <td class="ta-r">${x.date}</td>
                ${this.type === 'invoice' ? `<td>${Utils.escapeHtml(x.invoice_no || '')}</td>` : ''}
                <td class="ta-r td-money">${Utils.fmtMoney(x.amount)}</td>
                <td>${Utils.escapeHtml(x.remark || '')}</td>
              </tr>`).join('') || '<tr><td colspan="6" class="empty-cell">无可导入数据</td></tr>'}
              ${m.length > 8 ? `<tr><td colspan="6" class="empty-cell">… 其余 ${m.length - 8} 条略</td></tr>` : ''}
            </tbody>
          </table>
        </div>
        <div id="di-error" class="editor-error hidden"></div>
        <div class="modal-footer">
          <button class="btn" data-act="back">← 重新选文件</button>
          <button class="btn btn-primary" data-act="commit" id="di-commit" ${m.length ? '' : 'disabled'}>确认导入 ${m.length} 条</button>
        </div>
      </div>`;
    const body = document.getElementById('detail-import-body');
    body.querySelector('[data-act="back"]').addEventListener('click', () => this.renderStepFile());
    body.querySelector('[data-act="commit"]').addEventListener('click', () => this.commit());
  },

  async commit() {
    const errBox = document.getElementById('di-error');
    const btn = document.getElementById('di-commit');
    errBox.classList.add('hidden');
    btn.disabled = true; btn.textContent = '导入中…';
    try {
      const payloads = this.matched.map(x => {
        const p = {
          ledger_id: x.ledger.id,
          [this.dateKey()]: x.date,
          amount: x.amount,
          remark: x.remark,
          created_by: Auth.currentUser.id,
        };
        if (this.type === 'invoice' && x.invoice_no) p.invoice_no = x.invoice_no;
        return p;
      });

      let inserted = 0;
      const CHUNK = 200;
      for (let i = 0; i < payloads.length; i += CHUNK) {
        const { error } = await sb.from(this.table()).insert(payloads.slice(i, i + CHUNK));
        if (error) throw new Error('写入失败（第 ' + (i + 1) + ' 批起）：' + error.message);
        inserted += Math.min(CHUNK, payloads.length - i);
      }

      // 自动同步受影响台账行
      const synced = await this.syncAffected();

      document.getElementById('detail-import-body').innerHTML = `
        <div class="import-step import-done">
          <div class="done-icon ok">✓</div>
          <div class="done-title">导入完成</div>
          <div class="done-stats">
            写入${this.label()} <b>${inserted}</b> 条 · 自动同步台账 <b>${synced}</b> 行
            ${this.unmatched.length ? ` · 跳过未匹配 ${this.unmatched.length} 条` : ''}
            ${this.invalid.length ? ` · 跳过无效数据 ${this.invalid.length} 条` : ''}
          </div>
          <div class="modal-footer">
            <button class="btn btn-primary" data-act="close2">关闭</button>
          </div>
        </div>`;
      document.getElementById('detail-import-body').querySelector('[data-act="close2"]')
        .addEventListener('click', () => {
          document.getElementById('modal-detail-import').remove();
          Ledger.reload();
        });
    } catch (err) {
      errBox.textContent = err.message || String(err);
      errBox.classList.remove('hidden');
      btn.disabled = false; btn.textContent = `确认导入 ${this.matched.length} 条`;
    }
  },

  /** 同步受影响台账行：开票=金额合计+最新挂账时间；回款=金额合计 */
  async syncAffected() {
    const affected = [...new Set(this.matched.map(x => x.ledger.id))];
    if (!affected.length) return 0;
    const dateKey = this.dateKey();
    const { data: details, error } = await sb.from(this.table())
      .select(`ledger_id, amount, ${dateKey}`).in('ledger_id', affected);
    if (error) throw new Error('明细读取失败（同步台账金额时）：' + error.message);

    const agg = {};
    (details || []).forEach(d => {
      const a = agg[d.ledger_id] || (agg[d.ledger_id] = { sum: 0, latest: '' });
      a.sum = Math.round((a.sum + Number(d.amount || 0)) * 10000) / 10000;
      if (d[dateKey] && String(d[dateKey]) > a.latest) a.latest = String(d[dateKey]);
    });

    let n = 0;
    for (const id of affected) {
      const a = agg[id];
      if (!a) continue;
      const patch = this.type === 'invoice'
        ? { invoiced_amount: a.sum, charge_date: a.latest || null }
        : { received_amount: a.sum };
      const { error: uerr } = await sb.from('ar_ledger').update(patch).eq('id', id);
      if (uerr) console.error('台账同步失败', id, uerr.message);
      else n++;
    }
    return n;
  },
};
