import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { WebSocket } from 'ws';
import { createLanTerminalServer } from '../server/app.js';

const edgePath = 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe';
const delay = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds));

function fakePty() { return { pid: 1, onData() {}, onExit() {}, write() {}, resize() {}, kill() {} }; }

async function freePort() {
  const server = net.createServer();
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = server.address().port;
  await new Promise((resolve) => server.close(resolve));
  return port;
}

async function openPage(url) {
  assert.ok(fs.existsSync(edgePath), 'Microsoft Edge must be installed for browser UI tests.');
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'lan-terminal-file-browser-'));
  const port = await freePort();
  const browser = spawn(edgePath, ['--headless=new', '--disable-gpu', '--no-first-run', '--remote-allow-origins=*', `--remote-debugging-port=${port}`, `--user-data-dir=${profile}`, 'about:blank'], { stdio: 'ignore' });
  try {
    let endpoint;
    for (let attempt = 0; attempt < 80; attempt += 1) {
      try { endpoint = await (await fetch(`http://127.0.0.1:${port}/json/version`)).json(); break; } catch { await delay(100); }
    }
    assert.ok(endpoint, 'Edge DevTools endpoint did not start.');
    const socket = new WebSocket(endpoint.webSocketDebuggerUrl);
    await new Promise((resolve, reject) => { socket.once('open', resolve); socket.once('error', reject); });
    const pending = new Map();
    let messageId = 0;
    socket.on('message', (raw) => {
      const message = JSON.parse(raw.toString());
      const waiter = pending.get(message.id);
      if (!waiter) return;
      pending.delete(message.id);
      if (message.error) waiter.reject(new Error(message.error.message)); else waiter.resolve(message.result);
    });
    const call = (method, params = {}, sessionId) => new Promise((resolve, reject) => {
      const id = ++messageId;
      pending.set(id, { resolve, reject });
      socket.send(JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) }));
    });
    const { targetId } = await call('Target.createTarget', { url: 'about:blank' });
    const { sessionId } = await call('Target.attachToTarget', { targetId, flatten: true });
    await call('Page.enable', {}, sessionId);
    await call('Page.navigate', { url }, sessionId);
    const evaluate = async (expression) => {
      const result = await call('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true }, sessionId);
      if (result.exceptionDetails) throw new Error(result.exceptionDetails.text);
      return result.result.value;
    };
    for (let attempt = 0; attempt < 80; attempt += 1) {
      if (await evaluate(`document.getElementById('connection-banner')?.textContent.includes('已连接')`)) return {
        evaluate,
        close: async () => {
          socket.close();
          browser.kill();
          await delay(500);
          try { fs.rmSync(profile, { recursive: true, force: true, maxRetries: 8, retryDelay: 250 }); } catch { /* Edge may still hold a lock; OS cleanup can finish later. */ }
        },
      };
      await delay(100);
    }
    throw new Error('Terminal workspace did not finish initialization.');
  } catch (error) {
    browser.kill();
    await delay(500);
    try { fs.rmSync(profile, { recursive: true, force: true, maxRetries: 8, retryDelay: 250 }); } catch { /* ignore cleanup race */ }
    throw error;
  }
}

async function waitFor(page, expression, message) {
  for (let attempt = 0; attempt < 80; attempt += 1) {
    if (await page.evaluate(expression)) return;
    await delay(100);
  }
  assert.fail(message);
}

test('opens the file workspace as a separate page and previews a text file', { timeout: 30000 }, async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'lan-terminal-file-ui-'));
  fs.mkdirSync(path.join(root, 'docs'));
  fs.writeFileSync(path.join(root, 'docs', 'readme.txt'), 'hello from workspace');
  const service = createLanTerminalServer({
    config: { host: '127.0.0.1', port: 0, allowedRoot: root, maxUploadBytes: 1024 * 1024, maxSessionsPerClient: 8, maxSessionsTotal: 8, maxMessageBytes: 65536, maxHistoryBytes: 1024, outputBatchMs: 0 },
    ptyFactory: fakePty,
  });
  t.after(async () => { await service.close(); fs.rmSync(root, { recursive: true, force: true }); });
  await service.listen();
  const page = await openPage(`http://127.0.0.1:${service.server.address().port}`);
  t.after(() => page.close());

  await page.evaluate(`document.getElementById('show-files').click()`);
  await waitFor(page, `location.pathname === '/files.html' && document.getElementById('file-list')?.textContent.includes('docs')`, 'File workspace page did not load.');
  assert.equal(await page.evaluate(`location.pathname`), '/files.html');
  assert.equal(await page.evaluate(`document.getElementById('file-list').textContent.includes('docs')`), true);
  await page.evaluate(`([...document.querySelectorAll('#file-list .file-open')].find((button) => button.textContent.includes('docs'))).click()`);
  await waitFor(page, `document.getElementById('file-list')?.textContent.includes('readme.txt')`, 'Child folder contents did not load.');
  await page.evaluate(`([...document.querySelectorAll('#file-list .file-open')].find((button) => button.textContent.includes('readme.txt'))).click()`);
  await waitFor(page, `document.getElementById('file-preview')?.textContent.includes('hello from workspace')`, 'Text preview did not load.');
  assert.equal(await page.evaluate(`document.getElementById('file-preview').textContent.includes('hello from workspace')`), true);
  await page.evaluate(`document.getElementById('back-terminal').click()`);
  await waitFor(page, `location.pathname === '/' && Boolean(document.getElementById('terminal-host'))`, 'Terminal page did not load after returning.');
});

test('shows a mobile preview drawer with a close control', { timeout: 30000 }, async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'lan-terminal-file-mobile-'));
  fs.writeFileSync(path.join(root, 'note.txt'), 'mobile preview');
  const service = createLanTerminalServer({
    config: { host: '127.0.0.1', port: 0, allowedRoot: root, maxUploadBytes: 1024 * 1024, maxSessionsPerClient: 8, maxSessionsTotal: 8, maxMessageBytes: 65536, maxHistoryBytes: 1024, outputBatchMs: 0 },
    ptyFactory: fakePty,
  });
  t.after(async () => { await service.close(); fs.rmSync(root, { recursive: true, force: true }); });
  await service.listen();
  const page = await openPage(`http://127.0.0.1:${service.server.address().port}`);
  t.after(() => page.close());
  await page.evaluate(`document.getElementById('show-files').click()`);
  await waitFor(page, `location.pathname === '/files.html' && document.getElementById('file-list')?.textContent.includes('note.txt')`, 'File workspace page did not load.');
  await page.evaluate(`([...document.querySelectorAll('#file-list .file-open')].find((button) => button.textContent.includes('note.txt'))).click()`);
  await waitFor(page, `document.getElementById('file-preview')?.textContent.includes('mobile preview')`, 'Text preview did not load.');
  assert.equal(await page.evaluate(`getComputedStyle(document.getElementById('file-preview')).transform !== 'none'`), true);
  assert.equal(await page.evaluate(`Boolean(document.getElementById('file-preview-close'))`), true);
});

test('opens the mobile directory drawer from a visible toggle', { timeout: 30000 }, async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'lan-terminal-file-tree-mobile-'));
  fs.mkdirSync(path.join(root, 'docs'));
  const service = createLanTerminalServer({
    config: { host: '127.0.0.1', port: 0, allowedRoot: root, maxUploadBytes: 1024 * 1024, maxSessionsPerClient: 8, maxSessionsTotal: 8, maxMessageBytes: 65536, maxHistoryBytes: 1024, outputBatchMs: 0 },
    ptyFactory: fakePty,
  });
  t.after(async () => { await service.close(); fs.rmSync(root, { recursive: true, force: true }); });
  await service.listen();
  const page = await openPage(`http://127.0.0.1:${service.server.address().port}`);
  t.after(() => page.close());
  await page.evaluate(`document.getElementById('show-files').click()`);
  await waitFor(page, `location.pathname === '/files.html' && document.getElementById('file-list')?.textContent.includes('docs')`, 'File workspace page did not load.');
  assert.equal(await page.evaluate(`Boolean(document.getElementById('file-tree-toggle'))`), true);
  await page.evaluate(`document.getElementById('file-tree-toggle').click()`);
  assert.equal(await page.evaluate(`document.getElementById('file-tree').classList.contains('open')`), true);
});
