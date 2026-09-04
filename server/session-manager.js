import { randomUUID } from 'node:crypto';
import { EventEmitter } from 'node:events';
import { resolveWorkingDirectory } from './config.js';
import { resolveAnyDirectory } from './directory-browser.js';
import { TerminalSession } from './terminal-session.js';

export class SessionManager extends EventEmitter {
  constructor({ allowedRoot, maxSessionsPerClient, maxSessionsTotal, maxHistoryBytes, ptyFactory, resolveCwd = resolveWorkingDirectory, resolveAdminCwd = resolveAnyDirectory }) {
    super(); this.allowedRoot = allowedRoot; this.maxSessionsPerClient = maxSessionsPerClient; this.maxSessionsTotal = maxSessionsTotal; this.maxHistoryBytes = maxHistoryBytes; this.ptyFactory = ptyFactory; this.resolveCwd = resolveCwd; this.resolveAdminCwd = resolveAdminCwd; this.sessions = new Map(); this.accepting = true;
  }
  create(ownerClientId, request) {
    if (!this.accepting) throw new Error('服务正在关闭，不能创建会话。');
    if (this.sessions.size >= this.maxSessionsTotal) throw new Error('服务器会话数量已到上限。');
    if ([...this.sessions.values()].filter((session) => session.ownerClientId === ownerClientId).length >= this.maxSessionsPerClient) throw new Error('此浏览器的会话数量已到上限。');
    const cwd = request.admin ? this.resolveAdminCwd(request.cwd) : this.resolveCwd(this.allowedRoot, request.cwd);
    const session = new TerminalSession({ id: randomUUID(), ownerClientId, shell: request.shell, label: request.label, cwd, cols: request.cols, rows: request.rows, maxHistoryBytes: this.maxHistoryBytes, ptyFactory: this.ptyFactory });
    this.sessions.set(session.id, session); session.on('output', (data) => this.emit('output', session, data)); session.on('status', () => this.emit('status', session));
    try { session.start(); } catch (error) { this.sessions.delete(session.id); throw error; }
    return session;
  }
  getOwned(ownerClientId, sessionId) { const session = this.sessions.get(sessionId); return session?.ownerClientId === ownerClientId ? session : null; }
  requireOwned(ownerClientId, sessionId) { const session = this.getOwned(ownerClientId, sessionId); if (!session) throw new Error('会话不存在或不属于当前浏览器。'); return session; }
  delete(ownerClientId, sessionId) { const session = this.requireOwned(ownerClientId, sessionId); if (session.state !== 'exited') throw new Error('请先结束终端进程，再删除会话。'); this.sessions.delete(sessionId); return true; }
  restore(ownerClientId, sessionIds) { return sessionIds.map((id) => this.getOwned(ownerClientId, id)).filter(Boolean); }
  async shutdown() { this.accepting = false; await Promise.allSettled([...this.sessions.values()].map((session) => session.stop())); }
}
