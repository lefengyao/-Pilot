const TYPES = new Set(['hello', 'create', 'input', 'resize', 'stop', 'restart', 'delete']);
const SHELLS = new Set(['powershell', 'cmd']);

export class ProtocolError extends Error {
  constructor(message) { super(message); this.name = 'ProtocolError'; }
}

function stringValue(value, label, max) {
  if (typeof value !== 'string' || value.length === 0 || value.length > max) throw new ProtocolError(`${label} 格式无效。`);
  return value;
}

function boundedInteger(value, label, min, max) {
  if (!Number.isInteger(value) || value < min || value > max) throw new ProtocolError(`${label} 必须是 ${min} 到 ${max} 之间的整数。`);
  return value;
}

export function parseClientMessage(raw, { maxMessageBytes }) {
  const text = Buffer.isBuffer(raw) ? raw.toString('utf8') : String(raw);
  if (Buffer.byteLength(text, 'utf8') > maxMessageBytes) throw new ProtocolError('消息过大。');
  let message;
  try { message = JSON.parse(text); } catch { throw new ProtocolError('消息必须是 JSON。'); }
  if (!message || typeof message !== 'object' || !TYPES.has(message.type)) throw new ProtocolError('消息类型无效。');
  const payload = message.payload ?? {};
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) throw new ProtocolError('payload 格式无效。');

  if (message.type === 'hello') {
    const ids = Array.isArray(payload.sessionIds) ? payload.sessionIds : [];
    return { type: 'hello', sessionId: undefined, payload: { clientId: stringValue(payload.clientId, 'clientId', 128), sessionIds: [...new Set(ids.map((id) => stringValue(id, 'sessionId', 128)))].slice(0, 64) } };
  }
  if (message.type === 'create') {
    if (!SHELLS.has(payload.shell)) throw new ProtocolError('shell 必须是 powershell 或 cmd。');
    return { type: 'create', sessionId: undefined, payload: { shell: payload.shell, label: typeof payload.label === 'string' ? payload.label.trim().slice(0, 64) : '', cwd: typeof payload.cwd === 'string' ? payload.cwd.trim().slice(0, 1024) || '.' : '.', adminToken: typeof payload.adminToken === 'string' ? payload.adminToken.trim().slice(0, 256) : '', cols: boundedInteger(payload.cols ?? 100, 'cols', 2, 500), rows: boundedInteger(payload.rows ?? 30, 'rows', 1, 300) } };
  }
  const sessionId = stringValue(message.sessionId, 'sessionId', 128);
  if (message.type === 'input') return { type: 'input', sessionId, payload: { data: stringValue(payload.data, '输入', maxMessageBytes) } };
  if (message.type === 'resize') return { type: 'resize', sessionId, payload: { cols: boundedInteger(payload.cols, 'cols', 2, 500), rows: boundedInteger(payload.rows, 'rows', 1, 300) } };
  return { type: message.type, sessionId, payload: {} };
}

export function serverMessage(type, sessionId, payload) {
  return JSON.stringify({ type, ...(sessionId ? { sessionId } : {}), payload });
}
