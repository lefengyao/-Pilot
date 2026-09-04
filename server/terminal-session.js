import { EventEmitter } from 'node:events';
import { execFile } from 'node:child_process';
import { TextRingBuffer } from './text-ring-buffer.js';

const DEFINITIONS = { powershell: ['powershell.exe', ['-NoLogo']], cmd: ['cmd.exe', []] };

function terminateProcessTree(pid) {
  return new Promise((resolve, reject) => {
    execFile('taskkill.exe', ['/pid', String(pid), '/t', '/f'], { windowsHide: true }, (error) => {
      if (error) reject(error);
      else resolve();
    });
  });
}

export class TerminalSession extends EventEmitter {
  constructor({ id, ownerClientId, shell, label = '', cwd, cols, rows, maxHistoryBytes, ptyFactory, terminateTree = terminateProcessTree }) {
    super(); this.id = id; this.ownerClientId = ownerClientId; this.shell = shell; this.label = label; this.cwd = cwd;
    this.cols = cols; this.rows = rows; this.maxHistoryBytes = maxHistoryBytes; this.ptyFactory = ptyFactory; this.terminateTree = terminateTree;
    this.outputHistory = new TextRingBuffer(maxHistoryBytes); this.createdAt = new Date().toISOString();
    this.state = 'created'; this.pid = null; this.exitCode = null; this.pty = null; this.resolveStop = null; this.stopTimer = null;
  }

  start() {
    if (this.state === 'running' || this.state === 'stopping') throw new Error('终端已在运行。');
    const definition = DEFINITIONS[this.shell]; if (!definition) throw new Error('不支持的终端类型。');
    try {
      const pty = this.ptyFactory(definition[0], definition[1], { name: 'xterm-256color', cwd: this.cwd, cols: this.cols, rows: this.rows, env: process.env, useConpty: false });
      this.pty = pty; this.pid = pty.pid; this.exitCode = null;
      pty.onData((data) => { this.outputHistory.append(data); this.emit('output', data); });
      pty.onExit(({ exitCode }) => this.#didExit(exitCode));
      this.state = 'running'; this.emit('status', this.snapshot()); return this.snapshot();
    } catch (error) { this.state = 'error'; this.emit('status', this.snapshot()); throw error; }
  }

  write(data) { if (this.state !== 'running' || !this.pty) throw new Error('终端未运行，不能写入输入。'); this.pty.write(data); }
  resize(cols, rows) { this.cols = cols; this.rows = rows; if (this.state === 'running' && this.pty) this.pty.resize(cols, rows); }

  async stop() {
    if (this.state !== 'running' || !this.pty) return Promise.resolve(this.snapshot());
    this.state = 'stopping'; this.emit('status', this.snapshot());
    const promise = new Promise((resolve) => { this.resolveStop = resolve; });
    this.stopTimer = setTimeout(() => this.#didExit(null), 2000);
    const pty = this.pty; const pid = this.pid;
    try { await this.terminateTree(pid); } catch { /* Fall back to the PTY signal below. */ }
    if (this.state === 'stopping') {
      try { pty.kill(); } catch (error) { this.state = 'error'; this.emit('status', this.snapshot()); this.resolveStop?.(this.snapshot()); this.resolveStop = null; clearTimeout(this.stopTimer); this.stopTimer = null; }
    }
    return promise;
  }

  async restart() { await this.stop(); return this.start(); }
  history() { return this.outputHistory.toString(); }
  snapshot() { return { id: this.id, shell: this.shell, label: this.label, cwd: this.cwd, state: this.state, pid: this.pid, exitCode: this.exitCode, createdAt: this.createdAt }; }

  #didExit(exitCode) {
    this.pty = null; this.pid = null; this.exitCode = exitCode; this.state = 'exited'; if (this.stopTimer) { clearTimeout(this.stopTimer); this.stopTimer = null; } this.emit('status', this.snapshot());
    if (this.resolveStop) { this.resolveStop(this.snapshot()); this.resolveStop = null; }
  }
}
