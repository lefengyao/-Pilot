import assert from 'node:assert/strict';
import { once } from 'node:events';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { WebSocket } from 'ws';
import { createLanTerminalServer } from '../server/app.js';

function fakePty() { const data = []; const exits = []; return { pid: 9001, onData(handler) { data.push(handler); }, onExit(handler) { exits.push(handler); }, write(value) { data.forEach((handler) => handler(`echo:${value}`)); }, resize() {}, kill() { exits.forEach((handler) => handler({ exitCode: 0 })); } }; }
const next = (socket) => once(socket, 'message').then(([data]) => JSON.parse(data.toString()));

test('creates, routes, and restores an owned session', async (t) => {
  const service = createLanTerminalServer({ config: { host: '127.0.0.1', port: 0, allowedRoot: process.cwd(), maxSessionsPerClient: 8, maxSessionsTotal: 8, maxMessageBytes: 65536, maxHistoryBytes: 1024, outputBatchMs: 0 }, ptyFactory: fakePty, resolveCwd: () => process.cwd() });
  await service.listen(); t.after(() => service.close()); const port = service.server.address().port;
  const socket = new WebSocket(`ws://127.0.0.1:${port}/ws`); await once(socket, 'open'); socket.send(JSON.stringify({ type: 'hello', payload: { clientId: 'browser-a', sessionIds: [] } })); socket.send(JSON.stringify({ type: 'create', payload: { shell: 'cmd', label: '', cwd: '.', cols: 80, rows: 24 } }));
  const status = await next(socket); assert.equal(status.type, 'status'); assert.equal(status.payload.state, 'running');
  socket.send(JSON.stringify({ type: 'input', sessionId: status.sessionId, payload: { data: 'dir\r' } })); assert.deepEqual(await next(socket), { type: 'output', sessionId: status.sessionId, payload: { data: 'echo:dir\r' } });
  socket.close(); await once(socket, 'close'); const restored = new WebSocket(`ws://127.0.0.1:${port}/ws`); await once(restored, 'open'); const restoredMessages = []; const restoredDone = new Promise((resolve) => restored.on('message', (data) => { restoredMessages.push(JSON.parse(data.toString())); if (restoredMessages.length === 2) resolve(); })); restored.send(JSON.stringify({ type: 'hello', payload: { clientId: 'browser-a', sessionIds: [status.sessionId] } })); await restoredDone; assert.equal(restoredMessages[0].sessionId, status.sessionId); assert.deepEqual(restoredMessages[1], { type: 'output', sessionId: status.sessionId, payload: { data: 'echo:dir\r', replay: true } }); restored.close(); await once(restored, 'close');
});

test('allows an administrator token to create a session outside the ordinary root', async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'lan-terminal-ws-admin-'));
  const workspace = path.join(root, 'terminal-workspace');
  const outside = path.join(root, 'outside');
  fs.mkdirSync(workspace);
  fs.mkdirSync(outside);
  const adminKey = 'admin-key-'.padEnd(40, 'x');
  const ptyOptions = [];
  function capturePty(_file, _args, options) {
    ptyOptions.push(options);
    return { pid: 9002, onData() {}, onExit() {}, write() {}, resize() {}, kill() {} };
  }
  const service = createLanTerminalServer({
    config: { host: '127.0.0.1', port: 0, allowedRoot: workspace, adminKey, maxSessionsPerClient: 8, maxSessionsTotal: 8, maxMessageBytes: 65536, maxHistoryBytes: 1024, outputBatchMs: 0 },
    ptyFactory: capturePty,
  });
  await service.listen();
  t.after(async () => { await service.close(); fs.rmSync(root, { recursive: true, force: true }); });
  const port = service.server.address().port;
  const unlock = await fetch(`http://127.0.0.1:${port}/api/admin/unlock`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ key: adminKey, clientId: 'admin-browser' }) });
  const grant = await unlock.json();
  const socket = new WebSocket(`ws://127.0.0.1:${port}/ws`);
  await once(socket, 'open');
  socket.send(JSON.stringify({ type: 'hello', payload: { clientId: 'admin-browser', sessionIds: [] } }));
  socket.send(JSON.stringify({ type: 'create', payload: { shell: 'cmd', cwd: outside, adminToken: grant.token, cols: 80, rows: 24 } }));
  const status = await next(socket);
  assert.equal(status.type, 'status');
  assert.equal(status.payload.cwd, fs.realpathSync(outside));
  assert.equal(ptyOptions[0].cwd, fs.realpathSync(outside));
  socket.close();
  await once(socket, 'close');
});

test('rejects an ordinary session that requests an absolute directory outside the root', async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'lan-terminal-ws-ordinary-'));
  const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'lan-terminal-ws-outside-'));
  fs.mkdirSync(path.join(root, 'terminal-workspace'));
  const service = createLanTerminalServer({
    config: { host: '127.0.0.1', port: 0, allowedRoot: path.join(root, 'terminal-workspace'), maxSessionsPerClient: 8, maxSessionsTotal: 8, maxMessageBytes: 65536, maxHistoryBytes: 1024, outputBatchMs: 0 },
    ptyFactory: fakePty,
  });
  await service.listen();
  t.after(async () => { await service.close(); fs.rmSync(root, { recursive: true, force: true }); fs.rmSync(outside, { recursive: true, force: true }); });
  const socket = new WebSocket(`ws://127.0.0.1:${service.server.address().port}/ws`);
  await once(socket, 'open');
  socket.send(JSON.stringify({ type: 'hello', payload: { clientId: 'ordinary-browser', sessionIds: [] } }));
  socket.send(JSON.stringify({ type: 'create', payload: { shell: 'cmd', cwd: outside, cols: 80, rows: 24 } }));
  const error = await next(socket);
  assert.equal(error.type, 'error');
  assert.match(error.payload.message, /允许目录|工作目录/);
  socket.close();
  await once(socket, 'close');
});

test('deletes an exited session and notifies the browser', async (t) => {
  const service = createLanTerminalServer({ config: { host: '127.0.0.1', port: 0, allowedRoot: process.cwd(), maxSessionsPerClient: 8, maxSessionsTotal: 8, maxMessageBytes: 65536, maxHistoryBytes: 1024, outputBatchMs: 0 }, ptyFactory: fakePty, resolveCwd: () => process.cwd() });
  await service.listen(); t.after(() => service.close());
  const socket = new WebSocket(`ws://127.0.0.1:${service.server.address().port}/ws`); await once(socket, 'open');
  socket.send(JSON.stringify({ type: 'hello', payload: { clientId: 'browser-delete', sessionIds: [] } }));
  socket.send(JSON.stringify({ type: 'create', payload: { shell: 'cmd', cwd: '.', cols: 80, rows: 24 } }));
  const status = await next(socket);
  socket.send(JSON.stringify({ type: 'stop', sessionId: status.sessionId, payload: {} }));
  const stopping = await next(socket); assert.equal(stopping.payload.state, 'stopping');
  const stopped = await next(socket); assert.equal(stopped.payload.state, 'exited');
  socket.send(JSON.stringify({ type: 'delete', sessionId: status.sessionId, payload: {} }));
  assert.deepEqual(await next(socket), { type: 'deleted', sessionId: status.sessionId, payload: {} });
  socket.close(); await once(socket, 'close');
});
