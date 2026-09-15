/**
 * attachments.js - 附件上传区（要求四）
 *
 * 每条台账记录可上传多个附件（类别：决算 / 中止证明 / 其他，类别走选项字典）。
 * 文件存 Supabase Storage 私有桶 ar-attachments，路径 {ledger_id}/{uuid}.{ext}；
 * 元数据存 ar_attachments 表（RLS 跟随台账行可见性）。
 * 下载通过签名 URL（1 小时有效）；「附件类别及数量」列由本模块汇总自动生成。
 */

const Attachments = {

  BUCKET: 'ar-attachments',
  MAX_SIZE: 50 * 1024 * 1024,   // 单文件 50MB
  rows: [],                     // 当前行附件 [{id, category, file_name, file_size, storage_path, ...}]

  /** 全量附件计数（Ledger.load 后调用，供表格「附件类别及数量」列使用） */
  countMap: {},                 // ledger_id -> { 类别: 数量 }

  /** 拉取全部可见附件的计数（RLS 已按台账行可见性隔离） */
  async loadCounts() {
    this.countMap = {};
    try {
      const { data, error } = await sb.from('ar_attachments')
        .select('ledger_id, category').limit(20000);
      if (error) return;
      (data || []).forEach(a => {
        const m = (this.countMap[a.ledger_id] = this.countMap[a.ledger_id] || {});
        const c = a.category || '其他';
        m[c] = (m[c] || 0) + 1;
      });
    } catch (e) { /* 静默 */ }
  },

  /** 表格「附件类别及数量」文本，如「决算×2、中止证明×1」 */
  summaryText(ledgerId) {
    const m = this.countMap[ledgerId];
    if (!m) return '';
    return Object.entries(m).map(([k, v]) => `${k}×${v}`).join('、');
  },

  /** 附件总数徽标 */
  count(ledgerId) {
    const m = this.countMap[ledgerId];
    return m ? Object.values(m).reduce((s, v) => s + v, 0) : 0;
  },

  /* ================= 编辑弹窗内的附件区 ================= */

  async loadFor(ledgerId) {
    this.rows = [];
    if (!ledgerId) return;
    const { data, error } = await sb.from('ar_attachments')
      .select('*').eq('ledger_id', ledgerId).order('created_at', { ascending: false });
    if (!error) this.rows = data || [];
  },

  fmtSize(n) {
    if (!n && n !== 0) return '';
    if (n < 1024) return n + ' B';
    if (n < 1024 * 1024) return (n / 1024).toFixed(0) + ' KB';
    return (n / 1024 / 1024).toFixed(1) + ' MB';
  },

  /** 渲染附件区（编辑弹窗内）。canEdit：是否可上传/删除（实体部门对附件有权限） */
  render(canEdit) {
    const cats = Dicts.get('attach_category');
    const catOptions = cats.map(c => `<option value="${Utils.escapeHtml(c)}">${Utils.escapeHtml(c)}</option>`).join('');
    const list = this.rows.map(a => `
      <tr data-att-id="${a.id}" data-att-path="${Utils.escapeHtml(a.storage_path)}">
        <td style="width:92px"><span class="tag tag-teal">${Utils.escapeHtml(a.category || '其他')}</span></td>
        <td title="${Utils.escapeHtml(a.file_name)}">${Utils.escapeHtml(a.file_name)}</td>
        <td class="ta-r muted" style="width:80px">${this.fmtSize(a.file_size)}</td>
        <td style="width:120px">${Utils.escapeHtml((a.created_at || '').slice(0, 10))}</td>
        <td style="width:110px">
          <a data-att="dl">下载</a>
          ${canEdit ? '<a class="link-danger" data-att="del">删除</a>' : ''}
        </td>
      </tr>`).join('') || '<tr><td colspan="5" class="empty-cell">暂无附件<br>决算文件、中止证明等可上传留存，方便日后对账与举证</td></tr>';

    return `
      ${canEdit ? `
      <div class="att-upload">
        <select class="ipt" id="att-cat" style="width:120px">${catOptions}</select>
        <input type="file" id="att-file" class="hidden" multiple>
        <button class="btn btn-primary btn-sm" id="att-pick">⇪ 选择文件上传</button>
        <span class="muted" style="align-self:center">单文件 ≤ 50MB · 类别可在上传前选择</span>
        <div class="att-progress hidden" id="att-progress"><div class="att-progress-bar" id="att-progress-bar"></div></div>
      </div>` : '<div class="muted" style="margin-bottom:8px">您没有附件上传权限，仅可查看与下载。</div>'}
      <div class="table-wrap">
        <table class="invoice-table att-table">
          <thead><tr><th>类别</th><th>文件名</th><th class="ta-r" style="width:80px">大小</th><th style="width:120px">上传日期</th><th style="width:110px">操作</th></tr></thead>
          <tbody>${list}</tbody>
        </table>
      </div>`;
  },

  /** 绑定事件（render 后调用；onChange：附件变化后刷新汇总） */
  bind(container, onChange) {
    const pick = container.querySelector('#att-pick');
    const fileInput = container.querySelector('#att-file');
    if (pick && fileInput) {
      pick.addEventListener('click', () => fileInput.click());
      fileInput.addEventListener('change', async () => {
        const files = [...fileInput.files];
        fileInput.value = '';
        for (const f of files) await this.upload(f, container, onChange);
      });
    }
    container.querySelectorAll('tr[data-att-id]').forEach(tr => {
      tr.querySelector('[data-att="dl"]')?.addEventListener('click', () => this.download(tr.dataset.attPath, tr.querySelector('td:nth-child(2)').textContent));
      tr.querySelector('[data-att="del"]')?.addEventListener('click', async () => {
        const ok = await Utils.confirm('确定删除该附件？文件将从服务器一并删除。', { danger: true, confirmText: '删除' });
        if (!ok) return;
        const id = tr.dataset.attId;
        const att = this.rows.find(a => a.id === id);
        if (att) await sb.storage.from(this.BUCKET).remove([att.storage_path]);
        const { error } = await sb.from('ar_attachments').delete().eq('id', id);
        if (error) { Utils.toast('删除失败：' + error.message, 'error'); return; }
        this.rows = this.rows.filter(a => a.id !== id);
        await this.loadCounts();
        onChange && onChange();
        Utils.toast('附件已删除', 'success');
      });
    });
  },

  async upload(file, container, onChange) {
    if (file.size > this.MAX_SIZE) { Utils.toast(`「${file.name}」超过 50MB，已跳过`, 'error'); return; }
    const ledgerId = Editor.row && Editor.row.id;
    if (!ledgerId) { Utils.toast('请先保存记录再上传附件', 'error'); return; }
    const catSel = container.querySelector('#att-cat');
    const category = catSel ? catSel.value : '其他';
    const ext = (file.name.split('.').pop() || 'bin').toLowerCase().replace(/[^a-z0-9]/g, '').slice(0, 8);
    const path = `${ledgerId}/${(crypto.randomUUID ? crypto.randomUUID() : Date.now() + '-' + Math.random().toString(36).slice(2))}.${ext}`;

    const prog = container.querySelector('#att-progress');
    const bar = container.querySelector('#att-progress-bar');
    if (prog) { prog.classList.remove('hidden'); if (bar) bar.style.width = '12%'; }

    try {
      const { error: upErr } = await sb.storage.from(this.BUCKET).upload(path, file, {
        contentType: file.type || 'application/octet-stream',
      });
      if (upErr) throw new Error(upErr.message);
      if (bar) bar.style.width = '70%';
      const { data, error } = await sb.from('ar_attachments').insert({
        ledger_id: ledgerId,
        category,
        file_name: file.name,
        file_size: file.size,
        content_type: file.type || null,
        storage_path: path,
        uploaded_by: Auth.currentUser.id,
      }).select().single();
      if (error) {
        await sb.storage.from(this.BUCKET).remove([path]);
        throw new Error(error.message);
      }
      this.rows.unshift(data);
      await this.loadCounts();
      if (bar) bar.style.width = '100%';
      Utils.toast(`已上传「${file.name}」`, 'success');
    } catch (err) {
      Utils.toast('上传失败：' + (err.message || err), 'error');
    } finally {
      setTimeout(() => { if (prog) prog.classList.add('hidden'); }, 600);
      onChange && onChange();
    }
  },

  async download(path, name) {
    try {
      const { data, error } = await sb.storage.from(this.BUCKET).createSignedUrl(path, 3600);
      if (error || !data) { Utils.toast('获取下载链接失败：' + (error ? error.message : ''), 'error'); return; }
      const a = document.createElement('a');
      a.href = data.signedUrl;
      a.download = name || '';
      a.target = '_blank';
      document.body.appendChild(a);
      a.click();
      a.remove();
    } catch (e) {
      Utils.toast('下载失败：' + (e.message || e), 'error');
    }
  },
};
