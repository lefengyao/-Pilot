import { TerminalSocket } from './ws-client.js';
import { Workspace } from './workspace.js';

const $ = (id) => document.getElementById(id);
const socket = new TerminalSocket();
const workspace = new Workspace(socket, {
  list: $('session-list'),
  host: $('terminal-host'),
  title: $('session-title'),
  meta: $('session-meta'),
  banner: $('connection-banner'),
});
const createDialog = $('create-dialog');
const directoryDialog = $('directory-dialog');
const directoryState = { current: '.', parent: null };
const directoryPath = $('directory-path');
const directoryList = $('directory-list');
const directoryError = $('directory-error');
const selectedDirectory = $('selected-directory');
const cwdInput = document.querySelector('#create-form [name="cwd"]');
const adminDialog = $('admin-dialog');
const adminForm = $('admin-form');
const adminKeyInput = $('admin-key');
const adminError = $('admin-error');
const adminStatus = $('admin-status');
let adminToken = null;
let adminExpiresAt = 0;
let adminRoot = null;

function deactivateAdmin() {
  adminToken = null;
  adminExpiresAt = 0;
  adminRoot = null;
  cwdInput.value = '.';
  selectedDirectory.textContent = '允许目录';
  adminStatus.textContent = '普通用户模式';
  $('unlock-admin').disabled = false;
}

function isAdminActive() {
  if (!adminToken) return false;
  if (adminExpiresAt <= Date.now()) {
    deactivateAdmin();
    return false;
  }
  return true;
}

function displayPath(value) {
  if (isAdminActive() && /^[A-Za-z]:[\\/]/.test(value)) return `管理员目录 / ${value.split(/[\\/]/).join(' / ')}`;
  return value === '.' ? '允许目录' : `允许目录 / ${value.split(/[\\/]/).join(' / ')}`;
}

function showDirectoryError(message = '') {
  directoryError.hidden = !message;
  directoryError.textContent = message;
}

function renderDirectories(result) {
  directoryState.current = result.path;
  directoryState.parent = result.parent;
  directoryPath.textContent = displayPath(result.path);
  $('directory-up').disabled = result.parent === null;
  directoryList.replaceChildren(...result.directories.map((directory) => {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'directory-item';
    button.textContent = directory.name;
    button.addEventListener('click', () => loadDirectories(directory.path));
    return button;
  }));
  if (result.directories.length === 0) {
    directoryList.textContent = '当前目录没有可选择的子目录。';
  }
}

async function loadDirectories(path) {
  showDirectoryError();
  directoryList.textContent = '正在读取目录…';
  try {
    const headers = isAdminActive() ? { 'X-Admin-Token': adminToken, 'X-Client-ID': socket.clientId } : {};
    const response = await fetch(`/api/directories?path=${encodeURIComponent(path)}`, { headers });
    const result = await response.json();
    if (response.status === 401) deactivateAdmin();
    if (!response.ok) throw new Error(result.error || '无法读取目录。');
    renderDirectories(result);
  } catch (error) {
    directoryList.replaceChildren();
    showDirectoryError(error.message || '无法读取目录。');
  }
}

$('show-create').onclick = () => createDialog.showModal();
$('show-files').onclick = () => { window.location.href = '/files.html'; };
$('show-terminal').onclick = () => { window.location.href = '/'; };
$('close-create').onclick = () => createDialog.close();
$('cancel-create').onclick = () => createDialog.close();
$('unlock-admin').onclick = () => {
  adminError.hidden = true;
  adminKeyInput.value = '';
  adminDialog.showModal();
  adminKeyInput.focus();
};
$('close-admin').onclick = () => adminDialog.close();
$('cancel-admin').onclick = () => adminDialog.close();
adminForm.onsubmit = async (event) => {
  event.preventDefault();
  adminError.hidden = true;
  try {
    const response = await fetch('/api/admin/unlock', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ key: adminKeyInput.value, clientId: socket.clientId }),
    });
    const result = await response.json();
    if (!response.ok) throw new Error(result.error || '管理员解锁失败。');
    adminToken = result.token;
    adminExpiresAt = result.expiresAt;
    adminRoot = result.root;
    cwdInput.value = adminRoot;
    selectedDirectory.textContent = displayPath(adminRoot);
    adminStatus.textContent = '管理员已解锁';
    $('unlock-admin').disabled = true;
    adminDialog.close();
  } catch (error) {
    adminError.hidden = false;
    adminError.textContent = error.message || '管理员解锁失败。';
  }
};
$('choose-directory').onclick = async () => {
  directoryDialog.showModal();
  await loadDirectories(cwdInput.value || '.');
};
$('directory-up').onclick = () => {
  if (directoryState.parent !== null) loadDirectories(directoryState.parent);
};
$('close-directory').onclick = () => directoryDialog.close();
$('cancel-directory').onclick = () => directoryDialog.close();
$('confirm-directory').onclick = () => {
  cwdInput.value = directoryState.current;
  selectedDirectory.textContent = displayPath(directoryState.current);
  directoryDialog.close();
};
$('clear').onclick = () => workspace.clear();
$('reconnect').onclick = () => workspace.reconnect();
$('restart').onclick = () => workspace.restart();
$('stop').onclick = () => workspace.requestStop();
$('toggle-sidebar').onclick = () => $('sidebar').classList.toggle('open');
$('create-form').onsubmit = (event) => {
  event.preventDefault();
  const form = new FormData(event.currentTarget);
  try {
    const request = { shell: form.get('shell'), label: form.get('label'), cwd: form.get('cwd') };
    if (isAdminActive()) request.adminToken = adminToken;
    workspace.create(request);
    createDialog.close();
  } catch (error) {
    alert(error.message);
  }
};
window.onresize = () => workspace.resizeActive();
socket.connect();
