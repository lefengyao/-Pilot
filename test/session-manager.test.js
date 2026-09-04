import assert from 'node:assert/strict';
import test from 'node:test';
import { SessionManager } from '../server/session-manager.js';

function fakePty() { const exits = []; return { pid: 9001, onData() {}, onExit(handler) { exits.push(handler); }, write() {}, resize() {}, kill() { exits.forEach((handler) => handler({ exitCode: 0 })); } }; }
function manager(overrides = {}) { return new SessionManager({ allowedRoot: process.cwd(), maxSessionsPerClient: 2, maxSessionsTotal: 3, maxHistoryBytes: 1024, ptyFactory: () => fakePty(), resolveCwd: () => process.cwd(), ...overrides }); }

test('enforces per-browser session quota and restores owned sessions', () => { const instance = manager(); const first = instance.create('browser-a', { shell: 'cmd', label: '', cwd: '.', cols: 80, rows: 24 }); const second = instance.create('browser-a', { shell: 'powershell', label: '', cwd: '.', cols: 80, rows: 24 }); assert.equal(instance.restore('browser-a', [first.id, second.id]).length, 2); assert.throws(() => instance.create('browser-a', { shell: 'cmd', label: '', cwd: '.', cols: 80, rows: 24 }), /上限/); });
test('hides another owner session and shuts down every process', async () => { const instance = manager(); const session = instance.create('browser-a', { shell: 'cmd', label: '', cwd: '.', cols: 80, rows: 24 }); assert.equal(instance.getOwned('browser-b', session.id), null); await instance.shutdown(); assert.equal(session.state, 'exited'); assert.throws(() => instance.create('browser-a', { shell: 'cmd', label: '', cwd: '.', cols: 80, rows: 24 }), /正在关闭/); });

test('deletes an owned exited session and rejects running sessions', async () => {
  const instance = manager();
  const session = instance.create('browser-a', { shell: 'cmd', label: '', cwd: '.', cols: 80, rows: 24 });
  assert.throws(() => instance.delete('browser-a', session.id), /先结束/);
  await session.stop();
  assert.equal(instance.delete('browser-a', session.id), true);
  assert.equal(instance.getOwned('browser-a', session.id), null);
  assert.throws(() => instance.delete('browser-a', session.id), /会话不存在/);
});
