const CLIENT_KEY = 'lan-terminal-client-id'; const SESSIONS_KEY = 'lan-terminal-session-ids';
function createClientId() {
  const webCrypto = globalThis.crypto;
  if (typeof webCrypto?.randomUUID === 'function') return webCrypto.randomUUID();
  if (typeof webCrypto?.getRandomValues !== 'function') {
    throw new Error('浏览器不支持安全随机数。');
  }

  const bytes = webCrypto.getRandomValues(new Uint8Array(16));
  bytes[6] = (bytes[6] & 0x0f) | 0x40;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  const hex = [...bytes].map((byte) => byte.toString(16).padStart(2, '0')).join('');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}
export function getClientId() { let id = localStorage.getItem(CLIENT_KEY); if (!id) { id = createClientId(); localStorage.setItem(CLIENT_KEY, id); } return id; }
export function loadSessionIds() { try { return JSON.parse(localStorage.getItem(SESSIONS_KEY) || '[]'); } catch { return []; } }
export function saveSessionIds(ids) { localStorage.setItem(SESSIONS_KEY, JSON.stringify([...new Set(ids)].slice(0, 64))); }
export class TerminalSocket extends EventTarget {
  constructor() { super(); this.clientId = getClientId(); this.socket = null; this.delay = 500; this.timer = null; }
  connect() { clearTimeout(this.timer); if (this.socket?.readyState === WebSocket.OPEN || this.socket?.readyState === WebSocket.CONNECTING) return; const scheme = location.protocol === 'https:' ? 'wss' : 'ws'; this.socket = new WebSocket(`${scheme}://${location.host}/ws`); this.socket.addEventListener('open', () => { this.delay = 500; this.send('hello', { clientId: this.clientId, sessionIds: loadSessionIds() }); this.dispatchEvent(new Event('connected')); }); this.socket.addEventListener('message', (event) => { try { this.dispatchEvent(new CustomEvent('message', { detail: JSON.parse(event.data) })); } catch {} }); this.socket.addEventListener('close', () => { this.dispatchEvent(new Event('disconnected')); this.timer = setTimeout(() => this.connect(), this.delay); this.delay = Math.min(this.delay * 2, 5000); }); this.socket.addEventListener('error', () => this.dispatchEvent(new Event('disconnected'))); }
  reconnect() { if (this.socket) this.socket.close(1000, 'user reconnect'); else this.connect(); }
  send(type, payload = {}, sessionId) { if (this.socket?.readyState !== WebSocket.OPEN) throw new Error('服务未连接。'); this.socket.send(JSON.stringify({ type, ...(sessionId ? { sessionId } : {}), payload })); }
}
