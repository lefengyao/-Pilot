# 网页目录选择器 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 在新建终端表单中加入一个仅浏览 `ALLOWED_ROOT` 子目录的网页目录选择器，不调用 Windows 资源管理器。

**Architecture:** 新增一个服务端目录浏览模块，复用 `resolveWorkingDirectory` 进行真实路径约束，并只返回相对路径和直接子目录。Express 暴露同源只读接口；浏览器端用独立弹窗请求该接口、维护浏览位置，并在确认后将相对路径写入既有的终端创建消息。

**Tech Stack:** Node.js 24、Express 5、原生 `node:test`、原生浏览器 Fetch API、HTML Dialog、现有 xterm.js 工作台。

---

## File Structure

- Create: `server/directory-browser.js`，负责受限目录枚举、相对路径转换、过滤、排序与 500 项限制。
- Create: `test/directory-browser.test.js`，直接验证目录枚举、文件过滤、越界链接与列表上限。
- Create: `test/directory-api.test.js`，通过临时 Express 服务验证 HTTP 响应与错误映射。
- Modify: `server/app.js`，注册 `GET /api/directories`，不改变 WebSocket 或 PTY 生命周期。
- Modify: `public/index.html`，将可编辑的 `cwd` 文本框换为选中目录显示和选择按钮，并新增目录选择弹窗。
- Modify: `public/app.js`，维护目录浏览状态、请求接口、渲染目录项并将确认路径写回隐藏 `cwd` 字段。
- Modify: `public/styles.css`，为目录选择弹窗、可滚动列表、错误状态和移动端高度添加局部样式。

### Task 1: Add constrained directory enumeration

**Files:**
- Create: `server/directory-browser.js`
- Test: `test/directory-browser.test.js`

- [x] **Step 1: Write the failing directory enumeration tests.**

Create `test/directory-browser.test.js` with a temporary root containing `alpha`, `beta`, `alpha/child`, a regular file, and a directory junction to a separate temporary directory. Test the public `listDirectories` contract:

```js
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { listDirectories } from '../server/directory-browser.js';

function temporaryTree(callback) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'lan-terminal-directories-'));
  const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'lan-terminal-outside-'));
  try {
    fs.mkdirSync(path.join(root, 'alpha', 'child'), { recursive: true });
    fs.mkdirSync(path.join(root, 'beta'));
    fs.writeFileSync(path.join(root, 'ignore.txt'), 'not a directory');
    fs.symlinkSync(outside, path.join(root, 'escape'), 'junction');
    return callback(root);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
    fs.rmSync(outside, { recursive: true, force: true });
  }
}

test('lists only allowed direct child directories with relative paths', () => {
  temporaryTree((root) => {
    assert.deepEqual(listDirectories(root, '.'), {
      path: '.', parent: null,
      directories: [
        { name: 'alpha', path: 'alpha' },
        { name: 'beta', path: 'beta' },
      ],
    });
    assert.deepEqual(listDirectories(root, 'alpha'), {
      path: 'alpha', parent: '.',
      directories: [{ name: 'child', path: path.join('alpha', 'child') }],
    });
  });
});

test('rejects traversal and never exposes a linked directory outside the allowed root', () => {
  temporaryTree((root) => {
    assert.throws(() => listDirectories(root, '..'), /允许目录/);
    assert.deepEqual(listDirectories(root, '.').directories.map((item) => item.name), ['alpha', 'beta']);
  });
});
```

- [x] **Step 2: Run the new test to verify it fails.**

Run: `node --test test/directory-browser.test.js`

Expected: FAIL because `server/directory-browser.js` does not exist.

- [x] **Step 3: Implement the minimum constrained enumeration module.**

Create `server/directory-browser.js` with this public implementation. It deliberately resolves each candidate through the existing path boundary, uses only relative response paths, and sorts before applying the limit:

```js
import fs from 'node:fs';
import path from 'node:path';
import { resolveWorkingDirectory } from './config.js';

export const MAX_DIRECTORY_ENTRIES = 500;

function relativePath(root, directory) {
  const relative = path.relative(root, directory);
  return relative || '.';
}

export function listDirectories(allowedRoot, requestedPath = '.') {
  const root = resolveWorkingDirectory(allowedRoot, '.');
  const current = resolveWorkingDirectory(root, requestedPath);
  const directories = [];

  for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
    if (!entry.isDirectory() && !entry.isSymbolicLink()) continue;
    try {
      const child = resolveWorkingDirectory(root, path.join(current, entry.name));
      directories.push({ name: entry.name, path: relativePath(root, child) });
    } catch {
      // A broken link or a link escaping ALLOWED_ROOT is intentionally omitted.
    }
  }

  const collator = new Intl.Collator('zh-CN', { numeric: true, sensitivity: 'base' });
  directories.sort((left, right) => collator.compare(left.name, right.name));
  return {
    path: relativePath(root, current),
    parent: current === root ? null : relativePath(root, path.dirname(current)),
    directories: directories.slice(0, MAX_DIRECTORY_ENTRIES),
  };
}
```

- [x] **Step 4: Extend the test with the 500-item cap and run it.**

Append this test, then run the file again:

```js
test('caps a directory response at 500 sorted entries', () => {
  temporaryTree((root) => {
    for (let index = 0; index < 501; index += 1) fs.mkdirSync(path.join(root, `item-${index}`));
    const result = listDirectories(root, '.');
    assert.equal(result.directories.length, 500);
    assert.equal(result.directories[0].name, 'alpha');
    assert.ok(!result.directories.some((item) => item.name === 'escape'));
  });
});
```

Run: `node --test test/directory-browser.test.js`

Expected: PASS with three tests; the returned items are sorted, regular files and the external junction are absent, and no response path is absolute.

### Task 2: Expose the directory list through Express

**Files:**
- Modify: `server/app.js`
- Create: `test/directory-api.test.js`

- [x] **Step 1: Write the failing HTTP contract test.**

Create `test/directory-api.test.js`. Start `createLanTerminalServer` with a temporary allowed root and a fake PTY, then assert the public JSON response and traversal error:

```js
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { createLanTerminalServer } from '../server/app.js';

function fakePty() { return { pid: 1, onData() {}, onExit() {}, write() {}, resize() {}, kill() {} }; }

test('serves relative allowed-root directory listings and rejects traversal', async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'lan-terminal-directory-api-'));
  fs.mkdirSync(path.join(root, 'projects', 'demo'), { recursive: true });
  const service = createLanTerminalServer({
    config: { host: '127.0.0.1', port: 0, allowedRoot: root, maxSessionsPerClient: 8, maxSessionsTotal: 8, maxMessageBytes: 65536, maxHistoryBytes: 1024, outputBatchMs: 0 },
    ptyFactory: fakePty,
  });
  t.after(async () => { await service.close(); fs.rmSync(root, { recursive: true, force: true }); });
  await service.listen();
  const base = `http://127.0.0.1:${service.server.address().port}`;

  const rootResponse = await fetch(`${base}/api/directories?path=.`);
  assert.equal(rootResponse.status, 200);
  assert.deepEqual(await rootResponse.json(), { path: '.', parent: null, directories: [{ name: 'projects', path: 'projects' }] });

  const invalidResponse = await fetch(`${base}/api/directories?path=..`);
  assert.equal(invalidResponse.status, 400);
  assert.match((await invalidResponse.json()).error, /允许目录/);
});
```

- [x] **Step 2: Run the API test to verify it fails.**

Run: `node --test test/directory-api.test.js`

Expected: FAIL because `/api/directories` currently falls through to a 404 response.

- [x] **Step 3: Add the endpoint before static file middleware.**

In `server/app.js`, import `listDirectories` and register this route immediately after `/healthz`:

```js
import { listDirectories } from './directory-browser.js';

app.get('/api/directories', (req, res) => {
  const requestedPath = typeof req.query.path === 'string' ? req.query.path : '.';
  try {
    res.json(listDirectories(config.allowedRoot, requestedPath));
  } catch (error) {
    const message = error instanceof Error ? error.message : '无法读取目录。';
    if (/允许目录|工作目录/.test(message)) {
      res.status(400).json({ error: message });
    } else {
      logger.error?.('Directory listing failed', error);
      res.status(500).json({ error: '无法读取目录。' });
    }
  }
});
```

- [x] **Step 4: Run the focused server tests and the full suite.**

Run: `node --test test/directory-browser.test.js test/directory-api.test.js`

Expected: PASS; the endpoint yields only relative child paths and maps traversal to HTTP 400.

Run: `npm test`

Expected: all existing tests plus the new directory tests PASS.

### Task 3: Add the webpage directory selection dialog

**Files:**
- Modify: `public/index.html`
- Modify: `public/app.js`
- Modify: `public/styles.css`

- [x] **Step 1: Replace the editable cwd field and add the dialog markup.**

In `public/index.html`, replace the current `label` containing `<input name="cwd">` with the hidden form value and chooser control below. Insert the `directory-dialog` after `create-dialog` and before the xterm scripts:

```html
<label>初始工作目录
  <input type="hidden" name="cwd" value=".">
  <div class="directory-field">
    <output id="selected-directory">允许目录</output>
    <button type="button" id="choose-directory">选择目录</button>
  </div>
  <small>只能选择服务允许目录内的子目录。</small>
</label>
```

```html
<dialog id="directory-dialog" class="directory-dialog">
  <header><div><h1>选择初始工作目录</h1><p id="directory-path">允许目录</p></div><button type="button" id="close-directory" aria-label="关闭目录选择">×</button></header>
  <p class="directory-error" id="directory-error" hidden></p>
  <div class="directory-list" id="directory-list" aria-live="polite"></div>
  <footer><button type="button" id="directory-up">上一级</button><span></span><button type="button" id="cancel-directory">取消</button><button type="button" class="primary" id="confirm-directory">使用当前目录</button></footer>
</dialog>
```

- [x] **Step 2: Implement one focused browser-side directory picker state machine.**

Replace the one-line event wiring in `public/app.js` with readable event registrations. Preserve existing workspace handlers, then add this state and helpers before `socket.connect()`:

```js
const directoryDialog = $('directory-dialog');
const directoryState = { current: '.', parent: null };
const directoryPath = $('directory-path');
const directoryList = $('directory-list');
const directoryError = $('directory-error');
const selectedDirectory = $('selected-directory');
const cwdInput = document.querySelector('#create-form [name="cwd"]');

function displayPath(value) {
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
  if (result.directories.length === 0) directoryList.textContent = '当前目录没有可选择的子目录。';
}

async function loadDirectories(path) {
  showDirectoryError();
  directoryList.textContent = '正在读取目录…';
  try {
    const response = await fetch(`/api/directories?path=${encodeURIComponent(path)}`);
    const result = await response.json();
    if (!response.ok) throw new Error(result.error || '无法读取目录。');
    renderDirectories(result);
  } catch (error) {
    directoryList.replaceChildren();
    showDirectoryError(error.message || '无法读取目录。');
  }
}
```

Wire controls with these exact behaviors:

```js
$('choose-directory').onclick = async () => {
  directoryDialog.showModal();
  await loadDirectories(cwdInput.value || '.');
};
$('directory-up').onclick = () => loadDirectories(directoryState.parent);
$('close-directory').onclick = () => directoryDialog.close();
$('cancel-directory').onclick = () => directoryDialog.close();
$('confirm-directory').onclick = () => {
  cwdInput.value = directoryState.current;
  selectedDirectory.textContent = displayPath(directoryState.current);
  directoryDialog.close();
};
```

The existing `create-form` submit handler continues to use `new FormData`, so the hidden field sends the selected relative path with no WebSocket protocol change.

- [x] **Step 3: Add constrained dialog styling.**

Append these styles to `public/styles.css`; retain existing dialog styles:

```css
.directory-field { display: flex; gap: 8px; }
.directory-field output { min-width: 0; flex: 1; overflow: hidden; padding: 9px; border: 1px solid #3a4a51; background: #081015; color: #d8e4e8; text-overflow: ellipsis; white-space: nowrap; }
.directory-dialog { width: min(620px, calc(100vw - 32px)); max-height: min(620px, calc(100dvh - 32px)); grid-template-rows: auto auto minmax(0, 1fr) auto; }
.directory-dialog[open] { display: grid; }
.directory-dialog header { align-items: flex-start; }
.directory-dialog h1, .directory-dialog p { margin: 0; }
.directory-dialog header p { color: #7ee2c5; font: 12px Consolas, monospace; margin-top: 5px; overflow-wrap: anywhere; }
.directory-error { margin: 12px 20px 0 !important; color: #f49a71; font-size: 13px; }
.directory-list { min-height: 160px; overflow: auto; margin: 14px 20px; border: 1px solid #32464f; background: #081015; }
.directory-item { display: block; width: 100%; border: 0; border-bottom: 1px solid #243239; background: transparent; color: #d8e4e8; padding: 10px 12px; text-align: left; }
.directory-item:hover, .directory-item:focus-visible { background: #173038; outline: none; }
.directory-dialog footer { gap: 8px; justify-content: flex-end; }
.directory-dialog footer span { flex: 1; }
@media (max-width: 760px) { .directory-dialog { max-height: calc(100dvh - 16px); } .directory-list { min-height: 0; } }
```

- [ ] **Step 4: Perform browser acceptance with the running service.**

Use a fresh browser profile at `http://127.0.0.1:3000` and verify this sequence:

1. Open “新建终端”, click “选择目录”, and confirm only immediate folders from the configured allowed root appear.
2. Enter a child folder, use “上一级”, then enter it again and click “使用当前目录”. Confirm the form shows `允许目录 / …` without exposing an absolute host path.
3. Create a CMD session and confirm the session metadata reports the selected full working directory returned by the already-validated server session.
4. Set the browser viewport to 375px wide. Confirm the directory list scrolls while the path, “上一级”, “取消”, and “使用当前目录” controls remain usable.
5. Attempt `/api/directories?path=..` directly and confirm HTTP 400 with no absolute path in the JSON body.

- [x] **Step 5: Run final automated verification.**

Run: `npm test`

Expected: all test files PASS with no failures, including directory enumeration and HTTP API coverage.

Run: `Invoke-WebRequest -UseBasicParsing http://127.0.0.1:3000/healthz`

Expected: HTTP 200 and `{"ok":true}` while the existing LAN Terminal service remains running.

## Plan Self-Review

- **Spec coverage:** Task 1 implements restricted, relative, sorted and capped directory enumeration including link escape handling. Task 2 exposes only that contract with HTTP errors. Task 3 implements the confirmed independent dialog, root/child/up/cancel/confirm flows, error state, mobile constraints and final creation validation through the existing WebSocket flow.
- **Placeholder scan:** No unfinished markers, vague validation steps or unassigned implementation details remain.
- **Type consistency:** `listDirectories(allowedRoot, requestedPath)` is defined in Task 1, imported by Task 2, and its `path`, `parent`, and `directories` fields are consumed unchanged by Task 3.
- **Repository state:** This workspace is not a Git repository, so commit steps are intentionally omitted.
