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

function fakePty() {
  return { pid: 1, onData() {}, onExit() {}, write() {}, resize() {}, kill() {} };
}

async function freePort() {
  const server = net.createServer();
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address();
  await new Promise((resolve) => server.close(resolve));
  return port;
}

async function waitFor(check, message) {
  for (let attempt = 0; attempt < 80; attempt += 1) {
    if (await check()) return;
    await delay(100);
  }
  throw new Error(message);
}

async function openPage(url) {
  assert.ok(fs.existsSync(edgePath), 'Microsoft Edge must be installed for browser UI tests.');
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'lan-terminal-browser-'));
  const port = await freePort();
  const browser = spawn(edgePath, [
    '--headless=new', '--disable-gpu', '--no-first-run', '--remote-allow-origins=*',
    `--remote-debugging-port=${port}`, `--user-data-dir=${profile}`, 'about:blank',
  ], { stdio: 'ignore' });

  try {
    let endpoint;
    await waitFor(async () => {
      try {
        endpoint = await (await fetch(`http://127.0.0.1:${port}/json/version`)).json();
        return true;
      } catch {
        return false;
      }
    }, 'Edge DevTools endpoint did not start.');

    const socket = new WebSocket(endpoint.webSocketDebuggerUrl);
    await new Promise((resolve, reject) => { socket.once('open', resolve); socket.once('error', reject); });
    const pending = new Map();
    let messageId = 0;
    socket.on('message', (raw) => {
      const message = JSON.parse(raw.toString());
      const waiter = pending.get(message.id);
      if (!waiter) return;
      pending.delete(message.id);
      if (message.error) waiter.reject(new Error(message.error.message));
      else waiter.resolve(message.result);
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
    await waitFor(
      () => evaluate(`document.getElementById('connection-banner').textContent === '已连接到 LAN Terminal 服务'`),
      'Terminal workspace did not finish initialization.',
    );
    return { evaluate, async close() { socket.close(); browser.kill(); await delay(500); try { fs.rmSync(profile, { recursive: true, force: true, maxRetries: 8, retryDelay: 250 }); } catch { /* Edge may still hold a lock briefly. */ } } };
  } catch (error) {
    browser.kill();
    await delay(250);
    try { fs.rmSync(profile, { recursive: true, force: true, maxRetries: 8, retryDelay: 250 }); } catch { /* ignore cleanup race */ }
    throw error;
  }
}

test('selects a relative initial directory entirely in the web dialog', { timeout: 20000 }, async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'lan-terminal-picker-'));
  fs.mkdirSync(path.join(root, 'projects', 'demo'), { recursive: true });
  const service = createLanTerminalServer({
    config: { host: '127.0.0.1', port: 0, allowedRoot: root, maxSessionsPerClient: 8, maxSessionsTotal: 8, maxMessageBytes: 65536, maxHistoryBytes: 1024, outputBatchMs: 0 },
    ptyFactory: fakePty,
  });
  t.after(async () => { await service.close(); fs.rmSync(root, { recursive: true, force: true }); });
  await service.listen();
  const page = await openPage(`http://127.0.0.1:${service.server.address().port}`);
  t.after(() => page.close());

  await page.evaluate(`document.getElementById('show-create').click()`);
  await page.evaluate(`document.getElementById('choose-directory').click()`);
  await waitFor(
    () => page.evaluate(`document.getElementById('directory-dialog').open && document.getElementById('directory-list').textContent.includes('projects')`),
    'Directory picker did not load the allowed root.',
  );
  await page.evaluate(`([...document.querySelectorAll('#directory-list button')].find((button) => button.textContent === 'projects')).click()`);
  await waitFor(
    () => page.evaluate(`document.getElementById('directory-path').textContent === '允许目录 / projects'`),
    'Directory picker did not enter the selected child directory.',
  );
  await page.evaluate(`document.getElementById('directory-up').click()`);
  await waitFor(
    () => page.evaluate(`document.getElementById('directory-path').textContent === '允许目录'`),
    'Directory picker did not return to the allowed root.',
  );
  await page.evaluate(`([...document.querySelectorAll('#directory-list button')].find((button) => button.textContent === 'projects')).click()`);
  await waitFor(
    () => page.evaluate(`document.getElementById('directory-path').textContent === '允许目录 / projects'`),
    'Directory picker did not re-enter the selected child directory.',
  );
  await page.evaluate(`document.getElementById('confirm-directory').click()`);
  assert.equal(await page.evaluate(`document.querySelector('#create-form [name="cwd"]').value`), 'projects');
  assert.equal(await page.evaluate(`document.getElementById('selected-directory').textContent`), '允许目录 / projects');
  assert.equal(await page.evaluate(`document.body.textContent.includes(${JSON.stringify(root)})`), false);
});

test('unlocks administrator mode and browses outside the ordinary root', { timeout: 20000 }, async (t) => {
  const parent = fs.mkdtempSync(path.join(os.tmpdir(), 'lan-terminal-admin-picker-'));
  const root = path.join(parent, 'terminal-workspace');
  const outside = path.join(parent, 'outside');
  fs.mkdirSync(root);
  fs.mkdirSync(outside);
  const adminKey = 'admin-key-'.padEnd(40, 'x');
  const service = createLanTerminalServer({
    config: { host: '127.0.0.1', port: 0, allowedRoot: root, adminKey, maxSessionsPerClient: 8, maxSessionsTotal: 8, maxMessageBytes: 65536, maxHistoryBytes: 1024, outputBatchMs: 0 },
    ptyFactory: fakePty,
  });
  t.after(async () => { await service.close(); fs.rmSync(parent, { recursive: true, force: true }); });
  await service.listen();
  const page = await openPage(`http://127.0.0.1:${service.server.address().port}`);
  t.after(() => page.close());

  await page.evaluate(`document.getElementById('show-create').click()`);
  await page.evaluate(`document.getElementById('unlock-admin').click()`);
  await waitFor(
    () => page.evaluate(`document.getElementById('admin-dialog').open`),
    'Administrator dialog did not open.',
  );
  await page.evaluate(`document.getElementById('admin-key').value = ${JSON.stringify(adminKey)}; document.getElementById('confirm-admin').click()`);
  await waitFor(
    () => page.evaluate(`document.getElementById('admin-dialog').open === false && document.getElementById('admin-status').textContent.includes('已解锁')`),
    'Administrator unlock did not complete.',
  );
  await page.evaluate(`document.getElementById('choose-directory').click()`);
  await waitFor(
    () => page.evaluate(`document.getElementById('directory-dialog').open && document.getElementById('directory-path').textContent.includes('terminal-workspace')`),
    'Administrator directory picker did not start at the ordinary root.',
  );
  await page.evaluate(`document.getElementById('directory-up').click()`);
  await waitFor(
    () => page.evaluate(`([...document.querySelectorAll('#directory-list button')].some((button) => button.textContent === 'outside'))`),
    'Administrator picker did not browse to the parent directory.',
  );
  await page.evaluate(`([...document.querySelectorAll('#directory-list button')].find((button) => button.textContent === 'outside')).click()`);
  await waitFor(
    () => page.evaluate(`document.getElementById('directory-path').textContent.endsWith('outside')`),
    'Administrator picker did not enter the unrestricted directory.',
  );
  await page.evaluate(`document.getElementById('confirm-directory').click()`);
  assert.equal(await page.evaluate(`document.querySelector('#create-form [name="cwd"]').value`), fs.realpathSync(outside));
  assert.equal(await page.evaluate(`document.getElementById('selected-directory').textContent.endsWith('outside')`), true);
});
