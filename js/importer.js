/**
 * importer.js - Excel 导入模块
 * 流程：选择文件 -> 字段自动匹配（可人工调整映射）-> 预览确认 -> 分批写入
 * 支持按「合同编号」跳过重复或覆盖更新；支持按施工部门自动匹配数据归属部门。
 */

const Importer = {

  /** 前端动态生成导入模板（与字段定义自动同步） */
  downloadTemplate() {
    const header = FIELD_DEFS.map(f => f.label);
    const sample = ['WH24-001', '某某某地质勘查项目二维地震勘探技术服务（示例行，导入前请删除）',
      100, 100, 50, 30, 70, 0, 70, '某某煤业有限公司', '本单位名称', '2024-01-01', '2024-06-30',
      '施工中', '按进度付款', '物探一公司', '技术服务', '地质勘查', 20, '2025-06-30', '已电话催收，承诺下月回款'];
    const ws = XLSX.utils.aoa_to_sheet([header, sample]);
    ws['!cols'] = header.map(h => ({ wch: Math.max(12, h.length * 2 + 4) }));
    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, ws, '导入模板');
    XLSX.writeFile(wb, '应收账款导入模板.xlsx');
  },

  wb: null,           // 解析后的工作簿
  sheetRows: null,    // 二维数组
  headers: [],        // 表头行
  mapping: [],        // 每列 -> 目标字段 key 或 ''
  targetDept: 'auto', // auto | 部门id
  dupMode: 'skip',    // skip | overwrite
  existingNos: new Map(), // 合同编号 -> 行（覆盖更新用）

  open() {
    this.reset();
    const old = document.getElementById('modal-import');
    if (old) old.remove();
    const el = document.createElement('div');
    el.id = 'modal-import';
    el.className = 'modal-mask';
    el.innerHTML = `
      <div class="modal modal-lg">
        <div class="modal-header">导入 Excel <span class="modal-close" data-act="close">×</span></div>
        <div class="modal-body" id="import-body"></div>
      </div>`;
    document.body.appendChild(el);
    el.querySelector('[data-act="close"]').addEventListener('click', () => el.remove());
    Utils.bindMaskClose(el, () => el.remove());
    this.renderStepFile();
  },

  reset() {
    this.wb = null; this.sheetRows = null; this.headers = [];
    this.mapping = []; this.targetDept = 'auto'; this.dupMode = 'skip';
    this.existingNos = new Map();
  },

  /* ---------- 第 1 步：选择文件 ---------- */

  renderStepFile() {
    const deptOpts = ['<option value="auto">按「施工部门」自动匹配</option>',
      ...Ledger.departments.map(d => `<option value="${d.id}">${Utils.escapeHtml(d.name)}</option>`),
      '<option value="none">不指定（仅管理员可见）</option>'].join('');
    document.getElementById('import-body').innerHTML = `
      <div class="import-step">
        <div class="file-pick" id="file-pick">
          <div class="fp-icon">⇪</div>
          <div>点击选择或拖拽 Excel 文件到此处</div>
          <div class="muted">支持 .xlsx / .xls · 建议使用标准模板（<a id="tpl-download">下载模板</a>）</div>
        </div>
        <input type="file" id="import-file" accept=".xlsx,.xls" class="hidden">
        <div class="form-grid import-opts">
          <label class="form-field"><span class="ff-label">数据归属部门</span>
            <select class="ipt" id="imp-dept">${deptOpts}</select></label>
          <label class="form-field"><span class="ff-label">合同编号重复时</span>
            <select class="ipt" id="imp-dup">
              <option value="skip">跳过该行（不导入）</option>
              <option value="overwrite">覆盖更新已有记录</option>
              <option value="insert">仍然新增（允许重复）</option>
            </select></label>
        </div>
        <div id="import-error" class="editor-error hidden"></div>
      </div>`;

    const pick = document.getElementById('file-pick');
    const input = document.getElementById('import-file');
    document.getElementById('tpl-download').addEventListener('click', e => {
      e.stopPropagation();
      this.downloadTemplate();
    });
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
    const errBox = document.getElementById('import-error');
    errBox.classList.add('hidden');
    const reader = new FileReader();
    reader.onload = e => {
      try {
        this.wb = XLSX.read(e.target.result, { type: 'array', cellDates: true });
        const ws = this.wb.Sheets[this.wb.SheetNames[0]];
        this.sheetRows = XLSX.utils.sheet_to_json(ws, { header: 1, defval: null, raw: true });
        if (!this.sheetRows.length) throw new Error('表格内容为空');
        this.detectHeaderAndMapping();
        this.renderStepMapping();
      } catch (err) {
        errBox.textContent = '文件解析失败：' + (err.message || err);
        errBox.classList.remove('hidden');
      }
    };
    reader.onerror = () => {
      errBox.textContent = '文件读取失败，请重试';
      errBox.classList.remove('hidden');
    };
    reader.readAsArrayBuffer(file);
  },

  /* ---------- 第 2 步：字段映射 ---------- */

  detectHeaderAndMapping() {
    const norm = s => String(s || '').replace(/[\s()（）/／]/g, '').toLowerCase();
    // 找表头行：前 10 行内与已知字段匹配数最多的一行
    let best = { rowIdx: 0, score: -1 };
    const known = new Set(FIELD_DEFS.flatMap(f => [f.label, ...f.aliases]).map(norm));
    for (let i = 0; i < Math.min(10, this.sheetRows.length); i++) {
      const row = this.sheetRows[i] || [];
      let score = 0;
      row.forEach(cell => { if (cell && known.has(norm(cell))) score++; });
      if (score > best.score) best = { rowIdx: i, score };
    }
    this.headers = (this.sheetRows[best.rowIdx] || []).map(h => h === null || h === undefined ? '' : String(h).trim());
    this.dataRows = this.sheetRows.slice(best.rowIdx + 1).filter(r => r && r.some(c => c !== null && c !== undefined && String(c).trim() !== ''));

    // 自动匹配：表头精确 = label > alias > 归一化匹配
    const byExact = new Map(), byAlias = new Map(), byNorm = new Map();
    FIELD_DEFS.forEach(f => {
      byExact.set(f.label, f.key);
      f.aliases.forEach(a => { if (!byAlias.has(a)) byAlias.set(a, f.key); byNorm.set(norm(a), f.key); });
      byNorm.set(norm(f.label), f.key);
    });
    this.mapping = this.headers.map(h => {
      if (!h) return '';
      if (byExact.has(h)) return byExact.get(h);
      if (byAlias.has(h)) return byAlias.get(h);
      return byNorm.get(norm(h)) || '';
    });
  },

  renderStepMapping() {
    const used = {};
    const fieldOptions = key => {
      const opts = ['<option value="">— 忽略该列 —</option>'];
      FIELD_DEFS.forEach(f => {
        const disabled = used[f.key] && f.key !== key ? 'disabled' : '';
        opts.push(`<option value="${f.key}" ${f.key === key ? 'selected' : ''} ${disabled}>${f.label}</option>`);
      });
      return opts.join('');
    };

    const rows = this.headers.map((h, i) => {
      const sample = this.dataRows[0] ? this.dataRows[0][i] : '';
      const sampleStr = sample instanceof Date ? Utils.fmtDate(sample.toISOString().slice(0, 10))
        : Utils.escapeHtml(sample === null || sample === undefined ? '' : String(sample)).slice(0, 24);
      const matched = this.mapping[i] !== '';
      return `<tr class="${matched ? '' : 'map-miss'}">
        <td class="map-src" title="${Utils.escapeHtml(h)}">${Utils.escapeHtml(h || '（空列名）')}</td>
        <td class="map-sample">${sampleStr}</td>
        <td><select class="ipt map-select" data-col="${i}">${fieldOptions(this.mapping[i])}</select></td>
      </tr>`;
    }).join('');

    document.getElementById('import-body').innerHTML = `
      <div class="import-step">
        <div class="import-meta">共识别 <b>${this.dataRows.length}</b> 条数据 · ${this.mapping.filter(Boolean).length}/${this.headers.filter(Boolean).length} 列已自动匹配
          <span class="muted">（黄色行未匹配，请在右侧下拉中选择目标字段或忽略）</span></div>
        <div class="table-wrap map-wrap">
          <table class="map-table">
            <thead><tr><th style="width:32%">Excel 列名</th><th style="width:24%">首行示例</th><th>导入到系统字段</th></tr></thead>
            <tbody>${rows}</tbody>
          </table>
        </div>
        <div id="import-error" class="editor-error hidden"></div>
        <div class="modal-footer">
          <button class="btn" data-act="back">← 重新选文件</button>
          <button class="btn btn-primary" data-act="preview">下一步：预览确认</button>
        </div>
      </div>`;

    const body = document.getElementById('import-body');
    body.querySelector('[data-act="back"]').addEventListener('click', () => this.renderStepFile());
    body.querySelectorAll('.map-select').forEach(sel => sel.addEventListener('change', () => {
      this.mapping[Number(sel.dataset.col)] = sel.value;
      // 同一目标字段只允许映射一列
      body.querySelectorAll('.map-select').forEach(s2 => {
        if (s2 !== sel && s2.value && s2.value === sel.value) s2.value = '';
      });
    }));
    body.querySelector('[data-act="preview"]').addEventListener('click', () => this.renderStepPreview());
  },

  /* ---------- 第 3 步：预览 + 写入 ---------- */

  buildPayload(colIdx, raw) {
    const key = this.mapping[colIdx];
    if (!key) return {};
    const f = FIELD_DEFS.find(x => x.key === key);
    const row = {};
    if (f.type === 'money') row[key] = Utils.parseMoney(raw);
    else if (f.type === 'date') row[key] = Utils.parseExcelDate(raw);
    else row[key] = raw === null || raw === undefined ? null : String(raw).trim() || null;
    return row;
  },

  async renderStepPreview() {
    const errBox = document.getElementById('import-error');
    errBox.classList.add('hidden');
    // 预览前 5 行
    const previewRows = this.dataRows.slice(0, 5).map(r =>
      this.headers.reduce((acc, _h, i) => Object.assign(acc, this.buildPayload(i, r[i])), {}));
    const shownFields = [...new Set(this.mapping.filter(Boolean))];

    const previewHtml = `
      <div class="table-wrap" style="max-height:220px">
        <table class="ledger-table">
          <thead><tr>${shownFields.map(k => `<th>${FIELD_DEFS.find(f => f.key === k).label}</th>`).join('')}</tr></thead>
          <tbody>${previewRows.map(r => `<tr>${shownFields.map(k => {
            const f = FIELD_DEFS.find(x => x.key === k);
            let v = r[k]; if (v === null || v === undefined) v = '';
            if (f.type === 'money') return `<td class="ta-r td-money">${Utils.fmtMoney(v)}</td>`;
            if (f.key === 'project_name') return `<td class="td-name">${Utils.escapeHtml(Utils.clampName(v))}</td>`;
            return `<td>${Utils.escapeHtml(String(v))}</td>`;
          }).join('')}</tr>`).join('')}</tbody>
        </table>
      </div>`;

    document.getElementById('import-body').innerHTML = `
      <div class="import-step">
        <div class="import-meta">预览前 ${previewRows.length} 条（共 ${this.dataRows.length} 条）</div>
        ${previewHtml}
        <div id="import-error" class="editor-error hidden"></div>
        <div class="modal-footer">
          <button class="btn" data-act="back">← 调整映射</button>
          <button class="btn btn-primary" data-act="commit" id="btn-commit">确认导入 ${this.dataRows.length} 条</button>
        </div>
      </div>`;

    const body = document.getElementById('import-body');
    body.querySelector('[data-act="back"]').addEventListener('click', () => this.renderStepMapping());
    body.querySelector('[data-act="commit"]').addEventListener('click', () => this.commit());
  },

  async commit() {
    const errBox = document.getElementById('import-error');
    const btn = document.getElementById('btn-commit');
    errBox.classList.add('hidden');
    btn.disabled = true; btn.textContent = '导入中…';

    // 读取选项
    const deptSel = document.getElementById('imp-dept');
    const dupSel = document.getElementById('imp-dup');
    if (deptSel) this.targetDept = deptSel.value;
    if (dupSel) this.dupMode = dupSel.value;

    try {
      // 归属部门解析
      let deptId = null;
      let autoMatch = false;
      if (this.targetDept === 'auto') autoMatch = true;
      else if (this.targetDept !== 'none') deptId = this.targetDept;
      const deptByName = new Map(Ledger.departments.map(d => [d.name, d.id]));

      // 查询已有合同编号（跳过/覆盖模式）
      if (this.dupMode !== 'insert') {
        const { data: existing } = await sb.from('ar_ledger').select('id, contract_no');
        this.existingNos = new Map((existing || []).filter(r => r.contract_no).map(r => [r.contract_no.trim(), r.id]));
      }

      // 创建批次
      const fileName = (document.getElementById('import-file')?.files[0]?.name) || '手工批次';
      const { data: batch, error: batchErr } = await sb.from('ar_import_batches')
        .insert({ file_name: fileName, row_count: this.dataRows.length, imported_by: Auth.currentUser.id })
        .select().single();
      if (batchErr) throw new Error('创建导入批次失败：' + batchErr.message);

      // 组装行
      const toInsert = [], toUpdate = [];
      let skipped = 0;
      this.dataRows.forEach(raw => {
        const obj = this.headers.reduce((acc, _h, i) => Object.assign(acc, this.buildPayload(i, raw[i])), {});
        if (!obj.contract_no && !obj.project_name) { skipped++; return; } // 空行跳过
        obj.batch_id = batch.id;
        if (autoMatch) obj.department_id = (obj.dept_name && deptByName.get(obj.dept_name)) || null;
        else obj.department_id = deptId;

        const no = obj.contract_no ? String(obj.contract_no).trim() : null;
        if (no && this.existingNos.has(no)) {
          if (this.dupMode === 'skip') { skipped++; return; }
          if (this.dupMode === 'overwrite') { toUpdate.push({ id: this.existingNos.get(no), payload: obj }); return; }
        }
        obj.created_by = Auth.currentUser.id;
        toInsert.push(obj);
      });

      // 分批写入
      let inserted = 0, updated = 0, failed = 0;
      const CHUNK = 200;
      for (let i = 0; i < toInsert.length; i += CHUNK) {
        const { error } = await sb.from('ar_ledger').insert(toInsert.slice(i, i + CHUNK));
        if (error) { failed += Math.min(CHUNK, toInsert.length - i); console.error(error); }
        else inserted += Math.min(CHUNK, toInsert.length - i);
      }
      for (const item of toUpdate) {
        const { id, payload } = item;
        const { error } = await sb.from('ar_ledger').update(payload).eq('id', id);
        if (error) { failed++; console.error(error); } else updated++;
      }

      // 更新批次实际行数
      await sb.from('ar_import_batches').update({ row_count: inserted + updated }).eq('id', batch.id);

      document.getElementById('import-body').innerHTML = `
        <div class="import-step import-done">
          <div class="done-icon ${failed ? 'warn' : 'ok'}">${failed ? '!' : '✓'}</div>
          <div class="done-title">导入完成</div>
          <div class="done-stats">成功写入 <b>${inserted + updated}</b> 条（新增 ${inserted} · 覆盖更新 ${updated}）${skipped ? ` · 跳过 ${skipped} 条` : ''}${failed ? ` · <span class="text-danger">失败 ${failed} 条</span>` : ''}</div>
          <div class="modal-footer">
            <button class="btn" data-act="close2">关闭</button>
            <button class="btn btn-primary" data-act="view-batch">查看本批数据</button>
          </div>
        </div>`;
      document.getElementById('import-body').querySelector('[data-act="close2"]').addEventListener('click', () => {
        document.getElementById('modal-import').remove();
        Ledger.reload();
      });
      document.getElementById('import-body').querySelector('[data-act="view-batch"]').addEventListener('click', () => {
        document.getElementById('modal-import').remove();
        Ledger.filters.batch = batch.id;
        App.navigate('ledger');
        Batches.load();
      });
    } catch (err) {
      errBox.textContent = err.message || String(err);
      errBox.classList.remove('hidden');
      btn.disabled = false; btn.textContent = `确认导入 ${this.dataRows.length} 条`;
    }
  },
};
