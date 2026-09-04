import assert from 'node:assert/strict';
import test from 'node:test';
import { ProtocolError, parseClientMessage } from '../server/protocol.js';

const limits = { maxMessageBytes: 256 };
test('parses valid create requests', () => assert.deepEqual(parseClientMessage(JSON.stringify({ type: 'create', payload: { shell: 'powershell', label: 'Build', cwd: '.', cols: 120, rows: 32 } }), limits).payload.shell, 'powershell'));
test('rejects invalid and oversized requests', () => {
  assert.throws(() => parseClientMessage('{"type":"erase"}', limits), ProtocolError);
  assert.throws(() => parseClientMessage('{"type":"input","payload":{"data":"x"}}', limits), /sessionId/);
  assert.throws(() => parseClientMessage(JSON.stringify({ type: 'input', sessionId: 's', payload: { data: 'x'.repeat(300) } }), limits), /消息过大/);
});
test('deduplicates reconnect session IDs', () => assert.deepEqual(parseClientMessage(JSON.stringify({ type: 'hello', payload: { clientId: 'browser-1', sessionIds: ['a', 'a', 'b'] } }), limits).payload.sessionIds, ['a', 'b']));
test('parses a delete request', () => assert.deepEqual(parseClientMessage(JSON.stringify({ type: 'delete', sessionId: 'session-1', payload: {} }), limits), { type: 'delete', sessionId: 'session-1', payload: {} }));
