import assert from 'node:assert/strict';
import test from 'node:test';
import { TerminalSession } from '../server/terminal-session.js';

class FakePty {
  constructor(pid = 4242) { this.pid = pid; this.writes = []; this.resizes = []; this.dataHandlers = []; this.exitHandlers = []; }
  onData(handler) { this.dataHandlers.push(handler); } onExit(handler) { this.exitHandlers.push(handler); }
  write(data) { this.writes.push(data); } resize(cols, rows) { this.resizes.push([cols, rows]); }
  kill() { this.exitHandlers.forEach((handler) => handler({ exitCode: 0 })); }
  emitData(data) { this.dataHandlers.forEach((handler) => handler(data)); }
}

test('starts a PowerShell PTY and relays output, input, and resize', () => {
  const pty = new FakePty(); const session = new TerminalSession({ id: 's1', ownerClientId: 'b1', shell: 'powershell', cwd: 'C:\\Work', cols: 100, rows: 30, maxHistoryBytes: 16, ptyFactory: (command, args, options) => { assert.equal(command, 'powershell.exe'); assert.deepEqual(args, ['-NoLogo']); assert.equal(options.cwd, 'C:\\Work'); return pty; } });
  const output = []; session.on('output', (data) => output.push(data)); session.start(); pty.emitData('hello'); session.write('dir\r'); session.resize(120, 40);
  assert.equal(session.snapshot().state, 'running'); assert.equal(session.snapshot().pid, 4242); assert.deepEqual(output, ['hello']); assert.equal(session.history(), 'hello'); assert.deepEqual(pty.writes, ['dir\r']); assert.deepEqual(pty.resizes, [[120, 40]]);
});

test('stops and restarts a session without accepting input while stopped', async () => {
  const ptys = [new FakePty(1), new FakePty(2)]; const session = new TerminalSession({ id: 's2', ownerClientId: 'b1', shell: 'cmd', cwd: 'C:\\Work', cols: 80, rows: 24, maxHistoryBytes: 1024, ptyFactory: () => ptys.shift(), terminateTree: async () => {} });
  session.start(); await session.stop(); assert.equal(session.snapshot().state, 'exited'); assert.throws(() => session.write('echo no'), /未运行/); await session.restart(); assert.equal(session.snapshot().state, 'running');
});

test('stopping a session terminates its complete process tree', async () => {
  const terminatedPids = [];
  const session = new TerminalSession({
    id: 's3', ownerClientId: 'b1', shell: 'powershell', cwd: 'C:\\Work', cols: 80, rows: 24, maxHistoryBytes: 1024,
    ptyFactory: () => new FakePty(3210),
    terminateTree: async (pid) => { terminatedPids.push(pid); },
  });

  session.start();
  await session.stop();

  assert.deepEqual(terminatedPids, [3210]);
  assert.equal(session.snapshot().state, 'exited');
});
