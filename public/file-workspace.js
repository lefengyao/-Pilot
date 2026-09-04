const textExtensions = new Set(['txt', 'md', 'json', 'xml', 'yaml', 'yml', 'csv', 'js', 'mjs', 'cjs', 'ts', 'tsx', 'jsx', 'css', 'html', 'htm', 'py', 'ps1', 'bat', 'cmd', 'sh', 'log', 'ini', 'conf']);
const imageExtensions = new Set(['png', 'jpg', 'jpeg', 'gif', 'webp', 'svg', 'bmp', 'avif']);
const audioExtensions = new Set(['mp3', 'ogg', 'wav', 'm4a', 'flac']);
const videoExtensions = new Set(['mp4', 'webm', 'mov', 'mkv']);

function extension(name) {
  const index = name.lastIndexOf('.');
  return index < 0 ? '' : name.slice(index + 1).toLowerCase();
}

function formatSize(bytes) {
  if (!Number.isFinite(bytes)) return '—';
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  return `${(bytes / (1024 * 1024 * 1024)).toFixed(2)} GB`;
}

function displayPath(value) {
  return value === '.' ? '工作区' : `工作区 / ${value.split(/[\\/]/).join(' / ')}`;
}

function contentUrl(entryPath, download = false) {
  const search = new URLSearchParams({ path: entryPath });
  if (download) search.set('download', '1');
  return `/api/workspace/content?${search}`;
}

function iconFor(entry) {
  if (entry.type === 'directory') return '📁';
  const ext = extension(entry.name);
  if (imageExtensions.has(ext)) return '🖼️';
  if (audioExtensions.has(ext)) return '🎵';
  if (videoExtensions.has(ext)) return '🎬';
  if (ext === 'pdf') return '📕';
  if (['doc', 'docx'].includes(ext)) return '📝';
  if (['xls', 'xlsx'].includes(ext)) return '📊';
  if (textExtensions.has(ext)) return '⌘';
  return '📄';
}

function addButton(parent, label, className, handler, title = label) {
  const button = document.createElement('button');
  button.type = 'button';
  button.className = className;
  button.textContent = label;
  button.title = title;
  button.addEventListener('click', handler);
  parent.append(button);
  return button;
}

export class FileWorkspace {
  constructor(elements) {
    this.e = elements;
    this.currentPath = '.';
    this.selectedPath = null;
    this.expandedPaths = new Set(['.']);
    this.tree = new Map();
    this.entries = [];
    this.opened = false;
    this.operation = null;
    this.e.refresh.addEventListener('click', () => this.refresh());
    this.e.upload.addEventListener('click', () => this.e.input.click());
    this.e.input.addEventListener('change', () => this.uploadFiles(this.e.input.files));
    this.e.newFolder.addEventListener('click', () => this.showFolderDialog());
    this.e.drop.addEventListener('click', () => this.e.input.click());
    this.e.drop.addEventListener('dragover', (event) => { event.preventDefault(); this.e.drop.classList.add('dragging'); });
    this.e.drop.addEventListener('dragleave', () => this.e.drop.classList.remove('dragging'));
    this.e.drop.addEventListener('drop', (event) => { event.preventDefault(); this.e.drop.classList.remove('dragging'); this.uploadFiles(event.dataTransfer.files); });
    this.e.dialogClose.addEventListener('click', () => this.e.dialog.close());
    this.e.dialogCancel.addEventListener('click', () => this.e.dialog.close());
    this.e.dialogForm.addEventListener('submit', (event) => this.submitDialog(event));
    this.e.treeToggle.addEventListener('click', () => this.e.tree.classList.toggle('open'));
  }

  async open() {
    if (this.opened) return this.refresh();
    this.opened = true;
    await this.loadDirectory('.', { current: true });
  }

  async request(path) {
    const response = await fetch(`/api/workspace/tree?path=${encodeURIComponent(path)}`);
    const result = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(result.error || '无法读取工作区。');
    return result;
  }

  async loadDirectory(path, { current = false } = {}) {
    this.e.count.textContent = '正在读取…';
    try {
      const result = await this.request(path);
      this.tree.set(result.path, result);
      if (current) {
        this.currentPath = result.path;
        this.entries = result.entries;
        this.selectedPath = null;
        this.clearPreview();
      }
      this.renderTree();
      if (current) this.renderEntries();
      return result;
    } catch (error) {
      this.showToast(error.message || '无法读取工作区。', 'error');
      if (current) {
        this.e.list.textContent = '无法读取当前目录。';
        this.e.count.textContent = '读取失败';
      }
      return null;
    }
  }

  async refresh() {
    this.tree.delete(this.currentPath);
    await this.loadDirectory(this.currentPath, { current: true });
    const paths = [...this.expandedPaths].filter((path) => path !== this.currentPath);
    for (const path of paths) {
      this.tree.delete(path);
      await this.loadDirectory(path);
    }
  }

  renderTree() {
    this.e.tree.replaceChildren();
    const root = this.tree.get('.');
    if (!root) {
      this.e.tree.textContent = '正在读取目录…';
      return;
    }
    const build = (result, depth = 0) => {
      const container = document.createElement('div');
      container.className = 'tree-node';
      const row = document.createElement('div');
      row.className = `tree-row ${result.path === this.currentPath ? 'active' : ''}`;
      row.style.paddingLeft = `${10 + depth * 16}px`;
      const directories = result.entries.filter((entry) => entry.type === 'directory');
      const expanded = this.expandedPaths.has(result.path);
      const expand = document.createElement('button');
      expand.type = 'button';
      expand.className = 'tree-expand';
      expand.textContent = directories.length || this.tree.has(result.path) ? (expanded ? '▾' : '▸') : '';
      expand.disabled = directories.length === 0 && !this.tree.has(result.path);
      expand.addEventListener('click', async (event) => {
        event.stopPropagation();
        if (this.expandedPaths.has(result.path)) this.expandedPaths.delete(result.path);
        else {
          this.expandedPaths.add(result.path);
          if (!this.tree.has(result.path)) await this.loadDirectory(result.path);
        }
        this.renderTree();
      });
      const open = document.createElement('button');
      open.type = 'button';
      open.className = 'tree-open';
      open.textContent = `${result.path === '.' ? '🗂️ 工作区' : `📁 ${result.path.split(/[\\/]/).pop()}`}`;
      open.addEventListener('click', () => this.loadDirectory(result.path, { current: true }));
      row.append(expand, open);
      container.append(row);
      if (expanded) {
        for (const entry of directories) {
          const child = this.tree.get(entry.path);
          if (child) container.append(build(child, depth + 1));
          else {
            const childRow = document.createElement('div');
            childRow.className = `tree-row ${entry.path === this.currentPath ? 'active' : ''}`;
            childRow.style.paddingLeft = `${28 + depth * 16}px`;
            const childOpen = document.createElement('button');
            childOpen.type = 'button';
            childOpen.className = 'tree-open';
            childOpen.textContent = `📁 ${entry.name}`;
            childOpen.addEventListener('click', async () => {
              this.expandedPaths.add(result.path);
              this.expandedPaths.add(entry.path);
              await this.loadDirectory(entry.path, { current: true });
            });
            childRow.append(childOpen);
            container.append(childRow);
          }
        }
      }
      return container;
    };
    this.e.tree.append(build(root));
  }

  renderEntries() {
    this.e.path.textContent = displayPath(this.currentPath);
    this.e.count.textContent = `${this.entries.length} 项`;
    this.e.list.replaceChildren();
    if (this.entries.length === 0) {
      const empty = document.createElement('div');
      empty.className = 'file-empty';
      empty.textContent = '这个目录为空。';
      this.e.list.append(empty);
      return;
    }
    for (const entry of this.entries) {
      const row = document.createElement('div');
      row.className = `file-row ${entry.path === this.selectedPath ? 'selected' : ''}`;
      const open = document.createElement('button');
      open.type = 'button';
      open.className = 'file-open';
      const icon = document.createElement('span');
      icon.className = 'file-icon';
      icon.textContent = iconFor(entry);
      const info = document.createElement('span');
      info.className = 'file-info';
      const name = document.createElement('strong');
      name.textContent = entry.name;
      const meta = document.createElement('small');
      meta.textContent = entry.type === 'directory' ? '文件夹' : `${formatSize(entry.size)} · ${new Date(entry.mtime).toLocaleString('zh-CN')}`;
      info.append(name, meta);
      open.append(icon, info);
      open.addEventListener('click', () => {
        if (entry.type === 'directory') this.loadDirectory(entry.path, { current: true });
        else this.selectEntry(entry);
        this.e.tree.classList.remove('open');
      });
      const actions = document.createElement('div');
      actions.className = 'file-row-actions';
      if (entry.type === 'file') addButton(actions, '下载', 'compact', () => this.download(entry));
      addButton(actions, '重命名', 'compact', () => this.showRenameDialog(entry));
      addButton(actions, '删除', 'compact danger', () => this.showDeleteDialog(entry));
      row.append(open, actions);
      this.e.list.append(row);
    }
  }

  async selectEntry(entry) {
    this.selectedPath = entry.path;
    this.e.preview.classList.add('open');
    this.renderEntries();
    this.e.preview.replaceChildren();
    const heading = document.createElement('header');
    heading.className = 'preview-header';
    const title = document.createElement('strong');
    title.textContent = entry.name;
    const download = document.createElement('a');
    download.href = contentUrl(entry.path, true);
    download.textContent = '下载';
    download.className = 'compact';
    heading.append(title, download);
    const close = document.createElement('button');
    close.type = 'button';
    close.id = 'file-preview-close';
    close.className = 'compact preview-close';
    close.textContent = '关闭';
    close.addEventListener('click', () => this.e.preview.classList.remove('open'));
    heading.append(close);
    const content = document.createElement('div');
    content.className = 'preview-content';
    content.textContent = '正在加载预览…';
    this.e.preview.append(heading, content);
    try {
      await this.renderPreview(entry, content);
    } catch (error) {
      content.textContent = `预览失败：${error.message || '请下载后在本机打开。'}`;
    }
  }

  clearPreview() {
    this.e.preview.classList.remove('open');
    this.e.preview.replaceChildren();
    const empty = document.createElement('div');
    empty.className = 'preview-empty';
    empty.textContent = '选择文件后在这里预览';
    this.e.preview.append(empty);
  }

  async renderPreview(entry, target) {
    const ext = extension(entry.name);
    const url = contentUrl(entry.path);
    target.replaceChildren();
    if (textExtensions.has(ext)) {
      const response = await fetch(url);
      if (!response.ok) throw new Error('无法读取文件。');
      const pre = document.createElement('pre');
      pre.textContent = await response.text();
      target.append(pre);
      return;
    }
    if (imageExtensions.has(ext)) {
      const image = document.createElement('img');
      image.src = url;
      image.alt = entry.name;
      target.append(image);
      return;
    }
    if (ext === 'pdf') {
      const frame = document.createElement('iframe');
      frame.src = url;
      frame.title = entry.name;
      target.append(frame);
      return;
    }
    if (audioExtensions.has(ext)) {
      const audio = document.createElement('audio');
      audio.src = url;
      audio.controls = true;
      target.append(audio);
      return;
    }
    if (videoExtensions.has(ext)) {
      const video = document.createElement('video');
      video.src = url;
      video.controls = true;
      target.append(video);
      return;
    }
    if (['doc', 'docx'].includes(ext) && window.mammoth) {
      const response = await fetch(url);
      if (!response.ok) throw new Error('无法读取文档。');
      const result = await window.mammoth.convertToHtml({ arrayBuffer: await response.arrayBuffer() });
      this.renderSandboxedHtml(target, result.value, entry.name);
      return;
    }
    if (['xls', 'xlsx'].includes(ext) && window.XLSX) {
      const response = await fetch(url);
      if (!response.ok) throw new Error('无法读取表格。');
      const workbook = window.XLSX.read(await response.arrayBuffer(), { type: 'array' });
      const sheet = workbook.Sheets[workbook.SheetNames[0]];
      this.renderSandboxedHtml(target, window.XLSX.utils.sheet_to_html(sheet), entry.name);
      return;
    }
    const unsupported = document.createElement('p');
    unsupported.textContent = '此文件类型暂不支持网页预览，请下载后在本机打开。';
    target.append(unsupported);
  }

  renderSandboxedHtml(target, html, name) {
    const frame = document.createElement('iframe');
    frame.sandbox = '';
    frame.title = name;
    frame.srcdoc = `<!doctype html><meta charset="utf-8"><style>body{font:14px system-ui,sans-serif;line-height:1.6;padding:18px;overflow-wrap:anywhere}img{max-width:100%}table{border-collapse:collapse;max-width:100%}td,th{border:1px solid #ccc;padding:4px 8px}</style>${html}`;
    target.append(frame);
  }

  download(entry) {
    const link = document.createElement('a');
    link.href = contentUrl(entry.path, true);
    link.download = entry.name;
    document.body.append(link);
    link.click();
    link.remove();
  }

  showFolderDialog() {
    this.openDialog({
      title: '新建文件夹', message: `将在“${displayPath(this.currentPath)}”中创建。`, initialName: '',
      confirm: async (name) => this.jsonRequest('POST', '/api/workspace/folders', { path: this.currentPath, name }),
    });
  }

  showRenameDialog(entry) {
    this.openDialog({
      title: '重命名', message: `重命名“${entry.name}”。`, initialName: entry.name,
      confirm: async (name) => this.jsonRequest('PATCH', '/api/workspace/entries', { path: entry.path, name }),
    });
  }

  showDeleteDialog(entry) {
    this.openDialog({
      title: '删除', message: `确定删除“${entry.name}”？文件删除后无法恢复；文件夹必须为空。`, initialName: null,
      confirm: async () => this.jsonRequest('DELETE', `/api/workspace/entries?path=${encodeURIComponent(entry.path)}`),
    });
  }

  openDialog(operation) {
    this.operation = operation;
    this.e.dialogTitle.textContent = operation.title;
    this.e.dialogMessage.textContent = operation.message;
    this.e.dialogLabel.hidden = operation.initialName === null;
    this.e.dialogName.required = operation.initialName !== null;
    this.e.dialogName.value = operation.initialName || '';
    this.e.dialogConfirm.textContent = operation.title === '删除' ? '确认删除' : '确认';
    this.e.dialog.showModal();
    if (operation.initialName !== null) this.e.dialogName.focus();
  }

  async submitDialog(event) {
    event.preventDefault();
    if (!this.operation) return;
    this.e.dialogConfirm.disabled = true;
    try {
      await this.operation.confirm(this.operation.initialName === null ? undefined : this.e.dialogName.value);
      this.e.dialog.close();
      this.showToast('操作成功。', 'success');
      await this.refresh();
    } catch (error) {
      this.showToast(error.message || '操作失败。', 'error');
    } finally {
      this.e.dialogConfirm.disabled = false;
    }
  }

  async jsonRequest(method, url, body) {
    const response = await fetch(url, body === undefined ? { method } : {
      method,
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });
    const result = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(result.error || '操作失败。');
    return result;
  }

  async uploadFiles(fileList) {
    const files = [...(fileList || [])];
    if (files.length === 0) return;
    this.e.input.value = '';
    this.e.drop.classList.add('uploading');
    const outcomes = [];
    for (const file of files) {
      try {
        const result = await this.uploadOne(file);
        outcomes.push(...result.files);
      } catch (error) {
        outcomes.push({ originalName: file.name, status: 'failed', error: error.message || '上传失败。' });
      }
    }
    this.e.drop.classList.remove('uploading');
    const failures = outcomes.filter((item) => item.status === 'failed');
    const renamed = outcomes.filter((item) => item.status === 'renamed');
    const message = failures.length ? `${outcomes.length - failures.length} 个文件已上传，${failures.length} 个失败。` : `${outcomes.length} 个文件已上传${renamed.length ? `，${renamed.length} 个已自动改名` : ''}。`;
    this.showToast(message, failures.length ? 'error' : 'success');
    await this.refresh();
  }

  uploadOne(file) {
    return new Promise((resolve, reject) => {
      const form = new FormData();
      form.append('path', this.currentPath);
      form.append('file', file, file.name);
      const xhr = new XMLHttpRequest();
      xhr.open('POST', '/api/workspace/upload');
      xhr.upload.onprogress = (event) => {
        if (event.lengthComputable) this.e.drop.querySelector('span').textContent = `正在上传 ${file.name}：${Math.round(event.loaded / event.total * 100)}%`;
      };
      xhr.onerror = () => reject(new Error('网络错误，上传失败。'));
      xhr.onload = () => {
        let result = {};
        try { result = JSON.parse(xhr.responseText); } catch { /* fallback below */ }
        if (xhr.status >= 200 && xhr.status < 300) resolve(result);
        else reject(new Error(result.error || '上传失败。'));
      };
      xhr.send(form);
    });
  }

  showToast(message, kind) {
    let toast = document.getElementById('file-toast');
    if (!toast) {
      toast = document.createElement('div');
      toast.id = 'file-toast';
      toast.className = 'file-toast';
      toast.setAttribute('role', 'status');
      document.body.append(toast);
    }
    toast.textContent = message;
    toast.dataset.kind = kind;
    toast.hidden = false;
    clearTimeout(this.toastTimer);
    this.toastTimer = setTimeout(() => { toast.hidden = true; }, 3600);
  }
}
