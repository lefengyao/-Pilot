import { WebSocketServer, WebSocket } from 'ws';
import { ProtocolError, parseClientMessage, serverMessage } from './protocol.js';

function statusPayload(session) { return session.snapshot(); }
function tail(text, maxBytes) { if (Buffer.byteLength(text) <= maxBytes) return text; let i = 0; while (i < text.length && Buffer.byteLength(text.slice(i)) > maxBytes) i += 1; if (i > 0 && /[\uDC00-\uDFFF]/.test(text[i])) i += 1; return text.slice(i); }

export function installWebSocketRouter(server, manager, config, logger = console, adminAuth = null) {
  const wss = new WebSocketServer({ server, path: '/ws', maxPayload: config.maxMessageBytes });
  const clients = new Map(); const pending = new Map(); let timer = null;
  const send = (socket, type, id, payload) => { if (socket.readyState === WebSocket.OPEN) socket.send(serverMessage(type, id, payload)); };
  const subscribers = (id) => [...clients.entries()].filter(([, client]) => client.sessionIds.has(id)).map(([socket]) => socket);
  const flush = () => { timer = null; for (const [socket, chunks] of pending) for (const [id, data] of chunks) send(socket, 'output', id, { data }); pending.clear(); };
  manager.on('output', (session, data) => { for (const socket of subscribers(session.id)) { const chunks = pending.get(socket) || new Map(); chunks.set(session.id, tail((chunks.get(session.id) || '') + data, config.maxHistoryBytes)); pending.set(socket, chunks); } if (timer === null) timer = setTimeout(flush, config.outputBatchMs); });
  manager.on('status', (session) => { for (const socket of subscribers(session.id)) send(socket, 'status', session.id, statusPayload(session)); });

  wss.on('connection', (socket) => {
    clients.set(socket, { clientId: null, sessionIds: new Set() });
    socket.on('close', () => { clients.delete(socket); pending.delete(socket); });
    socket.on('error', (error) => logger.warn?.('WebSocket error', error.message));
    socket.on('message', async (raw) => {
      try {
        const message = parseClientMessage(raw, config); const client = clients.get(socket);
        if (message.type === 'hello') {
          client.clientId = message.payload.clientId;
          for (const session of manager.restore(client.clientId, message.payload.sessionIds)) { client.sessionIds.add(session.id); send(socket, 'status', session.id, statusPayload(session)); const history = session.history(); if (history) send(socket, 'output', session.id, { data: history, replay: true }); }
          return;
        }
        if (!client.clientId) throw new ProtocolError('请先发送 hello 消息。');
        if (message.type === 'create') {
          const admin = Boolean(message.payload.adminToken);
          if (admin && !adminAuth?.verify(message.payload.adminToken, client.clientId)) throw new ProtocolError('管理员解锁已失效。');
          const session = manager.create(client.clientId, { ...message.payload, admin });
          client.sessionIds.add(session.id); send(socket, 'status', session.id, statusPayload(session)); return;
        }
        const session = manager.requireOwned(client.clientId, message.sessionId); client.sessionIds.add(session.id);
        if (message.type === 'input') session.write(message.payload.data);
        else if (message.type === 'resize') session.resize(message.payload.cols, message.payload.rows);
        else if (message.type === 'stop') await session.stop();
        else if (message.type === 'restart') await session.restart();
        else if (message.type === 'delete') {
          const sessionSockets = subscribers(session.id);
          manager.delete(client.clientId, session.id);
          for (const otherClient of clients.values()) otherClient.sessionIds.delete(session.id);
          for (const sessionSocket of sessionSockets) send(sessionSocket, 'deleted', session.id, {});
        }
      } catch (error) { send(socket, 'error', undefined, { message: error.message || '终端操作失败。' }); }
    });
  });
  return { close: async () => { if (timer !== null) clearTimeout(timer); for (const socket of clients.keys()) socket.terminate(); await new Promise((resolve) => wss.close(resolve)); } };
}
