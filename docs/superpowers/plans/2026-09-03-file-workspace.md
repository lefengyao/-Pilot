# File Workspace Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a secure, LAN-only file workspace inside the existing terminal page for browsing, previewing, downloading, uploading, renaming, deleting files, and creating folders within `ALLOWED_ROOT`.

**Architecture:** Keep one Express/HTTP service. Add a focused `server/workspace-files.js` module with canonical-root validation and REST handlers under `/api/workspace`; add a `FileWorkspace` browser controller and a left-directory-tree view alongside the existing terminal view. File payloads use HTTP streams, while the existing terminal WebSocket remains terminal-only.

**Tech Stack:** Node.js 20, Express 5, Node `fs` streams, `busboy` for streaming multipart uploads, vanilla ES modules, existing HTML/CSS UI, `mammoth` for DOC/DOCX browser preview, `xlsx` for XLS/XLSX browser preview, Node test runner, and the existing Edge DevTools browser-test helper.

---

## File Map

- Create: `server/workspace-files.js` — safe path resolution, metadata listing, streaming content, multipart upload, folder creation, rename, and deletion routes.
- Create: `public/file-workspace.js` — file-workspace state, directory tree rendering, selection, preview, upload progress, and operation dialogs.
- Create: `test/workspace-files.test.js` — domain and HTTP tests for all file operations and security boundaries.
- Create: `test/file-workspace-browser.test.js` — Edge-based acceptance tests for the integrated view.
- Modify: `package.json`, `package-lock.json` — add `busboy`, `mammoth`, and `xlsx` runtime dependencies.
- Modify: `server/config.js` — parse and expose `maxUploadBytes` from `MAX_UPLOAD_BYTES`, defaulting to 2 GiB.
- Modify: `server/app.js` — mount the workspace router and serve the two browser preview bundles.
- Modify: `public/index.html` — add the file entry point, file view, preview surface, and reusable operation dialog markup.
- Modify: `public/app.js` — switch between terminal and file views and instantiate `FileWorkspace`.
- Modify: `public/styles.css` — style the directory tree, file list, preview pane, dialogs, upload progress, and mobile layout.
- Modify: `test/config.test.js` — verify upload-size configuration validation and default.

### Task 1: Add Configuration and Dependencies

**Files:**
- Modify: `package.json`
- Modify: `package-lock.json`
- Modify: `server/config.js`
- Modify: `test/config.test.js`

- [ ] **Step 1: Write failing configuration tests**

Add tests to `test/config.test.js`:

```js
test('loadConfig defaults MAX_UPLOAD_BYTES to 2 GiB and accepts a bounded override', () => {
  withTemporaryRoot((root) => {
    const config = loadConfig({ ALLOWED_ROOT: root }, root);
    assert.equal(config.maxUploadBytes, 2 * 1024 * 1024 * 1024);
    assert.equal(loadConfig({ ALLOWED_ROOT: root, MAX_UPLOAD_BYTES: '1048576' }, root).maxUploadBytes, 1048576);
  });
});

test('loadConfig rejects an upload limit below 1 MiB or above 8 GiB', () => {
  withTemporaryRoot((root) => {
    assert.throws(() => loadConfig({ ALLOWED_ROOT: root, MAX_UPLOAD_BYTES: '1048575' }, root), /MAX_UPLOAD_BYTES/);
    assert.throws(() => loadConfig({ ALLOWED_ROOT: root, MAX_UPLOAD_BYTES: String(8 * 1024 * 1024 * 1024 + 1) }, root), /MAX_UPLOAD_BYTES/);
  });
});
```

- [ ] **Step 2: Run the focused test to confirm it fails**

Run: `node --test test/config.test.js`

Expected: FAIL because `maxUploadBytes` is not present in the configuration.

- [ ] **Step 3: Implement the setting and install dependencies**

Extend the `DEFAULTS` object with `maxUploadBytes: 2 * 1024 * 1024 * 1024`, parse `MAX_UPLOAD_BYTES` using the existing bounded-integer helper with a minimum of `1024 * 1024` and maximum of `8 * 1024 * 1024 * 1024`, and expose it in the frozen config object. Run `npm install busboy mammoth xlsx` so `package.json` and `package-lock.json` record the exact versions.

- [ ] **Step 4: Run the focused test to confirm it passes**

Run: `node --test test/config.test.js`

Expected: PASS for all configuration tests.

### Task 2: Build the Safe Workspace File Module

**Files:**
- Create: `server/workspace-files.js`
- Create: `test/workspace-files.test.js`

- [ ] **Step 1: Write failing unit tests for path and name rules**

Export and test these contracts:

```js
assert.equal(relativeWorkspacePath(root, root), '.');
assert.equal(relativeWorkspacePath(root, path.join(root, 'docs')), 'docs');
assert.throws(() => resolveWorkspaceEntry(root, '..'), /工作区/);
assert.throws(() => resolveWorkspaceEntry(root, path.join(root, 'outside')), /工作区/);
assert.throws(() => validateEntryName('a\\b'), /名称/);
assert.throws(() => validateEntryName('.'), /名称/);
assert.equal(validateEntryName('报告 1.txt'), '报告 1.txt');
```

Create a temporary root with a normal child, an outside directory, a junction/symlink named `escape`, a regular file, and `.env`; test that `listWorkspaceEntries(root, '.')` returns only permitted entries, separates directories/files, includes size and `mtime`, sorts with `Intl.Collator('zh-CN', { numeric: true, sensitivity: 'base' })`, and caps the response at 500 entries.

- [ ] **Step 2: Run the new test to confirm it fails**

Run: `node --test test/workspace-files.test.js`

Expected: FAIL because `server/workspace-files.js` does not exist.

- [ ] **Step 3: Implement canonical path helpers and metadata listing**

Implement:

```js
export const MAX_DIRECTORY_ENTRIES = 500;
export function relativeWorkspacePath(root, absolutePath) {}
export function resolveWorkspaceEntry(root, requestedPath, { allowRoot = true } = {}) {}
export function resolveWorkspaceDirectory(root, requestedPath = '.') {}
export function validateEntryName(name) {}
export function listWorkspaceEntries(root, requestedPath = '.') {}
```

Use `fs.realpathSync` on the root and existing targets, `path.relative` for the boundary check, and reject absolute request paths, `..` segments, root-escaping links, non-directory parents, dot-reserved names (`.env`, `.env.*`, `.git`) and Windows-invalid names. Return only relative paths to the HTTP layer. For each file, use `lstat`/`stat` safely and skip entries that disappear or cannot be resolved.

- [ ] **Step 4: Write failing tests for content and mutations**

Add HTTP-facing tests that create a service with `createLanTerminalServer`, a fake PTY, and a temporary allowed root. Assert:

```js
assert.deepEqual((await get('/api/workspace/tree?path=.')).json().entries.map((e) => e.name), ['docs', 'note.txt']);
assert.equal((await get('/api/workspace/content?path=note.txt')).status, 200);
assert.equal(await (await get('/api/workspace/content?path=note.txt')).text(), 'hello');
assert.match((await get('/api/workspace/content?path=note.txt&download=1')).headers.get('content-disposition'), /attachment/);
assert.equal((await postJson('/api/workspace/folders', { path: '.', name: 'new-folder' })).status, 201);
assert.equal((await patchJson('/api/workspace/entries', { path: 'note.txt', name: 'renamed.txt' })).status, 200);
assert.equal((await del('/api/workspace/entries?path=renamed.txt')).status, 200);
assert.equal((await del('/api/workspace/entries?path=docs')).status, 409); // docs contains a file
```

Also assert 400/404 for `..`, an absolute path, a directory passed to `content`, a missing target, and a symlink pointing outside; assert 409 for duplicate rename and 400 for invalid new names.

- [ ] **Step 5: Run the new HTTP tests to confirm they fail**

Run: `node --test test/workspace-files.test.js`

Expected: FAIL because the Express app has no `/api/workspace` routes.

- [ ] **Step 6: Implement streaming content and mutation functions**

Add these exports and keep all writes inside the validated parent directory:

```js
export function createWorkspaceRouter({ root, maxUploadBytes, logger = console }) {}
export async function createFolder(root, parentPath, name) {}
export async function renameEntry(root, requestedPath, name) {}
export async function deleteEntry(root, requestedPath) {}
```

Use `fs.createReadStream` for content; set `Content-Type` from a maintained extension map and `Content-Disposition: attachment` with RFC 5987 filename encoding when `download=1`. Reject recursive deletion by checking that a directory has zero entries. Map conflicts to 409 and filesystem failures to generic user-facing errors while logging the original error.

- [ ] **Step 7: Implement multipart upload without buffering files in memory**

Use `busboy({ headers: req.headers, limits: { fileSize: maxUploadBytes, files: 64 } })`. Stream each file into a unique file under `fs.mkdtemp(path.join(os.tmpdir(), 'lan-terminal-upload-'))`; collect the `path` field and file metadata, then after `finish` validate the target directory and atomically move each temp file into it. Generate collision-free names by appending `_1`, `_2`, etc. before the extension. On limit, client abort, validation failure, or move failure, remove every temporary file and directory. Return HTTP 201 with an array containing `{ originalName, name, status: 'uploaded'|'renamed'|'failed', error? }`; return HTTP 413 when the per-file limit is exceeded.

- [ ] **Step 8: Run the backend test suite**

Run: `node --test test/workspace-files.test.js test/config.test.js`

Expected: PASS, including traversal, symlink, mutation, stream, and upload cleanup cases.

### Task 3: Mount the API and Browser Preview Assets

**Files:**
- Modify: `server/app.js`
- Modify: `test/workspace-files.test.js`

- [ ] **Step 1: Write the integration assertion**

Add an app test that creates the service with `allowedRoot` and `maxUploadBytes`, calls `GET /api/workspace/tree`, and verifies the returned JSON never contains the absolute root path. Assert that static requests for `/vendor/mammoth/mammoth.browser.min.js` and `/vendor/xlsx/xlsx.full.min.js` return 200 after dependencies are installed.

- [ ] **Step 2: Mount the workspace router**

In `server/app.js`, import `createWorkspaceRouter` and mount it before `express.static`:

```js
app.use('/api/workspace', createWorkspaceRouter({
  root: config.allowedRoot,
  maxUploadBytes: config.maxUploadBytes,
  logger,
}));
```

Also serve the installed browser bundles:

```js
app.use('/vendor/mammoth', express.static(path.join(root, 'node_modules', 'mammoth')));
app.use('/vendor/xlsx', express.static(path.join(root, 'node_modules', 'xlsx', 'dist')));
```

- [ ] **Step 3: Run integration tests**

Run: `node --test test/workspace-files.test.js`

Expected: PASS for API and preview asset assertions.

### Task 4: Add the File Workspace View Controller

**Files:**
- Create: `public/file-workspace.js`
- Modify: `public/index.html`
- Modify: `public/app.js`

- [ ] **Step 1: Add semantic markup**

Add a sidebar button with id `show-files` and a hidden `section#file-area` containing:

```html
<aside class="file-tree" id="file-tree" aria-label="工作区目录"></aside>
<section class="file-browser">
  <header class="file-toolbar">
    <strong id="file-path">工作区</strong>
    <div class="file-actions">
      <button type="button" id="file-refresh">刷新</button>
      <button type="button" id="file-upload">上传</button>
      <button type="button" id="file-new-folder">新建文件夹</button>
    </div>
  </header>
  <div class="file-content"><div id="file-list"></div><aside id="file-preview"></aside></div>
</section>
<input id="file-input" type="file" multiple hidden>
<dialog id="file-operation-dialog">
  <form method="dialog" id="file-operation-form">
    <h2 id="file-operation-title"></h2>
    <p id="file-operation-message"></p>
    <input id="file-operation-name" name="name" maxlength="255">
    <div class="dialog-actions">
      <button type="button" id="file-operation-cancel">取消</button>
      <button type="submit" id="file-operation-confirm">确认</button>
    </div>
  </form>
</dialog>
```

Include `/vendor/mammoth/mammoth.browser.min.js`, `/vendor/xlsx/xlsx.full.min.js`, and `/file-workspace.js` through the existing module loading path.

- [ ] **Step 2: Implement the controller state and tree loading**

Implement `FileWorkspace` with `currentPath`, `selectedPath`, `expandedPaths`, `entries`, and methods `open()`, `loadTree(path)`, `renderTree()`, `renderEntries()`, `selectEntry(entry)`, and `refresh()`. Use `fetch('/api/workspace/tree?...')`, never display an absolute path, and keep tree expansion when refreshing the active directory. Folder buttons call `loadTree(entry.path)`; file buttons call `selectEntry`.

- [ ] **Step 3: Implement preview and download behavior**

For text-like content, fetch `content` and render escaped text in a `<pre>`; for image, PDF, audio, and video use an appropriately typed `<img>`, `<iframe>`, `<audio controls>`, or `<video controls>` with the content URL. For DOC/DOCX call `window.mammoth.convertToHtml({ arrayBuffer })`; for XLS/XLSX call `window.XLSX.read` and render a sheet table. PPT/PPTX and unknown types show metadata plus a download button. Every preview has an error state and a download fallback.

- [ ] **Step 4: Wire view switching**

In `public/app.js`, instantiate `FileWorkspace` with the file DOM elements. `#show-files` hides the terminal area, shows `#file-area`, and calls `open()`; a new terminal-view control restores the existing terminal area. Keep the WebSocket connection alive while switching views so terminal sessions remain available.

### Task 5: Implement File Operations and Feedback UI

**Files:**
- Modify: `public/file-workspace.js`
- Modify: `public/index.html`
- Modify: `public/styles.css`

- [ ] **Step 1: Add operation-dialog tests to the browser test plan**

The browser test will assert that clicking upload, new-folder, rename, and delete controls opens the in-page dialog, not `window.alert` or `window.prompt`, and that a failed request leaves the current listing visible with an error toast.

- [ ] **Step 2: Implement uploads**

Use a hidden file input and drag/drop zone. For each selected file, create `FormData` with `path` and `file`, send `POST /api/workspace/upload`, and use `XMLHttpRequest.upload.onprogress` to display per-file progress. Render server-returned final names for auto-renamed files, then refresh the active directory.

- [ ] **Step 3: Implement folder creation, rename, delete, and refresh**

Use the reusable dialog for a single validated name. Send `POST /folders`, `PATCH /entries`, and `DELETE /entries`; display 409 messages such as “文件夹不为空，无法删除” in the toast. Disable destructive controls while a request is pending and restore them on both success and failure.

- [ ] **Step 4: Add responsive styling**

Append styles for the left tree, list rows, type icons, preview pane, toolbar actions, progress bars, confirmation dialog, and toast. At `max-width: 760px`, collapse the tree into a drawer and make the preview pane a full-screen layer. Use fixed icon/button dimensions and overflow-safe text so long Windows names do not resize or overlap controls.

### Task 6: Add Browser Acceptance Coverage

**Files:**
- Create: `test/file-workspace-browser.test.js`

- [ ] **Step 1: Build the Edge test fixture**

Reuse the existing `openPage`/`waitFor` pattern from `test/directory-picker-browser.test.js`, create a temporary allowed root containing `docs/readme.txt`, `image.png`, an empty directory, and a non-empty directory, then start `createLanTerminalServer` with a fake PTY and `maxUploadBytes: 1024 * 1024`.

- [ ] **Step 2: Test the core workflow**

Open the page, click `#show-files`, wait for `#file-area` and `docs`, enter `docs`, select `readme.txt`, assert the preview contains its text, open the new-folder dialog and create `uploads`, upload a small Blob through the file input, rename it, download it, and delete it. Assert the left tree and right listing update without navigating away.

- [ ] **Step 3: Test failures and mobile layout**

Attempt to delete the non-empty directory and assert the in-page error text; attempt a traversal through the API and assert 400. Use `Emulation.setDeviceMetricsOverride` at width 375 and assert the file area is visible, the preview layer fits the viewport, and no toolbar button has a bounding rectangle outside the viewport.

- [ ] **Step 4: Run the full verification suite**

Run: `npm test`

Expected: PASS for all existing terminal/admin/directory tests plus the new workspace tests. If Edge is unavailable, report the browser-test prerequisite explicitly and still run all Node tests.

### Task 7: Update User-Facing Documentation and Verify Startup

**Files:**
- Modify: `README.md`
- Modify: `.env.example` (if present; otherwise create it with the existing configuration keys)

- [ ] **Step 1: Document the file workspace**

Add the `/api/workspace` scope, supported operations, 2 GiB default upload limit, non-recursive deletion rule, Office preview limits, and the warning that the service remains intended for a trusted LAN. Add `MAX_UPLOAD_BYTES` to the configuration table and keep the statement that administrator unlock does not expand file-workspace access.

- [ ] **Step 2: Verify production startup and shutdown**

Run:

```powershell
$env:ALLOWED_ROOT = (Resolve-Path '.\terminal-workspace').Path
$env:PORT = '0'
node server/index.js
```

In a separate PowerShell request `/healthz`, `/api/workspace/tree?path=.`, and a sample `/api/workspace/content`; then stop the process with Ctrl+C and verify it closes without leaving a listening socket.

- [ ] **Step 3: Run final checks**

Run: `npm test`

Expected: all tests pass, no absolute `ALLOWED_ROOT` is rendered in the browser, and the file workspace remains limited to the configured root.
