/**
 * importer.js - Excel 导入模块（新指标体系 v3）
 * 流程：选择文件 -> 字段自动匹配（可人工调整映射）-> 预览确认 -> 分批写入
 *
 * - 模板列：序号 / 部门名称（自动归属）+ 台账字段 + 合同金额（非工作量结算时自动带入决算）；账内/账外应收为自动计算列，无需导入
 * - 「部门名称」列自动匹配数据归属部门（也可在导入时统一指定）
 * - 支持按「合同编号」跳过重复或覆盖更新
 *
 * ⚠️ 两条踩过的坑，改代码时别再犯：
 *   ① 「数据归属部门」「合同编号重复时」两个 <select> 只存在于第 1 步，进入第 2 步后
 *      #import-body 被 innerHTML 整体替换、元素销毁。必须在选中时就写回 Importer 实例，
 *      不能拖到 commit() 再读 DOM（那样恒得 null，设置静默失效）。
 *   ② 部门名匹配不上时**绝不能静默写 null**。归属部门是台账第一维度，静默丢弃会让
 *      「导入完成」与「列上全是未指定」同时成立，用户根本看不出问题在哪。
 *      现在由 deptPlan() 统一判定，预览页预检 + 结果页点名告警，并支持就地指定归属。
 */

/* 可映射的导入目标：台账字段 + 虚拟「部门名称」（归属部门）+ 合同金额（旧字段，自动带入决算）
   标了 noImport 的字段不在此列 —— 「归属部门」这一维度已由下面的虚拟「部门名称」目标承担，
   否则会出现两个指向同一列的映射目标，用户无从选择。 */
const IMPORT_TARGETS = [
  { key: 'department', label: '部门名称（归属部门）', aliases: ['部门名称', '部门', '施工部门'], virtual: true },
  { key: 'contract_amount', label: '合同金额（自动带入决算）', aliases: ['合同金额', '合同价', '合同额'] },
  ...FIELD_DEFS.filter(f => !f.noImport).map(f => ({ key: f.key, label: f.label, aliases: f.aliases || [f.label] })),
];

const Importer = {

  /** 前端动态生成导入模板（与字段定义自动同步，含示例行） */
  downloadTemplate() {
    const header = ['序号', '部门名称'];
    /* 示例里的部门名取系统里真实存在的第一个部门。
       原先写死一个库里没有的名字，配上「部门名匹配不上会告警」的预检，
       等于用示例教用户填出告警 —— 示例反而变成坑。 */
    const sampleDept = (Ledger.departments[0] && Ledger.departments[0].name) || '综合管理部门';
    const sample = ['1', sampleDept];
    /* noImport 字段跳过：模板首列已是「部门名称」，再加一列「归属部门」会让人以为要填两遍 */
    FIELD_DEFS.filter(f => !f.noImport).forEach(f => {
      header.push(f.label);
      // 决算方式后补「合同金额」列（非工作量结算时自动带入决算金额，ADR-0003）
      if (f.key === 'final_method') { header.push('合同金额'); sample.push(100); }
      const map = {
        contract_no: 'WH24-001', project_name: '某某某地质勘查项目二维地震勘探技术服务（示例行，导入前请删除）',
        owner_unit: '某某煤业有限公司', client_attr: '政府部门--省', creditor_unit: '物化院',
        work_nature: '综合物探', sector: '能源资源勘查开发', project_status: '完工', final_method: '合同金额',
        charge_date: '2024-07-01', final_amount: 100, invoiced_amount: 80, received_amount: 50, writeoff_amount: 10,
        debt_status: '正常', collector: '张三', dunning_date: '2025-06-30', comm_method: '电话',
        feedback: '承认欠款，但资金紧张', latest_progress: '已发送第二次催款函', next_plan: '跟踪付款进度', remark: '示例备注',
      };
      sample.push(map[f.key] !== undefined ? map[f.key] : '');
    });
    const ws = XLSX.utils.aoa_to_sheet([header, sample]);
    ws['!cols'] = header.map(h => ({ wch: Math.max(12, h.length * 2 + 2) }));
    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, ws, '导入模板');
    XLSX.writeFile(wb, '应收账款导入模板.xlsx');
  },

  wb: null,           // 解析后的工作簿
  sheetRows: null,    // 二维数组
  headers: [],        // 表头行
  mapping: [],        // 每列 -> 目标字段 key 或 ''
  targetDept: 'auto', // auto | 部门id | none
  dupMode: 'skip',    // skip | overwrite | insert
  existingNos: new Map(), // 合同编号 -> 行（覆盖更新用）
  fileName: '',       // 已选文件名（写入 ar_import_batches 用）
  deptOverrides: new Map(), // 「部门名称」列里系统查无此名的值 -> 人工指定的部门 id（null = 暂不归属）

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
    this.fileName = ''; this.deptOverrides = new Map();
  },

  /* ---------- 第 1 步：选择文件 ---------- */

  renderStepFile() {
    const deptOpts = ['<option value="auto">按「部门名称」列自动匹配</option>',
      ...Ledger.departments.map(d => `<option value="${d.id}">${Utils.escapeHtml(d.name)}</option>`),
      '<option value="none">不指定（仅管理员可见）</option>'].join('');
    document.getElementById('import-body').innerHTML = `
      <div class="import-step">
        <div class="file-pick" id="file-pick">
          <div class="fp-icon">⇪</div>
          <div>点击选择或拖拽 Excel 文件到此处</div>
          <div class="muted">支持 .xlsx / .xls · 建议使用标准模板（<a id="tpl-download">下载模板</a>）· 账内/账外应收自动计算，无需导入</div>
        </div>
        <input type="file" id="import-file" accept=".xlsx,.xls" class="hidden">
        ${Auth.isAdmin ? `
        <div class="di-entry">
          按合同编号批量导入明细：
          <a data-act="imp-inv">⇪ 开票明细</a> ·
          <a data-act="imp-rec">⇪ 回款明细</a>
          <span class="muted">（历史开票/回款 Excel，导入后自动同步金额与挂账时间）</span>
        </div>` : ''}
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

    /* 「数据归属部门」「合同编号重复时」两个 <select> 只在第 1 步存在 ——
       进入第 2 步时整个 #import-body 会被 innerHTML 替换掉，这两个元素随之销毁。
       旧写法在 commit() 里才去读 DOM，恒取到 null，于是这两项设置形同虚设
       （不管选什么都按 auto + skip 走）。这里改为选中即写回实例状态。 */
    const deptSel = document.getElementById('imp-dept');
    const dupSel = document.getElementById('imp-dup');
    deptSel.value = this.targetDept;      // 从「调整映射」返回时回填上次选择
    dupSel.value = this.dupMode;
    deptSel.addEventListener('change', () => {
      this.targetDept = deptSel.value;
      // 换成统一指定 / 不指定后，先前针对具体部门名的人工指定已无意义
      if (this.targetDept !== 'auto') this.deptOverrides.clear();
    });
    dupSel.addEventListener('change', () => { this.dupMode = dupSel.value; });

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

    // 明细批量导入入口（仅财务）
    document.querySelector('.di-entry [data-act="imp-inv"]')?.addEventListener('click', () => {
      document.getElementById('modal-import')?.remove();
      DetailImporter.open('invoice');
    });
    document.querySelector('.di-entry [data-act="imp-rec"]')?.addEventListener('click', () => {
      document.getElementById('modal-import')?.remove();
      DetailImporter.open('receipt');
    });
  },

  readFile(file) {
    const errBox = document.getElementById('import-error');
    errBox.classList.add('hidden');
    this.fileName = file.name || '';       // 记住文件名：写入批次记录（原先读 #import-file，那时已被销毁，故批次恒显示「手工批次」）
    this.deptOverrides.clear();            // 换了文件，先前的部门名人工指定不再适用
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
    const known = new Set(IMPORT_TARGETS.flatMap(f => [f.label, ...f.aliases]).map(norm));
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
    IMPORT_TARGETS.forEach(f => {
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
    const fieldOptions = key => {
      const opts = ['<option value="">— 忽略该列 —</option>'];
      IMPORT_TARGETS.forEach(f => {
        opts.push(`<option value="${f.key}" ${f.key === key ? 'selected' : ''}>${f.label}</option>`);
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

  /* ---------- 部门归属预检 ----------
     导入最容易踩的坑：Excel「部门名称」列里的名字系统里没有，代码直接写 null，
     结果台账「归属部门」列整列显示「未指定」，而导入结果仍是「成功写入 N 条」。
     这里把匹配情况提前算出来，让人在写入之前就能看见并补上。 */

  /** 部门名归一化：去掉所有空白（含全角空格）+ 统一小写，降低「看着一样其实不等」的误判 */
  normDept(s) { return String(s === null || s === undefined ? '' : s).replace(/[\s\u3000]/g, '').toLowerCase(); },

  /**
   * 部门归属计划：一次算出每行该归到哪个部门，以及哪些部门名系统里查不到。
   * 预览预检与正式写入共用这一份结果，避免「预览说没问题、落库却是空」。
   * @returns {{ci:number, rows:{name:string,deptId:string|null}[], missing:Map<string,number>}}
   */
  deptPlan() {
    const ci = this.mapping.indexOf('department');
    const byName = new Map();
    Ledger.departments.forEach(d => {
      byName.set(d.name, d.id);
      byName.set(this.normDept(d.name), d.id);
    });
    const rows = [], missing = new Map();
    if (ci >= 0) {
      this.dataRows.forEach(r => {
        const raw = r[ci];
        const name = raw === null || raw === undefined ? '' : String(raw).trim();
        let deptId = null, handled = false;
        if (name) {
          handled = this.deptOverrides.has(name);
          if (handled) deptId = this.deptOverrides.get(name);
          else deptId = byName.get(name) || byName.get(this.normDept(name)) || null;
          if (!handled && deptId === null) missing.set(name, (missing.get(name) || 0) + 1);
        }
        rows.push({ name, deptId });
      });
    }
    return { ci, rows, missing };
  },

  /** 未匹配部门名的处理面板（写入前把归属定下来；不匹配的名字也可选择「暂不归属」） */
  renderDeptPlan(plan) {
    if (!this.dataRows.length) return '';
    if (this.targetDept === 'none') {
      return `<div class="dept-check is-warn">你选择了「不指定」归属部门，本次导入的记录将没有部门归属，只有管理员能看到它们。</div>`;
    }
    if (this.targetDept !== 'auto') {
      const d = Ledger.departments.find(x => x.id === this.targetDept);
      return `<div class="dept-check is-ok">本次导入的记录将统一归属到「${Utils.escapeHtml(d ? d.name : '已选部门')}」，不再读取「部门名称」列。</div>`;
    }
    if (plan.ci < 0) {
      return `<div class="dept-check is-warn">
        <div class="dchk-title">⚠ 这张表里没找到可识别的「部门名称」列，也没有统一指定归属部门</div>
        <div class="dchk-hint">继续导入的话，这些记录在台账「归属部门」列会全部显示「未指定」。
          <a data-act="back-file">返回上一步统一指定一个部门</a>，或点下方「← 调整映射」把某列改为「部门名称（归属部门）」。</div>
      </div>`;
    }
    const missNames = [...plan.missing.keys()];
    if (!missNames.length) {
      const n = plan.rows.filter(x => x.deptId).length;
      return `<div class="dept-check is-ok">部门归属检查通过：${n} 行按「部门名称」列自动匹配到系统部门。</div>`;
    }
    const missRows = [...plan.missing.values()].reduce((a, b) => a + b, 0);
    const opts = Ledger.departments
      .map(d => `<option value="${d.id}">${Utils.escapeHtml(d.name)}</option>`).join('');
    return `<div class="dept-check is-warn">
      <div class="dchk-title">⚠ 有 <b>${missNames.length}</b> 个部门名称在系统中找不到，共 <b>${missRows}</b> 行无法自动归属</div>
      <div class="dchk-hint">在下面直接指定归属部门即可（不会改动你的 Excel 原文件）。若确属新部门，建议先到「系统管理 → 部门」建好，再回来用「覆盖更新」模式重导。</div>
      ${[...plan.missing.entries()].map(([name, cnt]) => {
        const cur = this.deptOverrides.has(name) ? (this.deptOverrides.get(name) || '__none__') : '';
        return `<div class="dchk-row${cur ? ' is-set' : ''}">
          <span class="dchk-name" title="${Utils.escapeHtml(name)}">${Utils.escapeHtml(name)}</span>
          <span class="dchk-cnt">${cnt} 行</span>
          <select class="ipt dchk-sel" data-name="${Utils.escapeHtml(name)}" aria-label="为「${Utils.escapeHtml(name)}」指定归属部门">
            <option value="">— 选择归属部门 —</option>
            ${opts}
            <option value="__none__" ${cur === '__none__' ? 'selected' : ''}>暂不归属（记为未指定）</option>
          </select>
        </div>`;
      }).join('')}
    </div>`;
  },

  /** 就地指定归属后刷新告警区计数与按钮文案（只改文本，不整页重绘，避免打断正在操作的下拉） */
  refreshDeptPlan(body) {
    const plan = this.deptPlan();
    const left = [...plan.missing.values()].reduce((a, b) => a + b, 0);
    const box = body.querySelector('.dept-check');
    if (box) {
      box.classList.toggle('is-warn', left > 0);
      box.classList.toggle('is-ok', left === 0);
    }
    const title = body.querySelector('.dchk-title');
    if (title) {
      title.innerHTML = left
        ? `⚠ 有 <b>${plan.missing.size}</b> 个部门名称在系统中找不到，共 <b>${left}</b> 行无法自动归属`
        : '✓ 找不到的部门名都已指定归属，可以导入了';
    }
    // 全部指定完毕后提示文案已无用，收起来
    body.querySelectorAll('.dchk-sel').forEach(s =>
      s.closest('.dchk-row').classList.toggle('is-set', !!s.value));
    const hint = body.querySelector('.dchk-hint');
    if (hint) hint.classList.toggle('hidden', left === 0);
    const btn = body.querySelector('#btn-commit');
    if (btn) btn.textContent = this.commitLabel(left);
  },

  /** 「确认导入」按钮文案：把未归属行数写进按钮，避免点下去才发现 */
  commitLabel(left) {
    return `确认导入 ${this.dataRows.length} 条` + (left ? `（其中 ${left} 行未指定部门）` : '');
  },

  /* ---------- 第 3 步：预览 + 写入 ---------- */

  buildPayload(colIdx, raw) {
    const key = this.mapping[colIdx];
    if (!key) return {};
    if (key === 'department') return { __dept_name: raw === null || raw === undefined ? null : String(raw).trim() || null };
    if (key === 'contract_amount') return { contract_amount: Utils.parseMoney(raw) };   // 旧字段，不在 FIELD_DEFS
    const f = FIELD_DEFS.find(x => x.key === key);
    if (!f) return {};
    const row = {};
    if (f.type === 'money') row[key] = Utils.parseMoney(raw);
    else if (f.type === 'date') row[key] = Utils.parseExcelDate(raw);
    else row[key] = raw === null || raw === undefined ? null : String(raw).trim() || null;
    return row;
  },

  async renderStepPreview() {
    const errBox = document.getElementById('import-error');
    errBox.classList.add('hidden');
    const previewRows = this.dataRows.slice(0, 5).map(r =>
      this.headers.reduce((acc, _h, i) => Object.assign(acc, this.buildPayload(i, r[i])), {}));
    const shownFields = [...new Set(this.mapping.filter(Boolean))];

    const labelOf = k => (IMPORT_TARGETS.find(f => f.key === k) || {}).label || k;
    const previewHtml = `
      <div class="table-wrap" style="max-height:220px">
        <table class="ledger-table">
          <thead><tr>${shownFields.map(k => `<th>${labelOf(k)}</th>`).join('')}</tr></thead>
          <tbody>${previewRows.map(r => `<tr>${shownFields.map(k => {
            // 「部门名称」是虚拟目标，buildPayload 把它存进 __dept_name 而非同名字段，
            // 直接按 k 取值会取到 undefined，预览里这一列恒为空白。
            let v = k === 'department' ? r.__dept_name : r[k];
            if (v === null || v === undefined) v = '';
            const f = FIELD_DEFS.find(x => x.key === k);
            if (f && f.type === 'money') return `<td class="ta-r td-money">${Utils.fmtMoney(v)}</td>`;
            if (f && f.key === 'project_name') return `<td class="td-name">${Utils.escapeHtml(Utils.clampName(v))}</td>`;
            return `<td>${Utils.escapeHtml(String(v))}</td>`;
          }).join('')}</tr>`).join('')}</tbody>
        </table>
      </div>`;

    // 部门归属预检：把「哪几行会没有部门」提前摆出来
    const plan = this.deptPlan();
    const deptPlanHtml = this.renderDeptPlan(plan);
    const leftNoDept = [...plan.missing.values()].reduce((a, b) => a + b, 0);
    const deptScope = this.targetDept === 'auto' ? '按「部门名称」列自动匹配'
      : this.targetDept === 'none' ? '不指定（仅管理员可见）'
      : `统一归属到「${(Ledger.departments.find(d => d.id === this.targetDept) || {}).name || '已选部门'}」`;
    const dupText = { skip: '跳过重复', overwrite: '覆盖更新', insert: '允许重复' }[this.dupMode] || this.dupMode;

    document.getElementById('import-body').innerHTML = `
      <div class="import-step">
        <div class="import-meta">预览前 ${previewRows.length} 条（共 ${this.dataRows.length} 条）
          <span class="muted">· 归属：${Utils.escapeHtml(deptScope)} · 合同编号重复：${dupText}</span></div>
        ${previewHtml}
        ${deptPlanHtml}
        <div id="import-error" class="editor-error hidden"></div>
        <div class="modal-footer">
          <button class="btn" data-act="back">← 调整映射</button>
          <button class="btn btn-primary" data-act="commit" id="btn-commit">${this.commitLabel(leftNoDept)}</button>
        </div>
      </div>`;

    const body = document.getElementById('import-body');
    body.querySelector('[data-act="back"]').addEventListener('click', () => this.renderStepMapping());
    body.querySelector('[data-act="commit"]').addEventListener('click', () => this.commit());
    body.querySelectorAll('.dchk-sel').forEach(sel => sel.addEventListener('change', () => {
      const name = sel.dataset.name;
      if (!sel.value) this.deptOverrides.delete(name);
      else this.deptOverrides.set(name, sel.value === '__none__' ? null : sel.value);
      this.refreshDeptPlan(body);
    }));
    body.querySelector('[data-act="back-file"]')?.addEventListener('click', () => this.renderStepFile());
  },

  async commit() {
    const errBox = document.getElementById('import-error');
    const btn = document.getElementById('btn-commit');
    errBox.classList.add('hidden');
    btn.disabled = true; btn.textContent = '导入中…';

    /* targetDept / dupMode 在第 1 步选中时已写回实例 —— 进入第 2 步后 #imp-dept / #imp-dup
       已被 innerHTML 替换销毁，旧写法在这里读 DOM 恒得 null，两项设置全部失效。 */

    try {
      let deptId = null;
      const autoMatch = this.targetDept === 'auto';
      if (!autoMatch && this.targetDept !== 'none') deptId = this.targetDept;
      const plan = this.deptPlan();   // 与预览页共用同一份归属判断，杜绝「预览说没问题、落库却是空的」

      // 查询已有合同编号（跳过/覆盖模式）
      if (this.dupMode !== 'insert') {
        const { data: existing, error: exErr } = await sb.from('ar_ledger').select('id, contract_no');
        if (exErr) throw new Error('读取已有合同编号失败：' + exErr.message);
        this.existingNos = new Map((existing || []).filter(r => r.contract_no).map(r => [r.contract_no.trim(), r.id]));
      }

      // 创建批次
      const fileName = this.fileName || '手工批次';
      const { data: batch, error: batchErr } = await sb.from('ar_import_batches')
        .insert({ file_name: fileName, row_count: this.dataRows.length, imported_by: Auth.currentUser.id })
        .select().single();
      if (batchErr) throw new Error('创建导入批次失败：' + batchErr.message);

      // 组装行
      const toInsert = [], toUpdate = [];
      let skipped = 0;
      this.dataRows.forEach((raw, ri) => {
        const obj = this.headers.reduce((acc, _h, i) => Object.assign(acc, this.buildPayload(i, raw[i])), {});
        delete obj.__dept_name;   // 「部门名称」列原文，仅用于解析归属
        if (!obj.contract_no && !obj.project_name) { skipped++; return; } // 空行跳过
        obj.batch_id = batch.id;
        // 归属部门一律取自 deptPlan（含预览页人工指定的映射）；取不到就留 null，
        // 台账列显示「未指定」，并在导入结果里点名告警 —— 不再静默丢弃。
        obj.department_id = autoMatch ? ((plan.rows[ri] || {}).deptId || null) : deptId;

        const no = obj.contract_no ? String(obj.contract_no).trim() : null;
        // ADR-0003 合同额带入规则：决算方式非「工作量」且决算金额为空 → 合同金额自动带入
        if (obj.final_amount === null || obj.final_amount === undefined) {
          if (obj.contract_amount !== null && obj.contract_amount !== undefined
              && obj.final_method && obj.final_method !== '工作量') {
            obj.final_amount = obj.contract_amount;
          }
        }
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

      /* 没有归属部门的行数 —— 这是最容易让人误判「导入成功」的地方：
         数据确实写进去了，但台账「归属部门」整列会是「未指定」。必须显式点名。 */
      const noDept = [...toInsert, ...toUpdate.map(x => x.payload)].filter(o => !o.department_id).length;
      const missNames = autoMatch ? [...plan.missing.keys()] : [];
      const noDeptHtml = noDept ? `
        <div class="dept-check is-warn done-dept">
          <div class="dchk-title">⚠ 其中 <b>${noDept}</b> 条没有归属部门，台账「归属部门」列会显示「未指定」</div>
          ${missNames.length ? `<div class="dchk-hint">原因：Excel「部门名称」列里的 ${missNames.map(n => `「${Utils.escapeHtml(n)}」`).join('、')} 在系统部门表中找不到。</div>` : ''}
          <div class="dchk-hint">两种补法：① 先到「系统管理 → 部门」建好同名部门，再用「覆盖更新」模式重新导入，即可补上归属；② 把 Excel 里的部门名改成系统已有名称后重导。</div>
        </div>` : '';

      document.getElementById('import-body').innerHTML = `
        <div class="import-step import-done">
          <div class="done-icon ${(failed || noDept) ? 'warn' : 'ok'}">${(failed || noDept) ? '!' : '✓'}</div>
          <div class="done-title">导入完成</div>
          <div class="done-stats">成功写入 <b>${inserted + updated}</b> 条（新增 ${inserted} · 覆盖更新 ${updated}）${skipped ? ` · 跳过 ${skipped} 条` : ''}${failed ? ` · <span class="text-danger">失败 ${failed} 条</span>` : ''}</div>
          ${noDeptHtml}
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
