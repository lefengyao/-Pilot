import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { createLanTerminalServer } from '../server/app.js';

function fakePty() {
  return { pid: 1, onData() {}, onExit() {}, write() {}, resize() {}, kill() {} };
}

test('serves relative allowed-root directory listings and rejects traversal', async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'lan-terminal-directory-api-'));
  fs.mkdirSync(path.join(root, 'projects', 'demo'), { recursive: true });
  const service = createLanTerminalServer({
    config: {
      host: '127.0.0.1',
      port: 0,
      allowedRoot: root,
      maxSessionsPerClient: 8,
      maxSessionsTotal: 8,
      maxMessageBytes: 65536,
      maxHistoryBytes: 1024,
      outputBatchMs: 0,
    },
    ptyFactory: fakePty,
  });

  t.after(async () => {
    await service.close();
    fs.rmSync(root, { recursive: true, force: true });
  });
  await service.listen();
  const base = `http://127.0.0.1:${service.server.address().port}`;

  const rootResponse = await fetch(`${base}/api/directories?path=.`);
  assert.equal(rootResponse.status, 200);
  assert.deepEqual(await rootResponse.json(), {
    path: '.',
    parent: null,
    directories: [{ name: 'projects', path: 'projects' }],
  });

  const invalidResponse = await fetch(`${base}/api/directories?path=..`);
  assert.equal(invalidResponse.status, 400);
  assert.match((await invalidResponse.json()).error, /允许目录/);
});

test('requires a client-bound administrator token for unrestricted directory listings', async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'lan-terminal-admin-api-'));
  const workspace = path.join(root, 'terminal-workspace');
  const other = path.join(root, 'other');
  fs.mkdirSync(workspace);
  fs.mkdirSync(other);
  fs.mkdirSync(path.join(other, 'nested'));
  const adminKey = 'admin-key-'.padEnd(40, 'x');
  const service = createLanTerminalServer({
    config: {
      host: '127.0.0.1',
      port: 0,
      allowedRoot: workspace,
      adminKey,
      maxSessionsPerClient: 8,
      maxSessionsTotal: 8,
      maxMessageBytes: 65536,
      maxHistoryBytes: 1024,
      outputBatchMs: 0,
    },
    ptyFactory: fakePty,
  });

  t.after(async () => {
    await service.close();
    fs.rmSync(root, { recursive: true, force: true });
  });
  await service.listen();
  const base = `http://127.0.0.1:${service.server.address().port}`;
  const clientId = 'browser-admin';

  const ordinary = await fetch(`${base}/api/directories?path=${encodeURIComponent(root)}`);
  assert.equal(ordinary.status, 400);

  const unlock = await fetch(`${base}/api/admin/unlock`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ key: adminKey, clientId }),
  });
  assert.equal(unlock.status, 200);
  const grant = await unlock.json();
  assert.match(grant.token, /^[A-Za-z0-9_-]{32,}$/);

  const admin = await fetch(`${base}/api/directories?path=${encodeURIComponent(root)}`, {
    headers: { 'X-Admin-Token': grant.token, 'X-Client-ID': clientId },
  });
  assert.equal(admin.status, 200);
  assert.deepEqual((await admin.json()).directories.map((item) => item.name), ['other', 'terminal-workspace']);

  const wrongClient = await fetch(`${base}/api/directories?path=${encodeURIComponent(root)}`, {
    headers: { 'X-Admin-Token': grant.token, 'X-Client-ID': 'another-browser' },
  });
  assert.equal(wrongClient.status, 401);
});
