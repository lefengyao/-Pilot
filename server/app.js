import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import express from 'express';
import pty from 'node-pty';
import { loadConfig } from './config.js';
import { AdminAuth, AdminAuthError } from './admin-auth.js';
import { listAnyDirectories, listDirectories } from './directory-browser.js';
import { SessionManager } from './session-manager.js';
import { installWebSocketRouter } from './websocket-router.js';
import { createWorkspaceRouter } from './workspace-files.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export function createLanTerminalServer({ config = loadConfig(), ptyFactory = pty.spawn, resolveCwd, logger = console } = {}) {
  const adminAuth = new AdminAuth({ key: config.adminKey });
  const app = express();
  app.disable('x-powered-by');
  app.use(express.json({ limit: '4kb' }));
  app.get('/healthz', (_req, res) => res.json({ ok: true }));
  app.post('/api/admin/unlock', (req, res) => {
    const key = req.body?.key;
    const clientId = req.body?.clientId;
    if (typeof clientId !== 'string' || clientId.length === 0 || clientId.length > 128) {
      return res.status(400).json({ error: '客户端标识无效。' });
    }
    try {
      const grant = adminAuth.unlock(key, clientId, req.socket.remoteAddress || 'unknown');
      return res.json({ ...grant, root: config.allowedRoot });
    } catch (error) {
      if (error instanceof AdminAuthError) return res.status(error.status).json({ error: error.message });
      logger.error?.('Administrator unlock failed', error);
      return res.status(500).json({ error: '管理员解锁失败。' });
    }
  });
  app.get('/api/directories', (req, res) => {
    const requestedPath = typeof req.query.path === 'string' ? req.query.path : '.';
    const adminToken = req.get('X-Admin-Token');
    const clientId = req.get('X-Client-ID');
    try {
      if (adminToken || clientId) {
        if (!adminAuth.verify(adminToken, clientId)) return res.status(401).json({ error: '管理员解锁已失效。' });
        return res.json(listAnyDirectories(requestedPath === '.' ? config.allowedRoot : requestedPath));
      }
      return res.json(listDirectories(config.allowedRoot, requestedPath));
    } catch (error) {
      const message = error instanceof Error ? error.message : '无法读取目录。';
      if (/允许目录|工作目录|目录/.test(message)) {
        res.status(400).json({ error: message });
      } else {
        logger.error?.('Directory listing failed', error);
        res.status(500).json({ error: '无法读取目录。' });
      }
    }
  });
  app.use('/api/workspace', createWorkspaceRouter({
    root: config.allowedRoot,
    maxUploadBytes: config.maxUploadBytes,
    logger,
  }));
  app.use('/vendor/xterm', express.static(path.join(root, 'node_modules', '@xterm', 'xterm')));
  app.use('/vendor/xterm-fit', express.static(path.join(root, 'node_modules', '@xterm', 'addon-fit')));
  app.use('/vendor/mammoth', express.static(path.join(root, 'node_modules', 'mammoth')));
  app.use('/vendor/xlsx', express.static(path.join(root, 'node_modules', 'xlsx', 'dist')));
  app.use(express.static(path.join(root, 'public'), { extensions: ['html'] }));
  const manager = new SessionManager({ ...config, ptyFactory, ...(resolveCwd ? { resolveCwd } : {}) }); const server = http.createServer(app); const router = installWebSocketRouter(server, manager, config, logger, adminAuth);
  return { app, server, manager, listen: () => new Promise((resolve, reject) => { const fail = (error) => { server.off('error', fail); reject(error); }; server.once('error', fail); server.listen(config.port, config.host, () => { server.off('error', fail); resolve(); }); }), async close() { await manager.shutdown(); await router.close(); if (server.listening) await new Promise((resolve) => server.close(resolve)); } };
}
