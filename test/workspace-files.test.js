import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { createLanTerminalServer } from '../server/app.js';

import {
  listWorkspaceEntries,
  relativeWorkspacePath,
  resolveWorkspaceEntry,
  validateEntryName,
} from '../server/workspace-files.js';

function fakePty() {
  return { pid: 1, onData() {}, onExit() {}, write() {}, resize() {}, kill() {} };
}

async function createWorkspaceService(root, maxUploadBytes = 1024 * 1024) {
  const service = createLanTerminalServer({
    config: {
      host: '127.0.0.1',
      port: 0,
      allowedRoot: root,
      maxUploadBytes,
      maxSessionsPerClient: 8,
      maxSessionsTotal: 8,
      maxMessageBytes: 65536,
      maxHistoryBytes: 1024,
      outputBatchMs: 0,
    },
    ptyFactory: fakePty,
  });
  await service.listen();
  return { service, base: `http://127.0.0.1:${service.server.address().port}` };
}

function withTemporaryWorkspace(callback) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'lan-terminal-workspace-files-'));
  const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'lan-terminal-workspace-outside-'));

  try {
    fs.mkdirSync(path.join(root, 'docs'));
    fs.writeFileSync(path.join(root, 'docs', 'readme.txt'), 'read me');
    fs.writeFileSync(path.join(root, 'note-10.txt'), 'ten');
    fs.writeFileSync(path.join(root, 'note-2.txt'), 'two');
    fs.writeFileSync(path.join(root, '.env'), 'secret');
    fs.mkdirSync(path.join(root, '.git'));
    fs.symlinkSync(outside, path.join(root, 'escape'), 'junction');
    return callback(root, outside);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
    fs.rmSync(outside, { recursive: true, force: true });
  }
}

test('resolves only permitted workspace entries and validates new names', () => {
  withTemporaryWorkspace((root, outside) => {
    assert.equal(relativeWorkspacePath(root, root), '.');
    assert.equal(relativeWorkspacePath(root, path.join(root, 'docs')), 'docs');
    assert.throws(() => resolveWorkspaceEntry(root, '..'), /工作区/);
    assert.throws(() => resolveWorkspaceEntry(root, outside), /工作区/);
    assert.throws(() => resolveWorkspaceEntry(root, 'escape'), /工作区/);
    assert.throws(() => validateEntryName('a\\b'), /名称/);
    assert.throws(() => validateEntryName('.'), /名称/);
    assert.throws(() => validateEntryName('CON.txt'), /名称/);
    assert.equal(validateEntryName('报告 1.txt'), '报告 1.txt');

    const listing = listWorkspaceEntries(root, '.');
    assert.equal(listing.path, '.');
    assert.equal(listing.parent, null);
    assert.deepEqual(listing.entries.map((entry) => entry.name), ['docs', 'note-2.txt', 'note-10.txt']);
    assert.deepEqual(listing.entries.map((entry) => entry.type), ['directory', 'file', 'file']);
    assert.equal(listing.entries.every((entry) => Number.isSafeInteger(entry.size) && typeof entry.mtime === 'number'), true);
  });
});

test('caps workspace listings at 500 permitted entries', () => {
  withTemporaryWorkspace((root) => {
    for (let index = 0; index < 501; index += 1) fs.writeFileSync(path.join(root, `item-${index}.txt`), 'x');
    assert.equal(listWorkspaceEntries(root, '.').entries.length, 500);
  });
});

test('serves only allowed files and applies non-recursive mutations', async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'lan-terminal-workspace-api-'));
  const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'lan-terminal-workspace-api-outside-'));
  fs.mkdirSync(path.join(root, 'docs'));
  fs.writeFileSync(path.join(root, 'docs', 'readme.txt'), 'read me');
  fs.writeFileSync(path.join(root, 'note.txt'), 'hello');
  fs.writeFileSync(path.join(root, 'page.html'), '<script>window.bad=true</script>');
  fs.writeFileSync(path.join(root, '.env'), 'secret');
  fs.symlinkSync(outside, path.join(root, 'escape'), 'junction');
  const { service, base } = await createWorkspaceService(root);
  t.after(async () => {
    await service.close();
    fs.rmSync(root, { recursive: true, force: true });
    fs.rmSync(outside, { recursive: true, force: true });
  });

  const get = (suffix) => fetch(`${base}${suffix}`);
  const json = (method, suffix, body) => fetch(`${base}${suffix}`, {
    method,
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });

  const listing = await get('/api/workspace/tree?path=.');
  assert.equal(listing.status, 200);
  const listingBody = await listing.json();
  assert.deepEqual(listingBody.entries.map((entry) => entry.name), ['docs', 'note.txt', 'page.html']);
  assert.equal(JSON.stringify(listingBody).includes(root), false);

  const content = await get('/api/workspace/content?path=note.txt');
  assert.equal(content.status, 200);
  assert.equal(await content.text(), 'hello');
  const download = await get('/api/workspace/content?path=note.txt&download=1');
  assert.equal(download.status, 200);
  assert.match(download.headers.get('content-disposition'), /attachment/);
  const html = await get('/api/workspace/content?path=page.html');
  assert.equal(html.headers.get('content-security-policy'), 'sandbox');

  assert.equal((await json('POST', '/api/workspace/folders', { path: '.', name: 'new-folder' })).status, 201);
  assert.equal((await json('PATCH', '/api/workspace/entries', { path: 'note.txt', name: 'renamed.txt' })).status, 200);
  assert.equal((await json('PATCH', '/api/workspace/entries', { path: 'renamed.txt', name: 'new-folder' })).status, 409);
  assert.equal((await fetch(`${base}/api/workspace/entries?path=renamed.txt`, { method: 'DELETE' })).status, 200);
  assert.equal((await fetch(`${base}/api/workspace/entries?path=new-folder`, { method: 'DELETE' })).status, 200);
  assert.equal((await fetch(`${base}/api/workspace/entries?path=docs`, { method: 'DELETE' })).status, 409);

  for (const suffix of [
    '/api/workspace/tree?path=..',
    `/api/workspace/tree?path=${encodeURIComponent(root)}`,
    '/api/workspace/content?path=docs',
    '/api/workspace/content?path=escape',
  ]) {
    const response = await get(suffix);
    assert.equal(response.status, 400);
  }
  assert.equal((await get('/api/workspace/content?path=missing.txt')).status, 404);
  assert.equal((await json('POST', '/api/workspace/folders', { path: '.', name: 'bad/name' })).status, 400);
});

test('uploads files by stream, reports renamed collisions, and rejects oversized files', async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'lan-terminal-workspace-upload-'));
  const { service, base } = await createWorkspaceService(root, 8);
  t.after(async () => {
    await service.close();
    fs.rmSync(root, { recursive: true, force: true });
  });

  const upload = async (name, data) => {
    const form = new FormData();
    form.append('path', '.');
    form.append('file', new Blob([data], { type: 'text/plain' }), name);
    return fetch(`${base}/api/workspace/upload`, { method: 'POST', body: form });
  };

  const first = await upload('report.txt', '1234');
  assert.equal(first.status, 201);
  assert.deepEqual((await first.json()).files, [{ originalName: 'report.txt', name: 'report.txt', status: 'uploaded' }]);
  const second = await upload('report.txt', '5678');
  assert.equal(second.status, 201);
  assert.deepEqual((await second.json()).files, [{ originalName: 'report.txt', name: 'report_1.txt', status: 'renamed' }]);
  assert.equal(fs.readFileSync(path.join(root, 'report_1.txt'), 'utf8'), '5678');

  const oversized = await upload('large.txt', '123456789');
  assert.equal(oversized.status, 413);
  assert.equal(fs.existsSync(path.join(root, 'large.txt')), false);
});

test('serves browser preview bundles and keeps workspace paths relative', async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'lan-terminal-workspace-assets-'));
  const { service, base } = await createWorkspaceService(root);
  t.after(async () => { await service.close(); fs.rmSync(root, { recursive: true, force: true }); });
  const tree = await fetch(`${base}/api/workspace/tree?path=.`);
  assert.equal(tree.status, 200);
  assert.equal((await tree.text()).includes(root), false);
  assert.equal((await fetch(`${base}/vendor/mammoth/mammoth.browser.min.js`)).status, 200);
  assert.equal((await fetch(`${base}/vendor/xlsx/xlsx.full.min.js`)).status, 200);
});
